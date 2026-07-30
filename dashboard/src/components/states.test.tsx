import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorState, EmptyState, LoadingState } from '../components/states';

describe('ErrorState', () => {
  it('renders error message', () => {
    render(<ErrorState message="Connection failed" />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });

  it('renders custom title', () => {
    render(<ErrorState title="Custom Error" message="oops" />);
    expect(screen.getByText('Custom Error')).toBeInTheDocument();
  });

  it('renders retry button when onRetry provided', () => {
    render(<ErrorState message="err" onRetry={() => {}} />);
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('does not render retry button when no onRetry', () => {
    render(<ErrorState message="err" />);
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
  });

  it('has alert role for accessibility', () => {
    render(<ErrorState message="err" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('renders title and description', () => {
    render(<EmptyState title="No problems" description="Click scan to discover" />);
    expect(screen.getByText('No problems')).toBeInTheDocument();
    expect(screen.getByText('Click scan to discover')).toBeInTheDocument();
  });

  it('renders action when provided', () => {
    render(<EmptyState title="Empty" action={<button>Scan</button>} />);
    expect(screen.getByText('Scan')).toBeInTheDocument();
  });
});

describe('LoadingState', () => {
  it('renders default 5 skeleton rows', () => {
    const { container } = render(<LoadingState />);
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons).toHaveLength(5);
  });

  it('renders custom number of rows', () => {
    const { container } = render(<LoadingState rows={3} />);
    const skeletons = container.querySelectorAll('.animate-pulse');
    expect(skeletons).toHaveLength(3);
  });

  it('has aria-busy attribute', () => {
    const { container } = render(<LoadingState />);
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it('has aria-live polite', () => {
    const { container } = render(<LoadingState />);
    expect(container.querySelector('[aria-live="polite"]')).toBeInTheDocument();
  });
});