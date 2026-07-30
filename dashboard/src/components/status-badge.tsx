import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatRelative } from '@/lib/utils';

type StatusVariant = 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline';

function variantForStatus(status: string): StatusVariant {
  const s = status.toLowerCase();
  if (['ready', 'ok', 'present', 'completed'].includes(s)) return 'success';
  if (['error', 'failed', 'missing', 'down'].includes(s)) return 'destructive';
  if (['uploading', 'hashing', 'verifying', 'running', 'pending', 'partial'].includes(s))
    return 'warning';
  if (['superseded', 'cancelled', 'none', 'orphan'].includes(s)) return 'secondary';
  return 'outline';
}

export function StatusBadge({
  status,
  label,
  observedAt,
  stale,
  className,
}: {
  status: string;
  label?: string;
  observedAt?: string | null;
  stale?: boolean;
  className?: string;
}) {
  const variant = variantForStatus(status);
  const text = label ?? status;
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Badge variant={variant} aria-label={`Status: ${text}`}>
        {text}
      </Badge>
      {stale && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="text-muted-foreground">
              stale
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            Last observed {observedAt ? formatRelative(observedAt) : 'unknown'}
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}