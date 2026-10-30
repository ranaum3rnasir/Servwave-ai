/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.10 - the Office review queue tile on the routed home page: a count and the jobs that have
 * waited longest, each row opening the job at the address the server sent (the one that opens the review panel), "View
 * all" only when the server sent the Jobs list's address, and one plain line when nothing is waiting.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends. The
 * addresses in these answers are invented ones, so a page that sent anyone somewhere it knew would fail. The last case
 * follows a row all the way to the routed job page (pages/v2/jobs/JobDetailPage) and finds the review panel open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta } from '@/lib/api/dashboard';
import { renderWithProviders, serveDashboard } from '@/__tests__/helpers';
import DashboardPage from '../DashboardPage';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const ID = 'office_review_queue';

const meta = (link: string | null): DashboardTileMeta => ({ id: ID, category: 'office_review', mode: 'company', label: null, link });
const job = (n: number, age_days: number) => ({
  id: `job-${n}`, job_number: `J-${n}`, title: `Customer ${n}`, address: `${n} Main St, Testville`, age_days, link: `/sent-job/${n}?panel=sent`,
});
const answer = (link: string | null, data: unknown): DashboardResponse => ({
  tiles: [meta(link)],
  categories: [{ id: 'office_review', label: 'Office review' }],
  data: { [ID]: data } as DashboardResponse['data'],
  generated_at: '2026-10-12T10:00:00.000Z',
});

/** Shows where the page has been sent. */
function Where() {
  return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
}
const where = () => screen.getByTestId('where').textContent;

/** The page of a person whose saved layout holds the tile (as an Admin's or a Dispatcher's default does). */
function open(body: DashboardResponse) {
  serveDashboard(body, [{ id: ID, visible: true }]);
  renderWithProviders(<><DashboardPage /><Where /></>, { ability: ADMIN });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the Office review queue tile', () => {
  it('shows how many jobs are waiting and one row per job the server sent, each with its number, customer, place and wait', async () => {
    open(answer('/sent-jobs', { count: 7, jobs: [job(1, 9), job(2, 1), job(3, 0)] }));
    const tile = (await screen.findByRole('heading', { name: /Office review queue/ })).closest('[data-slot="card"]') as HTMLElement;
    expect(within(tile).getByText('7')).toBeInTheDocument();
    expect(within(tile).getByText('J-1')).toBeInTheDocument();
    expect(within(tile).getByText('Customer 1')).toBeInTheDocument();
    expect(within(tile).getByText('1 Main St, Testville')).toBeInTheDocument();
    expect(within(tile).getByText('9 days')).toBeInTheDocument();
    expect(within(tile).getByText('1 day')).toBeInTheDocument();
    expect(within(tile).getByText('Today')).toBeInTheDocument();
    // The tile draws the jobs it was sent and no wall: three rows, not seven.
    expect(within(tile).getAllByText(/^J-\d$/)).toHaveLength(3);
  });

  it('opens a row at the address the server sent, panel and all', async () => {
    open(answer('/sent-jobs', { count: 2, jobs: [job(1, 3), job(2, 2)] }));
    fireEvent.click((await screen.findByText('Customer 2')).closest('button')!);
    expect(where()).toBe('/sent-job/2?panel=sent');
  });

  it('sends "View all" to the address the server sent for the tile', async () => {
    open(answer('/sent-jobs?filter=sent', { count: 1, jobs: [job(1, 3)] }));
    fireEvent.click(await screen.findByRole('button', { name: 'View all' }));
    expect(where()).toBe('/sent-jobs?filter=sent');
  });

  it('offers no "View all" when the server sent no address for the tile, and the rows still open their jobs', async () => {
    open(answer(null, { count: 1, jobs: [job(1, 3)] }));
    const row = await screen.findByText('Customer 1');
    expect(screen.queryByRole('button', { name: 'View all' })).not.toBeInTheDocument();
    fireEvent.click(row.closest('button')!);
    expect(where()).toBe('/sent-job/1?panel=sent');
  });

  it('says so in one plain line when nothing is waiting, with no count and no rows', async () => {
    open(answer('/sent-jobs', { count: 0, jobs: [] }));
    expect(await screen.findByText('No jobs waiting for review')).toBeInTheDocument();
  });

  it('claims nothing before the first answer lands', async () => {
    vi.mocked(api.get).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    await screen.findByRole('button', { name: /Customize home page/ });
    expect(screen.queryByText('No jobs waiting for review')).not.toBeInTheDocument();
  });

  it('is offered by the picker under the Office review category the server named, and added from there', async () => {
    serveDashboard(answer('/sent-jobs', { count: 0, jobs: [] }), []);
    renderWithProviders(<DashboardPage />, { ability: ADMIN });
    fireEvent.click(await screen.findByRole('button', { name: /Customize home page/ }));
    const group = (await screen.findByText('Office review', { selector: '[data-testid="category-name"]' })).closest('[role="group"]') as HTMLElement;
    fireEvent.click(within(group).getByRole('button', { name: 'Add Office review queue' }));
    expect(await screen.findByText('No jobs waiting for review')).toBeInTheDocument();
  });
});

describe('a row of the Office review queue, followed to the routed job page', () => {
  const JOB_ID = 'job-1';
  const VISIT = {
    id: `${JOB_ID}-v1`, visit_seq: 1, status: 'COMPLETED', purpose: 'WORK',
    scheduled_at: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', is_all_day: false,
    en_route_at: null, on_site_at: null, started_at: null, completed_at: '2026-10-02T15:00:00.000Z', cancelled_at: null,
    customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
  };
  const jobAnswer = (actions: string[]) => ({
    id: JOB_ID, job_number: 'J-1', status: 'OFFICE_REVIEW', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: VISIT.scheduled_at, scheduled_end: VISIT.scheduled_end, started_at: null,
    completed_at: VISIT.completed_at, cancelled_at: null, cancelled_reason: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [VISIT], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null, locked: true, locked_actions: [], actions, new_visit_closed_reason: null,
  });
  const review = {
    summary: { status: 'OFFICE_REVIEW', visits: [], lines: [], discount_amount: 0, total: 0, invoices: [], balance: 0, file_count: 0, note_count: 0 },
    groups: [], version: 'version-1', totals: { items: 1, checked: 0, unusual: 0 }, round: null,
  };

  /** The home page and the job page, routed as the app routes them; the server's own link (as the tile row sends it) is the only way between. */
  function openFromTheTile(actions: string[]) {
    serveDashboard(answer('/jobs?in_office_review=true', { count: 1, jobs: [{ ...job(1, 3), id: JOB_ID, link: `/jobs/${JOB_ID}?panel=review` }] }), [{ id: ID, visible: true }]);
    const served = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(((url: string) => {
      if (url === `/api/jobs/${JOB_ID}/review`) return Promise.resolve({ data: { review } });
      if (url === `/api/jobs/${JOB_ID}/visits`) return Promise.resolve({ data: { visits: [VISIT] } });
      if (url.endsWith('/scopes') || url.endsWith('/line-items')) return Promise.resolve({ data: { scopes: [], lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } });
      if (url.includes(`/api/jobs/${JOB_ID}`)) return Promise.resolve({ data: { job: jobAnswer(actions) } });
      return served(url);
    }) as never);
    renderWithProviders(
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/jobs/:id" element={<JobDetailPage />} />
      </Routes>,
      { ability: ADMIN },
    );
  }

  it('opens the job with the review panel open for a person the job offers the review to', async () => {
    openFromTheTile(['office_review', 'finish_review']);
    fireEvent.click((await screen.findByText('Customer 1')).closest('button')!);
    expect(await screen.findByRole('dialog', { name: 'Office review' })).toBeInTheDocument();
  });

  it('opens just the job, with no panel and no error, for a person the job does not offer the review to', async () => {
    openFromTheTile(['edit']);
    fireEvent.click((await screen.findByText('Customer 1')).closest('button')!);
    expect(await screen.findByText('J-1', { selector: 'h1, h2, h3, [data-testid], span' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
