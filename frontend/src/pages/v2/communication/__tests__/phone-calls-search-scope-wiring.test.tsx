/// <reference types="@testing-library/jest-dom/vitest" />
// #1948 follow-up. Fix 3 gave the Calls empty state an honest scope sentence
// ("No calls match "x" in Last 30 days ...") and a "Search all time" escape
// hatch. Both halves are computed by PhonePage and handed to CallsView as
// props, and NOTHING covered that seam: `describeSearchScope` is unit-tested in
// isolation and CallsView is tested with a scope injected by hand, so deleting
// the two prop lines from PhonePage left all fourteen of fix 3's tests green
// while the feature silently reverted in production.
//
// This suite owns the seam, and only the seam. It stubs CallsView - every other
// PhonePage suite does the same, the page is far too heavy to mount whole - but
// the stub RENDERS what it is given rather than asserting that a prop arrived:
// the scope string is put on screen, and the widening callback is put behind a
// real button. So the assertions are about data flowing through PhonePage and
// back out again, which is the thing that broke, not about a prop's name.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

// The stub surfaces both props as ordinary DOM: the scope as text, the widening
// callback as a button. `searchScope` is `string | null`, and null - "nothing
// was hidden" - is a meaningful value, so it is rendered as an explicit token
// rather than as an empty node that would read the same as a missing prop.
vi.mock('@/components/communication/phone/CallsView', () => ({
  CallsView: ({
    searchScope,
    onSearchAllTime,
  }: {
    searchScope?: string | null;
    onSearchAllTime?: () => void;
  }) => (
    <div>
      <span data-testid="scope">{searchScope ?? '(unbounded)'}</span>
      <button type="button" onClick={onSearchAllTime}>
        widen
      </button>
    </div>
  ),
}));
vi.mock('@/components/communication/phone/DispatchView', () => ({
  DispatchView: () => <div>Dispatch view stub</div>,
}));
vi.mock('@/components/communication/phone/PerformanceView', () => ({
  PerformanceView: () => <div>Performance view stub</div>,
}));
vi.mock('@/components/communication/phone/TrainingView', () => ({
  TrainingView: () => <div>Training view stub</div>,
}));
vi.mock('@/components/communication/phone/NumbersView', () => ({
  NumbersView: () => <div>Numbers view stub</div>,
}));
vi.mock('@/components/communication/phone/BlockedCallersView', () => ({
  BlockedCallersView: () => <div>Blocked callers view stub</div>,
}));
vi.mock('@/components/communication/phone/CallFlows', () => ({
  CallFlowsView: () => <div>Call flows view stub</div>,
}));
vi.mock('@/components/communication/phone/CallGroups', () => ({
  CallGroupsView: () => <div>Call groups view stub</div>,
}));
vi.mock('@/components/communication/phone/CallMaskingView', () => ({
  CallMaskingView: () => <div>Call masking view stub</div>,
}));
vi.mock('@/pages/v2/communication/components/planUsage', () => ({
  PlanUsage: () => null,
}));

import { useAuthStore } from '@/stores/auth.store';
import PhonePage from '@/pages/v2/communication/PhonePage';

const mockApi = vi.mocked(api);
const COMM_READ = buildAbility([{ action: 'read', subject: 'Communication' }]);
const REAL_ORG_ID = '00000000-0000-4000-8000-000000000a01';

function renderPhone({ isDemo = false }: { isDemo?: boolean } = {}) {
  vi.mocked(useAuthStore).mockImplementation((sel: unknown) =>
    (sel as (s: unknown) => unknown)({
      user: {
        id: 'u1',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        organization_id: REAL_ORG_ID,
        org_is_demo: isDemo,
        org_features: ['phone', 'inventory'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
  return renderWithProviders(
    <Routes>
      <Route path="/communication/phone/:tab" element={<PhonePage />} />
    </Routes>,
    { initialEntries: ['/communication/phone/calls'], ability: COMM_READ },
  );
}

const scope = () => screen.getByTestId('scope').textContent;

describe('PhonePage hands the Calls list its search scope (#1948)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({
      data: {
        calls: [],
        threads: [],
        callFlows: [],
        callGroups: [],
        blocked: [],
        numbers: [],
        contacts: [],
        agents: [],
        techs: [],
      },
    });
  });

  it('describes the default 30-day window the list is actually scoped to', async () => {
    renderPhone();
    await screen.findByTestId('scope');

    // The page opens on '30d'. The empty state can only name the window if
    // PhonePage computes a description and passes it down.
    expect(scope()).toMatch(/^Last 30 days \(.+\)$/);
  });

  it('widens to an unbounded scope when the list asks it to', async () => {
    renderPhone();
    await screen.findByTestId('scope');
    expect(scope()).not.toBe('(unbounded)');

    await userEvent.click(screen.getByRole('button', { name: 'widen' }));

    // Null is the "nothing was hidden" signal that suppresses the sentence and
    // the button. Reaching it proves the callback really moved the page's own
    // preset and that the description was recomputed from the new one - not
    // that a function was handed over and dropped.
    expect(scope()).toBe('(unbounded)');
  });

  it('anchors the description to the demo clock for a demo org', async () => {
    renderPhone({ isDemo: true });
    await screen.findByTestId('scope');

    // DEMO_NOW is 2026-05-30, so a demo org's 30-day window ends in May 2026
    // whatever the real clock says. Asserted here and not only in the pure
    // unit test, because it is PhonePage that decides to pass `isDemo` at all.
    expect(scope()).toContain('May 30th, 2026');
    expect(scope()).toMatch(/^Last 30 days \(/);
  });
});
