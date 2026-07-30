import type { Pool } from 'pg';
import type { Env } from './env.js';
import { RustClient, RustError } from './rust-client.js';
import * as db from './db.js';
import { logger } from './logger.js';
import type { JobT } from './schemas.js';

export interface WorkerContext {
  pool: Pool;
  env: Env;
  rust: RustClient;
}

export class JobWorker {
  private stopped = false;
  private running: Promise<void> | null = null;
  private readonly workerId = `ts-worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(private ctx: WorkerContext) {}

  start(): void {
    if (this.running) return;
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await db.failExpiredRunningJobs(this.ctx.pool);
        const job = await db.acquireJob(this.ctx.pool, this.workerId, this.ctx.env.workerLeaseSeconds);
        if (!job) {
          await sleep(1000);
          continue;
        }
        await this.runJob(job);
      } catch (err) {
        logger.error({ err }, 'worker loop failed');
        await sleep(1000);
      }
    }
  }

  private async runJob(job: JobT): Promise<void> {
    let leaseValid = true;
    const guard = async () => {
      if (!leaseValid) throw new db.JobLeaseLostError(job.id);
      await db.assertJobLease(this.ctx.pool, job);
    };
    const renew = setInterval(() => {
      void db.renewJobLease(this.ctx.pool, job.id, this.workerId, job.fencing_token, this.ctx.env.workerLeaseSeconds)
        .then((ok) => { leaseValid = leaseValid && ok; })
        .catch((err) => {
          leaseValid = false;
          logger.warn({ err, job_id: job.id }, 'job lease renewal failed');
        });
    }, Math.max(1000, Math.floor(this.ctx.env.workerLeaseSeconds * 500)));

    try {
      await guard();
      const result = await this.dispatch(job, guard);
      await guard();
      const committed = await db.completeJobWithLease(this.ctx.pool, job, 'completed', result, null, null);
      if (!committed) throw new db.JobLeaseLostError(job.id);
    } catch (err) {
      if (err instanceof db.JobLeaseLostError) {
        logger.warn({ job_id: job.id }, 'job lease lost; suppressing stale completion');
        return;
      }
      await db.completeJobWithLease(
        this.ctx.pool,
        job,
        'failed',
        null,
        errorCode(err),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearInterval(renew);
    }
  }

  private async dispatch(job: JobT, guard: () => Promise<void>): Promise<unknown> {
    switch (job.job_type) {
      case 'scan':
        return this.scan(job, guard);
      case 'snapshot':
        return this.snapshot(job, guard);
      case 'restore':
        return this.restore(job, guard);
      case 'evict':
        return this.evict(job, guard);
      case 'reconcile':
        return this.reconcile(job);
      case 'backfill':
        return this.backfill(job, guard);
      case 'gc_collect':
        return this.gcCollect(job, guard);
      case 'incident_command':
        return this.incidentCommand(job);
      default:
        throw new Error(`Unsupported job type ${job.job_type}`);
    }
  }

  private async scan(job: JobT, guard: () => Promise<void>): Promise<unknown> {
    if (!job.problem_id) throw new Error('scan job requires problem_id');
    const problem = await db.getProblem(this.ctx.pool, job.problem_id);
    if (!problem) throw new Error(`Problem not found: ${job.problem_id}`);
    await guard();
    const result = await this.ctx.rust.scan(problem.code, problem.external_id);
    await guard();
    await db.upsertProblemUsageForJob(this.ctx.pool, job, problem.external_id, {
      logical_bytes: result.logical_bytes,
      allocated_bytes: result.allocated_bytes,
      archive_bytes: result.archive_bytes,
      auxiliary_bytes: result.auxiliary_bytes,
      file_count: result.file_count,
      local_status: 'present',
      observed_at: result.observed_at,
    });
    return result;
  }

  private async snapshot(job: JobT, guard: () => Promise<void>): Promise<unknown> {
    if (!job.problem_id || job.target_generation === null) throw new Error('snapshot job requires problem_id and generation');
    const problem = await db.getProblem(this.ctx.pool, job.problem_id);
    if (!problem) throw new Error(`Problem not found: ${job.problem_id}`);
    await guard();
    const payload = (job.result ?? {}) as { dirty_version?: number | string | null };
    const dirtyVersion = payload.dirty_version ?? null;
    const snap = await this.ctx.rust.createSnapshot(problem.external_id, job.target_generation, problem.code, job.fencing_token, dirtyVersion);
    if (String(snap.state).toLowerCase() === 'ready') {
      await db.clearDirtyAfterSnapshotForJob(this.ctx.pool, job, problem.external_id, job.target_generation, dirtyVersion);
    }
    return snap;
  }

  private async restore(job: JobT, guard: () => Promise<void>): Promise<unknown> {
    if (!job.problem_id) throw new Error('restore job requires problem_id');
    const problem = await db.getProblem(this.ctx.pool, job.problem_id);
    if (!problem) throw new Error(`Problem not found: ${job.problem_id}`);
    const dest = `${this.ctx.env.problemRootContainer.replace(/\/$/, '')}/${problem.code}`;
    await guard();
    const result = await this.ctx.rust.restore(problem.external_id, job.target_generation ?? 0, dest, job.fencing_token);
    await db.markLocalPresentForJob(this.ctx.pool, job, problem.external_id, job.target_generation);
    return result;
  }

  private async evict(job: JobT, guard: () => Promise<void>): Promise<unknown> {
    if (!job.problem_id) throw new Error('evict job requires problem_id');
    const problem = await db.getProblem(this.ctx.pool, job.problem_id);
    if (!problem) throw new Error(`Problem not found: ${job.problem_id}`);
    const opts = (job.result ?? {}) as { dry_run?: boolean; force?: boolean };
    await guard();
    return this.ctx.rust.evict(problem.external_id, problem.code, opts.dry_run ?? true, opts.force ?? false, job.fencing_token);
  }

  private async reconcile(_job: JobT): Promise<unknown> {
    throw new Error('reconcile job requires catalog payload persisted by caller; use /catalog/problems:reconcile');
  }

  private async backfill(job: JobT, guard: () => Promise<void>): Promise<unknown> {
    const cfg = (job.result ?? {}) as { capability?: string; limit?: number };
    const capability = cfg.capability ?? 'accounting';
    const limit = Math.min(cfg.limit ?? 25, 100);
    const state = await this.ctx.pool.query('SELECT * FROM backfill_state WHERE capability = $1', [capability]);
    const cursor = state.rows[0]?.cursor_value as string | null | undefined;
    const page = await db.listProblems(this.ctx.pool, { cursor: cursor || undefined, limit, sort: 'external_id', order: 'asc' });

    let ready = 0;
    let error = 0;
    let skipped = 0;
    let bytesHashed = BigInt(0);
    for (const problem of page.items) {
      try {
        await guard();
        if (capability === 'accounting') {
          const result = await this.ctx.rust.scan(problem.code, problem.external_id);
          await db.upsertProblemUsageForJob(this.ctx.pool, job, problem.external_id, result);
          bytesHashed += BigInt(result.logical_bytes);
          ready++;
        } else if (capability === 'r2_snapshot') {
          const generation = await db.allocateGeneration(this.ctx.pool, problem.external_id);
          const child = await db.createJob(this.ctx.pool, {
            idempotencyKey: `${job.id}:snapshot:${problem.external_id}:${generation}`,
            jobType: 'snapshot',
            problemId: problem.external_id,
            targetGeneration: generation,
            leaseOwner: 'backfill',
            requestFingerprint: db.stableFingerprint({ capability, problem_id: problem.external_id, generation }),
          });
          await db.setJobPayload(this.ctx.pool, child.id, { parent_job_id: job.id, capability });
          ready++;
        } else {
          skipped++;
        }
      } catch {
        error++;
      }
    }

    await this.ctx.pool.query(
      `UPDATE backfill_state SET cursor_value = $2, status = $3,
         total_processed = total_processed + $4, total_ready = total_ready + $5,
         total_error = total_error + $6, total_skipped = total_skipped + $7,
         bytes_hashed = bytes_hashed + $8
       WHERE capability = $1`,
      [capability, page.next_cursor, page.has_more ? 'running' : 'completed', page.items.length, ready, error, skipped, bytesHashed.toString()],
    );
    if (page.has_more) {
      const next = await db.createJob(this.ctx.pool, {
        idempotencyKey: `${job.id}:${page.next_cursor}`,
        jobType: 'backfill',
        problemId: null,
        targetGeneration: null,
        leaseOwner: this.workerId,
        requestFingerprint: db.stableFingerprint({ action: 'backfill-page', capability, cursor: page.next_cursor, limit }),
      });
      await db.setJobPayload(this.ctx.pool, next.id, { capability, limit });
    }
    return { capability, processed: page.items.length, ready, error, skipped, has_more: page.has_more };
  }

  private async gcCollect(job: JobT, guard: () => Promise<void>): Promise<unknown> {
    const opts = (job.result ?? {}) as { limit?: number };
    const requestedLimit = Number(opts.limit ?? 100);
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 500)
      : 100;
    const objects = await db.listGcEligible(this.ctx.pool, limit);
    let collected = 0;
    let deferred = 0;
    for (const object of objects) {
      await guard();
      try {
        await this.ctx.rust.deleteObject(object.object_key, job.fencing_token);
        await guard();
        collected += await db.markGcCollected(this.ctx.pool, [object.id]);
      } catch (err) {
        if (isLiveReferenceError(err)) {
          await db.deferGcMark(this.ctx.pool, object.id, errorMessage(err));
          deferred++;
          continue;
        }
        await db.recordGcFailure(this.ctx.pool, object.id, errorMessage(err));
        throw err;
      }
    }
    return { collected, deferred, examined: objects.length };
  }

  private async incidentCommand(job: JobT): Promise<unknown> {
    const args = (job.result ?? {}) as { command?: string };
    if (!args.command) throw new Error('incident command missing command name');
    throw new Error(`Incident command ${args.command} has no automated implementation in the TypeScript control plane`);
  }
}

function errorCode(err: unknown): string {
  if (err instanceof Error && err.message.includes('Unsupported')) return 'unsupported_job';
  return 'job_failed';
}

function isLiveReferenceError(err: unknown): boolean {
  return err instanceof RustError
    && err.statusCode === 409
    && err.body.includes('"code":"OBJECT_LIVE_REFERENCE"');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
