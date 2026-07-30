import type React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  useDashboardStatusDistribution,
  useDashboardSummary,
  useHealth,
  useLargestOrganizations,
  useLargestProblems,
  useVolumeTimeseries,
  useVolumes,
} from '@/hooks/queries';
import { PageHeader } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { bytePercent, formatBytes, formatNumber, formatRelative, subtractBytes, toBigIntBytes } from '@/lib/utils';
import { Activity, AlertTriangle, BarChart3, Boxes, Database, FileText, HardDrive, LineChart } from 'lucide-react';
import type { ByteValue, OrganizationUsage, ProblemUsage, StatusDistributionRow, Volume } from '@/lib/types';

function KpiCard({ title, value, note, icon: Icon }: { title: string; value: React.ReactNode; note: string; icon: typeof Activity }) {
  return (
    <Card aria-label={title}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </CardContent>
    </Card>
  );
}

function bytesToGiB(value: ByteValue | bigint | null | undefined): number {
  const parsed = toBigIntBytes(value);
  if (parsed == null) return 0;
  return Number((parsed * 100n) / (1024n ** 3n)) / 100;
}

function countToNumber(value: number | string): number {
  const parsed = toBigIntBytes(value);
  return parsed == null ? 0 : Number(parsed);
}

function volumeChartData(items: Volume[]) {
  return [...items].reverse().map((v) => ({
    label: new Date(v.observed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    observed_at: v.observed_at,
    available: bytesToGiB(v.available_bytes),
    free: bytesToGiB(v.free_bytes),
    total: bytesToGiB(v.total_bytes),
    name: v.name,
  }));
}

function largestProblemData(items: ProblemUsage[]) {
  return items.map((p) => ({
    name: p.problem_id,
    logical: bytesToGiB(p.logical_bytes),
    label: formatBytes(p.logical_bytes),
  }));
}

function largestOrganizationData(items: OrganizationUsage[]) {
  return items.map((o) => ({
    name: o.organization_id,
    logical: bytesToGiB(o.logical_bytes),
    label: formatBytes(o.logical_bytes),
  }));
}

function StatusDistributionChart({ title, rows }: { title: string; rows: StatusDistributionRow[] }) {
  const data = rows.map((row) => ({ status: row.status, count: countToNumber(row.count), label: formatNumber(countToNumber(row.count)) }));
  if (data.length === 0) return <EmptyState title={`No ${title.toLowerCase()} data`} description="The endpoint returned no distribution rows." />;
  return (
    <div className="space-y-3">
      <div className="h-44" aria-label={`${title} distribution chart`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="status" tickLine={false} axisLine={false} fontSize={12} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} />
            <ChartTooltip formatter={(value) => [formatNumber(Number(value)), 'Problems']} />
            <Bar dataKey="count" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.status} className="flex justify-between rounded-md border px-3 py-2">
            <span>{row.status}</span>
            <span className="tabular-nums">{formatNumber(countToNumber(row.count))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OverviewPage() {
  const health = useHealth();
  const volumes = useVolumes();
  const summary = useDashboardSummary();
  const distributions = useDashboardStatusDistribution();
  const volumeSeries = useVolumeTimeseries({ limit: 100 });
  const largestProblems = useLargestProblems(8);
  const largestOrganizations = useLargestOrganizations(8);

  const volume = volumes.data?.items[0];
  const usedBytes = volume ? subtractBytes(volume.total_bytes, volume.available_bytes) : null;
  const usedPct = volume ? bytePercent(usedBytes, volume.total_bytes) : null;
  const trend = volumeChartData(volumeSeries.data?.items ?? []);
  const problemBars = largestProblemData(largestProblems.data?.items ?? []);
  const orgBars = largestOrganizationData(largestOrganizations.data?.items ?? []);

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="System health and storage summary" />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Card aria-label="System health">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">System health</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            {health.isLoading ? (
              <Skeleton className="h-8 w-20" />
            ) : health.isError ? (
              <ErrorState message="Health endpoint failed; retry to refresh this card." onRetry={health.refetch} />
            ) : (
              <div className="space-y-1">
                <StatusBadge status={health.data?.status ?? 'unknown'} />
                <p className="text-xs text-muted-foreground">
                  DB: {health.data?.database ? 'ok' : 'down'} / Rust: {health.data?.rust_data_plane ? 'ok' : 'down'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
        <KpiCard title="Catalog problems" icon={FileText} value={summary.isError ? '-' : formatNumber(summary.data?.catalog_problem_count)} note="all catalog states" />
        <KpiCard title="Active problems" icon={FileText} value={summary.isError ? '-' : formatNumber(summary.data?.active_problem_count)} note="present or mirror only" />
        <KpiCard title="Dirty" icon={Boxes} value={summary.isError ? '-' : formatNumber(summary.data?.dirty_problem_count)} note="problems needing scan/snapshot" />
        <KpiCard title="Orphans" icon={AlertTriangle} value={summary.isError ? '-' : formatNumber(summary.data?.orphan_count)} note="catalog state orphan" />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <KpiCard title="Active logical bytes" icon={Database} value={formatBytes(summary.data?.logical_bytes)} note="present/mirror problems only" />
        <KpiCard title="Active allocated bytes" icon={Database} value={formatBytes(summary.data?.allocated_bytes)} note="present/mirror local allocation" />
        <KpiCard title="Active archive bytes" icon={Database} value={formatBytes(summary.data?.archive_bytes)} note="present/mirror archive component" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-4 w-4" aria-hidden="true" />
            Storage volume
          </CardTitle>
          <CardDescription>{volume?.name ?? '-'} / {volume?.mount_path ?? '-'}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {volumes.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : volumes.isError ? (
            <ErrorState message="Volume metrics failed; cached data may be unavailable." onRetry={volumes.refetch} />
          ) : !volume ? (
            <EmptyState title="No volume data" description="The storage volume endpoint returned no metrics." />
          ) : (
            <>
              <div>
                <div className="mb-1 flex justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">Used</span>
                  <span className="text-right tabular-nums">
                    {formatBytes(usedBytes)} / {formatBytes(volume.total_bytes)} ({usedPct == null ? '-' : `${usedPct}%`})
                  </span>
                </div>
                <Progress
                  value={usedPct ?? 0}
                  indicatorClassName={(usedPct ?? 0) > 90 ? 'bg-destructive' : (usedPct ?? 0) > 80 ? 'bg-warning' : 'bg-primary'}
                  aria-label={`Disk usage ${usedPct ?? 0} percent`}
                />
              </div>
              <div className="grid gap-4 text-sm sm:grid-cols-3">
                <div><p className="text-muted-foreground">Free</p><p className="tabular-nums font-medium">{formatBytes(volume.free_bytes)}</p></div>
                <div><p className="text-muted-foreground">Available</p><p className="tabular-nums font-medium">{formatBytes(volume.available_bytes)}</p></div>
                <div><p className="text-muted-foreground">Observed</p><p className="font-medium">{formatRelative(volume.observed_at)}</p></div>
              </div>
              {volume.stale && <Badge variant="outline" className="text-muted-foreground">stale / {formatRelative(volume.observed_at)}</Badge>}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><LineChart className="h-4 w-4" aria-hidden="true" /> Volume history</CardTitle>
          <CardDescription>Available/free/total GiB from `/dashboard/volume-timeseries`</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {volumeSeries.isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : volumeSeries.isError ? (
            <ErrorState message="Volume history endpoint failed." onRetry={volumeSeries.refetch} />
          ) : trend.length === 0 ? (
            <EmptyState title="No volume history" description="The endpoint returned no observations yet." />
          ) : (
            <>
              <div className="h-72" aria-label="Volume history chart in GiB">
                <ResponsiveContainer width="100%" height="100%">
                  <RechartsLineChart data={trend} margin={{ left: 4, right: 20, top: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                    <YAxis tickLine={false} axisLine={false} fontSize={12} unit=" GiB" />
                    <ChartTooltip formatter={(value) => [`${value} GiB`, '']} labelFormatter={(_, payload) => payload?.[0]?.payload?.observed_at ?? ''} />
                    <Line type="monotone" dataKey="available" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} name="Available" />
                    <Line type="monotone" dataKey="free" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} name="Free" />
                    <Line type="monotone" dataKey="total" stroke="hsl(var(--chart-3))" strokeWidth={2} dot={false} name="Total" />
                  </RechartsLineChart>
                </ResponsiveContainer>
              </div>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <caption className="sr-only">Volume history table</caption>
                  <thead><tr className="border-b"><th className="p-2 text-left">Observed</th><th className="p-2 text-right">Available</th><th className="p-2 text-right">Free</th><th className="p-2 text-right">Total</th></tr></thead>
                  <tbody>{(volumeSeries.data?.items ?? []).slice(0, 8).map((v) => <tr key={`${v.name}-${v.observed_at}`} className="border-b last:border-0"><td className="p-2">{formatRelative(v.observed_at)}</td><td className="p-2 text-right tabular-nums">{formatBytes(v.available_bytes)}</td><td className="p-2 text-right tabular-nums">{formatBytes(v.free_bytes)}</td><td className="p-2 text-right tabular-nums">{formatBytes(v.total_bytes)}</td></tr>)}</tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><BarChart3 className="h-4 w-4" aria-hidden="true" /> Catalog state</CardTitle></CardHeader>
          <CardContent>{distributions.isLoading ? <Skeleton className="h-44 w-full" /> : distributions.isError ? <ErrorState message="Status distribution endpoint failed." onRetry={distributions.refetch} /> : <StatusDistributionChart title="Catalog state" rows={distributions.data?.catalog_state ?? []} />}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Local status</CardTitle></CardHeader>
          <CardContent>{distributions.isLoading ? <Skeleton className="h-44 w-full" /> : distributions.isError ? <ErrorState message="Status distribution endpoint failed." onRetry={distributions.refetch} /> : <StatusDistributionChart title="Local status" rows={distributions.data?.local_status ?? []} />}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>R2 status</CardTitle></CardHeader>
          <CardContent>{distributions.isLoading ? <Skeleton className="h-44 w-full" /> : distributions.isError ? <ErrorState message="Status distribution endpoint failed." onRetry={distributions.refetch} /> : <StatusDistributionChart title="R2 status" rows={distributions.data?.r2_status ?? []} />}</CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <LargestCard title="Largest problems" loading={largestProblems.isLoading} error={largestProblems.isError} onRetry={largestProblems.refetch} data={problemBars} />
        <LargestCard title="Largest organizations" loading={largestOrganizations.isLoading} error={largestOrganizations.isError} onRetry={largestOrganizations.refetch} data={orgBars} />
      </div>
    </div>
  );
}

function LargestCard({ title, loading, error, onRetry, data }: { title: string; loading: boolean; error: boolean; onRetry: () => void; data: Array<{ name: string; logical: number; label: string }> }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle><CardDescription>Logical bytes, GiB scale</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {loading ? <Skeleton className="h-64 w-full" /> : error ? <ErrorState message={`${title} endpoint failed.`} onRetry={onRetry} /> : data.length === 0 ? <EmptyState title={`No ${title.toLowerCase()}`} description="The endpoint returned no rows." /> : (
          <>
            <div className="h-64" aria-label={`${title} chart`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" unit=" GiB" fontSize={12} />
                  <YAxis type="category" dataKey="name" width={90} tickLine={false} axisLine={false} fontSize={12} />
                  <ChartTooltip formatter={(value, _, item) => [`${value} GiB (${item.payload.label})`, 'Logical']} />
                  <Bar dataKey="logical" fill="hsl(var(--chart-1))" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-1 text-sm">{data.slice(0, 6).map((row) => <div key={row.name} className="flex justify-between gap-3 rounded-md border px-3 py-2"><span className="truncate font-mono text-xs">{row.name}</span><span className="tabular-nums">{row.label}</span></div>)}</div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
