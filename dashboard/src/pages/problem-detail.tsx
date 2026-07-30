import { useEffect, useRef, useState } from 'react';
import { useProblem, useProblemUsage, useSnapshots, useProblemActions } from '@/hooks/queries';
import { PageHeader, Breadcrumb } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/toaster';
import { apiErrorMessage, watchJob, type JobWatcher } from '@/lib/api';
import { formatBytes, formatNumber, formatDateTime, formatRelative } from '@/lib/utils';
import { Scan, Camera, RotateCcw, Trash2, Loader2, Wifi } from 'lucide-react';
import type { AcceptedJobResponse, Job } from '@/lib/types';

export function ProblemDetailPage({ externalId }: { externalId: string }) {
  const problem = useProblem(externalId);
  const usage = useProblemUsage(externalId);
  const snapshots = useSnapshots(externalId, undefined);
  const actions = useProblemActions(externalId);
  const { toast } = useToast();
  const [confirmText, setConfirmText] = useState('');
  const [evictOpen, setEvictOpen] = useState(false);
  const [followedJobs, setFollowedJobs] = useState<Record<string, Job>>({});
  const watchers = useRef<JobWatcher[]>([]);

  useEffect(() => () => {
    watchers.current.forEach((watcher) => watcher.abort());
    watchers.current = [];
  }, []);

  const doAction = async (
    label: string,
    fn: () => Promise<AcceptedJobResponse>,
  ) => {
    try {
      const res = await fn();
      toast({
        title: `${label} accepted`,
        description: `Tracking job ${res.job_id}.`,
      });
      const watcher = watchJob(res, {
        onJob: (job) => {
          setFollowedJobs((jobs) => ({ ...jobs, [job.id]: job }));
        },
        onTerminal: (job) => {
          if (job.state === 'completed') {
            toast({ title: `${label} completed`, description: `Job ${job.id}`, variant: 'success' });
          } else if (job.state === 'failed') {
            toast({ title: `${label} failed`, description: job.error_message ?? job.error_code ?? `Job ${job.id} failed`, variant: 'destructive' });
          } else if (job.state === 'cancelled') {
            toast({ title: `${label} cancelled`, description: `Job ${job.id} was cancelled`, variant: 'destructive' });
          }
        },
        onUnauthorized: () => toast({ title: 'Session expired', description: 'Sign in again to continue tracking jobs.', variant: 'destructive' }),
      });
      watchers.current.push(watcher);
    } catch (e) {
      toast({
        title: `${label} failed`,
        description: apiErrorMessage(e),
        variant: 'destructive',
      });
    }
  };

  if (problem.isLoading) return <Skeleton className="h-32 w-full" />;
  if (problem.isError) return <ErrorState message="Failed to load problem" onRetry={problem.refetch} />;
  const p = problem.data!;

  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: 'Problems', href: '#/problems' }, { label: p.code }]} />
      <PageHeader
        title={p.code}
        description={`External ID: ${p.external_id}`}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => doAction('Scan', () => actions.scan.mutateAsync())} disabled={actions.scan.isPending}>
              {actions.scan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scan className="h-4 w-4" />} Scan
            </Button>
            <Button variant="outline" size="sm" onClick={() => doAction('Snapshot', () => actions.snapshot.mutateAsync())} disabled={actions.snapshot.isPending}>
              {actions.snapshot.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} Snapshot
            </Button>
            <Button variant="outline" size="sm" onClick={() => doAction('Restore', () => actions.restore.mutateAsync())} disabled={actions.restore.isPending}>
              {actions.restore.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Restore
            </Button>
            <AlertDialog open={evictOpen} onOpenChange={setEvictOpen}>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" disabled={actions.evict.isPending}>
                  {actions.evict.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Evict
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Evict local files?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will remove local problem files after confirming R2 has a verified READY snapshot.
                    Type <span className="font-mono font-semibold">{p.code}</span> to confirm.
                    Preconditions and bytes freed are enforced by the backend job.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                  aria-label="Type problem code to confirm"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={p.code}
                />
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setConfirmText('')}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={confirmText !== p.code || actions.evict.isPending}
                    onClick={async (e) => {
                      e.preventDefault();
                      await doAction('Evict', () => actions.evict.mutateAsync({ dryRun: false, force: true }));
                      setConfirmText('');
                      setEvictOpen(false);
                    }}
                  >
                    {actions.evict.isPending ? 'Starting...' : 'Evict'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        }
      />

      {Object.values(followedJobs).length > 0 && (
        <div className="rounded-md border p-3 text-sm" aria-live="polite">
          <div className="mb-2 flex items-center gap-2 font-medium">
            <Wifi className="h-4 w-4" aria-hidden="true" />
            Live job progress
          </div>
          <div className="space-y-1">
            {Object.values(followedJobs).map((job) => (
              <div key={job.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs">{job.id}</span>
                <StatusBadge status={job.state} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Problem info</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Code</span><span className="font-mono">{p.code}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Owner</span><span>{p.owner_organization ?? '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Manually managed</span><span>{p.is_manually_managed ? 'Yes' : 'No'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Mirror of</span><span>{p.mirror_of ?? '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Mirror root</span><span>{p.mirror_root ?? '—'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Catalog state</span><StatusBadge status={p.catalog_state} /></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Dirty</span><span>{p.dirty ? 'Yes' : 'No'}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Observed</span><span>{formatRelative(p.observed_at)}</span></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Usage</CardTitle></CardHeader>
          <CardContent>
            {usage.isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : usage.isError ? (
              <ErrorState message="Failed to load usage" onRetry={usage.refetch} />
            ) : (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Logical bytes</span><span className="tabular-nums">{formatBytes(usage.data?.logical_bytes)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Allocated bytes</span><span className="tabular-nums">{formatBytes(usage.data?.allocated_bytes)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Archive bytes</span><span className="tabular-nums">{formatBytes(usage.data?.archive_bytes)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Auxiliary bytes</span><span className="tabular-nums">{formatBytes(usage.data?.auxiliary_bytes)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">File count</span><span className="tabular-nums">{formatNumber(usage.data?.file_count)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Local status</span><StatusBadge status={usage.data?.local_status ?? 'unknown'} /></div>
                <div className="flex justify-between"><span className="text-muted-foreground">R2 status</span><StatusBadge status={usage.data?.r2_status ?? 'unknown'} /></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Snapshot gen</span><span className="tabular-nums">{usage.data?.snapshot_generation ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Referenced</span><span className="tabular-nums">{formatBytes(usage.data?.referenced_bytes)}</span></div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="snapshots">
        <TabsList>
          <TabsTrigger value="snapshots">Snapshots</TabsTrigger>
          <TabsTrigger value="raw">Raw metadata</TabsTrigger>
        </TabsList>
        <TabsContent value="snapshots">
          <Card>
            <CardContent className="p-0">
              {snapshots.isLoading ? (
                <Skeleton className="h-48 w-full" />
              ) : (snapshots.data?.items.length ?? 0) === 0 ? (
                <p className="p-6 text-sm text-muted-foreground">No snapshots yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Generation</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Files</TableHead>
                      <TableHead>Total bytes</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Completed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {snapshots.data?.items.map((s) => (
                      <TableRow key={s.id}>
                    <TableCell className="tabular-nums">{s.generation}</TableCell>
                        <TableCell><StatusBadge status={s.state} /></TableCell>
                        <TableCell className="tabular-nums">{formatNumber(s.file_count)}</TableCell>
                        <TableCell className="tabular-nums">{formatBytes(s.total_bytes)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDateTime(s.created_at)}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDateTime(s.completed_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="raw">
          <Card>
            <CardContent>
              <pre className="overflow-auto text-xs">
                {JSON.stringify({ problem: p, usage: usage.data }, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
