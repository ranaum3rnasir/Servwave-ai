/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
/**
 * The one harness for the routed job detail page (`src/pages/v2/jobs/JobDetailPage.tsx`) (#3259).
 *
 * Every test that mounts that page does it through `mountJobDetail`; none of them keeps a fake server of its own.
 * The fake server answers the job and the reads the page makes beside it (visits, scopes, line items) from default
 * records; a test states only what differs: the job's fields, a record the page should read, or a route of its own.
 *
 * A test file still declares two mocks, because `vi.mock` is hoisted per file:
 *
 *   vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
 *   vi.mock('react-router-dom', async () => (await import('./harness/jobDetailRouter')).jobDetailRouter(JOB_ID));
 */
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import api from '@/lib/axios';
import { buildAbility, type AppAbility } from '@/lib/ability';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { renderWithProviders } from '../helpers';

export { JOB_ID } from './jobDetailRouter';
import { JOB_ID } from './jobDetailRouter';

/** Everything is allowed to this person by role: only the job's own answer decides what the page draws. */
export const everythingAllowed = (): AppAbility => buildAbility([{ action: 'manage', subject: 'all' }]);

export const NO_BILLING = { total: 0, invoiced: 0, remaining: 0 };

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** The browser pieces the page's menus and charts need and jsdom lacks. Safe to call from every `beforeEach`. */
export function stubBrowser(): void {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
}

/**
 * A job as `GET /api/jobs/:id` answers it, with the default customer; `over` replaces any field. What the server says a
 * person may do with it (`locked`, `actions`, the closed-door reasons, `ready_to_close`) is the test's own state: it is
 * not defaulted, so a test never inherits a permission it did not state.
 */
export function jobRecord(over: Record<string, unknown> = {}, jobId: string = JOB_ID) {
  return {
    id: jobId, job_number: 'J00001', status: 'SCHEDULED', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', started_at: null,
    completed_at: null, cancelled_at: null, cancelled_reason: null, cancel_reason: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null,
    ...over,
  };
}

/** A route of the fake server: the first one whose `match` fits the URL answers with `data`. */
export interface FakeRoute {
  match: (url: string) => boolean;
  /** The answer, or a function of the request's config (`{ params }`) asked on every read; it may throw to refuse or return a promise. */
  data: unknown | ((config?: { params?: Record<string, unknown> }) => unknown);
}

export interface JobServer {
  jobId?: string;
  /** The job as the server answers it. A function is asked on every read, so a test can change the answer between refetches. */
  job: Record<string, unknown> | (() => Record<string, unknown>);
  /** The job's visits list (`/visits`). Default: none. A function is asked on every read (a write changes what the next read sees). */
  visits?: unknown[] | (() => unknown[]);
  scopes?: unknown[];
  lines?: unknown[];
  /** Billing totals both the scopes and the line-items answers carry. Default: all zero. */
  billing?: Record<string, number>;
  /** Routes asked before the job's own, for a read this test needs to answer (cancel reasons, review, timeline, ...). */
  routes?: FakeRoute[];
  /** What a read nothing above knows answers. Default `{}`; a page that also shows lists asks for `{ data: [] }` and the like. */
  otherwise?: unknown;
  /**
   * A server for the reads that are not the job page's own, when the test mounts another page beside it (a home page whose
   * tile links to the job). It answers the whole response, as the client does; asked after the job's reads.
   */
  rest?: (url: string, config?: { params?: Record<string, unknown> }) => unknown;
}

const answer = (data: unknown) => ({ data }) as never;

/** Install the fake server on the mocked client. Anything it does not know answers `{ data: {} }`. */
export function serveJobDetail(server: JobServer): void {
  const jobId = server.jobId ?? JOB_ID;
  const billing = server.billing ?? NO_BILLING;
  vi.mocked(api).get.mockImplementation((async (url: string, config?: { params?: Record<string, unknown> }) => {
    for (const r of server.routes ?? []) {
      if (!r.match(url)) continue;
      const out = typeof r.data === 'function' ? (r.data as (c?: unknown) => unknown)(config) : r.data;
      // A function may hand back a promise (one that never settles holds the read in flight).
      return out instanceof Promise ? out.then(answer) : answer(out);
    }
    if (url === `/api/jobs/${jobId}/visits`) return answer({ visits: (typeof server.visits === 'function' ? server.visits() : server.visits) ?? [] });
    if (url.endsWith('/scopes')) return answer({ scopes: server.scopes ?? [], billing });
    if (url.endsWith('/line-items')) return answer({ lines: server.lines ?? [], billing });
    if (url.includes(`/api/jobs/${jobId}`)) return answer({ job: typeof server.job === 'function' ? server.job() : server.job });
    if (server.rest) return server.rest(url, config);
    return answer(server.otherwise ?? {});
  }) as typeof api.get);
}

export interface MountJobDetail extends Omit<JobServer, 'job'> {
  /**
   * Fields of the job that differ from `jobRecord`'s defaults, or a whole record built with `jobRecord`. A function is
   * asked on every read (a refetch after a save can answer differently).
   */
  job?: Record<string, unknown> | (() => Record<string, unknown>);
  ability?: AppAbility;
  entry?: string;
  /** Render something beside the page (a location probe, say). */
  beside?: ReactElement;
  /** Put the page in a route table of the test's own (a real `:id` route, a page to land on after a delete). */
  wrap?: (page: ReactElement) => ReactElement;
}

/**
 * Mount the page without touching the fake server: for a test that serves (`serveJobDetail`) and then mounts, or mounts
 * more than once. `ability` left out means everything allowed; `{ ability: undefined }` renders with no ability provider.
 */
export function renderJobDetail(opts: Pick<MountJobDetail, 'ability' | 'entry' | 'beside' | 'wrap'> = {}) {
  const page = opts.beside ? <><JobDetailPage />{opts.beside}</> : <JobDetailPage />;
  return renderWithProviders(
    opts.wrap ? opts.wrap(page) : page,
    { ability: 'ability' in opts ? opts.ability : everythingAllowed(), ...(opts.entry ? { initialEntries: [opts.entry] } : {}) },
  );
}

/** Serve the job and mount the page. */
export function mountJobDetail(opts: MountJobDetail = {}) {
  const jobId = opts.jobId ?? JOB_ID;
  const over = opts.job;
  serveJobDetail({ ...opts, jobId, job: typeof over === 'function' ? () => jobRecord(over(), jobId) : jobRecord(over, jobId) });
  return renderJobDetail(opts);
}
