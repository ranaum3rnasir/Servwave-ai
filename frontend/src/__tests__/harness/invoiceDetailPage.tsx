/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
/**
 * The one harness for the routed invoice detail page (`src/pages/v2/invoices/InvoiceDetailPage.tsx`) (#3259).
 *
 * Every test that mounts that page does it through `mountInvoiceDetail` / `renderInvoiceDetail`; none of them keeps a fake
 * server of its own. The fake server answers the invoice and the reads the page makes beside it (the organization settings,
 * the state tax rates) from defaults; a test states only what differs: the invoice's fields or a route of its own.
 *
 * A test file still declares the mocks that are its own, because `vi.mock` is hoisted per file:
 *
 *   vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/invoiceDetailRouter')).invoiceDetailRouter({ navigate: true }));
 *   vi.mock('@/components/crm/IconRail', () => ({ IconRail: ({ children }) => children }));
 */
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import type { MemoryRouterProps } from 'react-router-dom';
import api from '@/lib/axios';
import type { AppAbility } from '@/lib/ability';
import InvoiceDetailPage from '@/pages/v2/invoices/InvoiceDetailPage';
import { renderWithProviders } from '../helpers';
import { setInvoiceRoute } from './invoiceDetailRouter';

export { setInvoiceRoute } from './invoiceDetailRouter';

/** A route of the fake server: the first one whose `match` fits the URL answers with `data`. */
export interface FakeRoute {
  match: (url: string) => boolean;
  /** The answer, or a function of the request's config asked on every read; it may throw to refuse or return a promise. */
  data: unknown | ((config?: { params?: Record<string, unknown> }) => unknown);
}

export interface InvoiceServer {
  /** The invoice as `GET /api/invoices/:id` answers it. A function is asked on every read (a refetch after a write can differ). */
  invoice: unknown | (() => unknown);
  /** What `GET /api/organization` answers. Default `{}`. */
  organization?: unknown;
  /** What `GET /api/state-tax-rates` answers. Default `[]`. */
  stateTaxRates?: unknown;
  /** Routes asked before the invoice's own, for a read this test needs to answer (a switch answer, a refusal, ...). */
  routes?: FakeRoute[];
  /** What a read nothing above knows answers. Default `{}`. */
  otherwise?: unknown;
  /** A server for the reads that are not the invoice page's own, when the test mounts another page beside it. Asked last. */
  rest?: (url: string, config?: { params?: Record<string, unknown> }) => unknown;
}

const answer = (data: unknown) => ({ data }) as never;

/** Install the fake server on the mocked client. */
export function serveInvoiceDetail(server: InvoiceServer): void {
  vi.mocked(api).get.mockImplementation((async (url: string, config?: { params?: Record<string, unknown> }) => {
    for (const r of server.routes ?? []) {
      if (!r.match(url)) continue;
      const out = typeof r.data === 'function' ? (r.data as (c?: unknown) => unknown)(config) : r.data;
      // A function may hand back a promise (one that never settles holds the read in flight).
      return out instanceof Promise ? out.then(answer) : answer(out);
    }
    if (url.includes('/api/invoices/')) return answer({ invoice: typeof server.invoice === 'function' ? (server.invoice as () => unknown)() : server.invoice });
    if (url.includes('/api/organization')) return answer(server.organization ?? {});
    if (url.includes('/state-tax-rates')) return answer(server.stateTaxRates ?? []);
    if (server.rest) return server.rest(url, config);
    return answer(server.otherwise ?? {});
  }) as typeof api.get);
}

export interface MountInvoiceDetail extends InvoiceServer {
  /** The id the address names: what the router mock answers `useParams` with. */
  id: string;
  /** Who is signed in by ability. Left out: no provider (the page draws as for a person who may do nothing). */
  ability?: AppAbility;
  entry?: NonNullable<MemoryRouterProps['initialEntries']>[number];
  /** Put the page in a route table of the test's own. */
  wrap?: (page: ReactElement) => ReactElement;
}

/** The page as an element, for a test that puts it in a route table of its own beside other pages (one fake server, many pages). */
export const invoiceDetailElement = (): ReactElement => <InvoiceDetailPage />;

/** The page as a component, for a table of pages (`Page: InvoiceDetailUnderTest`). */
export const InvoiceDetailUnderTest = () => <InvoiceDetailPage />;

/** Mount the page without touching the fake server: for a test that serves (`serveInvoiceDetail`) and then mounts, or mounts more than once. */
export function renderInvoiceDetail(opts: Pick<MountInvoiceDetail, 'id' | 'ability' | 'entry' | 'wrap'>) {
  setInvoiceRoute(opts.id);
  const page = <InvoiceDetailPage />;
  return renderWithProviders(opts.wrap ? opts.wrap(page) : page, {
    ability: opts.ability,
    ...(opts.entry ? { initialEntries: [opts.entry] } : {}),
  });
}

/** Serve the invoice and mount the page. */
export function mountInvoiceDetail(opts: MountInvoiceDetail) {
  serveInvoiceDetail(opts);
  return renderInvoiceDetail(opts);
}
