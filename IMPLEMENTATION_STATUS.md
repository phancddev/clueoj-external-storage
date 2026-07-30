# ClueOJ External Storage — Implementation Status

> Historical phase-completion snapshot. Test counts and unverified items in
> this file predate the live R2 validation. Use
> `FINAL_VALIDATION_REPORT_2026-07-30.md` and
> `docs/clueoj-integration.md` as the current deployment gates.

Source of truth: `plan/`. This file records decisions, progress, and verification status per phase.

## Phase 0 — Verification & Decisions (DONE)

### Judge volume topology
- Host `clueoj/problems/` → container `/problems/` mounted on `site`, `bridged`, `judge`.
- `DMOJ_PROBLEM_DATA_ROOT = '/problems/'` (local_settings.py:157).
- Problem folders at `/problems/<code>/`. Judge reads `init.yml` + archive from there.
- Storage app (Rust) will scan the same `./problems/` host volume (mounted read-only or read-write depending on capability; snapshot only needs read).
- **Decision**: Storage app mounts `STORAGE_PROBLEM_ROOT_HOST` (host `./problems/`) → `STORAGE_PROBLEM_ROOT_CONTAINER` (`/problems` in rust container). Rust scans `/problems/<code>/`.

### Writer/reader inventory & owners
Writers (Django, all in `clueoj/repo/`):
- `judge/utils/problem_data.py`: `ProblemDataStorage._save` (delete-before-save bug), `ProblemDataCompiler.compile` (non-atomic init.yml).
- `judge/models/problem_data.py`: `ProblemData.save` (deletes old zipfile before commit), `_update_code` (os.rename dir).
- `judge/models/problem.py`: `Problem.save` → `update_code()` rename on code change; mirror_of change handlers.
- `judge/views/problem_data.py`: `problem_data_file` download (proxies bytes via nginx X-Accel-Redirect or reads into response).

Readers:
- Judge process (`vnoj_judge01`) reads `init.yml` + archive from `/problems/<code>/`.
- `problem_data_file` view (download) reads archive.
- Nginx X-Accel-Redirect (internal redirect to `/media/` or problem archive).

### Logical vs allocated bytes; hardlink; orphan policy
- **Logical bytes** = sum of file sizes (st_size) in problem folder. **Allocated bytes** = sum of st_blocks*512 (actual disk blocks). Report both.
- **Hardlink**: dedup by `(st_dev, st_ino)`. If multiple paths in a snapshot resolve to same inode, count bytes once (against root owner). Mirrors that hardlink to root test files → root owner charged physical bytes, mirror gets `referenced_bytes` only.
- **Orphan**: folder under problem root with no matching Problem PK in catalog → "unassigned" bucket, no org charge, flagged in `/orphans` endpoint.

### storage_owner_organization migration
- Add `Problem.storage_owner_organization` FK → `Organization`, nullable. Null = system problem (no org charge).
- Migration backfills: for `is_organization_private` problems with exactly 1 org → set that org. For public problems with exactly 1 org in `organizations` M2M → set it. Otherwise null (system). Admin can change later via UI.
- Do NOT use `Problem.organizations` M2M for quota (it's visibility). Single FK is the quota owner.
- Mirror: physical bytes charged to root owner; mirror problem gets `referenced_bytes` only.

### Canonical downloadable artifact
- **Zip-based problems** (normal): canonical artifact = the zipfile stored in `ProblemData.zipfile` (the uploaded test archive). Direct download serves this via R2.
- **Manually managed problems** (`is_manually_managed=True`, no zipfile): canonical artifact = opt-in generated zip of the problem folder. Storage app can generate a zip on-demand snapshot and cache it in R2. Initially, if no generated zip exists, direct download returns 404 with actionable message (generate via dashboard action).
- **Decision**: Snapshot = full folder (manifest + content objects). Download artifact = zipfile if present, else generated zip (opt-in, dashboard-triggered), else 404.

### Independent PostgreSQL + retention
- Storage app uses its own PostgreSQL instance (`storage-db`), independent from ClueOJ MariaDB. ClueOJ never queries it directly; only via API.
- Retention: jobs 30-90d, audit ≥1yr, superseded snapshots configurable, content object GC only zero-ref + past safety window.

### Service auth + URL TTL + audit
- ClueOJ → storage app: service account with rotating asymmetric JWT (HS256 secret initially for simplicity, RS256 if keys provided). Audience = `storage-clueoj`. Scopes: `catalog:write`, `catalog:read`, `download:issue`.
- Dashboard auth: local admin bootstrap (username/password) initially; OIDC pluggable.
- TS ↔ Rust: internal network + shared service token header.
- URL TTL: default 180s, max 300s. No permanent presigned URL in DB. Signed URL returned only in response body, never persisted.
- Audit: all manual mutations, bulk actions, owner changes, URL issuance failures, login/denials. No secrets/presigned URLs in audit log.

### Benchmark baseline
- Current problem root: 53 entries, 292K total. Largest: `hcm_tst_22_b` 48K. Test dataset is small; production may be larger. Design for scale regardless.

### POC: judge restart with archive local missing
- **Decision**: If local archive missing but R2 generation READY+verified → judge still works ONLY if init.yml + archive present locally. Judge does NOT fetch from R2. Eviction initially OFF for full folder; only archive/cache eviction considered later. If local archive deleted (future eviction) and judge needs it → restore from R2 first (ensure-ready action). Direct download works even if local archive deleted (serves from R2).

### Rollback: owner + direct-download
- `STORAGE_PLATFORM_ENABLED`, `STORAGE_DIRECT_DOWNLOAD_ENABLED`, `STORAGE_CATALOG_SYNC_ENABLED`, `STORAGE_ATOMIC_WRITES_ENABLED`, `STORAGE_ENSURE_READY_ENABLED` feature flags. Each defaults OFF. Rollback = set flag false. Direct download rollback → ClueOJ falls back to old `add_file_response` byte-proxy/nginx flow. Owner rollback → ignore `storage_owner_organization`, quota uses old logic (or no quota).

---

## Phase 1 — Docker scaffolding + scan + read-only (DONE)
- Docker compose: storage-db (PG16+healthcheck+volume), storage-migrate (one-shot), storage-rust (no host port), storage-web (publishes 2907), network storage-net.
- Rust scan: full problem root, statvfs, walkdir (no symlink follow), hardlink dedup by (dev,ino), logical+allocated+archive+auxiliary bytes, file_count.
- Read-only dashboard + API: all GET endpoints, cursor pagination, search/filter/sort.
- Reconcile: orphan/missing/mirror detection, catalog_state upserts.
- Verified: cargo check + tsc --noEmit + dashboard build pass.

## Phase 2 — Immutable snapshot + fencing + crash-safe (DONE)
- Full-folder snapshot: manifest + content objects, manifest published LAST after all objects uploaded+verified.
- Snapshot state machine: DISCOVERED→HASHING→UPLOADING→VERIFYING→READY; ERROR branch; READY→SUPERSEDED.
- Fencing CAS: create_snapshot/restore/evict accept fencing_token, check MAX(fencing_token) for problem, 409 FENCING_MISMATCH if stale. ON CONFLICT DO NOTHING aborts if generation exists.
- Crash-safe: atomic temp+fsync+os.replace for local writes; restore downloads+verifies each object; old generation preserved until new READY.
- Eviction: default OFF, dry_run required unless force, only if R2 generation READY+verified.
- Verified: cargo check + tsc --noEmit pass.

## Phase 3 — OpenAPI + ClueOJ sync + direct download (DONE)
- OpenAPI 3.1 spec at packages/contracts/openapi/openapi.yaml, all /api/v1 endpoints.
- Generated TS client at packages/contracts/generated/client.ts.
- /api/v1/openapi.json + /api/v1/openapi.yaml endpoints serve spec.
- ClueOJ cursor sync: GET /sync/changes?cursor&limit, projection models + Celery tasks.
- R2 direct download: POST /downloads → Rust presigns R2 GET (180s default, max 300s, Content-Disposition: attachment) → ClueOJ returns 302. NO byte proxy.
- Dashboard mutation: RBAC (viewer/operator/storage-admin/auditor), audit events, Idempotency-Key required.
- Control plane does NOT read/stream test bytes.
- Verified: tsc --noEmit + vitest (openapi-contract 9 tests) pass.

## Phase 4 — Dashboard responsive + WCAG AA (DONE)
- Light/dark themes via shadcn CSS variables, prefers-reduced-motion.
- Server-side cursor pagination on all tables, search/filter/sort.
- Destructive actions via AlertDialog with type-to-confirm, returns job ID, toast links to job/audit.
- Empty/error/stale states: EmptyState explains+next action, ErrorState cause+retry, stale keeps last good + timestamp/badge.
- A11y: aria-label on icon-only, aria-sort on tables, aria-live for toast/progress, focus rings, StatusBadge not color-only (badge+text).
- Dashboard only calls TS control plane API, never touches DB or Rust directly.
- Verified: dashboard build (1729 modules) + vitest (35 tests) pass.

## Phase 5 — ClueOJ integration (DONE)
- Docker compose: clueoj/docker-compose.yml builds storage app via context ../clueoj-external-storage. Services: storage-db, storage-migrate, storage-rust, storage-web, celery-beat. Startup order: DB healthy→migrate→rust/web. ClueOJ calls http://storage-web:2907/api/v1.
- ClueOJ stale-safe sync: Celery beat every 5min (storage_sync_catalog), distributed singleton lock, cursor committed after DB txn.
- Download: STORAGE_DIRECT_DOWNLOAD_ENABLED → 302 R2 redirect; falls back to local file (degraded mode) if R2 fails.
- Upload: still local + auto snapshot via dirty-notification signal (STORAGE_CATALOG_SYNC_ENABLED).
- Atomic writers: ProblemDataStorage._save (temp+fsync+os.replace, no delete-before-save), ProblemData.save (old zipfile deleted AFTER save succeeds), ProblemDataCompiler.compile (atomic init.yml, deps-first), Problem.save (advisory lock on rename).
- Feature flags: STORAGE_PLATFORM_ENABLED, STORAGE_DIRECT_DOWNLOAD_ENABLED, STORAGE_CATALOG_SYNC_ENABLED, STORAGE_ATOMIC_WRITES_ENABLED, STORAGE_ENSURE_READY_ENABLED. All default OFF except ATOMIC_WRITES (default ON).
- Migrations: 0224_storage_owner_organization (FK nullable), 0225_storage_projection_models (StorageProblemUsage, StorageOrganizationUsage, StorageSystemStatus).
- Verified: py_compile all Python files + docker compose config + cargo check + tsc --noEmit pass.

## Phase 6 — Capability rollout + backfill + incident + retention + GC (DONE)
- Migration 002_phase6.sql: backfill_state, gc_marks, incident_commands, retention_config.
- API: /backfill (start/pause/progress per capability), /incident-commands (list_stuck_jobs, pause/resume_queue, pin/verify/restore/force_reconcile/rotate_credentials/export_audit/gc_collect — all --dry-run), /retention (GET+PUT), /gc/eligible.
- Backfill: cursor-based by stable problem ID, idempotent, resume after restart, reports discovered/ready/error/skipped + bytes.
- Rollback: per capability via feature flags.
- Retention: jobs 90d, audit 365d, superseded snapshots 90d, content objects 7d safety window.
- GC: mark-and-sweep only, no hard-delete from UI.
- Verified: tsc --noEmit + vitest (docker-compose 17 tests) pass.

---

## Test Results Summary

| Suite | Tests | Status |
|-------|-------|--------|
| Rust (hasher+scanner+r2) | 23 | PASS |
| TS control-plane (auth+openapi+docker-compose) | 35 | PASS |
| Dashboard (utils+status-badge+states) | 35 | PASS |
| Django (storage models+client+tasks) | compiles | PASS (py_compile) |
| **Total** | **93** | **ALL PASS** |

## Unverified Parts (require running infrastructure)

1. **R2 production upload/verify/restore**: Not run against real R2. InMemoryStore test double used. Production R2 adapter (R2Client with aws-sdk-s3) is complete but unverified. To verify: set R2_* env vars, run `cargo test -- --ignored` or manual snapshot+restore cycle.
2. **Docker compose full build/start**: `docker compose config` validates. Full `docker compose up --build` not run (requires Docker daemon). To verify: `cd clueoj && docker compose up --build`, check http://localhost:2907.
3. **Django migration apply**: Migrations written and py_compile clean. `migrate` not run (requires MariaDB). To verify: `docker compose run --rm site python manage.py migrate`.
4. **E2E upload→snapshot→R2→download redirect**: Requires all services running + R2 creds. To verify: upload problem data, trigger snapshot via dashboard, wait for READY, click download, verify 302 to R2 URL.
5. **Concurrent upload/upload race tests**: Atomic writes implemented but race tests not written (require multi-process orchestration). To verify: run two ProblemData.save() concurrently, confirm no data loss.
6. **Judge restart with archive local missing**: Not run (requires judge container). To verify: delete local archive, trigger restore from R2, restart judge, confirm judge works.
