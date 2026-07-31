# ClueOJ External Storage

External storage, accounting, and R2 snapshot system for ClueOJ (DMOJ-based OJ).

## Architecture

```
clueoj-external-storage/
├── rust-data-plane/      # Rust (Axum + Tokio + SQLx + AWS SDK + notify + walkdir)
├── control-plane/        # Node.js (Fastify + TypeBox + pg + OpenAPI)
├── dashboard/            # Vite + React + TS + shadcn/ui + Tailwind + TanStack
├── packages/contracts/   # OpenAPI spec + generated clients
├── migrations/           # SQL migrations for storage PostgreSQL
├── docker/               # Dockerfiles for rust/web/migrate
├── .env.example
├── docker-compose.yml
└── Cargo.toml            # Rust workspace root
```

- **Rust data plane** (internal, port 8081): scans problem filesystem, hashes (SHA-256), uploads/verifies/restores/evicts R2 objects, immutable full-folder snapshots, watcher + reconciliation, atomic file ops, job lease + fencing.
- **TS control plane** (port 2907): versioned REST API `/api/v1`, auth + RBAC, metadata query, job orchestration, audit, OpenAPI, serves React dashboard. Does NOT stream test bytes.
- **React dashboard** (port 2907): shadcn/ui, professional infra console.
- **PostgreSQL**: storage app's own (independent from ClueOJ MariaDB). ClueOJ never queries it directly.

## Quick start

```bash
cp .env.example .env
# Edit .env with strong secrets, UID/GID, and R2 credentials.
docker compose up --build
# In another terminal, create the first dashboard administrator:
./scripts/storage-admin create admin
# Dashboard at http://localhost:2907
```

For local smoke/dev without R2, explicitly set `STORAGE_ALLOW_INSECURE_DEV=true` and `STORAGE_OBJECT_STORE=inmemory`.

ClueOJ and this platform are deployed independently. ClueOJ must not build or
start this repository from its Dockerfile. Follow
[docs/clueoj-integration.md](docs/clueoj-integration.md) to share the problem
root, configure service authentication, run migrations, and enable each feature
flag safely.

## Deployment

### Prerequisites
- Docker + Docker Compose
- Cloudflare R2 account (or MinIO for local dev)
- ClueOJ instance with `./problems/` volume

### Environment variables
Copy `.env.example` to `.env` and fill in:
- `STORAGE_PROBLEM_ROOT_HOST` — host path to problems dir (default `./problems`)
- `STORAGE_PROBLEM_ROOT_CONTAINER` — container path (default `/problems`)
- `STORAGE_PORT` — dashboard/API port (default `2907`)
- `STORAGE_DATABASE_URL` — PostgreSQL connection string
- `STORAGE_PUBLIC_BASE_URL` — public URL for dashboard
- `STORAGE_EVICTION_ENABLED` and `STORAGE_LOCAL_EVICTION_ENABLED` — both must
  be `true` to enable passive local-test eviction; the default idle window is
  24 hours after the latest submission or latest local restore/snapshot
- `STORAGE_CLUEOJ_SERVICE_AUDIENCE` — JWT audience for ClueOJ service
- `STORAGE_CLUEOJ_SERVICE_SECRET` — shared secret used by ClueOJ to mint short-lived service JWTs
- `STORAGE_SERVICE_SCOPES` — ClueOJ service scopes, default `read,mutate,downloads:issue`
- `STORAGE_SERVICE_TOKEN_TTL_SECONDS`, `STORAGE_SERVICE_TOKEN_SKEW_SECONDS` — minted service JWT cache/refresh timing
- `STORAGE_SERVICE_TOKEN` — legacy static bearer fallback only; normal compose leaves it empty
- `STORAGE_JWT_SECRET` — secret for non-dashboard service JWT verification
- `STORAGE_DASHBOARD_JWT_SECRET`, `STORAGE_DASHBOARD_JWT_AUDIENCE` — operator dashboard JWT settings
- `STORAGE_INTERNAL_SERVICE_TOKEN` — canonical TS↔Rust internal auth token; compose maps it into `storage-web`
- `STORAGE_ENSURE_READY_MAX_ATTEMPTS`, `STORAGE_ENSURE_READY_RETRY_BASE_SECONDS`, `STORAGE_ENSURE_READY_RETRY_MAX_SECONDS` — ClueOJ retry tuning
- `STORAGE_OBJECT_STORE` — `r2` for production; `inmemory` only with `STORAGE_ALLOW_INSECURE_DEV=true`
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT`
- `R2_PRESIGN_TTL_SECONDS` — URL TTL (default 180, max 300)

### Docker Compose services
| Service | Port | Purpose |
|---------|------|---------|
| storage-db | internal | PostgreSQL 16 + healthcheck + persistent volume |
| storage-migrate | one-shot | Runs SQL migrations before web/rust start |
| storage-rust | internal | Rust data plane (scan, snapshot, R2) |
| storage-web | 2907 | TS control plane + React dashboard |

Startup order: DB healthy → migrate → rust/web ready.

## Migration

### Storage app (PostgreSQL)
Migrations run automatically via `storage-migrate` service on `docker compose up`. To run manually:
```bash
docker compose run --rm storage-migrate
```
Migrations are in `migrations/`:
- `001_init.sql` — core schema (volumes, problems, usage, snapshots, jobs, audit)
- `002_phase6.sql` — backfill, GC, incident commands, retention config
- `003_review_contracts.sql` — review contract additions and startup/auth schema refinements
- `004_idempotency_dirty_contract.sql` — idempotency and dirty-notification contract refinements
- `005_dashboard_users.sql` — database-backed dashboard administrators and revocable sessions

The migrate runner applies every `*.sql` file in lexical order and records each filename stem in `schema_migrations`; it is not hardcoded to a fixed migration list.

### Dashboard administrator accounts

Dashboard passwords are scrypt-hashed in PostgreSQL and never stored in `.env`.
The management script prompts without echoing the password and supports:

```bash
./scripts/storage-admin create <username>
./scripts/storage-admin passwd <username>
./scripts/storage-admin delete <username>
./scripts/storage-admin list
```

Password changes and user deletion revoke all existing dashboard sessions for
that account. The final enabled administrator cannot be deleted; create a
replacement account first.

### ClueOJ (MariaDB)
New Django migrations:
- `0224_storage_owner_organization` — adds `storage_owner_organization` FK to Problem
- `0225_storage_projection_models` — creates StorageProblemUsage, StorageOrganizationUsage, StorageSystemStatus
- `0226_storage_sync_contract` — sync/dead-letter/lease contract refinements
- `0227_storage_org_problem_quota` — organization/problem quota projection updates

```bash
cd clueoj
docker compose run --rm site python manage.py migrate
```

The storage service is not added to ClueOJ's Dockerfile or base compose file.
See the integration guide for a client-only compose override and the required
ClueOJ runtime variables.

## Rollback

All capabilities controlled by feature flags (in `dmoj/local_settings.py`):
| Flag | Default | Effect |
|------|---------|--------|
| `STORAGE_PLATFORM_ENABLED` | False | Master switch |
| `STORAGE_DIRECT_DOWNLOAD_ENABLED` | False | R2 302 download (false = local file fallback) |
| `STORAGE_CATALOG_SYNC_ENABLED` | False | Dirty notification + Celery sync |
| `STORAGE_ATOMIC_WRITES_ENABLED` | True | Atomic file writes (keep ON for safety) |
| `STORAGE_ENSURE_READY_ENABLED` | False | Auto-restore from R2 if local missing |

To rollback any capability: set flag to `False` and restart ClueOJ. No data loss — atomic writes and immutable generations preserve both local + R2 state.

Phase 6 per-capability backfill also supports pause/resume via API:
```bash
curl -X POST http://localhost:2907/api/v1/backfill/atomic_writes/pause \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)"
```

## Runbook

### Incident commands (all support --dry-run)
```bash
# List stuck jobs
curl -X POST http://localhost:2907/api/v1/incident-commands \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"command":"list_stuck_jobs","dry_run":true}'

# Pause/resume queue
curl -X POST http://localhost:2907/api/v1/incident-commands \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"command":"pause_queue","dry_run":false}'

# Force reconcile
curl -X POST http://localhost:2907/api/v1/incident-commands \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"command":"force_reconcile","dry_run":false}'

# Restore problem from R2
curl -X POST http://localhost:2907/api/v1/incident-commands \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"command":"restore_problem","problem_id":"123","dry_run":false}'

# Rotate credentials (generates new JWT secret, audit logged)
curl -X POST http://localhost:2907/api/v1/incident-commands \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"command":"rotate_credentials","dry_run":true}'

# Export audit log
curl -X POST http://localhost:2907/api/v1/incident-commands \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"command":"export_audit","dry_run":false}'
```

### ClueOJ degraded mode
If storage app is not ready:
- ClueOJ download falls back to local file (nginx X-Accel-Redirect or byte read).
- ClueOJ sync tasks log warning, mark projections stale, continue.
- Judge reads from local `/problems/` as normal — no R2 dependency.
- NEVER proxy R2 through ClueOJ.

### Health check
```bash
curl http://localhost:2907/api/v1/system/health
# 200 = healthy, 503 = degraded (DB or Rust down)
```

### SLOs
- API availability: 99.9%
- App metadata p95: <15s
- ClueOJ projection sync: <5min (99%)
- URL issuance p95: <500ms
- Snapshot success: 99.9%
- Restore: 100% checksum verified
- Zero test data loss

### Retention
| Entity | Default | Configurable |
|--------|---------|-------------|
| Jobs | 90 days | Yes (PUT /api/v1/retention/jobs) |
| Audit events | 365 days | Yes (PUT /api/v1/retention/audit_events) |
| Superseded snapshots | 90 days | Yes (PUT /api/v1/retention/superseded_snapshots) |
| Content objects (GC) | 7-day safety window | Yes (PUT /api/v1/retention/content_objects) |

GC is mark-and-sweep only. No hard-delete from UI. Objects with zero references + past safety window are eligible.

## Development

### Rust data plane
```bash
cd rust-data-plane
cargo fmt --check
cargo clippy --all-targets --all-features
cargo test
```

### TS control plane
```bash
cd control-plane
npm install
npm run typecheck
npm test
npm run dev  # hot reload
```

### Dashboard
```bash
cd dashboard
npm install
npm run build
npm test
npm run dev  # hot reload at :2907
```

### OpenAPI
Spec at `packages/contracts/openapi/openapi.yaml`. Served at `/api/v1/openapi.json` and `/api/v1/openapi.yaml`.

## Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| Rust data plane | 54 | PASS |
| TS control plane | 79 | PASS |
| Dashboard | 51 | PASS |
| Django (storage models+client+tasks) | compiles | PASS |
| **Automated tests** | **184** | **ALL PASS** |

See `FINAL_VALIDATION_REPORT_2026-07-30.md` for live R2 validation and
`docs/clueoj-integration.md` for the remaining cross-service release gates.
