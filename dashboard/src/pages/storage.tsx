import { useVolumes } from '@/hooks/queries';
import { PageHeader } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { bytePercent, formatBytes, formatRelative, subtractBytes } from '@/lib/utils';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export function StoragePage() {
  const volumes = useVolumes();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Storage & R2"
        description="Volume and R2 status"
        actions={
          <Button disabled title="Backend requires a full ClueOJ problem list payload">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Reconcile catalog
          </Button>
        }
      />

      <div className="flex items-start gap-2 rounded-md border border-warning/50 p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-4 w-4 text-warning" aria-hidden="true" />
        <p className="text-muted-foreground">
          Catalog reconcile is disabled in the dashboard because the backend contract requires a full ClueOJ problem list payload.
        </p>
      </div>

      {volumes.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : volumes.isError ? (
        <ErrorState message="Failed to load volumes" onRetry={volumes.refetch} />
      ) : volumes.data && volumes.data.items.length > 0 ? (
        volumes.data.items.map((v) => {
          const usedBytes = subtractBytes(v.total_bytes, v.available_bytes);
          const usedPct = bytePercent(usedBytes, v.total_bytes);
          return (
            <Card key={v.mount_path}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {v.name}
                  {v.stale && <Badge variant="outline" className="text-muted-foreground">stale</Badge>}
                </CardTitle>
                <CardDescription className="font-mono text-xs">{v.mount_path}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="mb-1 flex justify-between text-sm">
                    <span className="text-muted-foreground">Used</span>
                    <span className="tabular-nums">
                      {formatBytes(usedBytes)} / {formatBytes(v.total_bytes)} ({usedPct == null ? '-' : `${usedPct}%`})
                    </span>
                  </div>
                  <Progress
                    value={usedPct ?? 0}
                    indicatorClassName={(usedPct ?? 0) > 90 ? 'bg-destructive' : (usedPct ?? 0) > 80 ? 'bg-warning' : 'bg-primary'}
                    aria-label={`Disk usage ${usedPct ?? 0} percent`}
                  />
                </div>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Total</p>
                    <p className="tabular-nums font-medium">{formatBytes(v.total_bytes)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Free</p>
                    <p className="tabular-nums font-medium">{formatBytes(v.free_bytes)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Available</p>
                    <p className="tabular-nums font-medium">{formatBytes(v.available_bytes)}</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Observed {formatRelative(v.observed_at)}</p>
              </CardContent>
            </Card>
          );
        })
      ) : (
        <p className="text-sm text-muted-foreground">No volume data.</p>
      )}
    </div>
  );
}
