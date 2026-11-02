/**
 * Roles & Permissions S06.2 - the routed Jobs, Job Statistics and Commissions reports call finished work "Completed".
 *
 * "Done" names only the Done status (PRD 6, "Completion words"), so no label for the Completed status may read "Done",
 * "Jobs Done" or "Closed". The Jobs report is rendered against the server's real answer (the server labels a job in
 * Completed, Office review, Ready to close or Done "Completed"); the other two are the routed demo pages.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, fireEvent, waitFor } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/axios', () => ({ default: { get } }));
// A real org reads the live rows; a demo org would read the sample rows.
vi.mock('@/lib/useIsDemoOrg', () => ({ useIsDemoOrg: () => false }));
// Charts measure their container; jsdom has none.
vi.mock('recharts', async (orig) => {
  const actual = await orig<typeof import('recharts')>();
  return { ...actual, ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

import JobsReport from '../JobsReport';
import JobStatisticsReport from '../JobStatisticsReport';
import CommissionsReport from '../CommissionsReport';

const jobRow = (n: number, status: string) => ({
  jobNumber: n, jobName: `Gate repair ${n}`, client: `Acme ${n}`, email: '', phone: '', tags: [], type: '', status,
  tech: [], createdBy: '', address: '', source: '', origin: '',
  createdAt: '2026-10-01T10:00:00.000Z', scheduledAt: '2026-10-02T10:00:00.000Z', endAt: '2026-10-02T11:00:00.000Z',
  billed: 1080, paid: 0, subtotal: 1000, tax: 80, tip: 0, itemCost: 0, laborCost: 0, cardExpenses: 0, techExpenses: 0, profit: 920,
});

const ABILITY = buildAbility([
  { action: 'read', subject: 'Report' }, { action: 'read', subject: 'Pricing' }, { action: 'read', subject: 'CompanyFigures' },
  // See costs and See company figures need See prices.
  { action: 'read', subject: 'Prices' },
]);

beforeEach(() => {
  get.mockReset();
  try {
    localStorage.setItem('jobsReport.visibleFields.v1', JSON.stringify(['jobNumber', 'client', 'status']));
  } catch { /* ignore */ }
});

describe('Jobs report (routed page)', () => {
  it('counts the jobs the server calls Completed on a "Completed" tile, and no tile or pill reads "Done"', async () => {
    get.mockResolvedValue({ data: { jobs: [jobRow(1, 'Completed'), jobRow(2, 'Completed'), jobRow(3, 'Submitted')] } });
    const { container } = renderWithProviders(<JobsReport />, { ability: ABILITY });

    await screen.findByText('Acme 1');
    const tile = screen.getByRole('button', { name: /^Completed/ });
    expect(tile.textContent).toContain('2');
    expect(within(container).getAllByText('Completed').length).toBeGreaterThanOrEqual(3);
    expect(container.textContent).not.toMatch(/\bDone\b/);

    // Pressing the tile narrows the table to exactly those jobs.
    fireEvent.click(tile);
    await waitFor(() => expect(screen.queryByText('Acme 3')).toBeNull());
    expect(screen.getByText('Acme 1')).toBeInTheDocument();
    expect(screen.getByText('Acme 2')).toBeInTheDocument();
  });
});

describe('Job Statistics report (routed page)', () => {
  it('words the completed counts "Completed", never "Done" or "Jobs Done"', () => {
    const { container } = renderWithProviders(<JobStatisticsReport />, { ability: ABILITY });
    expect(screen.getByText('Jobs Completed')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Jobs Done|Done Jobs|\bDone\b|\bdone jobs?\b/);
  });
});

describe('Commissions report (routed page)', () => {
  it('words the status and the date column "Completed", never "Closed" or "Done"', () => {
    const { container } = renderWithProviders(<CommissionsReport />, { ability: ABILITY });
    expect(screen.getByRole('radio', { name: 'Completed' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\bClosed\b|\bDone\b/);
  });
});
