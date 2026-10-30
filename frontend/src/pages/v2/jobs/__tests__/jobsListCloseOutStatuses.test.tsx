/**
 * Roles & Permissions, PRD 6, S06.1 - the routed Jobs list shows the three close-out statuses under their own names.
 *
 * Office review, Ready to close and Done each read as their own label on the status chip in the list, next to
 * Completed, which keeps its word. No job status reads "Lost" or "Closed".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import JobsPage from '../JobsPage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockApi = vi.mocked(api);

const row = (n: number, status: string) => ({
  id: `j000000${n}-0000-0000-0000-000000000001`,
  job_number: `J0000${n}`,
  status,
  scheduled_start: '2026-07-20T09:00:00.000Z',
  created_at: '2026-07-15T00:00:00.000Z',
  customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, customer_number: 'C00001' },
  assignees: [],
  service_location: null,
});

const STATUSES: [string, string][] = [
  ['COMPLETED', 'Completed'],
  ['OFFICE_REVIEW', 'Office review'],
  ['READY_TO_CLOSE', 'Ready to close'],
  ['DONE', 'Done'],
];

const JOB_LIST = {
  jobs: STATUSES.map(([status], i) => row(i + 1, status)),
  pagination: { page: 1, limit: 25, total: STATUSES.length, totalPages: 1 },
  stats: { unassigned: 0, scheduled: 0, in_progress: 0, completed: 1, cancelled: 0, need_invoices: 0 },
  users: [],
  departments: [],
  tags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  mockApi.get.mockResolvedValue({ data: JOB_LIST });
});

describe('Jobs list - the close-out statuses', () => {
  it.each(STATUSES)('shows a %s job as "%s"', async (status, label) => {
    renderWithProviders(<JobsPage />, { ability: buildAbility([{ action: 'read', subject: 'Job' }]), initialEntries: ['/jobs'] });
    await screen.findByText('J00001');

    const index = STATUSES.findIndex(([s]) => s === status) + 1;
    const rowEl = screen.getByText(`J0000${index}`).closest('tr');
    expect(rowEl, 'the job row').not.toBeNull();
    expect(rowEl!.textContent).toContain(label);
    // A close-out status never leaks as its enum name, "Lost" or "Closed".
    expect(rowEl!.textContent).not.toMatch(/OFFICE_REVIEW|READY_TO_CLOSE|\bLost\b|\bClosed\b/);
  });
});
