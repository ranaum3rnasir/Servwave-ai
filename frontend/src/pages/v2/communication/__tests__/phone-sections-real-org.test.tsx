/// <reference types="@testing-library/jest-dom/vitest" />
// Locks the surface a newly phone-enabled real org sees: Calls and Phone
// numbers, nothing else. Ran's call (2026-08-13) when the `phone` entitlement
// was turned on for a real, non-pilot org - Call flows, Call masking, Call groups,
// Training and Blocked callers all stay hidden. Most are half-built; Blocked
// callers is fully backed and is hidden on scope grounds alone.
//
// The pilot org and the demo org keep those tabs, so the suite
// asserts both directions: widening OR narrowing the gate goes red on purpose.
//
// Retargeted at `pages/v2/communication/PhonePage` during the 2026-08-17
// staging-to-main promotion. `main` carried this suite against
// `pages/communication/PhonePage`, which `staging` deleted as unroutable - the
// route table is built entirely by `v2Routes()`. The v2 page was forked before
// the gate landed and so shipped without `blocked` in its
// `PILOT_AND_DEMO_SECTIONS`; the promotion ports that entry across, and this
// suite is what holds it there.
//
// The nav tabs assert `role="tab"`, not `role="button"`: the v2 strip
// (`pages/v2/_shared/tabs.tsx`) builds each trigger from the kit Button with an
// explicit `role="tab"`, and an explicit role replaces the implicit one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

vi.mock('@/components/communication/phone/CallsView', () => ({
  CallsView: () => <div>Calls view stub</div>,
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

// Header chrome, not the gate under test, and the one child that cannot survive
// the blanket GET stub below: it reads `usage.calling.used` off the response and
// a payload without a `calling` key throws rather than rendering empty.
vi.mock('@/pages/v2/communication/components/planUsage', () => ({
  PlanUsage: () => null,
}));

import { useAuthStore } from '@/stores/auth.store';
import PhonePage from '@/pages/v2/communication/PhonePage';

const mockApi = vi.mocked(api);
const COMM_READ = buildAbility([{ action: 'read', subject: 'Communication' }]);

// The CTM pilot allowlist default (the pilot org), same id in staging
// and prod - see lib/useIsCommunicationPilotOrg.ts.
const PILOT_ORG_ID = '11111111-2222-4333-8444-555555555555';
// A real, non-pilot, phone-entitled org.
const REAL_ORG_ID = '00000000-0000-4000-8000-000000000a01';

const HIDDEN_TABS = ['Call flows', 'Call masking', 'Call groups', 'Training', 'Blocked callers'];

function renderPhone(o: { orgId: string; isDemo: boolean; tab: string }) {
  vi.mocked(useAuthStore).mockImplementation((sel: unknown) =>
    (sel as (s: unknown) => unknown)({
      user: {
        id: 'u1',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        organization_id: o.orgId,
        org_is_demo: o.isDemo,
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
    { initialEntries: [`/communication/phone/${o.tab}`], ability: COMM_READ },
  );
}

describe('Phone module sections for a real non-pilot org', () => {
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

  it('shows exactly the Calls and Phone numbers tabs', async () => {
    renderPhone({ orgId: REAL_ORG_ID, isDemo: false, tab: 'calls' });

    await screen.findByText('Calls view stub');
    expect(screen.getByRole('tab', { name: 'Calls' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Phone numbers' })).toBeInTheDocument();
    for (const label of HIDDEN_TABS) {
      expect(screen.queryByRole('tab', { name: label })).toBeNull();
    }
  });

  it.each(['flows', 'masking', 'groups', 'training', 'blocked'])(
    'falls a /communication/phone/%s deep link back to Calls without mounting the view',
    async (tab) => {
      renderPhone({ orgId: REAL_ORG_ID, isDemo: false, tab });

      await screen.findByText('Calls view stub');
      expect(screen.queryByText(/view stub/)).toHaveTextContent('Calls view stub');
    },
  );

  it('keeps Blocked callers for the CTM pilot org', async () => {
    renderPhone({ orgId: PILOT_ORG_ID, isDemo: false, tab: 'blocked' });

    await screen.findByText('Blocked callers view stub');
    expect(screen.getByRole('tab', { name: 'Blocked callers' })).toBeInTheDocument();
  });

  it('keeps Blocked callers for the demo org', async () => {
    renderPhone({ orgId: REAL_ORG_ID, isDemo: true, tab: 'blocked' });

    await screen.findByText('Blocked callers view stub');
    expect(screen.getByRole('tab', { name: 'Blocked callers' })).toBeInTheDocument();
  });
});
