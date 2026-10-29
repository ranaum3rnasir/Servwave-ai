/**
 * Every walkthrough-visit write made from the LEAD page refreshes the customer page
 * (visits-and-task-categories slice 01). See the job-page suite beside this one for the defect.
 *
 * The lead page used to refresh only `['lead', id]`, so the customer page's Leads tab and the
 * scheduler's walkthrough lanes kept serving the pre-booking copy for five minutes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { expectCustomerPageStale, seedCustomerPage } from '@/__tests__/support/customerPageCache';
import { WalkthroughTabContent } from '@/pages/v2/leads/components/walkthroughTab';
import {
  CancelLeadDialog, CancelWalkthroughDialog, DeleteLeadDialog, MarkLostDialog,
} from '@/pages/v2/leads/components/leadDialogs';

vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) => (
    <button type="button" onClick={() => onChange(['user-2'])}>performers:{value.join(',') || 'none'}</button>
  ),
}));

vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const post = vi.mocked(api.post);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const UNSCHEDULED_LEAD = {
  walkthrough_scheduled_at: null,
  walkthrough_completed_at: null,
  walkthrough_cancelled_at: null,
  walkthrough_duration_minutes: null,
  walkthrough_notes: '',
  walkthrough_performers: [],
};

const SCHEDULED_LEAD = {
  ...UNSCHEDULED_LEAD,
  walkthrough_scheduled_at: '2026-10-02T13:00:00.000Z',
  walkthrough_duration_minutes: 60,
  walkthrough_performers: [{ user: { id: 'user-1', first_name: 'Pat', last_name: 'Sample' } }],
};

function renderTab(lead: Record<string, unknown>) {
  return renderWithProviders(
    <WalkthroughTabContent lead={lead} leadId="lead-1" canPerformWalkthrough canScheduleWalkthrough />,
    { ability: adminAbility },
  );
}

/** A scheduling form's performer (stubbed picker) and its first two textboxes: start date, then start time. */
async function fillStart(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement) {
  await user.click(within(scope).getByRole('button', { name: /^performers:/ }));
  const [date, time] = within(scope)
    .getAllByRole('textbox')
    .filter((el) => (el as HTMLInputElement).type !== 'hidden');
  await user.type(date!, '10/02/2026');
  await user.tab();
  await user.type(time!, '9:00 AM');
  await user.tab();
}

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: {} });
});

describe('the lead "Book Visit" form', () => {
  it('booking the walkthrough marks the customer page stale', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderTab(UNSCHEDULED_LEAD);
    seedCustomerPage(queryClient);

    await fillStart(user, document.body);
    await user.click(screen.getByRole('button', { name: 'Schedule Walkthrough' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/leads/lead-1/walkthrough/schedule', expect.anything()));
    await expectCustomerPageStale(queryClient);
  });

  it('rescheduling the walkthrough marks the customer page stale', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderTab(SCHEDULED_LEAD);
    seedCustomerPage(queryClient);

    await user.click(screen.getByRole('button', { name: /Reschedule/i }));
    await user.click(screen.getByRole('button', { name: /Save New Time/i }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/leads/lead-1/walkthrough/schedule', expect.anything()));
    await expectCustomerPageStale(queryClient);
  });

  it('booking another visit marks the customer page stale', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderTab(SCHEDULED_LEAD);
    seedCustomerPage(queryClient);

    await user.click(screen.getByRole('button', { name: /Book Another Visit/i }));
    const form = screen.getByText('Additional Visit').closest('div')!;
    await fillStart(user, form);
    await user.click(within(form).getByRole('button', { name: /Book Visit/i }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/leads/lead-1/visits', expect.anything()));
    await expectCustomerPageStale(queryClient);
  });

  it('completing the walkthrough marks the customer page stale', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderTab(SCHEDULED_LEAD);
    seedCustomerPage(queryClient);

    await user.click(screen.getByRole('button', { name: 'Complete' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/leads/lead-1/walkthrough/complete'));
    await expectCustomerPageStale(queryClient);
  });
});

describe('the lead page "Cancel Walkthrough" dialog', () => {
  it('cancelling the walkthrough marks the customer page stale', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(
      <CancelWalkthroughDialog open onOpenChange={() => {}} leadId="lead-1" />,
    );
    seedCustomerPage(queryClient);

    await user.type(screen.getByRole('textbox'), 'Customer postponed');
    await user.click(screen.getByRole('button', { name: /Cancel Walkthrough/i }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/leads/lead-1/walkthrough/cancel', expect.anything()));
    await expectCustomerPageStale(queryClient);
  });
});

/**
 * Leaving the lead - lost or cancelled - auto-cancels its scheduled walkthrough visit in the same
 * transaction (lead.controller markLost / cancelLead -> cancelLiveWalkthroughsOnLeadExit),
 * so both are visit writes.
 */
describe('the lead page "Mark Lost" and "Cancel Lead" dialogs', () => {
  it('marking the lead lost marks the customer page stale', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<MarkLostDialog open onOpenChange={() => {}} leadId="lead-1" />);
    seedCustomerPage(queryClient);

    await user.type(screen.getByPlaceholderText('Why was this lead lost?'), 'Went with another company');
    await user.click(screen.getByRole('button', { name: 'Mark Lost' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/leads/lead-1/mark-lost', expect.anything()));
    await expectCustomerPageStale(queryClient);
  });

  it('cancelling the lead marks the customer page stale', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<CancelLeadDialog open onOpenChange={() => {}} leadId="lead-1" />);
    seedCustomerPage(queryClient);

    await user.type(screen.getByPlaceholderText('Why is this lead being cancelled?'), 'Duplicate request');
    await user.click(screen.getByRole('button', { name: 'Cancel Lead' }));

    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/leads/lead-1/cancel', expect.anything()));
    await expectCustomerPageStale(queryClient);
  });
});

describe('the lead page "Delete Lead" dialog', () => {
  // A hard delete takes the lead's walkthrough visits with it.
  it('deleting the lead marks the customer page stale', async () => {
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(
      <DeleteLeadDialog open onOpenChange={() => {}} leadId="lead-1" onDeleted={() => {}} />,
    );
    seedCustomerPage(queryClient);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/leads/lead-1'));
    await expectCustomerPageStale(queryClient);
  });

  // Code review #11: the deleted lead's own query is dropped, not invalidated - an invalidated
  // query still on screen refetches at once, a 404 for a lead that no longer exists.
  it('drops the deleted lead\'s own query instead of refetching it', async () => {
    vi.mocked(api.delete).mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(
      <DeleteLeadDialog open onOpenChange={() => {}} leadId="lead-1" onDeleted={() => {}} />,
    );
    queryClient.setQueryDefaults(['lead', 'lead-1'], { gcTime: Infinity });
    queryClient.setQueryData(['lead', 'lead-1'], { lead: { id: 'lead-1' } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(queryClient.getQueryState(['lead', 'lead-1'])).toBeUndefined());
    expect(invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey))).not.toContain(JSON.stringify(['lead', 'lead-1']));
    // The leads list still refreshes: the lead left it.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['leads'] });
  });
});
