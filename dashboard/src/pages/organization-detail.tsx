import { useOrganizationUsage, useProblems } from '@/hooks/queries';
import { PageHeader, Breadcrumb } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { formatBytes, formatNumber, formatRelative } from '@/lib/utils';

export function OrganizationDetailPage({ externalId }: { externalId: string }) {
  const usage = useOrganizationUsage(externalId);
  const problems = useProblems({ owner_organization: externalId, limit: 100 });

  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: 'Organizations', href: '#/organizations' }, { label: externalId }]} />
      <PageHeader title={externalId} description={`Organization ID: ${externalId}`} />

      {usage.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : usage.isError ? (
        <ErrorState message="Failed to load" onRetry={usage.refetch} />
      ) : usage.data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader><CardTitle className="text-sm font-medium">Problems</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-semibold tabular-nums">{formatNumber(usage.data.problem_count)}</p></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm font-medium">Logical bytes</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-semibold tabular-nums">{formatBytes(usage.data.logical_bytes)}</p></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm font-medium">Allocated bytes</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-semibold tabular-nums">{formatBytes(usage.data.allocated_bytes)}</p></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm font-medium">Referenced</CardTitle></CardHeader>
            <CardContent><p className="text-2xl font-semibold tabular-nums">{formatBytes(usage.data.referenced_bytes)}</p></CardContent>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Problems in this organization</CardTitle>
          {usage.data?.stale && <Badge variant="outline" className="w-fit text-muted-foreground">stale · {formatRelative(usage.data.observed_at)}</Badge>}
        </CardHeader>
        <CardContent className="p-0">
          {problems.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (problems.data?.items.length ?? 0) === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No problems in this organization.</p>
          ) : (
            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>External ID</TableHead>
                  <TableHead>Catalog</TableHead>
                  <TableHead>Observed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {problems.data?.items.map((p) => (
                  <TableRow key={p.external_id}>
                    <TableCell className="font-mono text-sm">
                      <a
                        href={`#/problems/${encodeURIComponent(p.external_id)}`}
                        className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {p.code}
                      </a>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{p.external_id}</TableCell>
                    <TableCell>{p.catalog_state}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(p.observed_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
