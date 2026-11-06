// BOOKING A WALKTHROUGH CARRIES ITS NOTES. The booking form's box is "Walkthrough notes", open to anyone who may
// book (an Admin included) on a lead with no walkthrough and after the only walkthrough was cancelled; its text is
// sent with the booking. "Book Another Visit" sends its notes too. A reschedule has no such box and sends none.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';
import { draftStorageKey, readDraft, writeDraft } from '@/lib/drafts/fieldDraftStore';
import { WalkthroughTabContent } from '../components/walkthroughTab';

const SALES = { id: 'u-sales', first_name: 'Sam', last_name: 'Sales' };

vi.mock('@/lib/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/users')>()),
  useAssignableUsers: () => ({ data: [{ ...SALES, role: 'SALES', department: null }, { id: 'u-tech', first_name: 'Terry', last_name: 'Tech', role: 'TECHNICIAN', department: null }] }),
}));
vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));
vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn().mockResolvedValue({ data: {} }), get: vi.fn().mockResolvedValue({ data: [] }) },
}));
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const booker = buildAbility([{ action: 'read', subject: 'Lead' }, { action: 'schedule_walkthrough', subject: 'Lead' }]);
// An Admin holds Book walkthroughs and may name anyone (Assign work to other people needs View jobs).
const admin = buildAbility([{ action: 'read', subject: 'Lead' }, { action: 'schedule_walkthrough', subject: 'Lead' }, { action: 'assign', subject: 'User' }, { action: 'read', subject: 'Job' }]);

const NONE = {
  walkthrough_scheduled_at: null, walkthrough_completed_at: null, walkthrough_cancelled_at: null,
  walkthrough_duration_minutes: null, walkthrough_notes: null, walkthrough_performers: [],
};
// The only walkthrough was cancelled; its notes are still on the lead's current-walkthrough fields.
const CANCELLED = { ...NONE, walkthrough_cancelled_at: '2026-09-01T15:00:00.000Z', walkthrough_notes: 'Notes of the cancelled one' };
const BOOKED = {
  ...NONE, walkthrough_scheduled_at: '2026-09-10T15:00:00.000Z', walkthrough_duration_minutes: 60,
  walkthrough_notes: 'Notes of the booked one', walkthrough_performers: [{ user: SALES }],
};

function renderTab(lead: Record<string, unknown>, ability = booker, canSchedule = true) {
  return renderWithProviders(
    <WalkthroughTabContent lead={lead} leadId="lead-1" canPerformWalkthrough={false} canScheduleWalkthrough={canSchedule} />,
    { ability },
  );
}
const fillTime = async (user: ReturnType<typeof userEvent.setup>, scope: HTMLElement) => {
  const [date, time] = within(scope).getAllByRole('textbox').filter((el) => (el as HTMLInputElement).type !== 'hidden');
  await user.type(date!, '10/02/2026');
  await user.type(time!, '09:00 AM');
};
const postTo = (suffix: string) => vi.mocked(api.post).mock.calls.find(([url]) => String(url).endsWith(suffix));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({ user: { ...SALES, email: 's@test.com', role: 'SALES', organization_id: 'org-1' }, isAuthenticated: true, isLoading: false, error: null } as never),
  );
});

describe.each([
  ['a lead with no walkthrough', NONE],
  ['a lead whose only walkthrough was cancelled', CANCELLED],
])('the booking form on %s', (_name, lead) => {
  it.each([['a booker', booker], ['an Admin', admin]])('gives %s an open Walkthrough notes box whose text is sent with the booking', async (_who, ability) => {
    renderTab(lead, ability);
    const box = screen.getByRole('textbox', { name: 'Walkthrough notes' });
    expect(box).toBeEnabled();
    // Not the cancelled walkthrough's notes carried onto the next booking.
    expect(box).toHaveValue('');

    const user = userEvent.setup();
    await user.type(box, 'Gate code is on the side door');
    // An Admin may name anyone, so the Performers field starts empty (a booker is seeded with themselves).
    const performers = screen.getByRole('combobox', { name: /performers/i });
    if (!(performers as HTMLInputElement).disabled) {
      await user.click(performers);
      await user.click(await screen.findByRole('option', { name: /Terry Tech/ }));
    }
    await fillTime(user, document.body);
    await user.click(screen.getByRole('button', { name: /Schedule Walkthrough/i }));

    const call = postTo('/walkthrough/schedule');
    expect(call).toBeTruthy();
    expect((call![1] as { notes?: string }).notes).toBe('Gate code is on the side door');
  });

  it('shows no box to a viewer who may not book', () => {
    renderTab(lead, booker, false);
    expect(screen.queryByRole('textbox', { name: 'Walkthrough notes' })).not.toBeInTheDocument();
  });
});

describe('Book Another Visit', () => {
  it('has a Walkthrough notes box and sends its text as notes to the extra-visit door', async () => {
    renderTab(BOOKED);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Book Another Visit/i }));
    const form = screen.getByText('Additional Visit').closest('div')!;
    await user.type(within(form).getByRole('textbox', { name: 'Walkthrough notes' }), 'Measure the side gate too');
    await fillTime(user, form);
    await user.click(within(form).getByRole('button', { name: /Book Visit/i }));

    const call = postTo('/visits');
    expect(call).toBeTruthy();
    expect((call![1] as { notes?: string }).notes).toBe('Measure the side gate too');
  });
});

describe('rescheduling a booked walkthrough', () => {
  it('has no booking notes box and sends no notes', async () => {
    renderTab(BOOKED);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));
    expect(screen.queryByRole('textbox', { name: 'Walkthrough notes' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save New Time/i }));
    const call = postTo('/walkthrough/schedule');
    expect(call).toBeTruthy();
    expect(call![1]).not.toHaveProperty('notes');
  });
});

const draftKey = (field: string) =>
  draftStorageKey({ organizationId: 'org-1', userId: SALES.id, recordType: 'LEAD', recordId: 'lead-1', field });

describe('the unsent booking notes draft', () => {
  it('survives a reschedule that sends no notes', async () => {
    writeDraft(draftKey('walkthrough_booking_notes'), 'Typed but never sent');
    renderTab(BOOKED);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));
    await user.click(screen.getByRole('button', { name: /Save New Time/i }));
    expect(postTo('/walkthrough/schedule')![1]).not.toHaveProperty('notes');
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(readDraft(draftKey('walkthrough_booking_notes'))).toBe('Typed but never sent');
  });

  it('is cleared once a real booking has sent its notes', async () => {
    renderTab(NONE, admin);
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Walkthrough notes' }), 'Sent with the booking');
    await waitFor(() => expect(readDraft(draftKey('walkthrough_booking_notes'))).toBe('Sent with the booking'));
    await user.click(await screen.findByRole('combobox', { name: /performers/i }));
    await user.click(await screen.findByRole('option', { name: /Terry Tech/ }));
    await fillTime(user, document.body);
    await user.click(screen.getByRole('button', { name: /Schedule Walkthrough/i }));
    expect((postTo('/walkthrough/schedule')![1] as { notes?: string }).notes).toBe('Sent with the booking');
    await waitFor(() => expect(readDraft(draftKey('walkthrough_booking_notes'))).toBeNull());
  });

  it('is its own per form: Book Another Visit and the main booking box do not share text', async () => {
    writeDraft(draftKey('walkthrough_booking_notes'), 'Main booking text');
    renderTab(BOOKED);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Book Another Visit/i }));
    const box = screen.getByRole('textbox', { name: 'Walkthrough notes' });
    expect(box).toHaveValue('');
    await user.type(box, 'Extra visit text');
    await waitFor(() => expect(readDraft(draftKey('walkthrough_booking_notes'))).toBe('Main booking text'));
    cleanup();

    renderTab(NONE);
    expect(screen.getByRole('textbox', { name: 'Walkthrough notes' })).toHaveValue('Main booking text');
  });
});
