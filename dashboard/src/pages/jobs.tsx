import { useState } from 'react';
import { useJobs, useRetryJob, useCancelJob } from '@/hooks/queries';
import { PageHeader } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toaster';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { apiErrorMessage } from '@/lib/api';
import { formatRelative } from '@/lib/utils';
import { ChevronLeft, ChevronRight, RotateCcw, X } from 'lucide-react';

export function JobsPage() {
  const [state, setState] = useState<string>('');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const { data, isLoading, isError, error, refetch } = useJobs({ state: state || undefined, cursor });
  const retryM = useRetryJob();
  const cancelM = useCancelJob();
  const { toast } = useToast();

  const onRetry = async (id: string) => {
    try {
      await retryM.mutateAsync(id);
      toast({ title: 'Job retried', variant: 'success' });
    } catch (e) {
      toast({ title: 'Retry failed', description: apiErrorMessage(e), variant: 'destructive' });
    }
  };
  const onCancel = async (id: string) => {
    try {
      await cancelM.mutateAsync(id);
      toast({ title: 'Job cancelled', variant: 'success' });
    } catch (e) {
      toast({ title: 'Cancel failed', description: apiErrorMessage(e), variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Jobs" description="Background jobs and operations" />
      <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground" aria-live="polite">
        Job progress uses 10s polling fallback. The backend contract does not expose an SSE endpoint yet.
      </div>
      <Card>
        <CardContent className="p-4">
          <Select value={state || 'all'} onValueChange={(v) => { setState(v === 'all' ? '' : v); setCursor(undefined); setHistory([]); }}>
            <SelectTrigger className="w-[160px]" aria-label="Filter by state">
              <SelectValue placeholder="All states" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All states</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="running">Running</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <ErrorState message={(error as Error)?.message ?? 'Failed to load'} onRetry={refetch} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState title="No jobs" description="No jobs match the current filter." />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Problem</TableHead>
                  <TableHead>Attempt</TableHead>
                  <TableHead>Fencing</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell className="font-mono text-xs">{j.job_type}</TableCell>
                    <TableCell><StatusBadge status={j.state} /></TableCell>
                    <TableCell className="font-mono text-xs">{j.problem_id ?? '—'}</TableCell>
                    <TableCell className="tabular-nums">{j.attempt}/{j.max_attempts}</TableCell>
                    <TableCell className="tabular-nums">{j.fencing_token}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(j.created_at)}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(j.updated_at)}</TableCell>
                    <TableCell className="text-xs text-destructive">{j.error_code ?? ''}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <JobConfirmAction
                          title="Retry job?"
                          description={`Retry ${j.job_type} job ${j.id}. A new audit event will record the request.`}
                          disabled={j.state !== 'failed' && j.state !== 'cancelled'}
                          label="Retry job"
                          onConfirm={() => onRetry(j.id)}
                        >
                          <RotateCcw className="h-4 w-4" />
                        </JobConfirmAction>
                        <JobConfirmAction
                          title="Cancel job?"
                          description={`Cancel ${j.job_type} job ${j.id}. Running jobs may finish if the worker has already passed the cancellation point.`}
                          disabled={j.state !== 'pending' && j.state !== 'running'}
                          label="Cancel job"
                          onConfirm={() => onCancel(j.id)}
                          destructive
                        >
                          <X className="h-4 w-4" />
                        </JobConfirmAction>
                      </div>
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

function JobConfirmAction({
  title,
  description,
  disabled,
  label,
  onConfirm,
  destructive,
  children,
}: {
  title: string;
  description: string;
  disabled: boolean;
  label: string;
  onConfirm: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} disabled={disabled}>
          {children}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className={destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined} onClick={onConfirm}>
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
