import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('App shell and login', () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = '#/';
    vi.restoreAllMocks();
  });

  it('logs in without reloading and stores token expiry', async () => {
    const reload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...window.location, hash: '#/', reload },
      writable: true,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ token: 'jwt', expires_in: 3600, role: 'storage-admin' })));

    render(<App />);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(localStorage.getItem('storage_session')).not.toBeNull());
    const stored = JSON.parse(localStorage.getItem('storage_session')!);
    expect(stored.token).toBe('jwt');
    expect(stored.expires_at).toBeGreaterThan(Date.now());
    expect(localStorage.getItem('storage_token')).toBeNull();
    expect(localStorage.getItem('storage_token_expires_at')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('drops an expired stored token before rendering the dashboard', () => {
    localStorage.setItem('storage_session', JSON.stringify({
      token: 'old',
      expires_at: Date.now() - 1000,
    }));

    render(<App />);

    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(localStorage.getItem('storage_session')).toBeNull();
  });
});
