/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions S09.14 - the words on the routed home page: "Unassigned" is gone, and the tiles use PRD 6's
 * completion words. Collected Today counts "jobs completed", the pipeline stage reads "Job completed", and a Today's
 * Schedule pill says "Completed" for a job in Completed, Office review or Ready to close, and "Done" only for a job
 * whose status is Done.
 *
 * The page is the routed one (pages/v2/dashboard/DashboardPage), against the JSON shape GET /api/dashboard sends.
 * The last block reads the dashboard's source files, so a word put back in any of them fails here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { screen } from '@testing-library/react';

import { buildAbility } from '@/lib/ability';
import type { DashboardResponse, DashboardTileMeta, TechSchedule } from '@/lib/api/dashboard';
import { renderWithProviders, serveDashboard } from '@/__tests__/helpers';
import DashboardPage from '../DashboardPage';

vi.hoisted(() => {
  vi.stubEnv('VITE_DASHBOARD_USE_MOCK', 'false');
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const meta = (id: string, category: DashboardTileMeta['category']): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link: null });
const answer = (tiles: DashboardTileMeta[], data: Record<string, unknown>): DashboardResponse => ({
  tiles,
  categories: [{ id: 'jobs', label: 'Jobs' }, { id: 'invoices_and_payments', label: 'Invoices and payments' }],
  data: data as DashboardResponse['data'],
  generated_at: '2026-10-12T10:00:00.000Z',
});
function open(tileIds: Array<[string, DashboardTileMeta['category']]>, data: Record<string, unknown>) {
  serveDashboard(answer(tileIds.map(([id, category]) => meta(id, category)), data), tileIds.map(([id]) => ({ id, visible: true })));
  renderWithProviders(<DashboardPage />, { ability: ADMIN });
}

const entry = (id: string, status: string, customer: string) => ({
  id, job_number: `J-${id}`, status, scope_notes: null, scheduled_start: '2026-10-12T14:00:00.000Z', scheduled_end: '2026-10-12T15:00:00.000Z',
  customer_name: customer, address: null, entity: 'job' as const, link: `/jobs/${id}`,
});
const pillOf = (customer: string) => screen.getByText(customer).closest('button')!.querySelector('span.uppercase')!.textContent;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Collected Today', () => {
  it('reads "N jobs completed" under the amount, never "jobs done"', async () => {
    open([['kpi.collected_today', 'invoices_and_payments']], { 'kpi.collected_today': { amount: 1200, jobs_done: 5 } });
    expect(await screen.findByText('5 jobs completed')).toBeInTheDocument();
    expect(screen.queryByText(/jobs done/i)).not.toBeInTheDocument();
  });
});

describe('the Revenue Pipeline', () => {
  it('draws the stage the server calls "Job completed" under that name', async () => {
    open([['pipeline', 'jobs']], {
      pipeline: [
        { key: 'leads', label: 'Leads', kind: 'count', value: 3, link: null },
        { key: 'job', label: 'Job completed', kind: 'amount', value: 2900, link: null },
      ],
    });
    expect(await screen.findByText('Job completed')).toBeInTheDocument();
    expect(screen.queryByText('Job done')).not.toBeInTheDocument();
  });
});

describe("Today's Schedule", () => {
  const lanes = (): TechSchedule[] => [
    {
      user_id: 'u-1', first_name: 'Ann', last_name: 'Ames',
      jobs: [
        entry('a1', 'COMPLETED', 'Completed Customer'),
        entry('a2', 'OFFICE_REVIEW', 'Review Customer'),
        entry('a3', 'READY_TO_CLOSE', 'Ready Customer'),
        entry('a4', 'DONE', 'Done Customer'),
        entry('a5', 'SCHEDULED', 'Scheduled Customer'),
        entry('a6', 'IN_PROGRESS', 'Working Customer'),
      ],
    },
    { user_id: null, first_name: 'No crew', last_name: '', jobs: [entry('n1', 'SCHEDULED', 'Crewless Customer')] },
  ];

  it('says "Completed" for a job in Completed, Office review or Ready to close, and "Done" only for a Done job', async () => {
    open([['schedule_today', 'jobs']], { schedule_today: lanes() });
    await screen.findByText('Completed Customer');
    expect(pillOf('Completed Customer')).toBe('Completed');
    expect(pillOf('Review Customer')).toBe('Completed');
    expect(pillOf('Ready Customer')).toBe('Completed');
    expect(pillOf('Done Customer')).toBe('Done');
    expect(pillOf('Scheduled Customer')).toBe('Scheduled');
    expect(pillOf('Working Customer')).toBe('In Progress');
  });

  it('paints every finished job in the finished colours, whichever close-out status it is in', async () => {
    open([['schedule_today', 'jobs']], { schedule_today: lanes() });
    await screen.findByText('Completed Customer');
    for (const customer of ['Completed Customer', 'Review Customer', 'Ready Customer', 'Done Customer']) {
      expect(screen.getByText(customer).closest('button')!.className, customer).toContain('bg-sage-50');
    }
    expect(screen.getByText('Scheduled Customer').closest('button')!.className).not.toContain('bg-sage-50');
  });

  it('names the lane the server calls "No crew" and draws no "Unassigned" anywhere on the page', async () => {
    open([['schedule_today', 'jobs']], { schedule_today: lanes() });
    expect(await screen.findByText('No crew')).toBeInTheDocument();
    expect(screen.queryByText(/unassigned/i)).not.toBeInTheDocument();
  });
});

describe('the dashboard\'s source files', () => {
  const root = join(__dirname, '../../../..');
  const folders = ['pages/v2/dashboard', 'components/dashboard', 'lib/api/_mock/dashboard'];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('finds the files it is meant to guard', () => {
    const files = folders.flatMap((folder) => sourceFiles(join(root, folder)));
    expect(files.some((f) => f.endsWith('pages/v2/dashboard/DashboardPage.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('components/dashboard/widgetRegistry.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('lib/api/_mock/dashboard/seed.ts'))).toBe(true);
  });

  it('holds the word "unassigned" in no dashboard file: the empty slot is named for what is missing', () => {
    const hits = folders
      .flatMap((folder) => sourceFiles(join(root, folder)))
      .flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (/unassign/i.test(line) ? [`${file.replace(root, 'src')}:${i + 1}: ${line.trim()}`] : [])));
    expect(hits).toEqual([]);
  });

  it('says "jobs done" and "Job done" in no dashboard file', () => {
    const hits = folders
      .flatMap((folder) => sourceFiles(join(root, folder)))
      .flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line, i) => (/jobs done|job done/i.test(line) ? [`${file.replace(root, 'src')}:${i + 1}: ${line.trim()}`] : [])));
    expect(hits).toEqual([]);
  });
});
