import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProblemsPage } from './problems';
import { StoragePage } from './storage';
import { JobsPage } from './jobs';
import { Toaster } from '@/components/toaster';

vi.mock('@/hooks/queries', () => ({
  useProblems: vi.fn(() => ({
    data: {
      items: [{
        external_id: '42',
        code: 'sum',
        owner_organization: 'org-a',
        is_manually_managed: false,
        mirror_of: null,
        mirror_root: null,
        catalog_state: 'present',
        dirty: false,
        observed_at: '2026-01-01T00:00:00Z',
        stale: false,
      }],
      next_cursor: 'next',
      has_more: true,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  })),
  useVolumes: vi.fn(() => ({ data: { items: [], next_cursor: null, has_more: false }, isLoading: false, isError: false, refetch: vi.fn() })),
  useJobs: vi.fn(() => ({
    data: {
      items: [{
        id: 'job-1',
        idempotency_key: 'k',
        job_type: 'snapshot',
        problem_id: '42',
        target_generation: null,
        state: 'failed',
        lease_owner: null,
        lease_expires_at: null,
        fencing_token: 1,
        attempt: 1,
        max_attempts: 3,
        result: null,
        error_code: 'boom',
        error_message: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      }],
      next_cursor: null,
      has_more: false,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  })),
  useRetryJob: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
  useCancelJob: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

describe('dashboard page semantics', () => {
  it('renders problem rows as hash links and sortable headers', () => {
    render(<ProblemsPage />);

    expect(screen.getByRole('link', { name: 'sum' })).toHaveAttribute('href', '#/problems/42');
    expect(screen.getByRole('columnheader', { name: 'Code' })).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(screen.getByRole('button', { name: /sort descending/i }));
    expect(screen.getByRole('button', { name: /sort ascending/i })).toBeInTheDocument();
  });

  it('does not expose unsafe reconcile without a catalog payload', () => {
    render(<StoragePage />);

    expect(screen.getByRole('button', { name: /reconcile catalog/i })).toBeDisabled();
    expect(screen.getByText(/requires a full ClueOJ problem list payload/i)).toBeInTheDocument();
  });

  it('confirms retry job actions before mutation', () => {
    render(<Toaster><JobsPage /></Toaster>);

    fireEvent.click(screen.getByRole('button', { name: /retry job/i }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText(/Retry snapshot job job-1/i)).toBeInTheDocument();
  });
});
