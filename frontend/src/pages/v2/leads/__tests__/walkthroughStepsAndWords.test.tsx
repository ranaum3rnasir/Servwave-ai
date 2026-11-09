import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuthStore } from '@/stores/auth.store';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { LEAD_FIXTURE } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';
import { WALKTHROUGH_FILTERS } from '@/lib/filters/registries/leads';

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
vi.mock('@/components/crm/AttachmentSection', () => ({ AttachmentSection: () => null }));
vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: () => <div>performers</div>,
}));

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

describe('walkthroughSteps', () => {
  /**
   * Walkthrough steps follow the crew of the walkthrough acted on (Roles & Permissions, PRD 4, S04.19), on the ROUTED lead
   * page.
   *
   * The lead detail response lists the walkthrough steps the server will let THIS person take: noting the current
   * walkthrough and finishing the scheduled one, each only for a person on that walkthrough's crew or holding Update
   * any visit's status. The page offers no step the list leaves out, so the lead's Owner who is not on the crew is not
   * shown a Finish walkthrough button the route would refuse. Editing the lead is a different switch: a person doing only the
   * walkthrough still notes and finishes it. Cancelling a walkthrough rides Book walkthroughs, never a lead-cancel grant.
   * A response without the list (an older server) falls back to what the person's grants say.
   */

  stubBrowser();

  /** Everything a person doing only the walkthrough holds: no Edit leads, no Book walkthroughs. */
  const performerOnlyRules = [
    { action: 'read', subject: 'Lead' },
    { action: 'perform_walkthrough', subject: 'Lead' },
  ] as const;
  const performerOnly = buildAbility([...performerOnlyRules]);
  /** A person who books walkthroughs and holds Edit leads, with no hold on performing them. */
  const booker = buildAbility([
    { action: 'read', subject: 'Lead' },
    { action: 'update', subject: 'Lead' },
    { action: 'schedule_walkthrough', subject: 'Lead' },
  ]);
  /** The old lead-cancel grant and Edit leads, but no Book walkthroughs: nothing the walkthrough cancel rides. */
  const oldCancelOnly = buildAbility([
    { action: 'read', subject: 'Lead' },
    { action: 'update', subject: 'Lead' },
    { action: 'cancel', subject: 'Lead' },
  ]);

  const scheduledLead = (extra: Record<string, unknown> = {}) => ({
    ...LEAD_FIXTURE,
    status: 'WALKTHROUGH_SCHEDULED',
    estimates: [],
    walkthrough_scheduled_at: '2026-09-01T13:00:00.000Z',
    walkthrough_duration_minutes: 60,
    walkthrough_completed_at: null,
    walkthrough_cancelled_at: null,
    walkthrough_notes: '',
    walkthrough_performers: [{ user: { id: 'user-1', first_name: 'Ran', last_name: 'Roffe' } }],
    ...extra,
  });

  function serve(lead: unknown) {
    serveLeadDetail({ lead });
  }

  async function openWalkthroughTab(ability: ReturnType<typeof buildAbility>) {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLeadDetail({ ability });
    await user.click(await screen.findByRole('tab', { name: /walkthrough/i }));
    return user;
  }

  const kebabItems = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: /Lead actions/i }));
    return (await screen.findAllByRole('menuitem')).map((i) => i.textContent?.trim());
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('the walkthrough tab, from the lead\'s action list', () => {
    it('offers no Finish walkthrough and no notes box to a person with Perform walkthroughs who is not on this walkthrough', async () => {
      serve(scheduledLead({ actions: [] }));
      await openWalkthroughTab(performerOnly);

      await screen.findByText(/^Starts:/);
      expect(screen.queryByRole('button', { name: 'Finish walkthrough' })).toBeNull();
      expect(screen.queryByPlaceholderText('Walkthrough notes...')).toBeNull();
    });

    it('offers Finish walkthrough and no notes box when the server lists both steps', async () => {
      serve(scheduledLead({ actions: ['walkthrough_notes', 'walkthrough_finish'] }));
      await openWalkthroughTab(performerOnly);

      expect(await screen.findByRole('button', { name: 'Finish walkthrough' })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Walkthrough notes...')).toBeNull();
    });

    it('offers neither Finish walkthrough nor a notes box when the server lists the note step alone', async () => {
      serve(scheduledLead({ actions: ['walkthrough_notes'] }));
      await openWalkthroughTab(performerOnly);

      await screen.findByText(/^Starts:/);
      expect(screen.queryByRole('button', { name: 'Finish walkthrough' })).toBeNull();
      expect(screen.queryByPlaceholderText('Walkthrough notes...')).toBeNull();
    });

    it('lets a person with Edit leads off, on a lead someone else assigned, finish the walkthrough, with no notes box, and offers no Edit', async () => {
      serve(scheduledLead({ actions: ['walkthrough_notes', 'walkthrough_finish'] }));
      // Assign keeps the header menu from being empty, so a missing Edit is a real absence.
      const user = await openWalkthroughTab(buildAbility([...performerOnlyRules, { action: 'assign', subject: 'Lead' }]));

      expect(await screen.findByRole('button', { name: 'Finish walkthrough' })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Walkthrough notes...')).toBeNull();
      expect(await kebabItems(user)).not.toContain('Edit');
    });

    it('falls back to what the grants say when the response carries no list', async () => {
      serve(scheduledLead());
      await openWalkthroughTab(performerOnly);

      expect(await screen.findByRole('button', { name: 'Finish walkthrough' })).toBeInTheDocument();
    });
  });

  describe('cancelling and rescheduling a walkthrough ride Book walkthroughs', () => {
    it('offers Reschedule and Cancel, on the row and in the header menu, to a person with Book walkthroughs and no lead-cancel grant', async () => {
      serve(scheduledLead({ actions: [] }));
      const user = await openWalkthroughTab(booker);

      const office = await screen.findByRole('group', { name: 'Office actions' });
      expect(within(office).getByRole('button', { name: /Reschedule/ })).toBeInTheDocument();
      expect(within(office).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(await kebabItems(user)).toContain('Cancel Walkthrough');
    });

    it('offers a Book walkthroughs holder the header Cancel Walkthrough even with Edit leads off', async () => {
      serve(scheduledLead({ actions: [] }));
      const bookerNoEdit = buildAbility([{ action: 'read', subject: 'Lead' }, { action: 'schedule_walkthrough', subject: 'Lead' }]);
      const user = await openWalkthroughTab(bookerNoEdit);

      await screen.findByRole('group', { name: 'Office actions' });
      expect(await kebabItems(user)).toContain('Cancel Walkthrough');
    });

    it('offers a Book walkthroughs holder the header Cancel Walkthrough on a walkthrough still waiting for its time, and nobody without it', async () => {
      const toBeScheduled = { walkthrough_scheduled_at: null, walkthrough_to_be_scheduled: true, actions: [] };
      serve(scheduledLead(toBeScheduled));
      const bookerNoEdit = buildAbility([{ action: 'read', subject: 'Lead' }, { action: 'schedule_walkthrough', subject: 'Lead' }]);
      const user = await openWalkthroughTab(bookerNoEdit);
      await screen.findByRole('group', { name: 'Office actions' });
      expect(await kebabItems(user)).toContain('Cancel Walkthrough');
    });

    it('offers an Edit leads holder without Book walkthroughs no Cancel Walkthrough on a walkthrough still waiting for its time', async () => {
      serve(scheduledLead({ walkthrough_scheduled_at: null, walkthrough_to_be_scheduled: true, actions: ['edit'] }));
      const user = await openWalkthroughTab(oldCancelOnly);
      expect(await kebabItems(user)).not.toContain('Cancel Walkthrough');
    });

    it('offers no Reschedule and no Cancel without Book walkthroughs, whatever else the person holds', async () => {
      serve(scheduledLead({ actions: ['edit'] }));
      const user = await openWalkthroughTab(oldCancelOnly);

      await screen.findByText(/^Starts:/);
      expect(screen.queryByRole('group', { name: 'Office actions' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Reschedule/ })).toBeNull();
      expect(await kebabItems(user)).not.toContain('Cancel Walkthrough');
    });
  });
});

describe('walkthroughWords', () => {
  /**
   * Walkthrough words (Roles & Permissions, PRD 4, S04.20), on the ROUTED lead page.
   *
   * A walkthrough is a visit on a lead, so it takes the visit word: its last step reads "Finish walkthrough" and a
   * finished one reads "Finished". "Completed" belongs to the job. The LEAD's own status, Walkthrough Completed,
   * is a different thing and keeps its name; every assertion about the walkthrough's own words is made inside the
   * walkthrough tab (and on the header line that sums it up), never on the lead's status chip.
   */

  stubBrowser();

  const mockApi = vi.mocked(api);

  const performer = buildAbility([
    { action: 'read', subject: 'Lead' },
    { action: 'perform_walkthrough', subject: 'Lead' },
  ]);

  const baseLead = {
    ...LEAD_FIXTURE,
    estimates: [],
    walkthrough_notes: '',
    walkthrough_cancelled_at: null,
    walkthrough_performers: [{ user: { id: 'user-1', first_name: 'Ran', last_name: 'Roffe' } }],
  };
  const scheduledLead = {
    ...baseLead,
    status: 'WALKTHROUGH_SCHEDULED',
    walkthrough_scheduled_at: '2026-09-01T13:00:00.000Z',
    walkthrough_duration_minutes: 60,
    walkthrough_completed_at: null,
    actions: ['walkthrough_notes', 'walkthrough_finish'],
  };
  const finishedLead = {
    ...baseLead,
    status: 'WALKTHROUGH_COMPLETED',
    walkthrough_scheduled_at: '2026-09-01T13:00:00.000Z',
    walkthrough_completed_at: '2026-09-01T14:30:00.000Z',
    walkthrough_count: 2,
    walkthrough_history: [
      { id: 'wt-1', status: 'COMPLETED', scheduled_at: '2026-08-20T13:00:00.000Z', completed_at: '2026-08-20T14:00:00.000Z', cancelled_at: null, created_at: '2026-08-19T09:00:00.000Z' },
      { id: 'wt-2', status: 'COMPLETED', scheduled_at: '2026-09-01T13:00:00.000Z', completed_at: '2026-09-01T14:30:00.000Z', cancelled_at: null, created_at: '2026-08-25T09:00:00.000Z' },
    ],
    actions: [],
  };

  function serve(lead: unknown) {
    serveLeadDetail({ lead });
  }

  async function openWalkthroughTab() {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLeadDetail({ ability: performer });
    await user.click(await screen.findByRole('tab', { name: /walkthrough/i }));
    return user;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('the walkthrough tab\'s words', () => {
    it('reads "Finish walkthrough" on the last step of a scheduled walkthrough, and nothing says Complete', async () => {
      serve(scheduledLead);
      await openWalkthroughTab();

      const panel = screen.getByRole('tabpanel');
      expect(await within(panel).findByRole('button', { name: 'Finish walkthrough' })).toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: /Complete/ })).toBeNull();
      expect(panel.textContent).not.toMatch(/Complet/);
    });

    it('says "Finishing..." while the step is being taken and "Failed to finish walkthrough" when it cannot be', async () => {
      serve(scheduledLead);
      mockApi.post.mockRejectedValue({ response: { status: 500, data: {} } });
      const user = await openWalkthroughTab();

      await user.click(await screen.findByRole('button', { name: 'Finish walkthrough' }));
      expect(await screen.findByText('Failed to finish walkthrough')).toBeInTheDocument();
      expect(mockApi.post).toHaveBeenCalledWith('/api/leads/e0000000-0000-0000-0000-000000000001/walkthrough/complete');
      expect(screen.getByRole('tabpanel').textContent).not.toMatch(/Complet/);
    });

    it('reads "Finished on" on a finished walkthrough, with no Complete anywhere in the tab', async () => {
      serve(finishedLead);
      await openWalkthroughTab();

      const panel = screen.getByRole('tabpanel');
      expect(await within(panel).findByText(/^Finished on /)).toBeInTheDocument();
      expect(panel.textContent).not.toMatch(/Complet/);
    });

    it('reads "Finished" on an earlier finished visit in the history', async () => {
      serve(finishedLead);
      const user = await openWalkthroughTab();

      await user.click(await screen.findByRole('button', { name: /2 Visits Total/ }));
      const panel = screen.getByRole('tabpanel');
      await waitFor(() => expect(within(panel).getByText(/^Finished Aug 20/)).toBeInTheDocument());
      expect(panel.textContent).not.toMatch(/Complet/);
    });
  });

  describe('the lead page header line for a finished walkthrough', () => {
    it('reads "Finished <date>" while the lead\'s own status keeps the name Walkthrough Completed', async () => {
      serve(finishedLead);
      renderLeadDetail({ ability: performer });

      expect(await screen.findByText(/^Finished Sep 1/)).toBeInTheDocument();
      expect(screen.queryByText(/^Completed /)).toBeNull();
      expect(screen.getAllByText('Walkthrough Completed').length).toBeGreaterThan(0);
    });
  });

  describe('the Leads list Walkthrough filter', () => {
    it('offers "Finished" for a finished walkthrough, on the same value as before', () => {
      const finished = WALKTHROUGH_FILTERS.find((o) => o.value === 'completed');
      expect(finished?.label).toBe('Finished');
      expect(WALKTHROUGH_FILTERS.map((o) => o.label)).not.toContain('Completed');
    });
  });
});
