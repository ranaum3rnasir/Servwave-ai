/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
/**
 * The one harness for the routed lead detail page (`src/pages/v2/leads/LeadDetailPage.tsx`) (#3259).
 *
 * Every test that mounts that page does it through `mountLeadDetail` / `renderLeadDetail`; none of them keeps a fake server
 * of its own. The fake server answers the lead and the reads the page makes beside it (notes, users, tags, the person's own
 * switches, the timeline) from default records; a test states only what differs: the lead's fields, the notes, or a route of
 * its own.
 *
 * A test file still declares the mocks that are its own, because `vi.mock` is hoisted per file:
 *
 *   vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
 *   vi.mock('react-router-dom', async () => (await import('./harness/leadDetailRouter')).leadDetailRouter());
 */
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import type { MemoryRouterProps } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility, type AppAbility } from '@/lib/ability';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';
import { renderWithProviders, LEAD_FIXTURE } from '../helpers';

export { LEAD_ID } from './leadDetailRouter';

/** Everything is allowed to this person by role: only the lead's own answer decides what the page draws. */
export const everythingAllowed = (): AppAbility => buildAbility([{ action: 'manage', subject: 'all' }]);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** The browser pieces the page's menus need and jsdom lacks. Safe to call from every `beforeEach`. */
export function stubBrowser(): void {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
}

/** A lead as `GET /api/leads/:id` answers it: the shared fixture with no estimates and no contact entries; `over` replaces any field. */
export function leadRecord(over: Record<string, unknown> = {}) {
  return { ...LEAD_FIXTURE, estimates: [], contact_entries: [], ...over };
}

/** A route of the fake server: the first one whose `match` fits the URL answers with `data`. */
export interface FakeRoute {
  match: (url: string) => boolean;
  /** The answer, or a function of the request's config asked on every read; it may throw to refuse or return a promise. */
  data: unknown | ((config?: { params?: Record<string, unknown> }) => unknown);
}

export interface LeadServer {
  /** The lead as the server answers it. A function is asked on every read, so a test can change the answer between refetches. */
  lead: unknown | (() => unknown);
  /** The lead's notes (`/notes`). Default: none. A function is asked on every read. */
  notes?: unknown[] | (() => unknown[]);
  /** The person's own switches (`/api/permission-switches/me`). Left out: the read answers `{}`, as an unknown read does. */
  me?: unknown | (() => unknown);
  /** The users list. Default: none. */
  users?: unknown[];
  /** Routes asked before the lead's own, for a read this test needs to answer (timeline, estimates, a refusal, ...). */
  routes?: FakeRoute[];
  /** What a read nothing above knows answers. Default `{}`. */
  otherwise?: unknown;
  /** A server for the reads that are not the lead page's own, when the test mounts another page beside it. Asked after the lead's reads. */
  rest?: (url: string, config?: { params?: Record<string, unknown> }) => unknown;
}

const answer = (data: unknown) => ({ data }) as never;
const asked = <T,>(v: T | (() => T)): T => (typeof v === 'function' ? (v as () => T)() : v);

/** Install the fake server on the mocked client. */
export function serveLeadDetail(server: LeadServer): void {
  vi.mocked(api).get.mockImplementation((async (url: string, config?: { params?: Record<string, unknown> }) => {
    for (const r of server.routes ?? []) {
      if (!r.match(url)) continue;
      const out = typeof r.data === 'function' ? (r.data as (c?: unknown) => unknown)(config) : r.data;
      // A function may hand back a promise (one that never settles holds the read in flight).
      return out instanceof Promise ? out.then(answer) : answer(out);
    }
    if (server.me !== undefined && url === '/api/permission-switches/me') return answer(asked(server.me));
    if (url.includes('/notes')) return answer({ notes: asked(server.notes ?? []) });
    if (url.endsWith('/timeline')) return answer({ events: [] });
    if (url.includes('/api/leads/')) return answer({ lead: asked(server.lead) });
    if (url.includes('/api/users')) return answer({ users: server.users ?? [] });
    if (url.includes('/api/tags')) return answer({ tags: [] });
    if (server.rest) return server.rest(url, config);
    return answer(server.otherwise ?? {});
  }) as typeof api.get);
}

export interface MountLeadDetail extends Omit<LeadServer, 'lead'> {
  /** Fields of the lead that differ from `leadRecord`'s defaults, or a whole record. A function is asked on every read. */
  lead?: Record<string, unknown> | (() => Record<string, unknown>);
  ability?: AppAbility;
  /** Where the router starts: a path, or a location with a search and the router state a link carries. */
  entry?: NonNullable<MemoryRouterProps['initialEntries']>[number];
  /** Render something beside the page (a location probe, say). */
  beside?: ReactElement;
  /** Put the page in a route table of the test's own. */
  wrap?: (page: ReactElement) => ReactElement;
}

/**
 * Mount the page without touching the fake server: for a test that serves (`serveLeadDetail`) and then mounts, or mounts
 * more than once. `ability` left out means everything allowed; `{ ability: undefined }` renders with no ability provider.
 */
export function renderLeadDetail(opts: Pick<MountLeadDetail, 'ability' | 'entry' | 'beside' | 'wrap'> = {}) {
  const page = opts.beside ? <><LeadDetailPage />{opts.beside}</> : <LeadDetailPage />;
  return renderWithProviders(
    opts.wrap ? opts.wrap(page) : page,
    { ability: 'ability' in opts ? opts.ability : everythingAllowed(), ...(opts.entry ? { initialEntries: [opts.entry] } : {}) },
  );
}

/** The page as an element, for a test that puts it in a route table of its own beside other pages (one fake server, many pages). */
export const leadDetailElement = (): ReactElement => <LeadDetailPage />;

/** Serve the lead and mount the page. */
export function mountLeadDetail(opts: MountLeadDetail = {}) {
  const over = opts.lead;
  serveLeadDetail({ ...opts, lead: typeof over === 'function' ? () => leadRecord(over()) : leadRecord(over) });
  return renderLeadDetail(opts);
}

