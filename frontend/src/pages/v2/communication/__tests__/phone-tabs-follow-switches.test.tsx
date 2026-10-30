/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 8, slice S08.15 - the Phone numbers tab, the usage bar and the Calls-only Phone page.
//
// Renders the ROUTED Phone page (pages/v2/communication/PhonePage). The person's ability is compiled from the backend
// switch catalog: a Technician-preset person, a Dispatcher-preset person, and custom roles that hold exactly the switches
// under test. The sessions below are a DEMO org, where the org gate hides nothing, so every tab that is missing is missing
// because of a switch.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { abilityWithSwitches, presetSwitchLabels } from '@/__tests__/support/backendSwitchCatalog';

vi.mock('@/components/communication/phone/CallsView', () => ({ CallsView: () => <div>Calls view stub</div> }));
vi.mock('@/components/communication/phone/DispatchView', () => ({ DispatchView: () => null }));
vi.mock('@/components/communication/phone/PerformanceView', () => ({ PerformanceView: () => null }));
vi.mock('@/components/communication/phone/TrainingView', () => ({ TrainingView: () => <div>Training view stub</div> }));
vi.mock('@/components/communication/phone/NumbersView', () => ({ NumbersView: () => <div>Numbers view stub</div> }));
vi.mock('@/components/communication/phone/BlockedCallersView', () => ({ BlockedCallersView: () => <div>Blocked view stub</div> }));
vi.mock('@/components/communication/phone/CallFlows', () => ({ CallFlowsView: () => <div>Flows view stub</div> }));
vi.mock('@/components/communication/phone/CallGroups', () => ({ CallGroupsView: () => <div>Groups view stub</div> }));
vi.mock('@/components/communication/phone/CallMaskingView', () => ({ CallMaskingView: () => <div>Masking view stub</div> }));
// The usage bar itself is proven in phone-plan-usage-meter.test.tsx; here only whether the page draws it.
vi.mock('@/pages/v2/communication/components/planUsage', () => ({ PlanUsage: () => <div data-testid="usage-bar" /> }));

import { useAuthStore } from '@/stores/auth.store';
import PhonePage from '@/pages/v2/communication/PhonePage';

const mockApi = vi.mocked(api);
const ALL_TABS = ['Calls', 'Phone numbers', 'Call flows', 'Call masking', 'Call groups', 'Training', 'Blocked callers'];
const OTHER_TABS = ALL_TABS.filter((t) => t !== 'Calls');
/** A person who reads the section; the switches under test are added to it. */
const SECTION = ['Access Communication', 'View communication'];

function renderPhone(labels: string[], opts: { demo?: boolean; tab?: string } = {}) {
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
    return { data: { threads: [], callFlows: [], callGroups: [], blocked: [], numbers: [], agents: [], techs: [], contacts: [] } };
  });
  renderWithProviders(
    <Routes><Route path="/communication/phone/:tab" element={<PhonePage />} /></Routes>,
    { initialEntries: [`/communication/phone/${opts.tab ?? 'calls'}`], ability: abilityWithSwitches(...labels) },
  );
}

/** The module strip's tabs. The Calls page draws a tab list of its own below it, so on Calls with the strip gone only that one is left. */
function moduleTabs(onCalls = true): string[] {
  const lists = screen.getAllByRole('tablist');
  if (onCalls && lists.length < 2) return [];
  return within(lists[0]!).getAllByRole('tab').map((t) => t.textContent?.trim() ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Phone page with the Technician preset\'s switch values', () => {
  it('shows only the Calls page: no tab strip, no usage bar, none of the other sections', async () => {
    renderPhone(presetSwitchLabels('TECHNICIAN'));
    await screen.findByText('Calls view stub');

    for (const label of OTHER_TABS) expect(screen.queryByRole('tab', { name: label }), label).toBeNull();
    // The module strip is not drawn at all, not a strip of one: the only tab list left is the Calls page's own sub-tabs.
    expect(screen.getAllByRole('tablist')).toHaveLength(1);
    expect(screen.queryByTestId('usage-bar')).toBeNull();
  });

  it('opens straight on Calls from a deep link to a section it may not see', async () => {
    renderPhone(presetSwitchLabels('TECHNICIAN'), { tab: 'numbers' });
    await screen.findByText('Calls view stub');
    expect(screen.queryByText('Numbers view stub')).toBeNull();
  });
});

describe('Phone page with the Dispatcher preset\'s switch values', () => {
  it('keeps every tab and the usage bar, as today', async () => {
    renderPhone(presetSwitchLabels('DISPATCHER'));
    await screen.findByText('Calls view stub');

    expect(moduleTabs()).toEqual(ALL_TABS);
    expect(screen.getAllByRole('tablist')).toHaveLength(2);
    expect(screen.getByTestId('usage-bar')).toBeInTheDocument();
  });

  it('opens a section from its link', async () => {
    renderPhone(presetSwitchLabels('DISPATCHER'), { tab: 'numbers' });
    await screen.findByText('Numbers view stub');
  });
});

describe('each tab follows its own switch, and the usage bar follows the Phone numbers tab', () => {
  const TABS: Array<[switchLabel: string, tabLabel: string, stub: string, route: string]> = [
    ['Phone numbers tab', 'Phone numbers', 'Numbers view stub', 'numbers'],
    ['Call flows tab', 'Call flows', 'Flows view stub', 'flows'],
    ['Call masking tab', 'Call masking', 'Masking view stub', 'masking'],
    ['Call groups tab', 'Call groups', 'Groups view stub', 'groups'],
    ['Training tab', 'Training', 'Training view stub', 'training'],
    ['Blocked callers tab', 'Blocked callers', 'Blocked view stub', 'blocked'],
  ];

  it.each(TABS)('%s alone gives exactly that tab beside Calls, and nothing else', async (switchLabel, tabLabel, stub, route) => {
    renderPhone([...SECTION, switchLabel], { tab: route });
    await screen.findByText(stub);

    expect(moduleTabs(false)).toEqual(['Calls', tabLabel]);
    // The usage bar has no switch of its own (P1): it sits on the Phone numbers tab.
    if (switchLabel === 'Phone numbers tab') expect(screen.getByTestId('usage-bar')).toBeInTheDocument();
    else expect(screen.queryByTestId('usage-bar')).toBeNull();
  });

  it('leaves the Phone numbers tab off a person who holds the other tabs but not that switch', async () => {
    renderPhone([
      ...SECTION, 'Call flows tab', 'Call masking tab', 'Call groups tab', 'Training tab', 'Blocked callers tab',
    ]);
    await screen.findByText('Calls view stub');
    expect(screen.queryByRole('tab', { name: 'Phone numbers' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Call flows' })).toBeInTheDocument();
  });
});

describe('the org gate stays on top of the switches', () => {
  it('shows a real org that is not in the pilot only Calls and Phone numbers, whatever the switches say', async () => {
    renderPhone(presetSwitchLabels('DISPATCHER'), { demo: false });
    await screen.findByText('Calls view stub');
    await waitFor(() => expect(moduleTabs()).toEqual(['Calls', 'Phone numbers']));
  });
});
