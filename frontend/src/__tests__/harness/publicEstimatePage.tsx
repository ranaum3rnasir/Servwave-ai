/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
/**
 * The one harness for the routed public estimate page (`src/pages/v2/auth-public/PublicEstimatePage.tsx`) (#3259).
 *
 * The page talks to the server with a bare `fetch` (a customer holds a link, not a session). Every test that mounts it does it
 * through `servePublicEstimate` / `renderPublicEstimate`; none keeps a fetch stub of its own. A test states only what differs:
 * the page body it reads, what a write answers, a route of its own.
 *
 * A test file still declares the mocks that are its own, because `vi.mock` is hoisted per file:
 *
 *   vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/publicEstimateMocks')).publicRouter());
 *   vi.mock('react-signature-canvas', async () => (await import('@/__tests__/harness/publicEstimateMocks')).signedPad());
 */
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import { Route, Routes } from 'react-router-dom';
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';
import { renderWithProviders } from '../helpers';
import { padState, setPublicRoute } from './publicEstimateMocks';

export { publicRoute, setPublicRoute } from './publicEstimateMocks';

/** An answer of the fake server: what `fetch` resolves to. `status` is left off the response unless given. */
export interface FetchAnswer {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

type Init = RequestInit | undefined;

/** A route of the fake server: the first one whose `match` fits the URL answers. */
export interface PublicRoute {
  match: (url: string) => boolean;
  answer: FetchAnswer | ((url: string, init: Init) => FetchAnswer);
}

export interface PublicEstimateServer {
  /** The body every read answers (a GET no route answers). A function is asked on every read. Left out: `{}`. */
  page?: unknown | (() => unknown);
  /** What a write (any call that is not a GET) answers. Default: ok, `{}`. A function is asked on every write. */
  write?: FetchAnswer | ((url: string, init: Init) => FetchAnswer);
  /** Routes asked before the rest. */
  routes?: PublicRoute[];
  /** Answers handed out for the first calls in order, whatever they are; then the rest answers. */
  first?: FetchAnswer[];
  /** Every call stays in flight for ever (the page never leaves its loading state). */
  never?: boolean;
}

/** `lazy` is asked when the page reads the answer's JSON, as a real response is. */
const respond = (a: FetchAnswer, lazy?: () => unknown) => ({
  ok: a.ok ?? true,
  ...(a.status === undefined ? {} : { status: a.status }),
  json: async () => (lazy ? lazy() : a.body) ?? {},
});

/**
 * Install the fake server as the global `fetch` and hand back its spy. Pair it with `vi.unstubAllGlobals()` in the file's
 * `afterEach`.
 */
export function servePublicEstimate(server: PublicEstimateServer = {}) {
  const queue = [...(server.first ?? [])];
  const spy = vi.fn((url: string, init?: RequestInit) => {
    if (server.never) return new Promise<never>(() => {});
    const queued = queue.shift();
    if (queued) return Promise.resolve(respond(queued));
    const u = String(url);
    for (const r of server.routes ?? []) {
      if (r.match(u)) return Promise.resolve(respond(typeof r.answer === 'function' ? r.answer(u, init) : r.answer));
    }
    if (init?.method && init.method !== 'GET') {
      const w = server.write;
      return Promise.resolve(respond(typeof w === 'function' ? w(u, init) : (w ?? {})));
    }
    return Promise.resolve(respond({}, () => (typeof server.page === 'function' ? (server.page as () => unknown)() : server.page)));
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The calls that were writes (POST and the like), in order. */
export const writes = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.filter(([, init]) => Boolean((init as RequestInit | undefined)?.method && (init as RequestInit).method !== 'GET'));
/** The calls that were POSTs, in order. */
export const posts = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
/** The URL of the first POST. */
export const postUrl = (spy: ReturnType<typeof vi.fn>) => String(posts(spy)[0]![0]);
/** The JSON body of the first POST. */
export const postBody = (spy: ReturnType<typeof vi.fn>) => JSON.parse(String((posts(spy)[0]![1] as RequestInit).body));

export interface RenderPublicEstimate {
  /** The document id the address names, for a file that mocks the router. Default `est-1`. */
  id?: string;
  /** The token on the address. Default `tok-1`. */
  token?: string;
  /** The whole query string, when a case needs more than the token (a payment return). Wins over `token`. */
  query?: string;
  /** Whether the signature pad reports a drawn signature on mount (a pad from `signedPad`). Default true. */
  signed?: boolean;
  /** The address the router starts on (a file that does not mock the router). */
  entry?: string;
  /** Put the page in a `/p/estimates/:id` route, so the real router reads the id and token from `entry`. */
  routed?: boolean;
  /** Put the page in a route table of the test's own. */
  wrap?: (page: ReactElement) => ReactElement;
}

/** The page as an element, for a test that puts it in a route table of its own. */
export const publicEstimateElement = (): ReactElement => <PublicEstimatePage />;

/** Mount the page without touching the fake server. */
export function renderPublicEstimate(opts: RenderPublicEstimate = {}) {
  setPublicRoute({ id: opts.id ?? 'est-1', token: opts.token, query: opts.query });
  padState.signedOnMount = opts.signed ?? true;
  const page = <PublicEstimatePage />;
  const ui = opts.routed ? <Routes><Route path="/p/estimates/:id" element={page} /></Routes> : opts.wrap ? opts.wrap(page) : page;
  return renderWithProviders(ui, opts.entry ? { initialEntries: [opts.entry] } : undefined);
}

/** Serve and mount. */
export function mountPublicEstimate(opts: PublicEstimateServer & RenderPublicEstimate = {}) {
  const spy = servePublicEstimate(opts);
  return { spy, ...renderPublicEstimate(opts) };
}

/**
 * The page body of an estimate that asks for a deposit (the redesign shape: `send_config` + `invoices[]`, no legacy `deposit`
 * key, mirroring `estimatePublicSelect`): SENT, card or check, $3,187.50 of $10,625.00.
 */
export const PUBLIC_DEPOSIT_PAYLOAD = {
  estimate: {
    id: 'est-dep-1',
    estimate_number: 'E00099',
    status: 'SENT',
    tax_rate: 6.25,
    subtotal: 10000,
    tax_amount: 625,
    total_amount: 10625,
    scope_notes: 'HVAC replacement',
    line_items: [],
    send_config: {
      deposit_required: true,
      deposit_percentage: 30,
      deposit_amount: 3187.5,
      payment_methods: ['CARD', 'CHECK'],
      message_body: null,
    },
    invoices: [
      {
        id: 'inv-dep-1',
        status: 'SENT',
        total_amount: 3187.5,
        amount_due: 3187.5,
        public_token: 'dep-tok',
      },
    ],
    lead: {
      customer: { first_name: 'Alice', last_name: 'Smith', company_name: null },
    },
    customer: null,
    signature_data: null,
    signature_at: null,
  },
  organization: { name: 'ServWave HVAC', estimate_terms: null },
  payment_instructions: {},
  expired: false,
};
