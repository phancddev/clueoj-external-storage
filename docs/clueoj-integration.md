# Integrating with ClueOJ

This guide connects a ClueOJ deployment to `clueoj-external-storage` without
making ClueOJ build or start the storage platform. The two repositories keep
separate databases, release cycles, secrets, and Docker Compose projects.

Repository: <https://github.com/phancddev/clueoj-external-storage>

## Deployment boundary

- Run this repository with its own `docker-compose.yml`.
- Keep PostgreSQL, R2 credentials, dashboard secrets, and the Rust internal
  token inside this repository's `.env`.
- Give ClueOJ only the storage API URL, the shared ClueOJ service secret,
  service JWT metadata, retry settings, and feature flags.
- Mount the same host problem directory into `storage-rust` that the ClueOJ
  site, bridge, and judge use.
- Do not add a ClueOJ Dockerfile instruction that clones, builds, or starts the
  storage app.

## 1. Prepare both repositories

A sibling layout is convenient but not required:

```text
workspace/
├── clueoj/
└── clueoj-external-storage/
```

Use the ClueOJ `testing` branch containing the storage client, models, tasks,
migrations, download redirect, and submission readiness gate.

## 2. Configure and start the storage platform

From `clueoj-external-storage`:

```bash
cp .env.example .env
id -u
id -g
```

Set at least:

```dotenv
STORAGE_PROBLEM_ROOT_HOST=/absolute/path/to/clueoj/problems
STORAGE_RUST_UID=<numeric owner uid of the problem directory>
STORAGE_RUST_GID=<numeric owner gid of the problem directory>
STORAGE_PUBLIC_BASE_URL=https://storage.example.com
STORAGE_PORT=2907

POSTGRES_PASSWORD=<random value of at least 16 characters>
STORAGE_DATABASE_URL=postgresql://storage:<same password>@storage-db:5432/storage
STORAGE_CLUEOJ_SERVICE_SECRET=<random value of at least 32 characters>
STORAGE_JWT_SECRET=<different random value of at least 32 characters>
STORAGE_DASHBOARD_JWT_SECRET=<different random value of at least 32 characters>
STORAGE_INTERNAL_SERVICE_TOKEN=<different random value of at least 32 characters>

STORAGE_OBJECT_STORE=r2
STORAGE_ALLOW_INSECURE_DEV=false
R2_ACCOUNT_ID=<Cloudflare account id>
R2_ACCESS_KEY_ID=<R2 S3 access key id>
R2_SECRET_ACCESS_KEY=<R2 S3 secret access key>
R2_BUCKET_NAME=<bucket name>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

Generate independent secrets with a cryptographically secure tool such as
`openssl rand -hex 32`. Never commit `.env`.

Start and verify:

```bash
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:2907/api/v1/system/health
./scripts/storage-admin create admin
```

The dashboard is available on port `2907`. The compose file binds it to
`127.0.0.1` by default. Use an SSH tunnel or a trusted HTTPS reverse proxy for
operator access; do not expose the HTTP login endpoint directly to the Internet.

### Passive local-test eviction

After migrations are applied and `ensure-ready` restore is verified, enable:

```dotenv
STORAGE_EVICTION_ENABLED=true
STORAGE_LOCAL_EVICTION_ENABLED=true
STORAGE_ENSURE_READY_ENABLED=true
STORAGE_LOCAL_EVICTION_IDLE_HOURS=24
STORAGE_LOCAL_EVICTION_BATCH_SIZE=50
STORAGE_LOCAL_EVICTION_SWEEP_SECONDS=3600
```

Celery Beat performs one indexed, bounded sweep per interval. It does not
create a timer for each submission. A problem becomes eligible only when its
latest local restore/snapshot and its latest direct or mirror submission are
both older than the idle window, with no queued/running grading submission.
`ensure-ready` refreshes a storage-side access fence, so a submission racing
the eviction cancels it or waits for the completed eviction and restores the
single READY R2 generation.

## 3. Give ClueOJ network access

The storage API publishes host port `2907` on `STORAGE_PUBLISH_HOST`. On Docker Desktop, ClueOJ
containers can use:

```dotenv
STORAGE_SERVICE_BASE_URL=http://host.docker.internal:2907/api/v1
```

On Linux, add a client-only override to the ClueOJ deployment. This override
does not build or start the storage app:

Set `STORAGE_PUBLISH_HOST` in the storage app to the address returned for
`host.docker.internal` inside the ClueOJ container (commonly `172.17.0.1`).
This keeps the API reachable by ClueOJ without listening on the VPS public
interface.

```yaml
# clueoj/docker-compose.storage-client.yml
services:
  site:
    env_file:
      - environment/mysql.env
      - environment/site.env
      - environment/storage.env
    extra_hosts:
      - host.docker.internal:host-gateway
  celery:
    env_file:
      - environment/mysql.env
      - environment/site.env
      - environment/storage.env
    extra_hosts:
      - host.docker.internal:host-gateway
  celery-beat:
    image: vnoj/vnoj-celery
    env_file:
      - environment/mysql.env
      - environment/site.env
      - environment/storage.env
    extra_hosts:
      - host.docker.internal:host-gateway
    entrypoint: ["celery", "-A", "dmoj_celery"]
    command: ["beat", "-l", "info", "--schedule=/tmp/celerybeat-schedule"]
    networks:
      - site
      - db
```

Start ClueOJ with both files:

```bash
docker compose -f docker-compose.yml \
  -f docker-compose.storage-client.yml up -d
```

All three processes—site, Celery worker, and Celery beat—must receive the same
client configuration.

An alternative is a shared external Docker network where the storage web
service is reachable as `storage-web:2907`. Use one network strategy
consistently; do not expose the Rust data-plane port.

## 4. Configure the ClueOJ client

Create `clueoj/environment/storage.env` and keep it out of Git:

```dotenv
STORAGE_SERVICE_BASE_URL=http://host.docker.internal:2907/api/v1
STORAGE_CLUEOJ_SERVICE_SECRET=<same value as the storage app>
STORAGE_SERVICE_ISSUER=clueoj-storage
STORAGE_SERVICE_AUDIENCE=clueoj-storage
STORAGE_SERVICE_SUBJECT=clueoj
STORAGE_SERVICE_SCOPES=read,mutate,downloads:issue
STORAGE_SERVICE_TOKEN=
STORAGE_SERVICE_TOKEN_TTL_SECONDS=300
STORAGE_SERVICE_TOKEN_SKEW_SECONDS=30
STORAGE_SERVICE_TIMEOUT=10

STORAGE_PLATFORM_ENABLED=false
STORAGE_CATALOG_SYNC_ENABLED=false
STORAGE_DIRECT_DOWNLOAD_ENABLED=false
STORAGE_ATOMIC_WRITES_ENABLED=true
STORAGE_ENSURE_READY_ENABLED=false

STORAGE_ENSURE_READY_MAX_ATTEMPTS=12
STORAGE_ENSURE_READY_RETRY_BASE_SECONDS=5
STORAGE_ENSURE_READY_RETRY_MAX_SECONDS=60
STORAGE_ENSURE_READY_DEGRADED_DISPATCH=false
```

Do not copy `R2_*`, `POSTGRES_*`, `STORAGE_DATABASE_URL`,
`STORAGE_INTERNAL_SERVICE_TOKEN`, or dashboard JWT secrets into ClueOJ.

## 5. Apply the ClueOJ schema

Back up MariaDB, then run:

```bash
cd clueoj
docker compose run --rm site python3 manage.py showmigrations judge
docker compose run --rm site python3 manage.py migrate --noinput
docker compose run --rm site python3 manage.py check
```

The storage integration requires migrations `0224` through `0227`. A migration
failure is a release blocker; do not enable any storage feature flag on a
partially migrated database.

## 6. Validate connectivity with flags off

From a ClueOJ site container:

```bash
python3 manage.py shell -c \
  "from judge.utils.storage_client import get_storage_volumes; print(get_storage_volumes())"
```

Confirm:

- Storage health returns HTTP 200.
- The storage dashboard reports the shared problem volume.
- ClueOJ can mint a short-lived service JWT using the shared secret.
- The site and Celery logs contain no authentication, audience, or schema
  mismatch.

## 7. Roll out capabilities

Enable one capability at a time and restart the ClueOJ site, Celery worker, and
Celery beat after each environment change:

1. `STORAGE_PLATFORM_ENABLED=true` and
   `STORAGE_CATALOG_SYNC_ENABLED=true`.
2. Wait for catalog projections and organization usage to become non-stale.
3. Enable `STORAGE_DIRECT_DOWNLOAD_ENABLED=true`; verify an authorized archive
   request returns HTTP 302 to a short-lived R2 URL.
4. Keep `STORAGE_ENSURE_READY_ENABLED=false` until the live readiness contract
   test below passes.
5. Enable `STORAGE_ENSURE_READY_ENABLED=true` only after validating
   delete-local → submit → restore → judge dispatch in the target environment.

`STORAGE_ATOMIC_WRITES_ENABLED` should remain enabled.

## 8. Required release gates

Before enabling automatic restore in production:

- `GET /internal/ready?problem_external_id=<id>&code=<code>` between the control
  and Rust planes must return the per-problem fields `ready`, `local_status`,
  `generation`, and `observed_at`; a process-level `{"status":"ready"}` response
  is not sufficient.
- Repeated ensure-ready calls for the same problem and generation must reuse
  one active restore job.
- Restore writes must not be interpreted by the watcher as a new user upload.
- Removing a local test folder and submitting must restore every file from R2,
  preserve checksum and executable metadata, and dispatch exactly once.
- `python3 manage.py migrate --plan` and the real migration must both pass.

## 9. Rollback

Set these ClueOJ flags to `false` and restart ClueOJ:

```dotenv
STORAGE_ENSURE_READY_ENABLED=false
STORAGE_DIRECT_DOWNLOAD_ENABLED=false
STORAGE_CATALOG_SYNC_ENABLED=false
STORAGE_PLATFORM_ENABLED=false
```

Do not delete the storage PostgreSQL volume or R2 objects during application
rollback. With direct download disabled, ClueOJ falls back to local archive
serving when the local file still exists.

## 10. Secret rotation

Rotate the shared ClueOJ service secret in both deployments during one
maintenance window, then restart ClueOJ clients and the storage web service.
Rotate R2 keys only in the storage app. Dashboard administrators are managed
with `./scripts/storage-admin`; passwords do not belong in `.env`.
