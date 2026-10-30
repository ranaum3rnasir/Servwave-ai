/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions scenario pass 1 - a page the person may open asks only for what their switches let them read.
 *
 * The person here holds the built-in Technician's preset values (`support/technicianPreset.ts`), as a custom role would.
 * Every routed list and detail page they can open is rendered and each tab of it is opened; the test then lists every
 * read the page made and fails on one the server refuses to this person. A refused read changes nothing on screen, but
 * it shows as a red line in the browser console and, on a page that makes it twice per load, as noise that hides real
 * errors. The server stays as it is: the page must not ask.
 *
 * `REFUSED` is the list of routes whose guard asks for something the Technician preset does not hold, found by sweeping
 * these pages (the guard each one stands on is named beside it). A route is added here when the sweep finds a page
 * asking for it; each entry is checked against the person's own rules, so a preset change that gives them the grant
 * makes the entry fail loudly instead of silently excusing a read.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import api from '@/lib/axios';
import EstimatesPage from '@/pages/v2/estimates/EstimatesPage';
import InventoryPage from '@/pages/v2/inventory/InventoryPage';
import PriceBookPage from '@/pages/v2/inventory/PriceBookPage';
import SchedulePage from '@/pages/v2/schedule/SchedulePage';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import JobsPage from '@/pages/v2/jobs/JobsPage';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';
import LeadsPage from '@/pages/v2/leads/LeadsPage';
import TasksHubPage from '@/pages/v2/tasks/TasksHubPage';

import { ALL_JOB_ACTIONS, LEAD_FIXTURE, renderWithProviders } from './helpers';
import { technicianAbility, technicianSwitchesAnswer } from './support/technicianPreset';

const RECORD_ID = 'e0000000-0000-0000-0000-000000000001';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: RECORD_ID }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);
const PAGINATION = { page: 1, limit: 25, total: 0, totalPages: 1 };

/** A route the server refuses to the Technician preset, and the grant its guard asks for. */
const REFUSED: Array<{ path: RegExp; needs: { action: string; subject: string } | 'estimates-scope-all' }> = [
  { path: /^\/api\/inventory\/vendors/, needs: { action: 'read', subject: 'Vendor' } },
  { path: /^\/api\/inventory\/vendor-categories/, needs: { action: 'read', subject: 'Vendor' } },
  { path: /^\/api\/inventory\/purchase-orders/, needs: { action: 'read', subject: 'PurchaseOrder' } },
  { path: /^\/api\/inventory\/jobs\/[^/]+\/material-cost/, needs: { action: 'read', subject: 'PurchaseOrder' } },
  { path: /^\/api\/customers(\/|\?|$)/, needs: { action: 'read', subject: 'Customer' } },
  { path: /^\/api\/invoices(\/|\?|$)/, needs: { action: 'read', subject: 'Invoice' } },
  { path: /^\/api\/locations(\/|\?|$)/, needs: { action: 'read', subject: 'Location' } },
  { path: /^\/api\/estimates\/creators$/, needs: 'estimates-scope-all' },
];

const JOB = {
  id: RECORD_ID, job_number: 'J00042', status: 'UNSCHEDULED', scope_notes: null, estimated_duration: null,
  completion_notes: null, scheduled_start: null, scheduled_end: null, started_at: null, completed_at: null,
  cancelled_at: null, cancelled_reason: null, created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z',
  customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com', phone: '5551234567' },
  assignees: [], service_location: null, estimate: null, invoices: [], tags: [], source_plan_id: null, source_plan: null,
  actions: ALL_JOB_ACTIONS, viewer_attached: true,
};

/** Lists the inventory module answers in a `{ data, meta }` envelope (an empty page is enough for these pages). */
const ENVELOPED = ['/api/inventory/low-stock', '/api/inventory/assets', '/api/inventory/movements', '/api/logistic-orders'];

let requested: string[] = [];

function serve() {
  requested = [];
  localStorage.clear();
  mockApi.get.mockImplementation(async (url: string) => {
    requested.push(url);
    if (url === '/api/permission-switches/me') return { data: technicianSwitchesAnswer() };
    if (url === '/api/jobs') return { data: { jobs: [], pagination: PAGINATION, stats: {}, users: [], departments: [], tags: [] } };
    if (url === '/api/leads') return { data: { leads: [], pagination: PAGINATION, stats: {}, users: [] } };
    if (url === '/api/estimates') return { data: { estimates: [], pagination: PAGINATION, stats: {}, users: [] } };
    if (url === '/api/tasks') return { data: { tasks: [], users: [] } };
    if (ENVELOPED.some((path) => url.startsWith(path))) {
      return { data: { data: [], meta: { page: 1, limit: 100, total: 0, totalPages: 1 }, page: 1, limit: 100, total: 0 } };
    }
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } };
    if (url.endsWith('/notes') || url.includes('/notes?')) return { data: { notes: [] } };
    if (/^\/api\/jobs\/[^/]+$/.test(url)) return { data: { job: JOB } };
    if (/^\/api\/leads\/[^/]+$/.test(url)) return { data: { lead: LEAD_FIXTURE } };
    return { data: {} };
  });
}

/** The person's own rule list, so each REFUSED entry is proved refused for them and not just assumed. */
function personHolds(needs: { action: string; subject: string }) {
  return technicianAbility().can(needs.action as never, needs.subject as never);
}

function refusedReads(): string[] {
  return [...new Set(requested)].filter((url) => REFUSED.some((r) => r.path.test(url)));
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function openEveryTab() {
  for (const tab of await screen.findAllByRole('tab')) {
    await userEvent.click(tab);
    await settle();
  }
}

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.clearAllMocks();
  serve();
});

describe('the refused-route list is true of the Technician preset', () => {
  it.each(REFUSED.filter((r) => r.needs !== 'estimates-scope-all'))('the person does not hold the grant behind $path', ({ needs }) => {
    expect(personHolds(needs as { action: string; subject: string })).toBe(false);
  });

  it('the person\'s Jobs scope, which estimates and invoices follow, is narrower than All', () => {
    expect(technicianSwitchesAnswer().values.jobs_scope).not.toBe('all');
  });
});

const LISTS: Array<[string, string, () => ReactElement]> = [
  ['Jobs', '/jobs', () => <JobsPage />],
  ['Leads', '/leads', () => <LeadsPage />],
  ['Estimates', '/estimates', () => <EstimatesPage />],
  ['Tasks', '/tasks', () => <TasksHubPage />],
  ['Schedule', '/schedule', () => <SchedulePage />],
];

describe('a Technician-preset person on the list pages', () => {
  it.each(LISTS)('%s makes no refused read', async (_name, path, page) => {
    renderWithProviders(page(), { initialEntries: [path], ability: technicianAbility() });
    await waitFor(() => expect(requested.some((url) => url.startsWith('/api/') && url !== '/api/organization')).toBe(true));
    await settle();

    expect(refusedReads()).toEqual([]);
  });
});

describe('a Technician-preset person on the Inventory pages', () => {
  it.each([
    ['Stock', '/inventory'],
    ['Staging', '/inventory/staging'],
    ['Assets', '/inventory/assets'],
    ['Low stock', '/inventory/low-stock'],
    ['Logistic Orders', '/inventory/logistic-orders'],
  ])('%s makes no refused read', async (_name, path) => {
    renderWithProviders(<InventoryPage />, { initialEntries: [path], ability: technicianAbility() });
    await waitFor(() => expect(requested).toContain('/api/permission-switches/me'));
    await settle();

    expect(refusedReads()).toEqual([]);
  });

  it('Price Book makes no refused read on any tab', async () => {
    renderWithProviders(<PriceBookPage />, { initialEntries: ['/inventory/price-book'], ability: technicianAbility() });
    await openEveryTab();

    expect(refusedReads()).toEqual([]);
  });
});

describe('a Technician-preset person on the record pages', () => {
  it('a job makes no refused read on any tab', async () => {
    renderWithProviders(<JobDetailPage />, { ability: technicianAbility() });
    await screen.findByRole('tab', { name: /Overview/ });
    await openEveryTab();

    expect(refusedReads()).toEqual([]);
  });

  it('a lead makes no refused read on any tab', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: technicianAbility() });
    await screen.findByRole('tab', { name: /Overview/ });
    await openEveryTab();

    expect(refusedReads()).toEqual([]);
  });
});
