import { useState } from 'react';
import { useSnapshots } from '@/hooks/queries';
import { PageHeader } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { formatBytes, formatNumber, formatDateTime } from '@/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function SnapshotsPage() {
  const [problemId, setProblemId] = useState('');
  const [appliedFilter, setAppliedFilter] = useState<string | undefined>(undefined);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);

  const { data, isLoading, isError, error, refetch } = useSnapshots(appliedFilter, cursor);

  return (
    <div className="space-y-4">
      <PageHeader title="Snapshots" description="R2 snapshot generations" />
      <Card>
        <CardContent className="p-4">
          <div className="flex gap-2">
            <Input
              placeholder="Filter by problem ID…"
              value={problemId}
              onChange={(e) => setProblemId(e.target.value)}
              aria-label="Filter by problem ID"
            />
            <Button
              onClick={() => { setAppliedFilter(problemId || undefined); setCursor(undefined); setHistory([]); }}
            >
              Apply
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <ErrorState message={(error as Error)?.message ?? 'Failed to load'} onRetry={refetch} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState title="No snapshots" description="No snapshot data available." />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Generation</TableHead>
                  <TableHead>Problem</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Files</TableHead>
                  <TableHead>Total bytes</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="tabular-nums">{s.generation}</TableCell>
                    <TableCell className="font-mono text-xs">{s.problem_id}</TableCell>
                    <TableCell><StatusBadge status={s.state} /></TableCell>
                    <TableCell className="tabular-nums">{formatNumber(s.file_count)}</TableCell>
                    <TableCell className="tabular-nums">{formatBytes(s.total_bytes)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(s.created_at)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(s.completed_at)}</TableCell>
                    <TableCell className="text-xs text-destructive">{s.error_code ?? ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={() => setHistory((h) => { const prev = h[h.length - 1]; setCursor(prev); return h.slice(0, -1); })} disabled={history.length === 0}>
          <ChevronLeft className="h-4 w-4" /> Previous
        </Button>
        <Button variant="outline" size="sm" onClick={() => { if (data?.next_cursor) { setHistory((h) => [...h, cursor]); setCursor(data.next_cursor); } }} disabled={!data?.has_more}>
          Next <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
