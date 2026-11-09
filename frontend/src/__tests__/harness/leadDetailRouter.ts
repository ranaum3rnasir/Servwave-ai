import { vi } from 'vitest';

/**
 * The routed lead page's router, for `vi.mock('react-router-dom', ...)` in a test of the lead detail page (#3259).
 * Kept apart from the page harness (`leadDetailPage.tsx`) because a `vi.mock` factory cannot import a module that itself
 * imports the mocked module: this one imports only the test tool.
 *
 *   vi.mock('react-router-dom', async () => (await import('./harness/leadDetailRouter')).leadDetailRouter());
 */
export const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';

/** `useParams` answers the lead's id; `navigate: true` also swaps `useNavigate` for a mock that goes nowhere. */
export async function leadDetailRouter(opts: { id?: string; navigate?: boolean } = {}) {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: opts.id ?? LEAD_ID }),
    ...(opts.navigate ? { useNavigate: () => vi.fn() } : {}),
  };
}
