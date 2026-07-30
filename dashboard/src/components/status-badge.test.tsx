import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../components/status-badge';
import { TooltipProvider } from '../components/ui/tooltip';

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('StatusBadge', () => {
  it('renders ready status as success', () => {
    renderWithProviders(<StatusBadge status="ready" />);
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('renders error status as destructive', () => {
    renderWithProviders(<StatusBadge status="error" />);
    expect(screen.getByText('error')).toBeInTheDocument();
  });

  it('renders uploading status as warning', () => {
    renderWithProviders(<StatusBadge status="uploading" />);
    expect(screen.getByText('uploading')).toBeInTheDocument();
  });

  it('uses custom label when provided', () => {
    renderWithProviders(<StatusBadge status="ready" label="Ready" />);
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('renders stale badge when stale', () => {
    renderWithProviders(<StatusBadge status="ready" stale observedAt="2024-01-01T00:00:00Z" />);
    expect(screen.getByText('stale')).toBeInTheDocument();
  });

  it('does not render stale badge when not stale', () => {
    renderWithProviders(<StatusBadge status="ready" />);
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
  });

  it('has aria-label for accessibility', () => {
    renderWithProviders(<StatusBadge status="ready" label="Ready" />);
    expect(screen.getByLabelText('Status: Ready')).toBeInTheDocument();
  });
});