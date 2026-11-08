// BOOKING A SECOND VISIT — the door the tab had no button for.
//
// Reported by the product owner during manual QA of row 017: "there is no way to add more visits."
// It was never a permission bug. `POST /api/leads/:id/visits` has worked since S7 and answers 201
// to a rep booking themselves; nothing in `frontend/src` ever called it. So it was missing for a
// dispatcher exactly as much as for a salesperson, and there was nothing role-shaped to unblock.
//
// THE ONE THING THAT IS EASY TO GET WRONG, and the reason this suite exists rather than a single
// smoke test: `createVisit` calls `validatePerformers(req, assignee_ids)` with NO current-roster
// argument. A brand-new trip restates nothing, so the "an unchanged restatement is not a crew
// statement" exemption does not apply to this door. Seeding this form from the LIVE visit's crew
// would therefore hand a self-only rep a technician they may not name, locked, with no remove
// control — and the POST would come back 403. That is exactly the dead end the cancelled-visit
// repro produced on the other door, one door over. `openAddVisit` must seed from EMPTY.
//
// Renders the real `MultiAssigneeSelect` (mocking only the roster endpoint behind it), because
// two sibling suites stub that component with a button ignoring `disabled` and are blind to all
// of this.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';
import { WalkthroughTabContent } from '../components/walkthroughTab';

const SALES = { id: 'u-sales', first_name: 'Sam', last_name: 'Sales' };
const TECH = { id: 'u-tech', first_name: 'Terry', last_name: 'Tech' };

const rosterState = vi.hoisted(() => ({
  users: [] as { id: string; first_name: string; last_name: string; role: string; department: null }[],
}));

vi.mock('@/lib/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/users')>()),
  useAssignableUsers: () => ({ data: rosterState.users }),
}));

vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn().mockResolvedValue({ data: {} }), get: vi.fn().mockResolvedValue({ data: [] }) },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const selfOnlyAbility = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
]);
const grantHolderAbility = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
  { action: 'assign', subject: 'User' },
]);

function signedInAs(id: string) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { ...SALES, id, email: 'sam@test.com', role: 'SALES' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
}

/** A LIVE walkthrough staffed by somebody the self-only rep may not name. */
const BOOKED_WITH_TECH = {
  walkthrough_scheduled_at: '2026-09-10T15:00:00.000Z',
  walkthrough_completed_at: null,
  walkthrough_cancelled_at: null,
  walkthrough_duration_minutes: 60,
  walkthrough_notes: '',
  walkthrough_performers: [{ user: TECH }],
};

function renderTab(lead: Record<string, unknown>, ability = selfOnlyAbility, canSchedule = true) {
  return renderWithProviders(
    <WalkthroughTabContent
      lead={lead}
      leadId="lead-1"
      canPerformWalkthrough={false}
      canScheduleWalkthrough={canSchedule}
    />,
    { ability },
  );
}

/**
 * The form's first two visible textboxes: start date, then start time. Typed rather than
 * destructured off a filter so `tsc` sees two elements and not two `HTMLElement | undefined`s -
 * and so a layout change that removes a field fails loudly here instead of at `user.type`.
 */
function visibleTextboxes(scope: HTMLElement): [HTMLElement, HTMLElement] {
  const [date, time] = within(scope)
    .getAllByRole('textbox')
    .filter((el) => (el as HTMLInputElement).type !== 'hidden');
  if (!date || !time) throw new Error('expected a start date and a start time field in this form');
  return [date, time];
}

const openTheForm = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Book Another Visit/i }));
  return user;
};

beforeEach(() => {
  vi.clearAllMocks();
  rosterState.users = [{ ...SALES, role: 'SALES', department: null }];
  signedInAs(SALES.id);
});

describe('a rep booking a SECOND visit on their own lead', () => {
  it('offers the door at all — the defect was that this button did not exist', () => {
    renderTab(BOOKED_WITH_TECH);
    expect(screen.getByRole('button', { name: /Book Another Visit/i })).toBeInTheDocument();
  });

  it('seeds the new visit with THEMSELVES, not the live visit’s crew', async () => {
    renderTab(BOOKED_WITH_TECH);
    await openTheForm();

    const form = screen.getByText('Additional Visit').closest('div')!;
    // Their own name, seeded from an EMPTY set — this door takes the strict pool path.
    expect(await within(form).findByText('Sam Sales')).toBeInTheDocument();
    // NOT the technician already on visit 1. Carrying him over would arrive locked, unremovable,
    // and 403 — the same dead end the cancelled-visit repro produced on the schedule door.
    expect(within(form).queryByText('Terry Tech')).not.toBeInTheDocument();
  });

  it('locks the field, exactly as the first booking does', async () => {
    renderTab(BOOKED_WITH_TECH);
    await openTheForm();

    const form = screen.getByText('Additional Visit').closest('div')!;
    await within(form).findByText('Sam Sales');
    expect(within(form).queryByRole('button', { name: /Remove Sam Sales/i })).not.toBeInTheDocument();
    // NAMED, because this form now holds a SECOND combobox - the location picker, which slice 3
    // of the visit-location spec put on the additional-visit form as well. "the combobox" stopped
    // being an unambiguous thing for a test at the same moment it stopped being one for a screen
    // reader, which is what the `htmlFor`/`id` pair on the Performers label exists for.
    expect(within(form).getByRole('combobox', { name: /performers/i })).toBeDisabled();
  });

  it('posts to the ADDITIONAL-VISIT door, carrying only themselves', async () => {
    renderTab(BOOKED_WITH_TECH);
    const user = await openTheForm();

    const form = screen.getByText('Additional Visit').closest('div')!;
    const [startDate, startTime] = visibleTextboxes(form);
    await user.type(startDate, '10/02/2026');
    await user.type(startTime, '09:00 AM');

    await user.click(within(form).getByRole('button', { name: /Book Visit/i }));

    const call = vi.mocked(api.post).mock.calls.find(([url]) => String(url).endsWith('/visits'));
    expect(call, 'it must post to /visits, not /walkthrough/schedule — that one REUSES the live visit').toBeTruthy();
    expect((call![1] as { assignee_ids: string[] }).assignee_ids).toEqual([SALES.id]);
  });

  it('leaves the live visit alone — this books a second trip, it does not move the first', async () => {
    renderTab(BOOKED_WITH_TECH);
    const user = await openTheForm();

    const form = screen.getByText('Additional Visit').closest('div')!;
    const [startDate, startTime] = visibleTextboxes(form);
    await user.type(startDate, '10/02/2026');
    await user.type(startTime, '09:00 AM');
    await user.click(within(form).getByRole('button', { name: /Book Visit/i }));

    const reschedules = vi
      .mocked(api.post)
      .mock.calls.filter(([url]) => String(url).includes('/walkthrough/schedule'));
    expect(reschedules, 'posting to the schedule door would MOVE visit 1 instead of adding visit 2').toHaveLength(0);
  });

  it('backs out without posting anything', async () => {
    renderTab(BOOKED_WITH_TECH);
    const user = await openTheForm();

    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));

    expect(screen.queryByText('Additional Visit')).not.toBeInTheDocument();
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
    // And the door is offered again, rather than the tab being left in a half-open state.
    expect(screen.getByRole('button', { name: /Book Another Visit/i })).toBeInTheDocument();
  });
});

describe('everyone else', () => {
  it('gives a grant holder an editable field on the second visit too', async () => {
    rosterState.users = [
      { ...SALES, role: 'SALES', department: null },
      { ...TECH, role: 'TECHNICIAN', department: null },
    ];
    renderTab(BOOKED_WITH_TECH, grantHolderAbility);
    const user = await openTheForm();

    const form = screen.getByText('Additional Visit').closest('div')!;
    // The PERFORMERS one specifically - see the note on the locked case above.
    const combobox = within(form).getByRole('combobox', { name: /performers/i });
    expect(combobox).toBeEnabled();
    await user.click(combobox);
    expect(await screen.findByRole('option', { name: /Terry Tech/ })).toBeInTheDocument();
  });

  it('offers nothing to a viewer who cannot schedule at all', () => {
    renderTab(BOOKED_WITH_TECH, selfOnlyAbility, false);
    expect(screen.queryByRole('button', { name: /Book Another Visit/i })).not.toBeInTheDocument();
  });
});
