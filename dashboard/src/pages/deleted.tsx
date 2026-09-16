import { useProblems } from '@/hooks/queries';
import { useState } from 'react';
import { PageHeader } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { formatRelative } from '@/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export function DeletedPage() {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);
  const { data, isLoading, isError, error, refetch } = useProblems({
    catalog_state: 'deleted',
    sort: 'observed_at',
    order: 'desc',
    cursor,
    limit: 100,
  });
  const items = data?.items ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Deleted problems"
        description="Deleted from ClueOJ; R2 snapshots remain until retention collects them"
      />
      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : isError ? (
        <ErrorState message={(error as Error)?.message ?? 'Failed to load'} onRetry={refetch} />
      ) : items.length === 0 ? (
        <EmptyState title="No deleted problems" description="Nothing has been deleted yet." />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>External ID</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Organization</TableHead>
                  <TableHead>Deleted at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((p) => (
                  <TableRow key={p.external_id}>
                    <TableCell className="font-mono text-sm">{p.external_id}</TableCell>
                    <TableCell className="font-mono text-sm">{p.code}</TableCell>
                    <TableCell className="text-muted-foreground">{p.owner_organization ?? '-'}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(p.observed_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={history.length === 0 || isLoading}
          onClick={() => {
            const prev = history[history.length - 1];
            setHistory((h) => h.slice(0, -1));
            setCursor(prev);
          }}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!data?.has_more || isLoading}
          onClick={() => {
            setHistory((h) => [...h, cursor]);
            setCursor(data?.next_cursor ?? undefined);
          }}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
