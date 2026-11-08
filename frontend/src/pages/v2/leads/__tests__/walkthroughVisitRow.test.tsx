// Scheduling-notifications slice 09, the LEAD half: the walkthrough tab's live-visit row adopts
// the job row's layout. One primary next step for the crew (a walkthrough has exactly one
// milestone verb, Complete, riding `perform_walkthrough Lead`), and Reschedule / Cancel in a
// separate, right-aligned office group riding their own routes (`schedule_walkthrough Lead` and
// `cancel Lead`). Each control is absent, never present-and-failing, for a viewer whose role
// lacks it (PRD stories 20, 21, 26, 27).
//
// Component-level, like walkthroughAdditionalVisit.test.tsx: the tab is rendered directly with a
// live walkthrough, and the page's own wiring of the Cancel dialog is proved on the page suite.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import api from '@/lib/axios';
import { WalkthroughTabContent } from '../components/walkthroughTab';

vi.mock('@/lib/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/users')>()),
  useAssignableUsers: () => ({ data: [] }),
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

const ability = buildAbility([{ action: 'read', subject: 'Lead' }]);

/** A LIVE walkthrough: booked, neither completed nor cancelled. */
const LIVE_WALKTHROUGH = {
  walkthrough_scheduled_at: '2026-09-10T15:00:00.000Z',
  walkthrough_completed_at: null,
  walkthrough_cancelled_at: null,
  walkthrough_duration_minutes: 60,
  walkthrough_notes: '',
  walkthrough_performers: [{ user: { id: 'u-tech', first_name: 'Terry', last_name: 'Tech' } }],
};

function renderTab(opts: {
  canPerform?: boolean;
  canSchedule?: boolean;
  onCancelWalkthrough?: () => void;
} = {}) {
  return renderWithProviders(
    <WalkthroughTabContent
      lead={LIVE_WALKTHROUGH}
      leadId="lead-1"
      canPerformWalkthrough={opts.canPerform ?? true}
      canScheduleWalkthrough={opts.canSchedule ?? true}
      onCancelWalkthrough={opts.onCancelWalkthrough}
    />,
    { ability },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the live walkthrough row', () => {
  it('offers Complete as the primary step, and posts it to the walkthrough complete route', async () => {
    renderTab();

    const primary = screen.getByRole('button', { name: 'Complete' });
    await userEvent.click(primary);

    expect(vi.mocked(api.post)).toHaveBeenCalledWith('/api/leads/lead-1/walkthrough/complete');
  });

  it('keeps Reschedule and Cancel in an office group apart from the primary step, and Cancel opens the page dialog', async () => {
    const onCancelWalkthrough = vi.fn();
    renderTab({ onCancelWalkthrough });

    const office = screen.getByRole('group', { name: 'Office actions' });
    expect(within(office).getByRole('button', { name: /Reschedule/ })).toBeInTheDocument();
    expect(within(office).queryByRole('button', { name: 'Complete' })).toBeNull();

    await userEvent.click(within(office).getByRole('button', { name: 'Cancel' }));
    expect(onCancelWalkthrough).toHaveBeenCalledTimes(1);
    // Cancelling is the PAGE's dialog, with its reason box - nothing is posted from here.
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
  });

  it('offers a viewer who may only perform the walkthrough the primary step and no office group', () => {
    renderTab({ canSchedule: false });

    expect(screen.getByRole('button', { name: 'Complete' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Office actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('offers a viewer who may only book the office group and no primary step', () => {
    renderTab({ canPerform: false });

    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
    const office = screen.getByRole('group', { name: 'Office actions' });
    expect(within(office).getByRole('button', { name: /Reschedule/ })).toBeInTheDocument();
    // No cancel callback from the page means no Cancel on the row.
    expect(within(office).queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
