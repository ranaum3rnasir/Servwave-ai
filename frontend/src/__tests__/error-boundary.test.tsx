import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary';

function Boom(): JSX.Element { throw new Error('boom'); }

describe('ErrorBoundary', () => {
  it('renders fallback instead of crashing the tree', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
  });
  it('renders children when no error', () => {
    render(<ErrorBoundary><div>safe</div></ErrorBoundary>);
    expect(screen.getByText('safe')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
  });
});
