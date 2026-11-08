import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { spiderV2Routes } from '../spider.routes';
import { useIsSpiderAllowed } from '@/lib/useIsSpiderAllowed';

vi.mock('@/lib/useIsSpiderAllowed', () => ({
  useIsSpiderAllowed: vi.fn(),
}));

vi.mock('@/pages/v2/V2AppLayout', () => ({
  default: () => {
    const { Outlet } = require('react-router-dom');
    return <Outlet />;
  },
}));

vi.mock('@/pages/v2/spider/SpiderWatcherPage', () => ({
  default: () => <div data-testid="spider-watcher-page">Spider Watcher Page Content</div>,
}));

vi.mock('@/components/ProtectedRoute', () => ({
  default: () => {
    const { Outlet } = require('react-router-dom');
    return <Outlet />;
  },
}));

const queryClient = new QueryClient();

describe('spiderV2Routes & SpiderRouteGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects to / when Spider is not allowed for the company', () => {
    vi.mocked(useIsSpiderAllowed).mockReturnValue(false);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/spider']}>
          <Routes>
            <Route path="/" element={<div data-testid="home-page">Home Page</div>} />
            {spiderV2Routes()}
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Assert that SpiderWatcherPage was NOT mounted and user was redirected to home page
    expect(screen.queryByTestId('spider-watcher-page')).toBeNull();
    expect(screen.getByTestId('home-page')).toBeInTheDocument();
  });

  it('mounts SpiderWatcherPage when Spider is allowed for the company', async () => {
    vi.mocked(useIsSpiderAllowed).mockReturnValue(true);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/spider']}>
          <Routes>
            <Route path="/" element={<div data-testid="home-page">Home Page</div>} />
            {spiderV2Routes()}
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Assert that SpiderWatcherPage mounted successfully
    expect(await screen.findByTestId('spider-watcher-page')).toBeInTheDocument();
  });
});
