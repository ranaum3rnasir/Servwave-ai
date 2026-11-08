// A scheduled walkthrough used to be a dead end: the tab printed its start and a raw minute
// count and offered no way to move it. The only way out was Cancel Walkthrough, which cancels
// the visit row - mailing the customer a cancellation and leaving a junk CANCELLED row in the
// history - before booking a fresh one.
//
// Nothing on the server ever required that. POST /api/leads/:id/walkthrough/schedule reuses the
// lead's live visit row (walkthrough.service.ts, scheduleActiveWalkthrough: "a genuine reschedule
// of the SAME visit"), reports conflicts and honours `force`. These pin the UI onto the endpoint
// that was already there (#1632), and pin the summary to a real end rather than a duration the
// reader has to add up (#1633).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import LeadDetailPage from '../LeadDetailPage';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));

vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/components/crm/AttachmentSection', () => ({ AttachmentSection: () => null }));

// The real picker fetches the assignable roster; these tests are about the times.
vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) => (
    <button type="button" onClick={() => onChange(['user-2'])}>performers:{value.join(',') || 'none'}</button>
  ),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }) };
});

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
// Everything a walkthrough performer holds, and nothing that books one - the strict-TECHNICIAN
// split the tab already encodes: `perform_walkthrough` without `schedule_walkthrough`.
const performerOnlyAbility = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'perform_walkthrough', subject: 'Lead' },
]);

/** 9:00 AM America/New_York on 2026-09-01, the org zone every scheduling surface resolves against. */
const SCHEDULED_AT = '2026-09-01T13:00:00.000Z';
const DURATION_MINUTES = 150;

function scheduledLead(overrides: Record<string, unknown> = {}) {
  return {
    ...LEAD_FIXTURE,
    status: 'CONTACTED',
    walkthrough_scheduled_at: SCHEDULED_AT,
    walkthrough_duration_minutes: DURATION_MINUTES,
    walkthrough_completed_at: null,
    walkthrough_cancelled_at: null,
    walkthrough_performers: [{ user: { id: 'user-1', first_name: 'Art', last_name: 'Nakamura' } }],
    walkthrough_count: 1,
    ...overrides,
  };
}

function mockLead(lead: Record<string, unknown>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: [] } };
    if (url.includes('/api/users')) return { data: { users: [] } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    if (url.includes('/api/leads/')) return { data: { lead } };
    return { data: {} };
  });
}

import { DEFAULT_SCHEDULE_TIMEZONE, formatInstant } from '@/lib/schedule-tz';

function displayed(iso: string) {
  return formatInstant(iso, DEFAULT_SCHEDULE_TIMEZONE, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function openWalkthroughTab(user: ReturnType<typeof userEvent.setup>, ability = adminAbility) {
  renderWithProviders(<LeadDetailPage />, { ability });
  await user.click(await screen.findByRole('tab', { name: /walkthrough/i }));
}

/** The tab's [start date, start time, end date, end time] inputs, in DOM order. */
function timeFields() {
  return screen.getAllByRole('textbox').filter(
    (el) => (el as HTMLInputElement).placeholder === 'MM/DD/YYYY' || (el as HTMLInputElement).placeholder === 'Time',
  ) as HTMLInputElement[];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLead(scheduledLead());
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('v2 LeadDetailPage - a scheduled walkthrough reports when it ends (#1633)', () => {
  it('shows a start and an end instead of a raw duration', async () => {
    const user = userEvent.setup();
    await openWalkthroughTab(user);

    expect(screen.getByText(/^Starts:/)).toBeInTheDocument();
    expect(screen.getByText(/^Ends:/)).toBeInTheDocument();
    expect(screen.queryByText(/^Duration:/)).not.toBeInTheDocument();

    // 9:00 AM + 150 minutes.
    expect(screen.getByText(displayed(SCHEDULED_AT))).toBeInTheDocument();
    expect(screen.getByText(displayed('2026-09-01T15:30:00.000Z'))).toBeInTheDocument();
  });

  it('names the day a visit running past midnight actually ends on', async () => {
    // 26 hours cannot fit inside one calendar day in ANY zone, so the end date must differ from
    // the start date wherever this test runs.
    mockLead(scheduledLead({ walkthrough_duration_minutes: 26 * 60 }));
    const user = userEvent.setup();
    await openWalkthroughTab(user);

    const endText = displayed('2026-09-02T15:00:00.000Z');
    expect(screen.getByText(endText)).toBeInTheDocument();

    const dayOf = (text: string) => text.split(',').slice(0, 2).join(',');
    expect(dayOf(endText)).not.toBe(dayOf(displayed(SCHEDULED_AT)));
  });
});

describe('v2 LeadDetailPage - rescheduling a walkthrough (#1632)', () => {
  it('keeps Schedule Info read-only until Reschedule is asked for', async () => {
    const user = userEvent.setup();
    await openWalkthroughTab(user);

    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Reschedule/i }));

    expect(screen.getByLabelText('Start date')).toBeInTheDocument();
    expect(screen.getByLabelText('End date')).toBeInTheDocument();
  });

  it('seeds the form from the booking it is about to move', async () => {
    const user = userEvent.setup();
    await openWalkthroughTab(user);
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));

    const [startDate, startTime, , endTime] = timeFields();
    expect(startDate!.value).toBe('09/01/2026');
    expect(startTime!.value).toBe('9:00 AM');
    expect(endTime!.value).toBe('11:30 AM');
    expect(screen.getByText('performers:user-1')).toBeInTheDocument();
  });

  it('moves the SAME visit through /walkthrough/schedule rather than booking a second one', async () => {
    const user = userEvent.setup();
    await openWalkthroughTab(user);
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));

    const [, startTime] = timeFields();
    await user.clear(startTime!);
    await user.type(startTime!, '10:00 AM');
    await user.tab();

    await user.click(screen.getByRole('button', { name: /Save New Time/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    const [url, payload] = mockApi.post.mock.calls[0]!;
    expect(String(url)).toContain('/walkthrough/schedule');
    // 10:00 AM EDT, and the duration survives the move because the end was dragged with it.
    expect((payload as Record<string, unknown>).walkthrough_scheduled_at).toBe('2026-09-01T14:00:00.000Z');
    expect((payload as Record<string, unknown>).walkthrough_duration_minutes).toBe(DURATION_MINUTES);
    expect((payload as Record<string, unknown>).force).toBeUndefined();
  });

  it('backs out without posting, and without keeping the abandoned edit', async () => {
    const user = userEvent.setup();
    await openWalkthroughTab(user);
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));

    const [, startTime] = timeFields();
    await user.clear(startTime!);
    await user.type(startTime!, '4:00 PM');
    await user.tab();

    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));

    expect(mockApi.post).not.toHaveBeenCalled();
    expect(screen.getByText(displayed(SCHEDULED_AT))).toBeInTheDocument();

    // Re-opening shows the STORED time, not the 4:00 PM nobody saved.
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));
    expect(timeFields()[1]!.value).toBe('9:00 AM');
  });

  it('offers no Reschedule to someone who may perform a walkthrough but not book one', async () => {
    const user = userEvent.setup();
    await openWalkthroughTab(user, performerOnlyAbility);

    expect(screen.getByText(/^Starts:/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reschedule/i })).not.toBeInTheDocument();
  });
});

describe('v2 LeadDetailPage - a reschedule that collides (#1632)', () => {
  const conflict = {
    type: 'job' as const,
    id: 'j0000000-0000-0000-0000-000000000001',
    number: 'J00042',
    start: '2026-09-01T13:00:00.000Z',
    end: '2026-09-01T15:00:00.000Z',
  };

  it('names the clashing booking and gets through it with force', async () => {
    mockApi.post
      .mockRejectedValueOnce({
        response: { status: 409, data: { error: 'Schedule conflict detected', conflicts: [conflict] } },
      })
      .mockResolvedValue({ data: {} });

    const user = userEvent.setup();
    await openWalkthroughTab(user);
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));
    await user.click(screen.getByRole('button', { name: /Save New Time/i }));

    const panel = await screen.findByText(/Scheduling conflict/i);
    expect(panel).toBeInTheDocument();
    expect(screen.getByText('J00042')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Schedule anyway/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
    const [, forced] = mockApi.post.mock.calls[1]!;
    expect((forced as Record<string, unknown>).force).toBe(true);
    // The override re-posts the SAME slot - it overrules the verdict, it does not edit the ask.
    expect((forced as Record<string, unknown>).walkthrough_scheduled_at).toBe(SCHEDULED_AT);
  });

  it('retires a conflict verdict once the fields it judged have changed', async () => {
    mockApi.post.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'Schedule conflict detected', conflicts: [conflict] } },
    });

    const user = userEvent.setup();
    await openWalkthroughTab(user);
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));
    await user.click(screen.getByRole('button', { name: /Save New Time/i }));
    await screen.findByText(/Scheduling conflict/i);

    const [, startTime] = timeFields();
    await user.clear(startTime!);
    await user.type(startTime!, '6:00 PM');
    await user.tab();

    expect(screen.queryByText(/Scheduling conflict/i)).not.toBeInTheDocument();
  });

  it('reports a non-conflict failure as a plain error, not as a conflict', async () => {
    mockApi.post.mockRejectedValueOnce({
      response: { status: 500, data: { error: 'Something broke' } },
    });

    const user = userEvent.setup();
    await openWalkthroughTab(user);
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));
    await user.click(screen.getByRole('button', { name: /Save New Time/i }));

    expect(await screen.findByText('Something broke')).toBeInTheDocument();
    expect(screen.queryByText(/Scheduling conflict/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Schedule anyway/i })).not.toBeInTheDocument();
  });
});

describe('v2 LeadDetailPage - a completed walkthrough (#1633)', () => {
  it('reports its end the same way the scheduled one does', async () => {
    mockLead(scheduledLead({ walkthrough_completed_at: '2026-09-01T15:30:00.000Z' }));
    const user = userEvent.setup();
    await openWalkthroughTab(user);

    const summary = screen.getByText(/^Ends:/).closest('div')!;
    expect(within(summary).getByText(displayed('2026-09-01T15:30:00.000Z'))).toBeInTheDocument();
    expect(screen.queryByText(/^Duration:/)).not.toBeInTheDocument();
    // A finished visit is not reschedulable - there is no live row to move.
    expect(screen.queryByRole('button', { name: /Reschedule/i })).not.toBeInTheDocument();
  });
});

/**
 * Scheduling-notifications slice 09: the live row's Cancel opens the page's own cancel dialog
 * (the one with the reason box), and is offered only to a viewer holding `cancel Lead` - the
 * gate POST /api/leads/:id/walkthrough/cancel rides.
 */
describe('v2 LeadDetailPage - the walkthrough row\'s Cancel is the page\'s dialog (slice 09)', () => {
  it('opens the Cancel Walkthrough dialog from the row\'s office group', async () => {
    const user = userEvent.setup();
    await openWalkthroughTab(user);

    const office = await screen.findByRole('group', { name: 'Office actions' });
    await user.click(within(office).getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('dialog', { name: /Cancel Walkthrough/i })).toBeInTheDocument();
  });

  it('offers no Cancel on the row to a viewer who may book but not cancel', async () => {
    const user = userEvent.setup();
    await openWalkthroughTab(user, buildAbility([
      { action: 'read', subject: 'all' },
      { action: 'schedule_walkthrough', subject: 'Lead' },
    ]));

    const office = await screen.findByRole('group', { name: 'Office actions' });
    expect(within(office).getByRole('button', { name: /Reschedule/ })).toBeInTheDocument();
    expect(within(office).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
