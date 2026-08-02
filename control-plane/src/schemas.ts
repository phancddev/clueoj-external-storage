import type { Static } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';

// ===========================================================================
// Common scalar schemas
// ===========================================================================

export const Rfc3339 = Type.String({ format: 'date-time', description: 'UTC RFC3339 timestamp' });
export const Bytes = Type.Union([
  Type.Integer({ minimum: 0 }),
  Type.String({ pattern: '^[0-9]+$' }),
], { description: 'Bytes as a non-negative integer. Values larger than JS safe integer are serialized as decimal strings.' });
export const Cursor = Type.String({ description: 'Opaque pagination cursor' });

// ===========================================================================
// Error response
// ===========================================================================

export const ErrorResponse = Type.Object({
  code: Type.String(),
  message: Type.String(),
  retryable: Type.Boolean(),
  request_id: Type.String(),
});
export type ErrorResponseT = Static<typeof ErrorResponse>;

// ===========================================================================
// Volume
// ===========================================================================

export const Volume = Type.Object({
  name: Type.String(),
  mount_path: Type.String(),
  total_bytes: Bytes,
  free_bytes: Bytes,
  available_bytes: Bytes,
  observed_at: Rfc3339,
  stale: Type.Boolean(),
});
export type VolumeT = Static<typeof Volume>;

// ===========================================================================
// Problem
// ===========================================================================

export const Problem = Type.Object({
  external_id: Type.String(),
  code: Type.String(),
  logical_bytes: Type.Optional(Bytes),
  owner_organization: Type.Union([Type.String(), Type.Null()]),
  is_manually_managed: Type.Boolean(),
  mirror_of: Type.Union([Type.String(), Type.Null()]),
  mirror_root: Type.Union([Type.String(), Type.Null()]),
  quota_bytes: Type.Union([Bytes, Type.Null()]),
  catalog_state: Type.Enum({
    present: 'present',
    orphan: 'orphan',
    missing: 'missing',
    mirror: 'mirror',
    deleted: 'deleted',
  }),
  dirty: Type.Boolean(),
  dirty_generation: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  dirty_version: Bytes,
  observed_at: Rfc3339,
  stale: Type.Boolean(),
});
export type ProblemT = Static<typeof Problem>;

// ===========================================================================
// ProblemUsage
// ===========================================================================

export const ProblemUsage = Type.Object({
  problem_id: Type.String(),
  logical_bytes: Bytes,
  allocated_bytes: Bytes,
  archive_bytes: Bytes,
  auxiliary_bytes: Bytes,
  file_count: Type.Integer({ minimum: 0 }),
  local_status: Type.Enum({ present: 'present', missing: 'missing', partial: 'partial', orphan: 'orphan' }),
  r2_status: Type.Enum({ none: 'none', uploading: 'uploading', ready: 'ready', error: 'error', superseded: 'superseded' }),
  snapshot_generation: Type.Union([Type.Integer(), Type.Null()]),
  orphan_bytes: Bytes,
  referenced_bytes: Bytes,
  quota_bytes: Type.Union([Bytes, Type.Null()]),
  last_accessed_at: Type.Optional(Type.Union([Rfc3339, Type.Null()])),
  observed_at: Rfc3339,
  stale: Type.Boolean(),
});
export type ProblemUsageT = Static<typeof ProblemUsage>;

// ===========================================================================
// OrganizationUsage
// ===========================================================================

export const OrganizationUsage = Type.Object({
  organization_id: Type.String(),
  problem_count: Type.Integer({ minimum: 0 }),
  logical_bytes: Bytes,
  allocated_bytes: Bytes,
  archive_bytes: Bytes,
  auxiliary_bytes: Bytes,
  referenced_bytes: Bytes,
  quota_bytes: Type.Union([Bytes, Type.Null()]),
  problem_count_quota: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  observed_at: Rfc3339,
  stale: Type.Boolean(),
});
export type OrganizationUsageT = Static<typeof OrganizationUsage>;

// ===========================================================================
// Snapshot
// ===========================================================================

export const Snapshot = Type.Object({
  id: Type.String(),
  problem_id: Type.String(),
  generation: Type.Integer({ minimum: 0 }),
  state: Type.Enum({
    discovered: 'discovered',
    hashing: 'hashing',
    uploading: 'uploading',
    verifying: 'verifying',
    ready: 'ready',
    error: 'error',
    superseded: 'superseded',
  }),
  file_count: Type.Integer({ minimum: 0 }),
  total_bytes: Bytes,
  manifest_key: Type.Union([Type.String(), Type.Null()]),
  error_code: Type.Union([Type.String(), Type.Null()]),
  error_message: Type.Union([Type.String(), Type.Null()]),
  created_at: Rfc3339,
  completed_at: Type.Union([Rfc3339, Type.Null()]),
});
export type SnapshotT = Static<typeof Snapshot>;

// ===========================================================================
// Job
// ===========================================================================

export const Job = Type.Object({
  id: Type.String(),
  idempotency_key: Type.String(),
  job_type: Type.Enum({
    scan: 'scan',
    snapshot: 'snapshot',
    restore: 'restore',
    evict: 'evict',
    reconcile: 'reconcile',
    backfill: 'backfill',
    gc_collect: 'gc_collect',
    incident_command: 'incident_command',
  }),
  problem_id: Type.Union([Type.String(), Type.Null()]),
  target_generation: Type.Union([Type.Integer(), Type.Null()]),
  state: Type.Enum({ pending: 'pending', running: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled' }),
  lease_owner: Type.Union([Type.String(), Type.Null()]),
  lease_expires_at: Type.Union([Rfc3339, Type.Null()]),
  fencing_token: Type.Integer({ minimum: 0 }),
  attempt: Type.Integer({ minimum: 0 }),
  max_attempts: Type.Integer({ minimum: 1 }),
  result: Type.Union([Type.Unknown(), Type.Null()]),
  error_code: Type.Union([Type.String(), Type.Null()]),
  error_message: Type.Union([Type.String(), Type.Null()]),
  created_at: Rfc3339,
  updated_at: Rfc3339,
  completed_at: Type.Union([Rfc3339, Type.Null()]),
});
export type JobT = Static<typeof Job>;

// ===========================================================================
// AuditEvent
// ===========================================================================

export const AuditEvent = Type.Object({
  id: Type.String(),
  actor: Type.String(),
  actor_role: Type.Union([Type.String(), Type.Null()]),
  action: Type.String(),
  target_type: Type.Union([Type.String(), Type.Null()]),
  target_id: Type.Union([Type.String(), Type.Null()]),
  problem_id: Type.Union([Type.String(), Type.Null()]),
  generation: Type.Union([Type.Integer(), Type.Null()]),
  job_id: Type.Union([Type.String(), Type.Null()]),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  request_id: Type.Union([Type.String(), Type.Null()]),
  created_at: Rfc3339,
});
export type AuditEventT = Static<typeof AuditEvent>;

// ===========================================================================
// Download presign response
// ===========================================================================

export const DownloadResponse = Type.Object({
  url: Type.String(),
  expires_at: Rfc3339,
  method: Type.Literal('GET'),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type DownloadResponseT = Static<typeof DownloadResponse>;

export const DownloadRequest = Type.Object({
  problem_external_id: Type.String(),
  ttl_seconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
});
export type DownloadRequestT = Static<typeof DownloadRequest>;

// ===========================================================================
// Orphan
// ===========================================================================

export const Orphan = Type.Object({
  code: Type.String(),
  logical_bytes: Bytes,
  allocated_bytes: Bytes,
  file_count: Type.Integer({ minimum: 0 }),
  observed_at: Rfc3339,
});
export type OrphanT = Static<typeof Orphan>;

// ===========================================================================
// Sync changes
// ===========================================================================

export const SyncChange = Type.Object({
  external_id: Type.String(),
  code: Type.String(),
  owner_organization: Type.Union([Type.String(), Type.Null()]),
  is_manually_managed: Type.Boolean(),
  mirror_of: Type.Union([Type.String(), Type.Null()]),
  mirror_root: Type.Union([Type.String(), Type.Null()]),
  catalog_state: Type.String(),
  event_kind: Type.Enum({ upsert: 'upsert', delete: 'delete' }),
  schema_version: Type.Integer({ minimum: 1 }),
  downloadable: Type.Boolean(),
  quota_bytes: Type.Union([Bytes, Type.Null()]),
  logical_bytes: Bytes,
  allocated_bytes: Bytes,
  archive_bytes: Bytes,
  auxiliary_bytes: Bytes,
  file_count: Type.Integer({ minimum: 0 }),
  local_status: Type.String(),
  r2_status: Type.String(),
  snapshot_generation: Type.Union([Type.Integer(), Type.Null()]),
  orphan_bytes: Bytes,
  referenced_bytes: Bytes,
  last_accessed_at: Type.Optional(Type.Union([Rfc3339, Type.Null()])),
  observed_at: Rfc3339,
  stale: Type.Boolean(),
  updated_at: Rfc3339,
});
export type SyncChangeT = Static<typeof SyncChange>;

export const SyncChangesResponse = Type.Object({
  schema_version: Type.Integer({ minimum: 1 }),
  changes: Type.Array(SyncChange),
  next_cursor: Type.Union([Cursor, Type.Null()]),
  has_more: Type.Boolean(),
});
export type SyncChangesResponseT = Static<typeof SyncChangesResponse>;

// ===========================================================================
// Reconcile request
// ===========================================================================

export const ReconcileRequest = Type.Object({
  problems: Type.Array(Type.Object({
    external_id: Type.String(),
    code: Type.String(),
    owner_external_id: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    owner_organization: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    owner_organization_id: Type.Optional(Type.Union([Type.Null(), Type.String(), Type.Number()])),
    is_manually_managed: Type.Optional(Type.Boolean()),
    mirror_root_external_id: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    mirror_of_external_id: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    mirror_of: Type.Optional(Type.Union([Type.Null(), Type.String()])),
    problem_pk: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    quota_bytes: Type.Optional(Type.Union([Type.Null(), Bytes])),
    schema_version: Type.Optional(Type.Integer({ minimum: 1 })),
  })),
});
export type ReconcileRequestT = Static<typeof ReconcileRequest>;

export const ReconcileResult = Type.Object({
  discovered: Type.Integer({ minimum: 0 }),
  present: Type.Integer({ minimum: 0 }),
  missing: Type.Integer({ minimum: 0 }),
  orphan: Type.Integer({ minimum: 0 }),
  mirror: Type.Integer({ minimum: 0 }),
  job_id: Type.Optional(Type.String()),
});
export type ReconcileResultT = Static<typeof ReconcileResult>;

// ===========================================================================
// Mutation request bodies
// ===========================================================================

export const ProblemActionRequest = Type.Object({
  dry_run: Type.Optional(Type.Boolean()),
  generation: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ProblemActionRequestT = Static<typeof ProblemActionRequest>;

export const DirtyProblemRequest = Type.Object({
  external_id: Type.Optional(Type.String()),
  problem_pk: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  code: Type.String(),
  owner_organization: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  owner_organization_id: Type.Optional(Type.Union([Type.Null(), Type.String(), Type.Number()])),
  owner_external_id: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  is_manually_managed: Type.Optional(Type.Boolean()),
  mirror_of: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  mirror_of_external_id: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  mirror_root: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  mirror_root_external_id: Type.Optional(Type.Union([Type.Null(), Type.String()])),
  quota_bytes: Type.Optional(Type.Union([Type.Null(), Bytes])),
  schema_version: Type.Optional(Type.Integer({ minimum: 1 })),
  event_kind: Type.Optional(Type.Enum({ upsert: 'upsert', delete: 'delete' })),
  catalog_state: Type.Optional(Type.Enum({
    present: 'present',
    orphan: 'orphan',
    missing: 'missing',
    mirror: 'mirror',
    deleted: 'deleted',
  })),
});
export type DirtyProblemRequestT = Static<typeof DirtyProblemRequest>;

export const JobActionRequest = Type.Object({
  reason: Type.Optional(Type.String()),
});
export type JobActionRequestT = Static<typeof JobActionRequest>;

// ===========================================================================
// Health
// ===========================================================================

export const HealthResponse = Type.Object({
  status: Type.String(),
  version: Type.String(),
  database: Type.Boolean(),
  rust_data_plane: Type.Boolean(),
});
export type HealthResponseT = Static<typeof HealthResponse>;

export const LoginRequest = Type.Object({
  username: Type.String({ minLength: 3, maxLength: 64 }),
  password: Type.String({ minLength: 1, maxLength: 1024 }),
});
export type LoginRequestT = Static<typeof LoginRequest>;

export const LoginResponse = Type.Object({
  token: Type.String(),
  expires_in: Type.Integer({ minimum: 1 }),
  role: Type.String(),
  token_type: Type.Literal('Bearer'),
});
export type LoginResponseT = Static<typeof LoginResponse>;

export const ServiceTokenRequest = Type.Object({
  subject: Type.Optional(Type.String()),
  scopes: Type.Optional(Type.Array(Type.String())),
  ttl_seconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 2592000 })),
});
export type ServiceTokenRequestT = Static<typeof ServiceTokenRequest>;

export const ServiceTokenResponse = Type.Object({
  token: Type.String(),
  expires_in: Type.Integer({ minimum: 1 }),
  token_type: Type.Literal('Bearer'),
  audience: Type.String(),
  scopes: Type.Array(Type.String()),
});
export type ServiceTokenResponseT = Static<typeof ServiceTokenResponse>;

export const AcceptedJobResponse = Type.Object({
  job_id: Type.String(),
  state: Type.Enum({ pending: 'pending', running: 'running', completed: 'completed', failed: 'failed', cancelled: 'cancelled' }),
  poll_url: Type.String(),
  events_url: Type.String(),
});
export type AcceptedJobResponseT = Static<typeof AcceptedJobResponse>;

export const RestoreDryRunResponse = Type.Object({
  dry_run: Type.Literal(true),
  message: Type.String(),
});
export type RestoreDryRunResponseT = Static<typeof RestoreDryRunResponse>;

export const EnsureReadyResponse = Type.Object({
  status: Type.Enum({ ready: 'ready', restoring: 'restoring', snapshotting: 'snapshotting', unavailable: 'unavailable' }),
  ready: Type.Boolean(),
  job_id: Type.Optional(Type.String()),
  poll_url: Type.Optional(Type.String()),
  events_url: Type.Optional(Type.String()),
});
export type EnsureReadyResponseT = Static<typeof EnsureReadyResponse>;

// ===========================================================================
// Pagination envelope
// ===========================================================================

export function Paginated<T extends import('@sinclair/typebox').TSchema>(item: T) {
  return Type.Object({
    items: Type.Array(item),
    next_cursor: Type.Union([Cursor, Type.Null()]),
    has_more: Type.Boolean(),
  });
}
