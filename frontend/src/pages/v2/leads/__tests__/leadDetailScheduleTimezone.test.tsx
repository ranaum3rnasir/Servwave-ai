/**
 * LeadDetailPage's Scheduled Start / End must render on the ORG clock (#1634),
 * the same clock the Created field nine lines above them already uses via
 * `formatDate(lead.created_at, tz)`. Before this fix they were a bare
 * `new Date(...).toLocaleString()` - no locale, no timeZone - so they leaked
 * the viewer's own zone right next to a field on the org's.
 *
 * Mirrors the org-zone pinning `__tests__/job-detail-schedule-timezone.test.tsx`
 * established for JobDetailPage: the org zone here is Asia/Manila, which
 * differs from every plausible CI runner zone (UTC, America/New_York), so
 * these assertions fail on browser-local behaviour rather than passing by
 * coincidence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import LeadDetailPage from '../LeadDetailPage';

const ORG_TZ = 'Asia/Manila'; // UTC+8, no DST

// 2026-08-24T22:00:00Z === 6:00 AM Aug 25 in Manila, but still 6:00 PM Aug 24
// in New York - a browser-local read prints the wrong DAY, not just the wrong
// hour, so this cannot pass by coincidence on any plausible runner zone.
const START_ISO = '2026-08-24T22:00:00.000Z';
// 2026-08-25T00:00:00Z === 8:00 AM Aug 25 in Manila, 8:00 PM Aug 24 in New York.
const END_ISO = '2026-08-25T00:00:00.000Z';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: LEAD_FIXTURE.id }),
  };
});

// useScheduleTimezone reads org.timezone through this module.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', timezone: ORG_TZ }, isLoading: false, isError: false }),
  };
});

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const LEAD = {
  ...LEAD_FIXTURE,
  scheduled_start: START_ISO,
  scheduled_end: END_ISO,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/leads/')) return { data: { lead: LEAD } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
});

describe('LeadDetailPage schedule rendering honours the org timezone', () => {
  it('renders Scheduled Start / End on the org clock, not the browser clock', async () => {
    const { container } = renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // Loaded signal: the Service Request paragraph only appears once the lead
    // query resolves, so waiting on it avoids racing the Scheduled fields.
    await screen.findByText('AC not cooling');

    expect(container.textContent).toContain('Scheduled Start: Aug 25, 2026, 6:00 AM');
    expect(container.textContent).toContain('End: Aug 25, 2026, 8:00 AM');
    // The browser-local (New York) reading these leaked before the fix.
    expect(container.textContent).not.toContain('Aug 24, 2026, 6:00 PM');
    expect(container.textContent).not.toContain('Aug 24, 2026, 8:00 PM');
  });
});
