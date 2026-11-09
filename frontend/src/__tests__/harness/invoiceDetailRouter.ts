import { vi } from 'vitest';

/**
 * The routed invoice page's router, for `vi.mock('react-router-dom', ...)` in a test of the invoice detail page (#3259).
 * Kept apart from the page harness (`invoiceDetailPage.tsx`) because a `vi.mock` factory cannot import a module that itself
 * imports the mocked module: this one imports only the test tool.
 *
 *   vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/invoiceDetailRouter')).invoiceDetailRouter());
 *
 * The id the address names is state of this module, set by `renderInvoiceDetail` (or `setInvoiceRoute` for a page drawn in a
 * route table of the test's own) every time a page is drawn, so a file holding many cases never carries one case's id into
 * the next.
 */
export const invoiceRoute = { id: 'inv-1' };

export function setInvoiceRoute(id: string): void {
  invoiceRoute.id = id;
}

/**
 * The real router but for `useParams` (and, when asked, `useNavigate`).
 * `navigate: true` hands every caller a fresh spy; a function is asked for the spy to hand out (a test that checks where the
 * page went keeps its own); left out, the real hook.
 */
export async function invoiceDetailRouter(opts: { navigate?: true | (() => unknown) } = {}) {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: invoiceRoute.id }),
    ...(opts.navigate === true ? { useNavigate: () => vi.fn() } : opts.navigate ? { useNavigate: opts.navigate } : {}),
  };
}
