import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE } from './helpers';
import { buildAbility } from '@/lib/ability';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';

// Appearance matrix for the walkthrough tab-trigger dot on the ROUTED lead detail page
// (`pages/v2/leads/LeadDetailPage`, the one `/leads/:id` mounts). This file used to import
// the unrouted `pages/LeadDetailPage`, so the whole matrix ran against a page no user could
// open while its routed twin was free to drift.
//
// Walkthrough-as-entity redesign, PR-C2: WALKTHROUGH_SCHEDULED left LeadStatus, so the dot no
// longer reads lead.status AT ALL - it is driven purely by three independent, current-visit-
// projected timestamps (walkthrough_scheduled_at / walkthrough_completed_at /
// walkthrough_cancelled_at), and the ORDER in which the component tests them is load-bearing.
// A CANCELLED visit keeps its scheduled_at set (kept as D15 history so the backend can still
// resolve it as "the most recent visit that happened"), so scheduledAt alone is not "still
// scheduled" - completedAt must be checked before scheduledAt, and cancelledAt must be excluded
// before scheduledAt reads as an active, upcoming visit. The matrix below is a full cross of the
// three booleans (present/absent), not a LeadStatus sweep - the dot has no LeadStatus input to
// sweep anymore.
//
// This file deliberately does not import from lead-detail-page.test.tsx: that
// file exports nothing, so its mock preamble is replicated here rather than
// shared.

// Org-level comms access - held off so the call-entry surface stays out of the
// way; this file only cares about the walkthrough dot.
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));

vi.mock('@/lib/communication/phoneTabHandoff', () => ({
  requestCall: vi.fn(),
}));

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({
  JobLeadTasksTab: () => null,
}));

vi.mock('@/components/communication/LeadCommunicationsTab', () => ({
  LeadCommunicationsTab: () => null,
}));

// floating-ui (under the Radix dropdown) calls `new ResizeObserver(...)`.
// The shared setup file installs a constructable class stub already; this
// local copy mirrors the preamble in lead-detail-page.test.tsx so the file
// stands alone if that setup ever changes.
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
    useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }),
  };
});

const mockApi = vi.mocked(api);

// Action surfaces on this page gate on CASL ability, so render with a
// full-access ability to keep the tab strip fully mounted.
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// A timestamp is only ever present or absent - the value itself is never read
// for appearance, only its truthiness.
const STAMPED = '2026-02-01T10:00:00.000Z';

/**
 * The full cross of the three current-visit-projected timestamps being absent
 * or present, with the expected dot fill spelled literally per row. lead.status
 * is fixed at CONTACTED throughout (an arbitrary non-terminal stand-in) - the
 * dot has no LeadStatus input to sweep since PR-C2. Every expected value comes
 * from the design-token layer.
 */
const MATRIX: Array<[
  scheduledAt: string | null,
  completedAt: string | null,
  cancelledAt: string | null,
  expected: string,
]> = [
  [null, null, null, 'bg-muted'],
  // Actively scheduled: the only combination that reads info.
  [STAMPED, null, null, 'bg-status-blue'],
  // Completed always wins, whether or not scheduledAt is also (still) set.
  [null, STAMPED, null, 'bg-status-green'],
  [STAMPED, STAMPED, null, 'bg-status-green'],
  // The regression guard: cancelledAt must exclude scheduledAt from reading as
  // still-scheduled. A CANCELLED visit keeps scheduled_at set (D15 history), so
  // this is the exact shape the backend actually projects for one.
  [STAMPED, null, STAMPED, 'bg-muted'],
  [null, null, STAMPED, 'bg-muted'],
];

function mockLead(scheduledAt: string | null, completedAt: string | null, cancelledAt: string | null) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) {
      return { data: { notes: [] } };
    }
    if (url.includes('/api/users')) {
      return { data: { users: [] } };
    }
    if (url.includes('/api/leads/')) {
      return {
        data: {
          lead: {
            ...LEAD_FIXTURE,
            status: 'CONTACTED',
            walkthrough_scheduled_at: scheduledAt,
            walkthrough_completed_at: completedAt,
            walkthrough_cancelled_at: cancelledAt,
          },
        },
      };
    }
    if (url.includes('/api/tags')) {
      return { data: { tags: [] } };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('v2 LeadDetailPage walkthrough dot', () => {
  it.each(MATRIX)(
    'scheduledAt %s, completedAt %s, cancelledAt %s renders %s',
    async (scheduledAt, completedAt, cancelledAt, expected) => {
      mockLead(scheduledAt, completedAt, cancelledAt);
      renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

      const dot = await screen.findByTestId('walkthrough-dot');
      expect(dot.className).toContain(expected);
    }
  );

  it('covers every combination the three timestamps can produce that the component actually branches on', () => {
    expect(MATRIX).toHaveLength(6);
  });
});
