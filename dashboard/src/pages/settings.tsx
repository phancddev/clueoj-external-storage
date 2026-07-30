import { PageHeader } from '@/components/layout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toaster';
import { LogOut } from 'lucide-react';

export function SettingsPage() {
  const { toast } = useToast();
  const onLogout = () => {
    localStorage.removeItem('storage_token');
    localStorage.removeItem('storage_token_expires_at');
    toast({ title: 'Signed out', variant: 'success' });
    window.dispatchEvent(new Event('storage-session-logout'));
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Console settings" />
      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>Manage your console session</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={onLogout}>
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>ClueOJ External Storage Console</p>
          <p>React + TypeScript + shadcn/ui</p>
        </CardContent>
      </Card>
    </div>
  );
}
