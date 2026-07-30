import type { Pool } from 'pg';
import * as db from './db.js';
import { logger } from './logger.js';

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const GC_BATCH_SIZE = 500;
type MaintenanceDb = Pick<
  typeof db,
  'applyRetention' | 'listGcEligible' | 'createJob' | 'setJobPayload' | 'stableFingerprint'
>;

export class MaintenanceScheduler {
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private pool: Pool,
    private maintenanceDb: MaintenanceDb = db,
  ) {}

  start(): void {
    if (this.running || this.timer) return;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.running = this.runOnce().finally(() => {
        this.running = null;
        this.schedule(MAINTENANCE_INTERVAL_MS);
      });
    }, delayMs);
    this.timer.unref();
  }

  async runOnce(): Promise<void> {
    try {
      const retention = await this.maintenanceDb.applyRetention(this.pool);
      const eligible = await this.maintenanceDb.listGcEligible(this.pool, 1);
      if (eligible.length > 0) {
        const bucket = Math.floor(Date.now() / MAINTENANCE_INTERVAL_MS);
        const job = await this.maintenanceDb.createJob(this.pool, {
          idempotencyKey: `maintenance-gc-${bucket}`,
          jobType: 'gc_collect',
          problemId: null,
          targetGeneration: null,
          leaseOwner: 'system',
          requestFingerprint: this.maintenanceDb.stableFingerprint({
            action: 'scheduled-gc',
            batch_size: GC_BATCH_SIZE,
          }),
        });
        await this.maintenanceDb.setJobPayload(this.pool, job.id, { limit: GC_BATCH_SIZE });
      }
      logger.info({ retention, gc_eligible: eligible.length > 0 }, 'storage maintenance completed');
    } catch (err) {
      logger.error({ err }, 'storage maintenance failed');
    }
  }
}
