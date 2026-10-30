/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 8, slice S08.16 - the Phone page and the org-gated tabs behind their switches.
//
// Renders the ROUTED Phone page (pages/v2/communication/PhonePage) with the real Call flows and Training views. The
// server now refuses a tab's data to a person without the tab's switch (and, outside a demo or pilot org, to everyone),
// so the page must not ask for it: no request is made that the server will refuse. A person with the Call flows tab on
// and the Phone numbers tab off gets numbers without their call flow, so the flows screen must not claim there are none.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { abilityWithSwitches, catalogToggle, presetSwitchLabels } from '@/__tests__/support/backendSwitchCatalog';

vi.mock('@/components/communication/phone/CallsView', () => ({ CallsView: () => <div>Calls view stub</div> }));
vi.mock('@/components/communication/phone/DispatchView', () => ({ DispatchView: () => null }));
vi.mock('@/components/communication/phone/PerformanceView', () => ({ PerformanceView: () => null }));
vi.mock('@/components/communication/phone/NumbersView', () => ({ NumbersView: () => <div>Numbers view stub</div> }));
vi.mock('@/pages/v2/communication/components/planUsage', () => ({ PlanUsage: () => <div data-testid="usage-bar" /> }));

import { useAuthStore } from '@/stores/auth.store';
import PhonePage from '@/pages/v2/communication/PhonePage';

const mockApi = vi.mocked(api);
const SECTION = ['Access Communication', 'View communication'];
const FLOWS_URL = '/api/communication/call-flows';
const GROUPS_URL = '/api/communication/call-groups';
const BLOCKED_URL = '/api/communication/blocked';

const FLOW = {
  id: 'f1', name: 'Main line', structure: 'basic', record: false, status: 'active', hoursMode: 'always',
  openNodes: [{ id: 'n1', type: 'greeting', message: 'Hello.' }], closedNodes: [], updatedAt: '2026-09-01T12:00:00.000Z',
};
/** What the numbers list answers a person without the Phone numbers tab: the number, without its call flow or forward-to. */
const NUMBER_WITHOUT_ROUTING = { id: 'pn-1', e164: '+15550000001', formatted: '(555) 000-0001', status: 'active', sms_enabled: true };

/** The editor's Save button is drawn for a holder of the whole Communication module ("manage"), which would also hold every
 *  tab, so a case that saves adds it and takes the Phone numbers tab back off (a CASL "cannot" rule). */
function withManage(labels: string[]) {
  const rules = labels.flatMap((l) => catalogToggle(l).grants.map((g) => ({ action: g.action, subject: g.subject }) as AbilityRule));
  return buildAbility([
    { action: 'manage', subject: 'Communication' } as AbilityRule,
    ...rules,
    { action: 'phone_numbers_tab', subject: 'Communication', inverted: true } as AbilityRule,
  ]);
}

function renderPhone(labels: string[], opts: { demo?: boolean; tab?: string; manage?: boolean } = {}) {
  vi.mocked(useAuthStore).mockImplementation((sel: unknown) =>
    (sel as (s: unknown) => unknown)({
      user: {
        id: 'u1', email: 'custom@test.com', first_name: 'Custom', last_name: 'Role', role: 'CUSTOM',
        organization_id: '00000000-0000-4000-8000-000000000a01', org_is_demo: opts.demo ?? true, org_features: ['phone'],
      },
      isAuthenticated: true, isLoading: false, error: null,
    }),
  );
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/communication/calls') return { data: { calls: [] } };
    if (url === FLOWS_URL) return { data: { callFlows: [FLOW] } };
    if (url === '/api/communication/numbers') return { data: { numbers: [NUMBER_WITHOUT_ROUTING] } };
    if (url.startsWith('/api/communication/training')) return { data: { scenarios: [], sessions: [] } };
    return { data: { threads: [], callGroups: [], blocked: [], numbers: [], agents: [], techs: [], contacts: [] } };
  });
  renderWithProviders(
    <Routes><Route path="/communication/phone/:tab" element={<PhonePage />} /></Routes>,
    { initialEntries: [`/communication/phone/${opts.tab ?? 'calls'}`], ability: opts.manage ? withManage(labels) : abilityWithSwitches(...labels) },
  );
}

const requested = (url: string) => mockApi.get.mock.calls.some(([u]) => u === url);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the Phone page asks only for what the server will answer', () => {
  it('requests no flows, groups or blocked list for the Technician preset', async () => {
    renderPhone(presetSwitchLabels('TECHNICIAN'));
    await screen.findByText('Calls view stub');
    await waitFor(() => expect(requested('/api/communication/numbers')).toBe(true));

    expect(requested(FLOWS_URL)).toBe(false);
    expect(requested(GROUPS_URL)).toBe(false);
    expect(requested(BLOCKED_URL)).toBe(false);
  });

  it('requests all three for the Dispatcher preset in a demo org', async () => {
    renderPhone(presetSwitchLabels('DISPATCHER'));
    await screen.findByText('Calls view stub');

    await waitFor(() => {
      expect(requested(FLOWS_URL)).toBe(true);
      expect(requested(GROUPS_URL)).toBe(true);
      expect(requested(BLOCKED_URL)).toBe(true);
    });
  });

  it.each([
    ['Call flows tab', FLOWS_URL],
    ['Call groups tab', GROUPS_URL],
    ['Blocked callers tab', BLOCKED_URL],
  ])('requests only the data behind %s when that is the one tab held', async (switchLabel, url) => {
    renderPhone([...SECTION, switchLabel]);
    await screen.findByText('Calls view stub');
    await waitFor(() => expect(requested('/api/communication/numbers')).toBe(true));

    for (const other of [FLOWS_URL, GROUPS_URL, BLOCKED_URL]) expect(requested(other), other).toBe(other === url);
  });

  it('requests none of them in a real org outside the pilot, whatever the switches say', async () => {
    renderPhone(presetSwitchLabels('DISPATCHER'), { demo: false });
    await screen.findByText('Calls view stub');
    await waitFor(() => expect(requested('/api/communication/numbers')).toBe(true));

    expect(requested(FLOWS_URL)).toBe(false);
    expect(requested(GROUPS_URL)).toBe(false);
    expect(requested(BLOCKED_URL)).toBe(false);
  });
});

describe('the Call flows screen for a person without the Phone numbers tab', () => {
  it('does not claim a flow has no numbers when it cannot tell', async () => {
    renderPhone([...SECTION, 'Call flows tab'], { tab: 'flows' });
    const row = (await screen.findByText('Main line')).closest('tr')!;

    expect(within(row).queryByText('None')).toBeNull();
    expect(within(row).getByText(/Phone numbers tab/i)).toBeInTheDocument();
  });

  it('still says None to a person who holds the Phone numbers tab and the flow has no number', async () => {
    renderPhone([...SECTION, 'Call flows tab', 'Phone numbers tab'], { tab: 'flows' });
    const row = (await screen.findByText('Main line')).closest('tr')!;

    expect(within(row).getByText('None')).toBeInTheDocument();
  });

  it('offers no number list in the editor, and no "No numbers to assign" claim', async () => {
    const user = userEvent.setup();
    renderPhone([...SECTION, 'Call flows tab'], { tab: 'flows', manage: true });
    await user.click(await screen.findByRole('button', { name: 'Edit Main line' }));

    expect(await screen.findByText('Flow name')).toBeInTheDocument();
    expect(screen.queryByText('No numbers to assign.')).toBeNull();
    expect(screen.queryByText('+15550000001')).toBeNull();
    expect(screen.queryByText('(555) 000-0001')).toBeNull();
    expect(screen.getByText(/Phone numbers tab/i)).toBeInTheDocument();
  });

  it('keeps a saved flow active: not knowing its numbers is not the flow having none', async () => {
    const user = userEvent.setup();
    renderPhone([...SECTION, 'Call flows tab'], { tab: 'flows', manage: true });
    await user.click(await screen.findByRole('button', { name: 'Edit Main line' }));
    await user.click(await screen.findByRole('button', { name: /Save flow/i }));

    const row = (await screen.findByText('Main line')).closest('tr')!;
    expect(within(row).getByText('Active')).toBeInTheDocument();
    expect(within(row).queryByText('Draft')).toBeNull();
  });
});

describe('Training has no plan gate and no locked screen', () => {
  const LOCKED = /upgrade|locked|unlock|available on|your plan/i;

  it('draws no Training tab, and nothing about a plan or a lock, without the switch', async () => {
    renderPhone(presetSwitchLabels('TECHNICIAN'), { tab: 'training' });
    await screen.findByText('Calls view stub');

    expect(screen.queryByRole('tab', { name: /Training/ })).toBeNull();
    expect(screen.queryByText(LOCKED)).toBeNull();
  });

  it('opens the Training screen itself with the switch, with no locked or upgrade screen in front of it', async () => {
    renderPhone([...SECTION, 'Training tab'], { tab: 'training' });
    await waitFor(() => expect(requested('/api/communication/training/scenarios')).toBe(true));

    expect(screen.getByRole('tab', { name: /Training/ })).toBeInTheDocument();
    expect(screen.queryByText(LOCKED)).toBeNull();
  });
});
