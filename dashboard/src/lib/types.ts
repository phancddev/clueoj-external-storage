export type {
  AcceptedJobResponse,
  AuditEvent,
  ByteValue,
  DownloadRequest,
  DownloadResponse,
  ErrorResponse as ApiError,
  HealthResponse,
  Job,
  Orphan,
  OrganizationUsage,
  Paginated,
  Problem,
  ProblemActionRequest,
  ProblemUsage,
  ReconcileRequest,
  ReconcileResult,
  Snapshot,
  SyncChange,
  SyncChangesResponse,
  Volume,
} from '../../../packages/contracts/generated/client';

export type Bytes = import('../../../packages/contracts/generated/client').ByteValue;
export type Rfc3339 = string;
export type Cursor = string;

export interface LoginResponse {
  token: string;
  expires_in: number;
  role: string;
  token_type?: string;
}

export interface DashboardSummary {
  catalog_problem_count: number;
  active_problem_count: number;
  dirty_problem_count: number;
  orphan_count: number;
  logical_bytes: Bytes;
  allocated_bytes: Bytes;
  archive_bytes: Bytes;
  auxiliary_bytes: Bytes;
}

export interface StatusDistributionRow {
  status: string;
  count: number | string;
}

export interface DashboardStatusDistribution {
  local_status: StatusDistributionRow[];
  r2_status: StatusDistributionRow[];
  catalog_state: StatusDistributionRow[];
}
