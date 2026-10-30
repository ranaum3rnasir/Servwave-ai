/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 8, slice S08.4 - the Phone page's four tiles (Calls today, Missed Calls, Unread messages,
// Needs Attention) and the Calls tab's stat strip count what the call log lists, and nothing else.
//
// Renders the ROUTED Phone page (pages/v2/communication/PhonePage) with the real call log in it. The server answers the
// way the call log and the text inbox route do for each Communication scope value: "Attached" returns only the
// person's calls and conversations, "All" returns every one. The page has no count route of its own and no other
// source, so every figure on screen must come from those answers. The out-of-scope fixtures are chosen to move EVERY
// figure if one leaked: a missed call, a needs-manager call, a negative-sentiment call, a live call, a long call, a
// second call from a number the person has only one call from, and an unread text.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';

vi.mock('@/components/communication/phone/DispatchView', () => ({ DispatchView: () => null }));
vi.mock('@/components/communication/phone/PerformanceView', () => ({ PerformanceView: () => null }));
vi.mock('@/components/communication/phone/TrainingView', () => ({ TrainingView: () => null }));
vi.mock('@/components/communication/phone/NumbersView', () => ({ NumbersView: () => null }));
vi.mock('@/components/communication/phone/BlockedCallersView', () => ({ BlockedCallersView: () => null }));
vi.mock('@/components/communication/phone/CallFlows', () => ({ CallFlowsView: () => null }));
vi.mock('@/components/communication/phone/CallGroups', () => ({ CallGroupsView: () => null }));
vi.mock('@/components/communication/phone/CallMaskingView', () => ({ CallMaskingView: () => null }));
vi.mock('@/pages/v2/communication/components/planUsage', () => ({ PlanUsage: () => null }));

import { useAuthStore } from '@/stores/auth.store';
import PhonePage from '@/pages/v2/communication/PhonePage';

const mockApi = vi.mocked(api);
const COMM_READ = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
  // Needs Attention also counts negative-sentiment and flagged calls for a holder of See call insights (S08.13); this
  // suite is about the scope, so the person holds it.
  { action: 'see_call_insights', subject: 'Communication' },
]);

const COMPANY_LINE = '+12019037784';
const CUSTOMER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let sequence = 0;
function call(fields: Record<string, unknown>) {
  sequence += 1;
  return {
    id: `cd000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    direction: 'inbound', toNumber: COMPANY_LINE, status: 'completed', answeredBy: { kind: 'none' },
    startedAt: new Date().toISOString(), durationSec: 0, ...fields,
  };
}

// The person's own calls: one missed, and two from one existing customer (a repeat caller) lasting 120 and 60 seconds.
const MINE = [
  call({ fromNumber: '+15551110001', status: 'missed' }),
  call({ fromNumber: '+15551110002', customerId: CUSTOMER_A, durationSec: 120 }),
  call({ fromNumber: '+15551110002', customerId: CUSTOMER_A, durationSec: 60 }),
];
// Calls on a number that is not linked to the person.
const NOT_MINE = [
  call({ fromNumber: '+15551110009', status: 'missed', disposition: 'needs_manager' }),
  call({ fromNumber: '+15551110001', status: 'active', durationSec: 300 }),
  call({ fromNumber: '+15551110008', customerId: CUSTOMER_B, durationSec: 600, sentiment: 'negative' }),
];
const MY_THREADS = [{ id: 't1', unread: 2, messages: [] }];
const OTHER_THREADS = [{ id: 't2', unread: 3, messages: [] }];

function renderPhone(answers: { calls: unknown[]; threads: unknown[] }) {
  vi.mocked(useAuthStore).mockImplementation((sel: unknown) =>
    (sel as (s: unknown) => unknown)({
      user: {
        id: 'u1', email: 'custom@test.com', first_name: 'Custom', last_name: 'Role', role: 'CUSTOM',
        organization_id: '00000000-0000-4000-8000-000000000a01', org_is_demo: false, org_features: ['phone'],
      },
      isAuthenticated: true, isLoading: false, error: null,
    }),
  );
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/communication/calls') return { data: { calls: answers.calls } };
    if (url === '/api/communication/threads') return { data: { threads: answers.threads } };
    return { data: { callFlows: [], callGroups: [], blocked: [], numbers: [], agents: [], techs: [], contacts: [] } };
  });
  renderWithProviders(
    <Routes><Route path="/communication/phone/:tab" element={<PhonePage />} /></Routes>,
    { initialEntries: ['/communication/phone/calls'], ability: COMM_READ },
  );
}

/** The figure on the tile (or stat card) with exactly this label. */
function figure(label: string): string {
  const tile = screen
    .getAllByRole('button')
    .find((b) => [...b.querySelectorAll('*')].some((el) => el.children.length === 0 && el.textContent === label));
  if (!tile) throw new Error(`no tile labelled "${label}"`);
  return (tile.textContent ?? '').replace(label, '').trim();
}

const PAGE_TILES = ['Calls today', 'Missed Calls', 'Unread messages', 'Needs Attention'] as const;
const STRIP = ['Missed calls', 'Calls', 'New customers', 'Existing customers', 'Repeat callers', 'Active Calls', 'Avg call time'] as const;
const figures = (labels: readonly string[]) => Object.fromEntries(labels.map((l) => [l, figure(l)]));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Phone page tiles and the Calls stat strip follow Communication scope (S08.4)', () => {
  it('on "Attached" every tile and every stat-strip figure counts only the person\'s own calls and texts', async () => {
    renderPhone({ calls: MINE, threads: MY_THREADS });
    await waitFor(() => expect(figure('Calls today')).toBe('3'));
    expect(figures(PAGE_TILES)).toEqual({
      'Calls today': '3', 'Missed Calls': '1', 'Unread messages': '2', 'Needs Attention': '0',
    });
    expect(figures(STRIP)).toEqual({
      'Missed calls': '1', Calls: '3', 'New customers': '1', 'Existing customers': '2', 'Repeat callers': '1',
      'Active Calls': '0', 'Avg call time': '1 Min 30 Sec',
    });
  });

  it('on "All" the same tiles count every call and every text, as they do today', async () => {
    renderPhone({ calls: [...MINE, ...NOT_MINE], threads: [...MY_THREADS, ...OTHER_THREADS] });
    await waitFor(() => expect(figure('Calls today')).toBe('6'));
    expect(figures(PAGE_TILES)).toEqual({
      'Calls today': '6', 'Missed Calls': '2', 'Unread messages': '5', 'Needs Attention': '2',
    });
    expect(figures(STRIP)).toEqual({
      'Missed calls': '2', Calls: '6', 'New customers': '3', 'Existing customers': '3', 'Repeat callers': '2',
      'Active Calls': '1', 'Avg call time': '4 Min 30 Sec',
    });
  });

  it('a person whose scope holds no calls and no texts sees zeros, not a hint of what is hidden', async () => {
    renderPhone({ calls: [], threads: [] });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/communication/calls'));
    await waitFor(() => expect(figures(PAGE_TILES)).toEqual({
      'Calls today': '0', 'Missed Calls': '0', 'Unread messages': '0', 'Needs Attention': '0',
    }));
    expect(figures(STRIP)).toMatchObject({ 'Missed calls': '0', Calls: '0', 'Active Calls': '0', 'Avg call time': '-' });
  });
});
