import { useState } from 'react';
import { useProblems } from '@/hooks/queries';
import { PageHeader } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState, EmptyState } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { formatRelative } from '@/lib/utils';
import { ArrowUpDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import type { Problem } from '@/lib/types';

export function ProblemsPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [catalogState, setCatalogState] = useState<string>('');
  const [sort, setSort] = useState('code');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<(string | undefined)[]>([]);

  const { data, isLoading, isError, error, refetch } = useProblems({
    search: debouncedSearch || undefined,
    catalog_state: catalogState || undefined,
    sort,
    order,
    cursor,
    limit: 50,
  });

  const onSearch = (v: string) => {
    setSearch(v);
    setCursor(undefined);
    setHistory([]);
    setDebouncedSearch(v);
  };

  const onNext = () => {
    if (data?.next_cursor) {
      setHistory((h) => [...h, cursor]);
      setCursor(data.next_cursor);
    }
  };
  const onPrev = () => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      setCursor(prev);
      return h.slice(0, -1);
    });
  };

  const problems = data?.items ?? [];
  const resetCursor = () => {
    setCursor(undefined);
    setHistory([]);
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Problems" description="Problem catalog and storage status" />

      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input
                placeholder="Search by code or ID…"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
                aria-label="Search problems"
                className="pl-8"
              />
            </div>
            <Select value={catalogState || 'all'} onValueChange={(v) => { setCatalogState(v === 'all' ? '' : v); resetCursor(); }}>
              <SelectTrigger className="w-[160px]" aria-label="Filter by catalog state">
                <SelectValue placeholder="All states" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                <SelectItem value="present">Present</SelectItem>
                <SelectItem value="orphan">Orphan</SelectItem>
                <SelectItem value="missing">Missing</SelectItem>
                <SelectItem value="mirror">Mirror</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => { setSort(v); resetCursor(); }}>
              <SelectTrigger className="w-[160px]" aria-label="Sort by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="code">Code</SelectItem>
                <SelectItem value="external_id">External ID</SelectItem>
                <SelectItem value="observed_at">Observed</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              onClick={() => { setOrder((v) => (v === 'asc' ? 'desc' : 'asc')); resetCursor(); }}
              aria-label={`Sort ${order === 'asc' ? 'descending' : 'ascending'}`}
            >
              <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
              {order.toUpperCase()}
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : isError ? (
        <ErrorState message={(error as Error)?.message ?? 'Failed to load'} onRetry={refetch} />
      ) : problems.length === 0 ? (
        <EmptyState
          title="No problems found"
          description="Try adjusting your search or filters."
        />
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead aria-sort={sort === 'code' ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>Code</TableHead>
                  <TableHead aria-sort={sort === 'external_id' ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>External ID</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Catalog</TableHead>
                  <TableHead>Dirty</TableHead>
                  <TableHead>Manually managed</TableHead>
                  <TableHead aria-sort={sort === 'observed_at' ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>Observed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {problems.map((p: Problem) => (
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
                    <TableCell>{p.owner_organization ?? '—'}</TableCell>
                    <TableCell><StatusBadge status={p.catalog_state} stale={p.stale} observedAt={p.observed_at} /></TableCell>
                    <TableCell>{p.dirty ? <StatusBadge status="dirty" label="Dirty" /> : 'No'}</TableCell>
                    <TableCell>{p.is_manually_managed ? 'Yes' : 'No'}</TableCell>
                    <TableCell className="text-muted-foreground">{formatRelative(p.observed_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={onPrev} disabled={history.length === 0}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
        </Button>
        <span className="text-sm text-muted-foreground">
          {data?.has_more ? 'More available' : 'End of list'}
        </span>
        <Button variant="outline" size="sm" onClick={onNext} disabled={!data?.has_more}>
          Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
