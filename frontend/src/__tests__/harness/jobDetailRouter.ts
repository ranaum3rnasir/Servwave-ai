import { vi } from 'vitest';

/**
 * The routed job page's router, for `vi.mock('react-router-dom', ...)` in a test of the job detail page (#3259).
 * Kept apart from the page harness (`jobDetailPage.tsx`) because a `vi.mock` factory cannot import a module that itself
 * imports the mocked module: this one imports only the test tool.
 *
 *   vi.mock('react-router-dom', async () => (await import('./harness/jobDetailRouter')).jobDetailRouter());
 */
export const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

export async function jobDetailRouter(jobId: string = JOB_ID) {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: jobId }), useNavigate: () => vi.fn() };
}
