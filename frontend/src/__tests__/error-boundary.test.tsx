import { lazy, Suspense } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const reloadPage = vi.fn();
vi.mock('@/lib/platform/reloadPage', () => ({ reloadPage: () => reloadPage() }));

function Boom(): JSX.Element { throw new Error('boom'); }

/**
 * What a deploy does to an open tab: the route's lazy chunk is gone from the server, so the
 * dynamic import rejects. A fresh lazy() per render, because React caches a rejected lazy.
 */
function staleChunkPage() {
  return lazy(() =>
    Promise.reject(
      new TypeError('Failed to fetch dynamically imported module: https://app.example/assets/JobsPage-old.js'),
    ),
  );
}

function renderStalePage() {
  const StalePage = staleChunkPage();
  return render(
    <ErrorBoundary>
      <Suspense fallback={<div>Loading...</div>}>
        <StalePage />
      </Suspense>
    </ErrorBoundary>,
  );
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    reloadPage.mockReset();
    window.sessionStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders fallback instead of crashing the tree', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument();
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('renders children when no error', () => {
    render(<ErrorBoundary><div>safe</div></ErrorBoundary>);
    expect(screen.getByText('safe')).toBeInTheDocument();
    expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
  });

  describe('a lazy chunk that fails to load after a deploy', () => {
    it('reloads the page once instead of showing the generic error screen', async () => {
      renderStalePage();
      await screen.findByTestId('chunk-reload-pending');
      expect(reloadPage).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
    });

    it('when the reload does not help, shows a Reload error state and does not reload again', async () => {
      // Page load 1: the chunk fails, the boundary reloads.
      const first = renderStalePage();
      await screen.findByTestId('chunk-reload-pending');
      first.unmount();

      // Page load 2 (same tab, so same sessionStorage): the chunk fails again.
      renderStalePage();
      const prompt = await screen.findByTestId('chunk-reload-prompt');
      expect(reloadPage).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
      expect(screen.queryByText('Something went wrong')).toBeNull();

      // The Reload button is the user's own retry.
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reloadPage).toHaveBeenCalledTimes(2);

      // The copy names no third-party vendor.
      expect(prompt.textContent ?? '').not.toMatch(
        /\b(vercel|render|supabase|vite|webpack|sentry|cloudflare|ctm|calltrackingmetrics|twilio|resend|stripe)\b/i,
      );
    });

    it('never loops: a chunk that keeps failing reloads exactly once', async () => {
      for (let pageLoad = 0; pageLoad < 5; pageLoad += 1) {
        const view = renderStalePage();
        await screen.findByTestId(pageLoad === 0 ? 'chunk-reload-pending' : 'chunk-reload-prompt');
        view.unmount();
      }
      expect(reloadPage).toHaveBeenCalledTimes(1);
    });
  });
});
