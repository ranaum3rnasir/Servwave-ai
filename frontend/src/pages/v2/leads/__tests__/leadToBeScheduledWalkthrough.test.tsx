import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuthStore } from '@/stores/auth.store';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { LEAD_FIXTURE } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { renderLeadDetail, serveLeadDetail } from '@/__tests__/harness/leadDetailPage';
import { getWalkthroughDisplay } from '@/pages/v2/leads/leadsColumns';
import { formatDateForInput } from '@/lib/date-input';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }) };
});

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

describe('leadToBeScheduledWalkthrough', () => {
  /**
   * Roles & Permissions, PRD 3, slice S03.19 - a walkthrough with performers and no time reads "To be scheduled".
   * Rendered through the routed lead page (the one /leads/:id mounts): the Overview's walkthrough strip, the tab's
   * dot and the Walkthrough tab itself, and the Leads list's Walkthrough column. Setting the time later is a
   * booking, so the control that does it shows only with Book walkthroughs.
   */

  const mockApi = vi.mocked(api);

  const PERFORMER = { id: 'u-perf', first_name: 'Pat', last_name: 'Performer' };
  const READ = { action: 'read', subject: 'Lead' } as const;
  // Assign work to other people needs View jobs.
  const withBooking = buildAbility([
    READ,
    { action: 'schedule_walkthrough', subject: 'Lead' },
    { action: 'assign', subject: 'User' },
    { action: 'read', subject: 'Job' },
  ]);
  const withoutBooking = buildAbility([READ, { action: 'perform_walkthrough', subject: 'Lead' }]);

  /** What the server projects for a lead whose live walkthrough has performers and no time. */
  const TO_BE_SCHEDULED = {
    walkthrough_scheduled_at: null,
    walkthrough_to_be_scheduled: true,
    walkthrough_completed_at: null,
    walkthrough_cancelled_at: null,
    walkthrough_duration_minutes: null,
    walkthrough_notes: null,
    walkthrough_performers: [{ user: PERFORMER }],
    walkthrough_count: 1,
    walkthrough_history: [{ id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: null, duration_minutes: null, completed_at: null, cancelled_at: null, cancelled_reason: null, created_at: '2026-01-16T00:00:00.000Z' }],
  };

  function serverHolds(lead: Record<string, unknown>) {
    serveLeadDetail({ lead: { ...LEAD_FIXTURE, status: 'WALKTHROUGH_SCHEDULED', ...lead }, notes: [] });
    mockApi.post.mockResolvedValue({ data: {} });
  }

  const openWalkthroughTab = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('tab', { name: /walkthrough/i }));
    return screen.getByRole('tabpanel', { name: /walkthrough/i });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  });

  describe('a lead whose walkthrough has performers and no time', () => {
    it('reads "To be scheduled" with its performers on the Overview strip, not "No walkthrough scheduled yet"', async () => {
      serverHolds(TO_BE_SCHEDULED);
      renderLeadDetail({ ability: withBooking });

      expect(await screen.findByText('To be scheduled')).toBeInTheDocument();
      expect(screen.getByText(/with Pat Performer/)).toBeInTheDocument();
      expect(screen.queryByText(/No walkthrough scheduled yet/)).toBeNull();
    });

    it('shows the live (blue) dot on the Walkthrough tab', async () => {
      serverHolds(TO_BE_SCHEDULED);
      renderLeadDetail({ ability: withBooking });

      expect((await screen.findByTestId('walkthrough-dot')).className).toContain('bg-status-blue');
    });

    it('reads "To be scheduled" on the Walkthrough tab, names the performers and offers no scheduling form until asked', async () => {
      serverHolds(TO_BE_SCHEDULED);
      const user = userEvent.setup();
      renderLeadDetail({ ability: withBooking });
      const tab = await openWalkthroughTab(user);

      expect(within(tab).getByText('To be scheduled')).toBeInTheDocument();
      expect(within(tab).getByText('Pat Performer')).toBeInTheDocument();
      expect(within(tab).queryByRole('button', { name: /^schedule walkthrough$/i })).toBeNull();
      expect(within(tab).getByRole('button', { name: /set time/i })).toBeInTheDocument();
    });

    it('lets a person with Book walkthroughs set the time: it posts the time with the same performers', async () => {
      serverHolds(TO_BE_SCHEDULED);
      const user = userEvent.setup();
      renderLeadDetail({ ability: withBooking });
      const tab = await openWalkthroughTab(user);
      await user.click(within(tab).getByRole('button', { name: /set time/i }));
      await user.type(within(tab).getByLabelText('Start date'), formatDateForInput('2031-05-14'));
      await user.tab();
      await user.click(within(tab).getByRole('button', { name: /save time/i }));

      await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(
        '/api/leads/e0000000-0000-0000-0000-000000000001/walkthrough/schedule',
        expect.objectContaining({ performer_ids: [PERFORMER.id], walkthrough_scheduled_at: expect.any(String) }),
      ));
    });

    it('offers a person without Book walkthroughs no way to set the time, but still shows the state', async () => {
      serverHolds(TO_BE_SCHEDULED);
      const user = userEvent.setup();
      renderLeadDetail({ ability: withoutBooking });
      const tab = await openWalkthroughTab(user);

      expect(within(tab).getByText('To be scheduled')).toBeInTheDocument();
      expect(within(tab).queryByRole('button', { name: /set time/i })).toBeNull();
      expect(within(tab).queryByRole('button', { name: /reschedule/i })).toBeNull();
    });

    it('is not "To be scheduled" once the walkthrough has a time', async () => {
      serverHolds({ ...TO_BE_SCHEDULED, walkthrough_to_be_scheduled: false, walkthrough_scheduled_at: '2031-05-14T15:00:00.000Z', walkthrough_duration_minutes: 60 });
      renderLeadDetail({ ability: withBooking });

      expect(await screen.findByText(/^Scheduled for/)).toBeInTheDocument();
      expect(screen.queryByText('To be scheduled')).toBeNull();
    });
  });

  describe('the Leads list Walkthrough column', () => {
    const lead = { status: 'WALKTHROUGH_SCHEDULED', walkthrough_scheduled_at: null, walkthrough_completed_at: null } as unknown as Parameters<typeof getWalkthroughDisplay>[0];

    it('says "To be scheduled" for a walkthrough with performers and no time, not "Needs Sched."', () => {
      expect(getWalkthroughDisplay({ ...lead, walkthrough_to_be_scheduled: true }, 'America/New_York').text).toBe('To be scheduled');
    });

    it('still says "Needs Sched." for a lead with no walkthrough at all', () => {
      expect(getWalkthroughDisplay({ ...lead, walkthrough_to_be_scheduled: false }, 'America/New_York').text).toBe('Needs Sched.');
    });
  });
});
