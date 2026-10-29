/**
 * The leads list's CSV export, `toExportRow` in LeadsPage.tsx. Every date on
 * this page except one now renders through the ORG zone (#1634) - but
 * `created_at` here is the deliberate holdout: "when was this row made" is a
 * viewer-local fact, the same ruling the parallel jobs-list PR applies to its
 * own `created_at`. See the contract report for the full argument.
 *
 * This pins that the CSV `Created` column is UNCHANGED: still the browser's
 * own `toLocaleDateString()`, not routed through `formatDate`/org tz. The org
 * zone is deliberately set to a DIFFERENT zone than the stubbed viewer zone,
 * so a future accidental re-route to the org zone would flip this red instead
 * of passing by coincidence.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import LeadsPage from '../LeadsPage';

// Viewer/browser clock, pinned like format-date.test.ts pins it: TZ is
// normally unset, so vi.stubEnv (not a manual save/restore) is what leaves it
// clean afterwards - see that file's comment on why unstubAllEnvs is required.
beforeAll(() => {
  vi.stubEnv('TZ', 'America/New_York');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

// 2026-08-24T22:00:00Z is Aug 24 in America/New_York (the stubbed viewer zone)
// and already Aug 25 in Asia/Manila (the mocked ORG zone below) - the
// discriminating instant that proves which clock actually rendered this.
const CREATED_AT = '2026-08-24T22:00:00.000Z';

const hoisted = vi.hoisted(() => ({
  toCSV: vi.fn((_rows: Record<string, unknown>[]) => 'csv-content'),
  downloadCSV: vi.fn(),
}));
vi.mock('@/lib/inventory/csv', () => ({
  toCSV: hoisted.toCSV,
  downloadCSV: hoisted.downloadCSV,
}));

// useScheduleTimezone / the page's own org lookups both read this. The org
// zone is Manila - deliberately NOT the stubbed viewer zone above - so the two
// clocks disagree on this instant's calendar day.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({
      data: { id: 'org-1', timezone: 'Asia/Manila', source_options: [], job_type_options: [] },
      isLoading: false,
      isError: false,
    }),
  };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const LEAD_ROW = {
  id: 'e0000000-0000-0000-0000-000000000001',
  lead_number: 'L00001',
  status: 'NEW',
  service_request: 'AC not cooling',
  job_type: null,
  service_city: 'Austin',
  service_state: 'TX',
  walkthrough_scheduled_at: null,
  walkthrough_completed_at: null,
  contacted_at: null,
  service_location_id: null,
  created_at: CREATED_AT,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: 'Doe HVAC',
    phone: '5551234567',
    customer_number: 'C-1',
    ad_source: null,
  },
  commission_owner: null,
  lead_assignees: [],
  estimates: [],
};

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/leads') {
      return {
        data: {
          leads: [LEAD_ROW],
          pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
          stats: { total: 1, new_this_week: 0, unassigned: 0, won: 0, lost: 0 },
        },
      };
    }
    if (url.includes('/api/users')) return { data: { users: [] } };
    return { data: {} };
  });
});

describe('LeadsPage CSV export - created_at (#1634 deliberate holdout)', () => {
  it('renders Created on the browser clock, not the org clock', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadsPage />);

    await screen.findByText('AC not cooling');

    await user.click(screen.getByRole('button', { name: /^export$/i }));
    await user.click(await screen.findByRole('menuitem', { name: /current page/i }));

    expect(hoisted.toCSV).toHaveBeenCalledTimes(1);
    const [rows] = hoisted.toCSV.mock.calls[0]!;
    const created = (rows[0] as Record<string, unknown>).Created as string;

    // Viewer zone (New York): still Aug 24. Org zone (Manila): already Aug 25.
    // toLocaleDateString() carries no month name, so this also rules out the
    // "Aug 25, 2026" shape formatDate/formatInstant would have produced.
    expect(created).toContain('24');
    expect(created).not.toContain('25');
    expect(created).not.toMatch(/[A-Za-z]/);
  });
});

describe('LeadsPage CSV export - Status column (walkthrough lead statuses)', () => {
  it.each([
    ['WALKTHROUGH_SCHEDULED', 'Walkthrough Scheduled'],
    ['WALKTHROUGH_COMPLETED', 'Walkthrough Completed'],
    ['ESTIMATED', 'Estimate Sent'],
  ])('writes the label for %s, never the raw value', async (status, label) => {
    const user = userEvent.setup();
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === '/api/leads') {
        return {
          data: {
            leads: [{ ...LEAD_ROW, status }],
            pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
            stats: { total: 1, new_this_week: 0, unassigned: 0, won: 0, lost: 0 },
          },
        };
      }
      if (url.includes('/api/users')) return { data: { users: [] } };
      return { data: {} };
    });
    renderWithProviders(<LeadsPage />);
    await screen.findByText('AC not cooling');

    await user.click(screen.getByRole('button', { name: /^export$/i }));
    await user.click(await screen.findByRole('menuitem', { name: /current page/i }));

    const [rows] = hoisted.toCSV.mock.calls.at(-1)!;
    expect((rows[0] as Record<string, unknown>).Status).toBe(label);
  });
});
