/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
/**
 * The one harness for the routed inventory page (`src/pages/v2/inventory/InventoryPage.tsx`) (#3259).
 *
 * Every test that mounts that page does it through `renderInventory` / `mountInventory`; none keeps a fake server or a copy of
 * the data-hook stubs of its own. A test gets its records either from the fake server (`serveInventory`: the page reads
 * them over the client) or by stubbing the data hooks with `inventoryApiStub.ts` (`vi.mock` is hoisted per file, so the
 * mock line stays in the test and takes its body from there).
 */
import { vi } from 'vitest';
import type { ReactElement } from 'react';
import type { MemoryRouterProps } from 'react-router-dom';
import api from '@/lib/axios';
import type { AppAbility } from '@/lib/ability';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import { renderWithProviders } from '../helpers';

/** A route of the fake server: the first one whose `match` fits the URL answers with `data`. */
export interface FakeRoute {
  match: (url: string) => boolean;
  /** The answer, or a function of the request's arguments asked on every read; it may throw to refuse or return a promise. */
  data: unknown | ((url: string, ...rest: unknown[]) => unknown);
}

export interface InventoryServer {
  /** `GET /api/inventory/items`. A function is asked on every read. */
  items?: unknown[] | (() => unknown[]);
  locations?: unknown[];
  vendors?: unknown[];
  categories?: unknown[];
  purchaseOrders?: unknown[];
  jobStages?: unknown[];
  techs?: unknown[];
  /** `GET /api/inventory/assets`: the rows (the meta total follows). */
  assets?: unknown[];
  /** `GET /api/organization`. Left out: the empty answer. */
  organization?: unknown;
  /** Routes asked before the rest: a switch answer, the movement log, the low-stock read, a refusal. */
  routes?: FakeRoute[];
}

const answer = (data: unknown) => ({ data }) as never;

/** What a read nothing above knows answers: every list the page asks for, empty. */
const EVERYTHING_EMPTY = {
  data: [], meta: { page: 1, limit: 1, total: 0, totalPages: 1 },
  locations: [], vendors: [], categories: [], branches: [], brands: [],
  stages: [], assets: [], total: 0, jobStages: [], purchaseOrders: [],
  users: [], finishes: [], techs: [], itemGroups: [],
};

/** Install the fake server on the mocked client. */
export function serveInventory(server: InventoryServer = {}): void {
  vi.mocked(api).get.mockImplementation((async (url: string, ...rest: unknown[]) => {
    for (const r of server.routes ?? []) {
      if (!r.match(url)) continue;
      const out = typeof r.data === 'function' ? (r.data as (u: string, ...r: unknown[]) => unknown)(url, ...rest) : r.data;
      return out instanceof Promise ? out.then(answer) : answer(out);
    }
    if (url.startsWith('/api/inventory/items')) return answer({ data: typeof server.items === 'function' ? server.items() : (server.items ?? []) });
    if (url.startsWith('/api/inventory/locations')) return answer({ locations: server.locations ?? [] });
    if (url.startsWith('/api/inventory/categories') && server.categories) return answer({ categories: server.categories });
    if (url.startsWith('/api/inventory/assets')) return answer({ data: server.assets ?? [], meta: { total: (server.assets ?? []).length } });
    if (url.startsWith('/api/inventory/vendors') && server.vendors) return answer({ vendors: server.vendors });
    if (url.startsWith('/api/inventory/purchase-orders') && server.purchaseOrders) return answer({ purchaseOrders: server.purchaseOrders });
    if (url.startsWith('/api/inventory/job-stages') && server.jobStages) return answer({ jobStages: server.jobStages });
    if (url.startsWith('/api/inventory/techs') && server.techs) return answer({ techs: server.techs });
    if (url.startsWith('/api/logistic-orders')) return answer({ data: [], page: 1, limit: 50, total: 0 });
    if (url.startsWith('/api/users') && !url.startsWith('/api/users/')) return answer({ users: [] });
    if (url.startsWith('/api/organization') && server.organization !== undefined) return answer(server.organization);
    return answer(EVERYTHING_EMPTY);
  }) as typeof api.get);
}

export interface MountInventory extends InventoryServer {
  /** Who is signed in by ability. Left out: no provider. */
  ability?: AppAbility;
  entry?: NonNullable<MemoryRouterProps['initialEntries']>[number];
  /** Put the page in a route table of the test's own. */
  wrap?: (page: ReactElement) => ReactElement;
}

/** The page as an element, for a test that puts it in a route table of its own. */
export const inventoryElement = (): ReactElement => <InventoryPage />;

/** Mount the page without touching the fake server: for a test whose records come from stubbed hooks, or that serves first. */
export function renderInventory(opts: Pick<MountInventory, 'ability' | 'entry' | 'wrap'> = {}) {
  const page = <InventoryPage />;
  return renderWithProviders(opts.wrap ? opts.wrap(page) : page, {
    ability: opts.ability,
    ...(opts.entry ? { initialEntries: [opts.entry] } : {}),
  });
}

/** Serve the records and mount the page. */
export function mountInventory(opts: MountInventory = {}) {
  serveInventory(opts);
  return renderInventory(opts);
}
