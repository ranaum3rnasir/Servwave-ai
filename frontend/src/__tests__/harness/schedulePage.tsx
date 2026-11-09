/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
/**
 * The one harness for the routed schedule board (`src/pages/v2/schedule/SchedulePage.tsx`) (#3259).
 *
 * Every test that mounts that page, or draws one of the cards it exports, does it through this module; none of them keeps
 * a fake server of its own. The fake server answers the reads the board makes (the window's jobs and leads, the
 * unscheduled bucket, the roster, departments, organization, service-plan bucket, calendar entries) from empty defaults; a
 * test states only what differs.
 *
 * A test file still declares the mocks that are its own, because `vi.mock` is hoisted per file.
 */
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import type { MemoryRouterProps } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility, type AppAbility } from '@/lib/ability';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import SchedulePage from '@/pages/v2/schedule/SchedulePage';
import { renderWithProviders } from '../helpers';

// The pieces of the page that tests draw on their own (a card, a draft helper): the harness is the one importer.
export { ScheduleEvent, boardCardDraft, planDraftLocation, ghostToEvent } from '@/pages/v2/schedule/SchedulePage';

/** Everything is allowed to this person by role: only the server's answers decide what the board draws. */
export const everythingAllowed = (): AppAbility => buildAbility([{ action: 'manage', subject: 'all' }]);

type Params = Record<string, unknown>;

/** A route of the fake server: the first one whose `match` fits the URL answers with `data`. */
export interface FakeRoute {
  match: (url: string) => boolean;
  /** The answer, or a function of the request's params asked on every read; it may throw to refuse or return a promise. */
  data: unknown | ((params: Params) => unknown);
}

export interface ScheduleServer {
  /** The jobs in the board's window (a read of `/api/jobs` that does not ask for the unscheduled bucket). Default: none. */
  jobs?: unknown[] | ((params: Params) => unknown[]);
  /** The unscheduled bucket (a read of `/api/jobs` whose status is UNSCHEDULED). Default: none. */
  bucketJobs?: unknown[];
  /** The leads; a function is asked with the read's params (a window read and the needs-scheduling bucket differ by them). Default: none. */
  leads?: unknown[] | ((params: Params) => unknown[]);
  /** The roster, answered at `/api/users` and `/api/users/assignable`. Default: none. */
  users?: unknown[];
  /** The departments. A function is asked on every read (a write changes the list). Default: none. */
  departments?: unknown[] | (() => unknown[]);
  /** What `GET /api/organization` answers. Default `{}`. */
  organization?: unknown;
  /** The service-plan bucket. Default: none. */
  plans?: unknown[];
  /** The calendar entries. Default: none. */
  calendarEntries?: unknown[];
  /** Routes asked before the board's own (search, a raw-shaped roster, ...). */
  routes?: FakeRoute[];
  /** What a read nothing above knows answers. Default `{}`. */
  otherwise?: unknown;
}

const answer = (data: unknown) => ({ data }) as never;
const wantsBucket = (status: unknown) => status === 'UNSCHEDULED' || (Array.isArray(status) && status.includes('UNSCHEDULED'));
const fromParam = <T,>(v: T[] | ((p: Params) => T[]) | undefined, p: Params): T[] => (typeof v === 'function' ? v(p) : (v ?? []));

/** Install the fake server on the mocked client. */
export function serveSchedule(server: ScheduleServer): void {
  vi.mocked(api).get.mockImplementation(((url: string, config?: { params?: Params }) => {
    const params = (config?.params ?? {}) as Params;
    for (const r of server.routes ?? []) {
      if (!r.match(url)) continue;
      const out = typeof r.data === 'function' ? (r.data as (p: Params) => unknown)(params) : r.data;
      return out instanceof Promise ? out.then(answer) : Promise.resolve(answer(out));
    }
    if (url === '/api/jobs') return Promise.resolve(answer({ jobs: wantsBucket(params.status) ? (server.bucketJobs ?? []) : fromParam(server.jobs, params) }));
    if (url === '/api/leads') return Promise.resolve(answer({ leads: fromParam(server.leads, params) }));
    if (url === '/api/departments') return Promise.resolve(answer({ departments: typeof server.departments === 'function' ? server.departments() : (server.departments ?? []) }));
    if (url === '/api/users' || url === '/api/users/assignable') return Promise.resolve(answer({ users: server.users ?? [] }));
    if (url === '/api/organization') return Promise.resolve(answer(server.organization ?? {}));
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve(answer({ plans: server.plans ?? [] }));
    if (url === '/api/calendar-entries') return Promise.resolve(answer({ calendar_entries: server.calendarEntries ?? [] }));
    return Promise.resolve(answer(server.otherwise ?? {}));
  }) as typeof api.get);
}

/** The board as an element, for a test that puts it in a list of pages mounted on one fake server. */
export const scheduleElement = (): ReactElement => <SchedulePage />;

export interface MountSchedule extends ScheduleServer {
  ability?: AppAbility;
  entry?: NonNullable<MemoryRouterProps['initialEntries']>[number];
  /** Render something beside the page (a location probe, say). */
  beside?: ReactElement;
  /** Put the page in a wrapper of the test's own. */
  wrap?: (page: ReactElement) => ReactElement;
  /** Wrap the board in the kit's tooltip provider, as the app does. Default true. */
  tooltip?: boolean;
}

/**
 * Mount the board without touching the fake server. `ability` left out means everything allowed; `{ ability: undefined }`
 * renders with no ability provider.
 */
export function renderSchedule(opts: Pick<MountSchedule, 'ability' | 'entry' | 'beside' | 'wrap' | 'tooltip'> = {}) {
  const board = opts.tooltip === false ? <SchedulePage /> : <TooltipProvider><SchedulePage /></TooltipProvider>;
  const page = opts.beside ? <>{board}{opts.beside}</> : board;
  return renderWithProviders(
    opts.wrap ? opts.wrap(page) : page,
    { ability: 'ability' in opts ? opts.ability : everythingAllowed(), ...(opts.entry ? { initialEntries: [opts.entry] } : {}) },
  );
}

/** Serve the board's reads and mount it. */
export function mountSchedule(opts: MountSchedule = {}) {
  serveSchedule(opts);
  return renderSchedule(opts);
}
