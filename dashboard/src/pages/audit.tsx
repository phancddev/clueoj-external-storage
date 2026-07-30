import { useState } from 'react';
import { useAuditEvents } from '@/hooks/queries';
import { PageHeader } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/states';
import { formatDateTime } from '@/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function AuditPage() {
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState<{ actor?: string; action?: string }>({});
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);

  const { data, isLoading, isError, error, refetch } = useAuditEvents({
    actor: applied.actor,
    action: applied.action,
    cursor,
  });

  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" description="Audit events for all mutations" />
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input placeholder="Actor…" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Filter by actor" />
            <Input placeholder="Action…" value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action" />
            <Button onClick={() => { setApplied({ actor: actor || undefined, action: action || undefined }); setCursor(undefined); setHistory([]); }}>
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
        <EmptyState title="No audit events" description="No events match the current filter." />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Problem</TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Request ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(e.created_at)}</TableCell>
                    <TableCell className="text-sm">{e.actor}</TableCell>
                    <TableCell className="text-sm">{e.actor_role}</TableCell>
                    <TableCell className="font-mono text-xs">{e.action}</TableCell>
                    <TableCell className="text-xs">{e.target_type ? `${e.target_type}:${e.target_id ?? ''}` : '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{e.problem_id ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{e.job_id ?? '—'}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{e.request_id}</TableCell>
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
