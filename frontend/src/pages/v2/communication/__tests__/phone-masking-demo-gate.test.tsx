/// <reference types="@testing-library/jest-dom/vitest" />
// SRVW-132 - locks the demo-only gate around the Call masking prototype.
// Ran's decision on the card (2026-07-31): hide it completely, visible only
// in the test organization. This suite proves that in both directions - a
// real org never sees the tab or the deep link, and the demo org does - so a
// future change that widens or narrows the gate goes red on purpose.
//
// Retargeted at `pages/v2/communication/PhonePage` when the legacy
// `pages/communication/PhonePage` was deleted as unroutable. That page had
// stopped being the one the app mounts: the route table is built entirely by
// `v2Routes()`, and `routes/communication.routes.tsx` mounts the v2 page at
// both `/communication/phone` and `/communication/phone/:tab`. The gate itself
// is unchanged - the v2 page carries the same `DEMO_ONLY_SECTIONS` list and the
// same rule that a deep link to a hidden section falls back to Calls - so this
// suite kept its three cases and changed only what it renders.
//
// The nav tabs assert `role="tab"`, not `role="button"`: the v2 strip
// (`pages/v2/_shared/tabs.tsx`) builds each trigger from the kit Button with an
// explicit `role="tab"`, and an explicit role replaces the implicit one. "Save
// masking rules" stays a button - it lives inside the real CallMaskingView,
// which is deliberately left unmocked so the demo case proves the view really
// mounts rather than that a stub rendered.
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

// Header chrome, not the gate under test. It is also the one child that cannot
// survive the blanket GET stub below: it reads `usage.calling.used` from the
// response, and a payload without a `calling` key throws rather than rendering
// empty. It is demo-only, so only the demo case would hit it - which is exactly
// the case that has to reach CallMaskingView.
vi.mock('@/pages/v2/communication/components/planUsage', () => ({
  PlanUsage: () => null,
}));

import { useAuthStore } from '@/stores/auth.store';
import PhonePage from '@/pages/v2/communication/PhonePage';

const mockApi = vi.mocked(api);
const COMM_READ = buildAbility([{ action: 'read', subject: 'Communication' }]);

function mockUser(user: unknown) {
  vi.mocked(useAuthStore).mockImplementation((sel: unknown) =>
    (sel as (s: unknown) => unknown)({ user, isAuthenticated: true, isLoading: false, error: null }),
  );
}

function renderPhone(o: { isDemo: boolean; tab: string }) {
  mockUser({
    id: 'u1',
    email: 'admin@test.com',
    first_name: 'Test',
    last_name: 'Admin',
    role: 'ADMIN',
    organization_id: '11111111-1111-1111-1111-111111111111',
    org_is_demo: o.isDemo,
    org_features: ['phone', 'inventory'],
  });
  return renderWithProviders(
    <Routes>
      <Route path="/communication/phone/:tab" element={<PhonePage />} />
    </Routes>,
    { initialEntries: [`/communication/phone/${o.tab}`], ability: COMM_READ },
  );
}

describe('Phone module masking demo gate (SRVW-132)', () => {
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

  it('real org (org_is_demo false): the "Call masking" tab is absent from the phone module nav', async () => {
    renderPhone({ isDemo: false, tab: 'calls' });

    await screen.findByText('Calls view stub');
    expect(screen.queryByRole('tab', { name: 'Call masking' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Phone numbers' })).toBeInTheDocument();
  });

  it('real org: a /communication/phone/masking deep link falls back to the Calls section and never mounts CallMaskingView', async () => {
    renderPhone({ isDemo: false, tab: 'masking' });

    await screen.findByText('Calls view stub');
    expect(screen.queryByRole('button', { name: /save masking rules/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Call masking' })).toBeNull();
  });

  it('demo org (org_is_demo true): the "Call masking" tab renders and the deep link mounts the real CallMaskingView', async () => {
    renderPhone({ isDemo: true, tab: 'masking' });

    await screen.findByRole('button', { name: /save masking rules/i });
    expect(screen.getByRole('tab', { name: 'Call masking' })).toBeInTheDocument();
  });
});
