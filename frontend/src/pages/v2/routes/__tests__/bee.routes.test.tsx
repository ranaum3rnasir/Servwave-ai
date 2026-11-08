import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beeV2Routes } from '../bee.routes';
import { useIsBeeAllowed } from '@/lib/useIsBeeAllowed';

vi.mock('@/lib/useIsBeeAllowed', () => ({
  useIsBeeAllowed: vi.fn(),
}));

vi.mock('@/pages/v2/V2AppLayout', () => ({
  default: () => {
    const { Outlet } = require('react-router-dom');
    return <Outlet />;
  },
}));

vi.mock('@/pages/v2/bee/BeeAgentView', () => ({
  default: () => <div data-testid="bee-agent-view">Bee Agent View Content</div>,
}));

vi.mock('@/components/ProtectedRoute', () => ({
  default: () => {
    const { Outlet } = require('react-router-dom');
    return <Outlet />;
  },
}));

const queryClient = new QueryClient();

describe('beeV2Routes & BeeRouteGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to / when Bee is not allowed for the company', () => {
    vi.mocked(useIsBeeAllowed).mockReturnValue(false);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/bee']}>
          <Routes>
            <Route path="/" element={<div data-testid="home-page">Home Page</div>} />
            {beeV2Routes()}
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.queryByTestId('bee-agent-view')).toBeNull();
    expect(screen.getByTestId('home-page')).toBeInTheDocument();
  });

  it('mounts BeeAgentView when Bee is allowed for the company', async () => {
    vi.mocked(useIsBeeAllowed).mockReturnValue(true);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/bee']}>
          <Routes>
            <Route path="/" element={<div data-testid="home-page">Home Page</div>} />
            {beeV2Routes()}
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(await screen.findByTestId('bee-agent-view')).toBeInTheDocument();
  });
});

