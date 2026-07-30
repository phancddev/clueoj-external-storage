import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AlertTriangle,
  Archive,
  Boxes,
  Database,
  FileText,
  HardDrive,
  History,
  Layers,
  LogOut,
  Menu,
  Settings,
  Users,
} from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  description?: string;
}

export const navItems: NavItem[] = [
  { label: 'Overview', to: '#/', icon: Activity, description: 'System health and summary' },
  { label: 'Problems', to: '#/problems', icon: FileText, description: 'Problem catalog' },
  { label: 'Organizations', to: '#/organizations', icon: Users, description: 'Organization usage' },
  { label: 'Snapshots', to: '#/snapshots', icon: Layers, description: 'R2 snapshots' },
  { label: 'Jobs', to: '#/jobs', icon: Boxes, description: 'Background jobs' },
  { label: 'Storage & R2', to: '#/storage', icon: HardDrive, description: 'Volumes and R2 status' },
  { label: 'Orphans', to: '#/orphans', icon: AlertTriangle, description: 'Unassigned folders' },
  { label: 'Audit log', to: '#/audit', icon: History, description: 'Audit events' },
  { label: 'Settings', to: '#/settings', icon: Settings, description: 'Settings' },
];

function currentPath(hash = window.location.hash || '#/') {
  return hash.replace(/^#/, '') || '/';
}

function isActive(to: string, path: string) {
  const target = to.replace(/^#/, '');
  if (target === '/') return path === '/';
  return path === target || path.startsWith(`${target}/`);
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const [path, setPath] = useState(() => currentPath());
  useEffect(() => {
    const handler = () => setPath(currentPath());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return (
    <ul className="flex-1 space-y-1 p-2">
      {navItems.map((item) => {
        const active = isActive(item.to, path);
        return (
          <li key={item.to}>
            <a
              href={item.to}
              aria-current={active ? 'page' : undefined}
              onClick={onNavigate}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                active && 'bg-accent text-accent-foreground',
              )}
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              <span>{item.label}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function Sidebar({ className }: { className?: string }) {
  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        'flex h-full w-60 flex-col border-r bg-card',
        className,
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Archive className="h-5 w-5 text-primary" aria-hidden="true" />
        <span className="font-semibold">Storage Console</span>
      </div>
      <NavLinks />
      <div className="border-t p-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5" aria-hidden="true" />
          PostgreSQL · R2
        </span>
      </div>
    </nav>
  );
}

export function MobileNav({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b bg-background/95 px-4 md:hidden">
      <div className="flex items-center gap-2">
        <Archive className="h-5 w-5 text-primary" aria-hidden="true" />
        <span className="font-semibold">Storage Console</span>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="icon" aria-label="Open navigation">
            <Menu className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DialogTrigger>
        <DialogContent className="left-0 top-0 h-dvh max-w-80 translate-x-0 translate-y-0 content-start gap-0 p-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:rounded-none">
          <div className="flex h-14 items-center gap-2 border-b px-4">
            <Archive className="h-5 w-5 text-primary" aria-hidden="true" />
            <DialogTitle className="text-base">Storage Console</DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Primary dashboard navigation
          </DialogDescription>
          <NavLinks onNavigate={() => setOpen(false)} />
          <div className="border-t p-3">
            <Button variant="ghost" className="min-h-11 w-full justify-start text-destructive" onClick={() => { setOpen(false); onLogout(); }}>
              <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </header>
  );
}
