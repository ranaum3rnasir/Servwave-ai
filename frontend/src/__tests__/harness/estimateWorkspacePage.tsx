/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
/**
 * The one harness for the routed estimate workspace page (`src/pages/v2/estimates/EstimateWorkspacePage.tsx`) (#3259).
 *
 * Every test that mounts that page does it through `mountEstimateWorkspace` / `renderEstimateWorkspace`; none of them keeps
 * a fake server of its own. The fake server answers the estimate and the reads the page makes beside it (the state tax
 * rates, the organization settings) from defaults; a test states only what differs: the estimate's fields or a route of its
 * own (communications, lost-reason options, a refusal, ...).
 *
 * A test file still declares the mocks that are its own, because `vi.mock` is hoisted per file:
 *
 *   vi.mock('@/features/estimate-workspace/components/EstimateTabs', () => ({ EstimateTabs: () => null }));
 *   vi.mock('react-router-dom', async () => (await import('./harness/estimateWorkspaceRouter')).estimateWorkspaceRouter(ESTIMATE_ID));
 */
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import type { MemoryRouterProps } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility, type AppAbility } from '@/lib/ability';
import EstimateWorkspacePage from '@/pages/v2/estimates/EstimateWorkspacePage';
import { renderWithProviders } from '../helpers';

/** Everything is allowed to this person by role: only the estimate's own answer decides what the page draws. */
export const everythingAllowed = (): AppAbility => buildAbility([{ action: 'manage', subject: 'all' }]);

/** What the organization read answers for a page that draws a deposit from the company's defaults. */
export const DEPOSIT_DEFAULTS = { accepted_payment_methods: ['CARD'], deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50 };

/** A route of the fake server: the first one whose `match` fits the URL answers with `data`. */
export interface FakeRoute {
  match: (url: string) => boolean;
  /** The answer, or a function of the request's config asked on every read; it may throw to refuse or return a promise. */
  data: unknown | ((config?: { params?: Record<string, unknown> }) => unknown);
}

export interface EstimateServer {
  /** The estimate as `GET /api/estimates/:id` answers it. A function is asked on every read (a refetch after a write can differ). */
  estimate: unknown | (() => unknown);
  /** What `GET /api/organization` answers. Left out: an unknown read, `{}`. */
  organization?: unknown;
  /** Routes asked before the estimate's own, for a read this test needs to answer (communications, lost reasons, a refusal, ...). */
  routes?: FakeRoute[];
  /** What a read nothing above knows answers. Default `{}`. */
  otherwise?: unknown;
  /** A server for the reads that are not the estimate page's own, when the test mounts another page beside it. Asked after the estimate's reads. */
  rest?: (url: string, config?: { params?: Record<string, unknown> }) => unknown;
}

const answer = (data: unknown) => ({ data }) as never;

/** Install the fake server on the mocked client. */
export function serveEstimateWorkspace(server: EstimateServer): void {
  vi.mocked(api).get.mockImplementation((async (url: string, config?: { params?: Record<string, unknown> }) => {
    for (const r of server.routes ?? []) {
      if (!r.match(url)) continue;
      const out = typeof r.data === 'function' ? (r.data as (c?: unknown) => unknown)(config) : r.data;
      // A function may hand back a promise (one that never settles holds the read in flight).
      return out instanceof Promise ? out.then(answer) : answer(out);
    }
    if (url.includes('/state-tax-rates')) return answer({ data: [] });
    if (url.includes('/api/estimates/')) return answer({ estimate: typeof server.estimate === 'function' ? (server.estimate as () => unknown)() : server.estimate });
    if (server.organization !== undefined && url === '/api/organization') return answer(server.organization);
    if (server.rest) return server.rest(url, config);
    return answer(server.otherwise ?? {});
  }) as typeof api.get);
}

export interface MountEstimateWorkspace extends EstimateServer {
  ability?: AppAbility;
  entry?: NonNullable<MemoryRouterProps['initialEntries']>[number];
  /** Render something beside the page (a location probe, say). */
  beside?: ReactElement;
  /** Put the page in a route table of the test's own. */
  wrap?: (page: ReactElement) => ReactElement;
}

/** The page as an element, for a test that puts it in a route table of its own beside other pages (one fake server, many pages). */
export const estimateWorkspaceElement = (): ReactElement => <EstimateWorkspacePage />;

/**
 * Mount the page without touching the fake server: for a test that serves (`serveEstimateWorkspace`) and then mounts, or
 * mounts more than once. `ability` left out means everything allowed; `{ ability: undefined }` renders with no provider.
 */
export function renderEstimateWorkspace(opts: Pick<MountEstimateWorkspace, 'ability' | 'entry' | 'beside' | 'wrap'> = {}) {
  const page = opts.beside ? <><EstimateWorkspacePage />{opts.beside}</> : <EstimateWorkspacePage />;
  return renderWithProviders(
    opts.wrap ? opts.wrap(page) : page,
    { ability: 'ability' in opts ? opts.ability : everythingAllowed(), ...(opts.entry ? { initialEntries: [opts.entry] } : {}) },
  );
}

/** Serve the estimate and mount the page. */
export function mountEstimateWorkspace(opts: MountEstimateWorkspace) {
  serveEstimateWorkspace(opts);
  return renderEstimateWorkspace(opts);
}
