import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Providers } from '@/providers';
import { MobileNav, Sidebar } from '@/components/sidebar';
import { useToast } from '@/components/toaster';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { api, apiErrorMessage, onUnauthorized, setToken } from '@/lib/api';

const OverviewPage = lazy(() => import('@/pages/overview').then((module) => ({ default: module.OverviewPage })));
const ProblemsPage = lazy(() => import('@/pages/problems').then((module) => ({ default: module.ProblemsPage })));
const ProblemDetailPage = lazy(() => import('@/pages/problem-detail').then((module) => ({ default: module.ProblemDetailPage })));
const OrganizationsPage = lazy(() => import('@/pages/organizations').then((module) => ({ default: module.OrganizationsPage })));
const OrganizationDetailPage = lazy(() => import('@/pages/organization-detail').then((module) => ({ default: module.OrganizationDetailPage })));
const SnapshotsPage = lazy(() => import('@/pages/snapshots').then((module) => ({ default: module.SnapshotsPage })));
const JobsPage = lazy(() => import('@/pages/jobs').then((module) => ({ default: module.JobsPage })));
const StoragePage = lazy(() => import('@/pages/storage').then((module) => ({ default: module.StoragePage })));
const OrphansPage = lazy(() => import('@/pages/orphans').then((module) => ({ default: module.OrphansPage })));
const DeletedPage = lazy(() => import('@/pages/deleted').then((module) => ({ default: module.DeletedPage })));
const AuditPage = lazy(() => import('@/pages/audit').then((module) => ({ default: module.AuditPage })));
const SettingsPage = lazy(() => import('@/pages/settings').then((module) => ({ default: module.SettingsPage })));

const SESSION_KEY = 'storage_session';
const LEGACY_TOKEN_KEY = 'storage_token';
const LEGACY_EXPIRES_KEY = 'storage_token_expires_at';

function readStoredToken(now = Date.now()) {
  const raw = localStorage.getItem(SESSION_KEY);
  try {
    const session = raw ? JSON.parse(raw) as { token?: unknown; expires_at?: unknown } : null;
    if (
      !session
      || typeof session.token !== 'string'
      || typeof session.expires_at !== 'number'
      || session.expires_at <= now
    ) {
      throw new Error('Missing or expired session');
    }
    setToken(session.token);
    return session.token;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_EXPIRES_KEY);
    setToken(null);
    return null;
  }
}

function clearStoredToken() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_KEY);
  setToken(null);
}

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const handler = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return hash;
}

function matchRoute(hash: string): { page: string; param?: string } {
  const path = normalizeHash(hash);
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { page: 'overview' };
  if (parts[0] === 'problems' && parts.length === 1) return { page: 'problems' };
  if (parts[0] === 'problems' && parts.length === 2) return { page: 'problem-detail', param: parts[1] };
  if (parts[0] === 'organizations' && parts.length === 1) return { page: 'organizations' };
  if (parts[0] === 'organizations' && parts.length === 2) return { page: 'organization-detail', param: parts[1] };
  if (parts[0] === 'snapshots') return { page: 'snapshots' };
  if (parts[0] === 'jobs') return { page: 'jobs' };
  if (parts[0] === 'storage') return { page: 'storage' };
  if (parts[0] === 'orphans') return { page: 'orphans' };
  if (parts[0] === 'deleted') return { page: 'deleted' };
  if (parts[0] === 'audit') return { page: 'audit' };
  if (parts[0] === 'settings') return { page: 'settings' };
  return { page: 'overview' };
}

function normalizeHash(hash: string) {
  const withoutHash = hash.replace(/^#/, '') || '/';
  return withoutHash.startsWith('/') ? withoutHash : `/${withoutHash}`;
}

function pageTitle(page: string) {
  const titles: Record<string, string> = {
    overview: 'Overview',
    problems: 'Problems',
    'problem-detail': 'Problem detail',
    organizations: 'Organizations',
    'organization-detail': 'Organization detail',
    snapshots: 'Snapshots',
    jobs: 'Jobs',
    storage: 'Storage & R2',
    orphans: 'Orphans',
    deleted: 'Deleted problems',
    audit: 'Audit log',
    settings: 'Settings',
  };
  return titles[page] ?? 'Overview';
}

function LoginScreen({ onLogin }: { onLogin: (token: string, expiresIn: number) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.login(username, password);
      if (res.token_type && res.token_type !== 'Bearer') {
        throw new Error('Unsupported token type returned by server');
      }
      onLogin(res.token, res.expires_in);
      toast({ title: 'Signed in', variant: 'success' });
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Storage Console</CardTitle>
          <CardDescription>Sign in with a dashboard administrator account</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              type="text"
              label="Username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              disabled={loading}
              required
            />
            <Input
              type="password"
              label="Password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              aria-describedby={error ? 'login-error' : undefined}
              aria-invalid={Boolean(error)}
              required
            />
            {error && <p id="login-error" className="text-sm text-destructive" role="alert">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Router() {
  const hash = useHashRoute();
  const { page, param } = matchRoute(hash);
  useEffect(() => {
    document.title = `${pageTitle(page)} - Storage Console`;
    document.getElementById('main-content')?.focus();
  }, [page, param]);

  let pageContent: React.ReactNode;
  switch (page) {
    case 'overview':
      pageContent = <OverviewPage />;
      break;
    case 'problems':
      pageContent = <ProblemsPage />;
      break;
    case 'problem-detail':
      pageContent = <ProblemDetailPage externalId={param!} />;
      break;
    case 'organizations':
      pageContent = <OrganizationsPage />;
      break;
    case 'organization-detail':
      pageContent = <OrganizationDetailPage externalId={param!} />;
      break;
    case 'snapshots':
      pageContent = <SnapshotsPage />;
      break;
    case 'jobs':
      pageContent = <JobsPage />;
      break;
    case 'storage':
      pageContent = <StoragePage />;
      break;
    case 'deleted':
      pageContent = <DeletedPage />;
      break;
    case 'orphans':
      pageContent = <OrphansPage />;
      break;
    case 'audit':
      pageContent = <AuditPage />;
      break;
    case 'settings':
      pageContent = <SettingsPage />;
      break;
    default:
      pageContent = <OverviewPage />;
  }
  return (
    <Suspense fallback={<div className="py-12 text-center text-sm text-muted-foreground" role="status">Loading page…</div>}>
      {pageContent}
    </Suspense>
  );
}

export function App() {
  const [authed, setAuthed] = useState(() => !!readStoredToken());
  const logout = useMemo(() => () => {
    clearStoredToken();
    setAuthed(false);
  }, []);

  useEffect(() => {
    onUnauthorized(logout);
    const syncSession = () => {
      const t = readStoredToken();
      setAuthed(!!t);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === SESSION_KEY) syncSession();
    };
    window.addEventListener('storage', handleStorage);
    window.addEventListener('storage-session-logout', logout);
    const interval = window.setInterval(syncSession, 30_000);
    return () => {
      onUnauthorized(null);
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('storage-session-logout', logout);
      window.clearInterval(interval);
    };
  }, [logout]);

  const handleLogin = (t: string, expiresIn: number) => {
    const expiresAt = Date.now() + Math.max(0, expiresIn - 30) * 1000;
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: t, expires_at: expiresAt }));
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_EXPIRES_KEY);
    setToken(t);
    setAuthed(true);
  };

  if (!authed) {
    return (
      <Providers>
        <LoginScreen onLogin={handleLogin} />
      </Providers>
    );
  }

  return (
    <Providers>
      <div className="flex min-h-dvh bg-background">
        <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[200] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring">
          Skip to content
        </a>
        <Sidebar className="hidden md:flex" />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileNav onLogout={logout} />
          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none sm:p-6">
            <Router />
          </main>
        </div>
      </div>
    </Providers>
  );
}
