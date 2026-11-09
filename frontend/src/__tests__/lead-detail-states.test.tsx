import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LEAD_FIXTURE } from './helpers';
import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/leadDetailRouter')).leadDetailRouter());

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('lead-detail-multi-visit', () => {
  /**
   * Multi-visit spec slice S1, the lead-page half of the tracer bullet.
   *
   * A lead can now hold SEVERAL live visits at once (user story 7: pre-book the follow-up while
   * still on site for the first). The page has to show all of them, not just the one the legacy
   * flat `walkthrough_*` fields resolve to.
   *
   * Driven through the rendered page - what a user can actually read on screen - so it survives any
   * reshuffle of how the visit list is derived internally.
   *
   * Against the ROUTED page (`pages/v2/leads/LeadDetailPage`, what `/leads/:id` mounts). It used
   * to import the unrouted `pages/LeadDetailPage`, so S1 was being proved on a page no user could
   * open.
   */

  stubBrowser();

  const FIRST_VISIT = {
    id: 'v-1',
    status: 'SCHEDULED',
    scheduled_at: '2026-09-01T14:00:00.000Z',
    duration_minutes: 60,
    completed_at: null,
    cancelled_at: null,
    cancelled_reason: null,
    created_at: '2026-08-20T10:00:00.000Z',
  };

  const SECOND_VISIT = {
    ...FIRST_VISIT,
    id: 'v-2',
    scheduled_at: '2026-09-08T14:00:00.000Z',
    created_at: '2026-08-20T11:00:00.000Z',
  };

  function mockLeadWithVisits(visits: Array<Record<string, unknown>>) {
    serveLeadDetail({
      lead: {
        ...LEAD_FIXTURE,
        status: 'CONTACTED',
        // The legacy flat fields still describe the CURRENT (earliest live) visit.
        walkthrough_scheduled_at: visits[0]?.scheduled_at ?? null,
        walkthrough_completed_at: null,
        walkthrough_cancelled_at: null,
        walkthrough_count: visits.length,
        walkthrough_history: visits,
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('v2 LeadDetailPage - a lead holding several live visits (S1)', () => {
    it('counts every visit, including a second live one', async () => {
      mockLeadWithVisits([FIRST_VISIT, SECOND_VISIT]);
      renderLeadDetail();
      // The visit list lives in the Walkthrough tab, which mounts its content only once active.
      await userEvent.click(await screen.findByRole('tab', { name: /walkthrough/i }));

      expect(await screen.findByText(/2 Visits Total/i)).toBeInTheDocument();
    });

    it('lists the SECOND live visit behind the disclosure, not only the current one', async () => {
      // The defect this guards: the history filter dropped every SCHEDULED row whenever the
      // current visit was itself scheduled, which under the old one-live-visit invariant removed
      // exactly the row already shown above - and under multi-visit hides real, booked trips.
      mockLeadWithVisits([FIRST_VISIT, SECOND_VISIT]);
      renderLeadDetail();
      // The visit list lives in the Walkthrough tab, which mounts its content only once active.
      await userEvent.click(await screen.findByRole('tab', { name: /walkthrough/i }));

      await userEvent.click(await screen.findByText(/2 Visits Total/i));

      // Sep 8 is the second booking; it must be readable somewhere on the page.
      expect(await screen.findByText(/Sep 8, 2026/i)).toBeInTheDocument();
      // ...and it must NOT report "No earlier visits", which is what the old filter produced.
      expect(screen.queryByText(/No earlier visits/i)).not.toBeInTheDocument();
    });
  });
});

describe('lead-detail-walkthrough-dot', () => {
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

  stubBrowser();

  // Action surfaces on this page gate on CASL ability, so render with a
  // full-access ability to keep the tab strip fully mounted.

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
    serveLeadDetail({
      lead: {
        ...LEAD_FIXTURE,
        status: 'CONTACTED',
        walkthrough_scheduled_at: scheduledAt,
        walkthrough_completed_at: completedAt,
        walkthrough_cancelled_at: cancelledAt,
      },
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
        renderLeadDetail();

        const dot = await screen.findByTestId('walkthrough-dot');
        expect(dot.className).toContain(expected);
      }
    );

    it('covers every combination the three timestamps can produce that the component actually branches on', () => {
      expect(MATRIX).toHaveLength(6);
    });
  });
});
