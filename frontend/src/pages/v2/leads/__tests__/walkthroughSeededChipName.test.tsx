/**
 * PRD story 15, on the lead tab: "I want to see my own name rendered correctly on any chip that
 * names me, so that I never see 'Unknown' where my name should be."
 *
 * WHY THIS IS ITS OWN FILE. `walkthroughSelfPerformerSeed.test.tsx` MOCKS `useAssignableUsers`
 * with a synchronous `{ data: [...] }`, which is a roster that has already landed - so it cannot
 * see the window this suite is about, and its "no Unknown" assertions pass on the strength of a
 * roster the real app does not have yet. Here the hook is REAL and only axios is mocked, so the
 * query genuinely loads and genuinely fails.
 *
 * WHAT THE WINDOW IS. `MultiAssigneeSelect` resolves a chip label roster -> `knownPeople` ->
 * `'Unknown'`. In the seeding case both of the first two are empty:
 *
 *   - `useAssignableUsers` sets no `placeholderData` for a cold key, so `data` is `undefined`
 *     (`[]` at the call site) for the whole of the request AND for ever if it rejects;
 *   - the record's own `walkthrough_performers` is empty - that is WHY the seed fired.
 *
 * So a rep cold-loading their own lead saw a chip reading `Unknown` with "You can only put
 * yourself on a walkthrough." underneath it. The fix is `useAssignUserPermission` handing the
 * actor's NAME back beside their id, and the tab prepending it to `knownPeople`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { WalkthroughTabContent } from '../components/walkthroughTab';

// The walkthrough form now holds TWO comboboxes - Performers and the visit-location picker
// added by the visit-location spec - so every query here names the one it means. The
// Performers field is named by its own <Label htmlFor>, so this stays stable whether the field
// is empty or holds chips.
const PERFORMERS = { name: /performers/i };

const SALES = { id: 'u-sales', first_name: 'Sam', last_name: 'Sales' };

// The org timezone query is not what this file is about, and letting it fall through to the
// catch-all mock below would make every case depend on a second unrelated request.
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

/** SALES: books walkthroughs on their own leads, holds NO `assign User`. */
const selfOnlyAbility = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
]);

/** A lead with no walkthrough at all - so the field is SEEDED, which is the case in question. */
const UNBOOKED = {
  walkthrough_scheduled_at: null,
  walkthrough_completed_at: null,
  walkthrough_cancelled_at: null,
  walkthrough_notes: '',
  walkthrough_performers: [] as { user: typeof SALES }[],
};

function signedInAsSales() {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { ...SALES, email: 'sam@test.com', role: 'SALES' },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    } as never),
  );
}

function renderTab() {
  return renderWithProviders(
    <WalkthroughTabContent
      lead={UNBOOKED}
      leadId="lead-1"
      canPerformWalkthrough={false}
      canScheduleWalkthrough
    />,
    { ability: selfOnlyAbility },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  signedInAsSales();
});

describe('the seeded performer chip, while the scoped roster is unavailable', () => {
  it('reads the rep\'s own name while `/api/users/assignable` is still in flight', async () => {
    // Never settles, so `useAssignableUsers().data` is `undefined` for the whole test.
    vi.mocked(api.get).mockReturnValue(new Promise(() => {}) as never);
    renderTab();

    expect(await screen.findByText('Sam Sales')).toBeInTheDocument();
    // The bug, stated: a chip reading `Unknown` on a field the viewer cannot edit - the form
    // refusing to name the one person it will let them book.
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    // The lock is the landmark now. It used to be the explanatory sentence, which Ran removed
    // (1 Sep) as redundant beside a field that plainly cannot be opened.
    expect(screen.getByRole('combobox', PERFORMERS)).toBeDisabled();
  });

  it('reads the rep\'s own name FOR EVER when that request fails', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('network'));
    renderTab();

    expect(await screen.findByText('Sam Sales')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });

  it('still reads the rep\'s own name once the roster DOES land', async () => {
    // The roster answers a self-only caller with exactly one row, and it is them - so the chip
    // has two sources agreeing. Asserting it here keeps the fix from being a loading-only patch
    // that some later change could quietly make the ONLY source.
    vi.mocked(api.get).mockResolvedValue({
      data: [{ ...SALES, role: 'SALES', department: null }],
    });
    renderTab();

    expect(await screen.findByText('Sam Sales')).toBeInTheDocument();
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
  });
});
