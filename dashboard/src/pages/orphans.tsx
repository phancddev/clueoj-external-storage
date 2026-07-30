import { useOrphans } from '@/hooks/queries';
import { useState } from 'react';
import { PageHeader } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { formatBytes, formatNumber, formatRelative } from '@/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function OrphansPage() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const { data, isLoading, isError, error, refetch } = useOrphans(cursor);
  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <PageHeader title="Orphans" description="Folders not associated with any problem" />
      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : isError ? (
        <ErrorState message={(error as Error)?.message ?? 'Failed to load'} onRetry={refetch} />
      ) : items.length === 0 ? (
        <EmptyState title="No orphans" description="All folders are associated with a problem." />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Catalog link</TableHead>
                  <TableHead>Logical</TableHead>
                  <TableHead>Allocated</TableHead>
                  <TableHead>Files</TableHead>
                  <TableHead>Observed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((o) => (
                  <TableRow key={o.code}>
                    <TableCell className="font-mono text-sm">{o.code}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">-</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(o.logical_bytes)}</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(o.allocated_bytes)}</TableCell>
                    <TableCell className="tabular-nums">{formatNumber(o.file_count)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(o.observed_at)}</TableCell>
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
