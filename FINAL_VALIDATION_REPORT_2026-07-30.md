# Final validation report — 2026-07-30

## Post-validation ClueOJ integration findings

The standalone storage and R2 checks below passed, but the later live
submit-after-local-delete test found two release blockers outside those
standalone checks:

- The control plane expects per-problem `ready`, `local_status`, `generation`,
  and `observed_at` fields from Rust, while the current Rust
  `/internal/ready` handler returns only process-level `{"status":"ready"}`.
  Consequently `/api/v1/problems/:id/ensure-ready` repeatedly schedules
  restore jobs and never releases the submission to the judge.
- ClueOJ migration `0225_storage_projection_models` uses unnamed indexes and
  fails on the deployed Django migration state with `Indexes passed to
  ModelState require a name attribute`.

Keep `STORAGE_ENSURE_READY_ENABLED=false` and do not roll out the ClueOJ
projection migrations until these gates pass. The required integration test,
job coalescing, watcher suppression, and rollback procedure are specified in
`docs/clueoj-integration.md`.

## Result

The standalone external-storage stack is running on port `2907`. PostgreSQL,
the Rust data plane, the TypeScript control plane, Cloudflare R2 readiness, and
the dashboard health check are all healthy.

A persistent catalog problem and a persistent orphan fixture were deliberately
left in place so the result remains visible in the dashboard:

- Problem external ID: `990000001`
- Problem code: `storage_r2_demo_20260730`
- Organization: `storage-demo-org`
- Orphan code: `storage_r2_orphan_20260730`
- Latest READY snapshot generation: `13`
- Snapshot contents: `8` files, `848` logical bytes
- Canonical archive: `615` bytes
- R2 object verification: `8/8` uploaded and verified
- Current usage state: `present / ready / generation 13`

## Defects fixed during live integration

- Configured the AWS S3 client for the Cloudflare R2 account endpoint using
  path-style requests.
- Removed the incompatible explicit checksum request header and retained
  application-level SHA-256 GET verification.
- Replaced string matching for missing R2 objects with typed SDK `404`
  handling.
- Changed public health to use the Rust readiness endpoint, including database
  and object-store readiness.
- Prevented AJV from coercing nullable catalog fields into empty strings or
  zero, and added defensive normalization.
- Added `orphan` to the problem-usage response contract.
- Converted every PostgreSQL `INTEGER` generation read used by Rust into
  `BIGINT` at the SQL boundary.
- Fixed watcher/catalog identity races by serializing on problem code and
  atomically claiming watcher-created orphan rows.
- Added `ON UPDATE CASCADE` foreign keys so orphan usage, jobs, counters, and
  snapshots survive the authoritative identity change.
- Made orphan discovery and usage accounting one atomic transaction.
- Restored file modes and hardlink topology using a two-pass materializer.
- Changed disallowed CORS origins from an internal error into a structured
  `403`.
- Added the missing typed `200` response for restore dry-run.
- Updated Fastify plugins to supported versions, moved the runtime to Node 22,
  upgraded vulnerable test/build dependencies, and reduced the dashboard main
  bundle through route-level lazy loading.
- Added persistent Cargo registry/target caches to the Rust Docker build.

## Verification checklist

| Check | Result |
|---|---|
| Rust unit/integration tests | PASS — 54 |
| Control-plane tests | PASS — 79 |
| Dashboard tests | PASS — 51 |
| TypeScript type checks/builds | PASS |
| Dashboard production build | PASS; main chunk reduced to about 320 KB |
| Production and full npm audits | PASS — 0 vulnerabilities in both packages |
| Django integration file compilation | PASS |
| Docker Compose validation | PASS |
| PostgreSQL/Rust/web container health | PASS |
| Public health including R2 readiness | PASS |
| Real folder scan and usage accounting | PASS |
| Real R2 object and manifest upload | PASS |
| Direct R2 presigned download | PASS |
| Downloaded archive SHA-256 vs local archive | PASS — exact match |
| ZIP integrity after direct download | PASS |
| Full-folder restore after local folder removal | PASS |
| Restored per-file SHA-256 tree | PASS |
| Restored executable mode `0755` | PASS |
| Restored hardlink inode relationship | PASS |
| Organization aggregation | PASS |
| Orphan listing/serialization | PASS |
| Restore dry-run response | PASS |
| Disallowed CORS origin | PASS — structured `403` |
| Same-key concurrent dirty requests | PASS — 100/100 returned `200` |
| Distinct-key concurrent dirty requests | PASS — 8/8 returned `200` |
| Generation uniqueness under race | PASS — no duplicate generations |
| Latest-wins convergence | PASS — one READY latest generation, older generations superseded |
| Dashboard Problems page | PASS — persistent problem visible |
| Dashboard Problem detail/usage/R2 state | PASS |
| Dashboard Snapshots table | PASS |
| Dashboard Organization detail | PASS |
| Dashboard Orphans page | PASS |

The destructive restore test intentionally removed the local fixture folder.
One snapshot job correctly recorded `PROBLEM_FOLDER_MISSING` during that window;
the restore completed, watcher reconciliation converged to a newer READY
snapshot, and the final local/R2 state is consistent.

## Operational follow-ups

- Rotate the Cloudflare R2 token and access key because credentials were pasted
  into chat during setup.
- Keep monitoring local disk headroom; R2 is not a replacement for the free
  space required while receiving and snapshotting a new upload.
- Rust currently emits a non-blocking future-compatibility warning from
  `sqlx-postgres 0.7.4`; upgrade SQLx in a dedicated dependency migration before
  adopting a Rust toolchain that turns that warning into an error.
