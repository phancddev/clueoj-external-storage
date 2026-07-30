import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  AcceptedJobResponse,
  AuditEvent,
  DashboardStatusDistribution,
  DashboardSummary,
  HealthResponse,
  Job,
  Orphan,
  OrganizationUsage,
  Paginated,
  Problem,
  ProblemUsage,
  ReconcileResult,
  Snapshot,
  SyncChangesResponse,
  Volume,
} from '@/lib/types';

export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 30_000,
  });
}

export function useVolumes() {
  return useQuery<Paginated<Volume>>({
    queryKey: ['volumes'],
    queryFn: api.getVolumes,
    refetchInterval: 60_000,
  });
}

export function useDashboardSummary() {
  return useQuery<DashboardSummary>({
    queryKey: ['dashboard-summary'],
    queryFn: api.getDashboardSummary,
    refetchInterval: 60_000,
  });
}

export function useDashboardStatusDistribution() {
  return useQuery<DashboardStatusDistribution>({
    queryKey: ['dashboard-status-distribution'],
    queryFn: api.getDashboardStatusDistribution,
    refetchInterval: 60_000,
  });
}

export function useLargestProblems(limit = 10) {
  return useQuery<Paginated<ProblemUsage>>({
    queryKey: ['dashboard-largest-problems', limit],
    queryFn: () => api.getLargestProblems(limit),
    refetchInterval: 60_000,
  });
}

export function useLargestOrganizations(limit = 10) {
  return useQuery<Paginated<OrganizationUsage>>({
    queryKey: ['dashboard-largest-organizations', limit],
    queryFn: () => api.getLargestOrganizations(limit),
    refetchInterval: 60_000,
  });
}

export function useVolumeTimeseries(params: { name?: string; limit?: number } = {}) {
  return useQuery<Paginated<Volume>>({
    queryKey: ['dashboard-volume-timeseries', params],
    queryFn: () => api.getVolumeTimeseries(params),
    refetchInterval: 60_000,
  });
}

export function useReconcile() {
  const qc = useQueryClient();
  return useMutation<ReconcileResult, Error, Array<{ external_id: string; code: string }>>({
    mutationFn: api.reconcile,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['volumes'] });
      qc.invalidateQueries({ queryKey: ['problems'] });
      qc.invalidateQueries({ queryKey: ['orphans'] });
    },
  });
}

export function useProblems(params: {
  search?: string;
  owner_organization?: string;
    catalog_state?: string;
    sort?: string;
    order?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}) {
  return useQuery<Paginated<Problem>>({
    queryKey: ['problems', params],
    queryFn: () => api.listProblems(params),
    placeholderData: (prev) => prev,
  });
}

export function useProblem(externalId: string) {
  return useQuery<Problem>({
    queryKey: ['problem', externalId],
    queryFn: () => api.getProblem(externalId),
    enabled: !!externalId,
  });
}

export function useProblemUsage(externalId: string) {
  return useQuery<ProblemUsage>({
    queryKey: ['problem-usage', externalId],
    queryFn: () => api.getProblemUsage(externalId),
    enabled: !!externalId,
    refetchInterval: 30_000,
  });
}

export function useProblemActions(externalId: string) {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['problem', externalId] });
    qc.invalidateQueries({ queryKey: ['problem-usage', externalId] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    qc.invalidateQueries({ queryKey: ['snapshots'] });
  };
  return {
    scan: useMutation<AcceptedJobResponse, Error, void>({
      mutationFn: () => api.scanProblem(externalId),
      onSuccess: invalidate,
    }),
    snapshot: useMutation<AcceptedJobResponse, Error, void>({
      mutationFn: () => api.snapshotProblem(externalId),
      onSuccess: invalidate,
    }),
    restore: useMutation<AcceptedJobResponse, Error, void>({
      mutationFn: () => api.restoreProblem(externalId),
      onSuccess: invalidate,
    }),
    evict: useMutation<AcceptedJobResponse, Error, { dryRun: boolean; force?: boolean }>({
      mutationFn: ({ dryRun, force = false }) => api.evictProblem(externalId, dryRun, force),
      onSuccess: invalidate,
    }),
  };
}

export function useOrganizations(cursor?: string, limit = 50) {
  return useQuery<Paginated<OrganizationUsage>>({
    queryKey: ['organizations', cursor, limit],
    queryFn: () => api.listOrganizations(cursor, limit),
    placeholderData: (prev) => prev,
  });
}

export function useOrganizationUsage(externalId: string) {
  return useQuery<OrganizationUsage>({
    queryKey: ['org-usage', externalId],
    queryFn: () => api.getOrganizationUsage(externalId),
    enabled: !!externalId,
  });
}

export function useSnapshots(problemId?: string, cursor?: string, limit = 50) {
  return useQuery<Paginated<Snapshot>>({
    queryKey: ['snapshots', problemId, cursor, limit],
    queryFn: () => api.listSnapshots(problemId, cursor, limit),
    placeholderData: (prev) => prev,
  });
}

export function useJobs(params: { state?: string; problem_id?: string; cursor?: string; limit?: number }) {
  return useQuery<Paginated<Job>>({
    queryKey: ['jobs', params],
    queryFn: () => api.listJobs(params),
    placeholderData: (prev) => prev,
    refetchInterval: 10_000,
  });
}

export function useRetryJob() {
  const qc = useQueryClient();
  return useMutation<Job, Error, string>({
    mutationFn: (id) => api.retryJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation<Job, Error, string>({
    mutationFn: (id) => api.cancelJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

export function useOrphans(cursor?: string, limit = 50) {
  return useQuery<Paginated<Orphan>>({
    queryKey: ['orphans', cursor, limit],
    queryFn: () => api.listOrphans(cursor, limit),
    refetchInterval: 60_000,
  });
}

export function useAuditEvents(params: {
  actor?: string;
  action?: string;
  problem_id?: string;
  cursor?: string;
}) {
  return useQuery<Paginated<AuditEvent>>({
    queryKey: ['audit', params],
    queryFn: () => api.listAuditEvents(params),
    placeholderData: (prev) => prev,
  });
}

export function useSyncChanges(cursor?: string, limit = 500) {
  return useQuery<SyncChangesResponse>({
    queryKey: ['sync', cursor, limit],
    queryFn: () => api.getSyncChanges(cursor, limit),
  });
}
