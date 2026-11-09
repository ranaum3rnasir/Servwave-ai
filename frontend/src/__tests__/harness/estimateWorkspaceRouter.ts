import { vi } from 'vitest';

/**
 * The routed estimate page's router, for `vi.mock('react-router-dom', ...)` in a test of the estimate workspace page (#3259).
 * Kept apart from the page harness (`estimateWorkspacePage.tsx`) because a `vi.mock` factory cannot import a module that
 * itself imports the mocked module: this one imports only the test tool.
 *
 *   vi.mock('react-router-dom', async () => (await import('./harness/estimateWorkspaceRouter')).estimateWorkspaceRouter(() => ESTIMATE_ID));
 */
/** `id` may be a function, so a router mocked at the top of a file can read the file's own `const ESTIMATE_ID` when the page asks. */
export async function estimateWorkspaceRouter(id: string | (() => string), opts: { navigate?: boolean } = {}) {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: typeof id === 'function' ? id() : id }), ...(opts.navigate ? { useNavigate: () => vi.fn() } : {}) };
}
