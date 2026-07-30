import { useOrganizations } from '@/hooks/queries';
import { useState } from 'react';
import { PageHeader } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { formatBytes, formatNumber, formatRelative } from '@/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function OrganizationsPage() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const { data, isLoading, isError, error, refetch } = useOrganizations(cursor);

  return (
    <div className="space-y-4">
      <PageHeader title="Organizations" description="Storage usage by organization" />
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <ErrorState message={(error as Error)?.message ?? 'Failed to load'} onRetry={refetch} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState title="No organizations" description="No organization usage data available." />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Problems</TableHead>
                  <TableHead>Logical</TableHead>
                  <TableHead>Allocated</TableHead>
                  <TableHead>Archive</TableHead>
                  <TableHead>Auxiliary</TableHead>
                  <TableHead>Referenced</TableHead>
                  <TableHead>Observed</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((o) => (
                  <TableRow key={o.organization_id}>
                    <TableCell className="font-medium">
                      <a
                        href={`#/organizations/${encodeURIComponent(o.organization_id)}`}
                        className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {o.organization_id}
                      </a>
                    </TableCell>
                    <TableCell className="tabular-nums">{formatNumber(o.problem_count)}</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(o.logical_bytes)}</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(o.allocated_bytes)}</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(o.archive_bytes)}</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(o.auxiliary_bytes)}</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(o.referenced_bytes)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(o.observed_at)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" asChild aria-label={`Open ${o.organization_id}`}>
                        <a href={`#/organizations/${encodeURIComponent(o.organization_id)}`}>
                        <ChevronRight className="h-4 w-4" />
                        </a>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={() => setHistory((h) => { const prev = h[h.length - 1]; setCursor(prev); return h.slice(0, -1); })} disabled={history.length === 0}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
        </Button>
        <span className="text-sm text-muted-foreground">{data?.has_more ? 'More available' : 'End of list'}</span>
        <Button variant="outline" size="sm" onClick={() => { if (data?.next_cursor) { setHistory((h) => [...h, cursor]); setCursor(data.next_cursor); } }} disabled={!data?.has_more}>
          Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
