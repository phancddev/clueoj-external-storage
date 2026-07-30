# Snapshot retention and garbage collection

## Snapshot states

- `ready`: the newest fully uploaded and verified generation used by normal
  restore and download operations.
- `superseded`: an older immutable generation retained for the configured
  rollback window.
- `error`: an incomplete generation retained briefly so failed uploads can be
  inspected or retried.

When a new generation becomes `ready`, older `ready` generations for the same
problem become `superseded` and receive a `superseded_at` timestamp. Existing
installations start the retention clock for legacy `superseded` rows when
migration `008_snapshot_retention_gc.sql` is applied.

## Default timeline

1. A superseded snapshot remains protected for 90 days.
2. An error snapshot remains protected for 7 days.
3. After protection expires, unshared content objects and the snapshot
   manifest are inserted into `gc_marks`.
4. A GC mark waits for the `content_objects` safety window, 7 days by default.
5. The worker locks the object key, checks all protected references again, and
   deletes the R2 object.
6. Snapshot metadata is pruned on a later maintenance pass only after every
   private object is collected. Objects shared with a protected snapshot remain
   in R2.

The control plane runs this maintenance pass at startup and once per hour.
Manual `POST /api/v1/retention:apply` and `gc_collect` incident commands remain
available for operators.

## Concurrency guarantees

- Snapshot upload claims every content key and manifest key in PostgreSQL
  before sending bytes to R2.
- Claim creation and GC deletion use the same per-object PostgreSQL advisory
  lock.
- If deletion wins the lock, a later upload recreates the object.
- If upload wins the lock, GC observes the active claim and defers deletion.
- Only one active global `gc_collect` job is allowed.
- GC rechecks references immediately before and after deletion.
- A stale GC worker is rejected by the global GC fencing token.

## Configuration

Retention windows are stored in `retention_config`:

| Entity | Default |
| --- | ---: |
| `jobs` | 90 days |
| `audit_events` | 365 days |
| `superseded_snapshots` | 90 days |
| `error_snapshots` | 7 days |
| `content_objects` | 7 days |

Update a value through `PUT /api/v1/retention/:entityType`. Reducing a window
does not immediately delete data: objects still pass through the GC safety
window and reference checks.
