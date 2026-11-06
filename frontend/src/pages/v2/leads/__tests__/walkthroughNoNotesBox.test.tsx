// THE WALKTHROUGH TAB HAS NO NOTES BOX once a walkthrough exists (booked/timed, To be scheduled, Finished): the notes
// are written on the lead's Notes tab. Before a walkthrough exists (no walkthrough, or the only one cancelled and
// nothing rebooked) the booking form keeps its "Walkthrough notes" box for the NEXT booking. Every other control stays.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';
import { WalkthroughTabContent } from '../components/walkthroughTab';

const SALES = { id: 'u-sales', first_name: 'Sam', last_name: 'Sales' };

vi.mock('@/lib/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/users')>()),
  useAssignableUsers: () => ({ data: [{ ...SALES, role: 'SALES', department: null }] }),
}));
vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));
vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn().mockResolvedValue({ data: {} }), get: vi.fn().mockResolvedValue({ data: [] }) },
}));
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const everything = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
  { action: 'perform_walkthrough', subject: 'Lead' },
]);

const NONE = {
  walkthrough_scheduled_at: null, walkthrough_completed_at: null, walkthrough_cancelled_at: null,
  walkthrough_duration_minutes: null, walkthrough_notes: null, walkthrough_performers: [],
};
const BOOKED = {
  ...NONE, walkthrough_scheduled_at: '2026-09-10T15:00:00.000Z', walkthrough_duration_minutes: 60,
  walkthrough_notes: 'Saved notes', walkthrough_performers: [{ user: SALES }], walkthrough_count: 2,
  walkthrough_history: [
    { id: 'v1', visit_seq: 1, status: 'COMPLETED', scheduled_at: '2026-09-01T15:00:00.000Z', duration_minutes: 60, completed_at: '2026-09-01T16:00:00.000Z', cancelled_at: null, cancelled_reason: null, created_at: '2026-08-30T00:00:00.000Z' },
    { id: 'v2', visit_seq: 2, status: 'SCHEDULED', scheduled_at: '2026-09-10T15:00:00.000Z', duration_minutes: 60, completed_at: null, cancelled_at: null, cancelled_reason: null, created_at: '2026-09-02T00:00:00.000Z' },
  ],
};
const TO_BE_SCHEDULED = { ...BOOKED, walkthrough_scheduled_at: null, walkthrough_duration_minutes: null, walkthrough_to_be_scheduled: true };
const FINISHED = { ...BOOKED, walkthrough_completed_at: '2026-09-10T16:00:00.000Z' };
const CANCELLED_NOTHING_REBOOKED = { ...NONE, walkthrough_cancelled_at: '2026-09-01T15:00:00.000Z', walkthrough_notes: 'Old notes' };

function renderTab(lead: Record<string, unknown>, onCancel = vi.fn()) {
  return renderWithProviders(
    <WalkthroughTabContent lead={lead} leadId="lead-1" canPerformWalkthrough canScheduleWalkthrough onCancelWalkthrough={onCancel} />,
    { ability: everything },
  );
}
const noteBoxes = () => [
  ...screen.queryAllByPlaceholderText('Walkthrough notes...'),
  ...screen.queryAllByRole('textbox', { name: 'Walkthrough notes' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({ user: { ...SALES, email: 's@test.com', role: 'SALES' }, isAuthenticated: true, isLoading: false, error: null } as never),
  );
});

describe('the notes box on the Walkthrough tab, by state', () => {
  it.each([
    ['booked with a time', BOOKED, false],
    ['To be scheduled', TO_BE_SCHEDULED, false],
    ['Finished', FINISHED, false],
    ['cancelled with nothing rebooked', CANCELLED_NOTHING_REBOOKED, true],
    ['no walkthrough', NONE, true],
  ])('%s', (_name, lead, bookingBox) => {
    renderTab(lead);
    expect(screen.queryByText('Save Notes')).toBeNull();
    expect(screen.queryByText(/^Notes$/)).toBeNull();
    if (bookingBox) {
      const box = screen.getByRole('textbox', { name: 'Walkthrough notes' });
      expect(box).toBeEnabled();
      expect(box).toHaveValue('');
    } else {
      expect(noteBoxes()).toHaveLength(0);
      expect(screen.queryByDisplayValue('Saved notes')).toBeNull();
    }
  });
});

describe('the booked walkthrough keeps its other controls', () => {
  it('shows Finish walkthrough, Reschedule, Cancel, Book Another Visit and the visit history, all wired', async () => {
    const onCancel = vi.fn();
    renderTab(BOOKED, onCancel);
    const user = userEvent.setup();

    expect(screen.getByText('Schedule Info')).toBeInTheDocument();
    expect(screen.getByText(/2 Visits Total/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Finish walkthrough' }));
    expect(vi.mocked(api.post).mock.calls.some(([url]) => String(url).endsWith('/walkthrough/complete'))).toBe(true);

    await user.click(screen.getByRole('button', { name: /^Cancel$/i }));
    expect(onCancel).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Book Another Visit/i }));
    expect(screen.getByText('Additional Visit')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Walkthrough notes' })).toBeInTheDocument();
  });

  it('opens the Reschedule form', async () => {
    renderTab(BOOKED);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Reschedule/i }));
    expect(screen.getByRole('button', { name: /Save New Time/i })).toBeInTheDocument();
  });
});
