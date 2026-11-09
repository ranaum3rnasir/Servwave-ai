/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
/**
 * The one harness for the routed home page (`src/pages/v2/dashboard/DashboardPage.tsx`) (#3259).
 *
 * Every test that mounts that page does it through `mountDashboard` / `renderDashboard`; none of them keeps a fake server
 * of its own. The page reads its layout from `GET /api/dashboard/layout`, saves it with `PUT` there, carries a browser
 * layout over with `POST .../carry-over`, resets it with `POST .../reset`, and reads the figures from `GET /api/dashboard`.
 * `serveDashboard` answers all of them: the layout starts as the factory layout unless a test gives one, and a save is
 * remembered, so a second render reads back what the first one saved.
 *
 * A read a test needs to hold, fail or count is a ROUTE (`routes`), asked before the standard answers; a route that wants
 * the standard answer back returns `server.read(url)`. A test never replaces `api.get` itself.
 *
 * The dashboard seam reads `VITE_DASHBOARD_USE_MOCK` once, when its module loads: a test file pins it to the live path
 * with `vi.hoisted(() => { vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false'); })`, because only a file can hoist that.
 */
import { vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import api from '@/lib/axios';
import type { AppAbility } from '@/lib/ability';
import DashboardPage from '@/pages/v2/dashboard/DashboardPage';
import { renderWithProviders } from '../helpers';

// ─── The home page's server layout (Roles & Permissions S09.4) ────────────────
export interface ServedLayoutEntry {
  id: string;
  visible: boolean;
  size?: string;
  range?: string;
  /** `false` marks a stored tile the person cannot have right now (S09.7): kept in place, never drawn. */
  available?: false;
}

export const FACTORY_LAYOUT: ServedLayoutEntry[] = [
  'kpi.revenue_mtd', 'kpi.collected_today', 'kpi.recurring', 'kpi.ar', 'kpi.close_rate', 'kpi.jobs_today', 'kpi.open_leads',
  'kpi.avg_ticket', 'kpi.jobs_week', 'kpi.deposits', 'smart_insights', 'needs_attention', 'schedule_today', 'revenue_chart',
  'pipeline', 'tech_scoreboard', 'dispatch_scoreboard', 'lead_sources', 'revenue_by_job_type',
].map((id) => ({ id, visible: true }));

/** A read of the fake server a test holds, fails or counts: the first route whose `match` fits the URL answers. */
export interface DashboardRoute {
  match: (url: string) => boolean;
  /** The answer, or a function of the URL asked on every read; it may throw or return a promise (a held or refused read). */
  data: unknown | ((url: string) => unknown);
}

export interface DashboardServerOptions {
  /** `saved: false` is a person with no layout on the server yet (S09.5): the layout is then their role's default. */
  saved?: boolean;
  /** Reads asked before the standard answers. */
  routes?: DashboardRoute[];
}

export function serveDashboard(
  answer: unknown,
  layout: ServedLayoutEntry[] = FACTORY_LAYOUT,
  roleDefault: ServedLayoutEntry[] = layout,
  options: DashboardServerOptions = {},
) {
  const server = {
    layout: layout.map((e) => ({ ...e })),
    saved: options.saved ?? true,
    saves: [] as ServedLayoutEntry[][],
    carryOvers: [] as ServedLayoutEntry[][],
    /** How many times the person asked for their role's default back (S09.6). */
    resets: 0,
    layoutReads: 0,
    /** The standard answer to a read (what a route hands back to let a read through); counts a layout read. */
    read(url: string): unknown {
      if (url === '/api/dashboard/layout') server.layoutReads += 1;
      return url === '/api/dashboard/layout' ? layoutAnswer() : answer;
    },
  };
  const layoutAnswer = () => ({ layout: server.layout, saved: server.saved });
  vi.mocked(api.get).mockImplementation((async (url: string) => {
    for (const r of options.routes ?? []) {
      if (!r.match(url)) continue;
      const out = typeof r.data === 'function' ? (r.data as (u: string) => unknown)(url) : r.data;
      return out instanceof Promise ? out.then((data) => ({ data })) : { data: out };
    }
    return { data: server.read(url) };
  }) as never);
  vi.mocked(api.put).mockImplementation(((url: string, payload: { layout: ServedLayoutEntry[] }) => {
    if (url !== '/api/dashboard/layout') return Promise.reject(new Error(`unexpected PUT ${url}`));
    server.layout = payload.layout;
    server.saved = true;
    server.saves.push(payload.layout);
    return Promise.resolve({ data: layoutAnswer() });
  }) as never);
  // The one-time carry-over of a browser layout stores it only when nothing is saved, as the real route does.
  vi.mocked(api.post).mockImplementation(((url: string, payload: { layout: ServedLayoutEntry[] }) => {
    // A reset replaces the saved layout with the role's default and keeps the row (`saved` stays true), as the real route does.
    if (url === '/api/dashboard/layout/reset') {
      server.resets += 1;
      server.layout = roleDefault.map((e) => ({ ...e }));
      server.saved = true;
      return Promise.resolve({ data: layoutAnswer() });
    }
    if (url !== '/api/dashboard/layout/carry-over') return Promise.reject(new Error(`unexpected POST ${url}`));
    server.carryOvers.push(payload.layout);
    if (!server.saved) {
      server.layout = payload.layout;
      server.saved = true;
    }
    return Promise.resolve({ data: layoutAnswer() });
  }) as never);
  return server;
}

/** A server that never answers a read: the page stays on its loading state. */
export function serveNothing(): void {
  vi.mocked(api.get).mockReturnValue(new Promise(() => undefined));
}

export interface RenderDashboard {
  /** Who is signed in by ability. */
  ability?: AppAbility;
  /** Drawn next to the page in the same router (a location probe, for example). */
  beside?: ReactNode;
  /** Put the page in a wrapper of the test's own (a strict-mode tree, a route table). */
  wrap?: (page: ReactElement) => ReactElement;
}

/** The page as an element, for a test that puts it in a route table of its own. */
export const dashboardElement = (): ReactElement => <DashboardPage />;

/** Mount the page without touching the fake server: for a test that serves (`serveDashboard`) and then mounts, or mounts more than once. */
export function renderDashboard(opts: RenderDashboard = {}) {
  const page = <DashboardPage />;
  const tree = opts.wrap ? opts.wrap(page) : page;
  return renderWithProviders(opts.beside ? <>{tree}{opts.beside}</> : tree, { ability: opts.ability });
}

/** Serve the answer and mount the page. */
export function mountDashboard(answer: unknown, opts: RenderDashboard & DashboardServerOptions & { layout?: ServedLayoutEntry[]; roleDefault?: ServedLayoutEntry[] } = {}) {
  const server = serveDashboard(answer, opts.layout, opts.roleDefault, opts);
  return { server, ...renderDashboard(opts) };
}
