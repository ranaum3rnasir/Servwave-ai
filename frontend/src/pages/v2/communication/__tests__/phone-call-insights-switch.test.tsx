/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 8, slice S08.13 - See call insights, agent scorecards and money on calls.
//
// Renders the ROUTED Phone page (pages/v2/communication/PhonePage) with the real Calls tab, call drawer and Performance
// & QA view in it. The person's ability is compiled from the backend switch catalog, for a custom role that holds
// exactly the switches under test:
//   - without See call insights there is no Insights column and no Performance & QA sub-tab, the call drawer shows no
//     sentiment, review flag or agent QA chip, and Needs Attention counts only after-hours emergency and needs-manager
//     calls (with a help text that says so), even when a sentiment or a flag arrives in the data;
//   - the Answered By name in the list, the filter by person, and the Answered By detail and call score in the drawer
//     stay for that person (the agents list still answers with identity, no metrics);
//   - agent revenue on the scorecards shows only with See company figures.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import type { AppAbility } from '@/lib/ability';
import { abilityWithSwitches } from '@/__tests__/support/backendSwitchCatalog';

vi.mock('@/components/communication/phone/DispatchView', () => ({ DispatchView: () => null }));
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

const COMPANY_LINE = '+12019037784';
const AGENT_USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AGENT_NAME = 'Dana Lee';
const REVIEW_FLAG = 'Low-confidence booking';
const FLAGGED_FROM = '+15559990005';

let sequence = 0;
function call(fields: Record<string, unknown>) {
  sequence += 1;
  return {
    id: `cd000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    direction: 'inbound', toNumber: COMPANY_LINE, status: 'completed', answeredBy: { kind: 'none' },
    startedAt: new Date().toISOString(), durationSec: 60, fromNumber: '+15551110001', ...fields,
  };
}

const ANSWERED = call({ answeredBy: { kind: 'csr', id: AGENT_USER }, qaScore: 87, sentiment: 'neutral' });
const CALLS = [
  ANSWERED,
  // The outcome-based items: counted whatever the person holds.
  call({ disposition: 'needs_manager' }),
  call({ disposition: 'after_hours_emergency' }),
  // The insight-based items: counted only for a holder of See call insights.
  call({ sentiment: 'negative' }),
  call({ reviewFlag: REVIEW_FLAG, sentiment: 'negative', fromNumber: FLAGGED_FROM }),
];

/** The agents list as the server answers it: identity for everyone, the metrics only with See call insights. */
const AGENT_IDENTITY = {
  id: 'ag000000-0000-4000-8000-000000000001', kind: 'human', name: AGENT_NAME, role: 'Front desk', userId: AGENT_USER,
  linkedUser: { id: AGENT_USER, name: AGENT_NAME, email: 'dana@example.test' },
};
const AGENT_METRICS = {
  calls: 412, answerRatePct: 91, bookingRatePct: 64, ahtSec: 233, sentimentPct: 88, scriptAdherencePct: 93,
};
const AGENT_REVENUE = 28800;

function renderPhone(ability: AppAbility, agents: unknown[]) {
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
    if (url === '/api/communication/calls') return { data: { calls: CALLS } };
    if (url === '/api/communication/agents') return { data: { agents } };
    if (url === '/api/communication/threads') return { data: { threads: [] } };
    return { data: { callFlows: [], callGroups: [], blocked: [], numbers: [], techs: [], contacts: [] } };
  });
  renderWithProviders(
    <Routes><Route path="/communication/phone/:tab" element={<PhonePage />} /></Routes>,
    { initialEntries: ['/communication/phone/calls'], ability },
  );
}

/** A person who reads the section; the switches under test are added to it. */
const SECTION = ['Access Communication', 'View communication'];
const without = abilityWithSwitches(...SECTION);
const withInsights = abilityWithSwitches(...SECTION, 'See call insights');
// See company figures needs See prices.
const withInsightsAndFigures = abilityWithSwitches(...SECTION, 'See call insights', 'See prices', 'See company figures');

/** The tile with exactly this label, whole. */
function tile(label: string): HTMLElement {
  const found = screen
    .getAllByRole('button')
    .find((b) => [...b.querySelectorAll('*')].some((el) => el.children.length === 0 && el.textContent === label));
  if (!found) throw new Error(`no tile labelled "${label}"`);
  return found;
}
const figure = (label: string) => (tile(label).textContent ?? '').replace(label, '').trim();

const columnHeaders = () => screen.queryAllByRole('columnheader').map((h) => h.textContent?.trim());

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Phone page without See call insights', () => {
  it('has no Performance & QA sub-tab and no Insights column, and keeps the Answered By name', async () => {
    renderPhone(without, [AGENT_IDENTITY]);
    await waitFor(() => expect(figure('Calls today')).toBe(String(CALLS.length)));

    expect(screen.queryByRole('tab', { name: /Performance & QA/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Performance & QA/)).not.toBeInTheDocument();
    const headers = columnHeaders();
    expect(headers).not.toContain('Insights');
    expect(headers).toContain('Answered By');
    // The agents list still answered with identity, so the list names who answered.
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());
  });

  it('still offers the filter by person, with the answerer\'s name in it', async () => {
    renderPhone(without, [AGENT_IDENTITY]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Filter results/ }));
    const user = (await screen.findByText('User')).parentElement as HTMLElement;
    expect(within(user).getByRole('button', { name: AGENT_NAME })).toBeInTheDocument();
  });

  it('shows the Answered By detail and the call score in the call drawer, and no sentiment, review flag or agent QA', async () => {
    renderPhone(without, [AGENT_IDENTITY]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    fireEvent.click(screen.getByText(AGENT_NAME));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Answered by')).toBeInTheDocument();
    expect(within(drawer).getByText(AGENT_NAME)).toBeInTheDocument();
    expect(within(drawer).getByText('Front desk')).toBeInTheDocument();
    expect(within(drawer).getByText('Call score')).toBeInTheDocument();
    expect(within(drawer).getByText('87')).toBeInTheDocument();
    expect(within(drawer).queryByText(/Sentiment/)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/Agent QA/)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/undefined|NaN/)).not.toBeInTheDocument();
  });

  it('shows no sentiment or review flag in the drawer even if the call arrives carrying them', async () => {
    renderPhone(without, [AGENT_IDENTITY]);
    await waitFor(() => expect(figure('Calls today')).toBe(String(CALLS.length)));

    // The fifth call carries a review flag and a negative sentiment; open it from the list.
    fireEvent.click(screen.getByText(/999-0005/));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Call score')).toBeInTheDocument();
    expect(within(drawer).queryByText(REVIEW_FLAG)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/Sentiment/)).not.toBeInTheDocument();
  });

  it('counts only after-hours emergency and needs-manager calls under Needs Attention, and the help text says so', async () => {
    renderPhone(without, [AGENT_IDENTITY]);
    // Five calls reach the screen; the negative-sentiment one and the flagged one carry insights this person may not use.
    await waitFor(() => expect(figure('Calls today')).toBe('5'));
    expect(figure('Needs Attention')).toBe('2');
    expect(tile('Needs Attention')).toHaveAttribute('title', expect.stringMatching(/after-hours emergenc/i));
    expect(tile('Needs Attention')).toHaveAttribute('title', expect.stringMatching(/needs-manager|needs a manager|need a manager/i));

    // Its focus filter lists the same two calls.
    fireEvent.click(tile('Needs Attention'));
    expect(await screen.findByText(/Showing Needs Attention · 2/)).toBeInTheDocument();
  });
});

describe('Phone page with See call insights', () => {
  it('has the Performance & QA sub-tab and the Insights column', async () => {
    renderPhone(withInsights, [{ ...AGENT_IDENTITY, ...AGENT_METRICS }]);
    await waitFor(() => expect(figure('Calls today')).toBe('5'));

    expect(screen.getByRole('tab', { name: /Performance & QA/ })).toBeInTheDocument();
    expect(columnHeaders()).toContain('Insights');
  });

  it('also counts negative-sentiment and flagged calls under Needs Attention, with no restriction in the help text', async () => {
    renderPhone(withInsights, [{ ...AGENT_IDENTITY, ...AGENT_METRICS }]);
    await waitFor(() => expect(figure('Calls today')).toBe('5'));
    expect(figure('Needs Attention')).toBe('4');
    expect(tile('Needs Attention').getAttribute('title') ?? '').not.toMatch(/after-hours/i);
  });

  it('shows agent revenue on the scorecards only with See company figures', async () => {
    const agents = [{ ...AGENT_IDENTITY, ...AGENT_METRICS, revenue: AGENT_REVENUE }];

    renderPhone(withInsightsAndFigures, agents);
    await waitFor(() => expect(figure('Calls today')).toBe('5'));
    fireEvent.click(screen.getByRole('tab', { name: /Performance & QA/ }));
    await waitFor(() => expect(screen.getAllByText('Revenue').length).toBeGreaterThan(0));
    expect(screen.getAllByText('$28.8k').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/attributed revenue/).length).toBeGreaterThan(0);
  });

  it('shows the scorecards with no revenue column, tile or total without See company figures, and no zero in its place', async () => {
    renderPhone(withInsights, [{ ...AGENT_IDENTITY, ...AGENT_METRICS }]);
    await waitFor(() => expect(figure('Calls today')).toBe('5'));
    fireEvent.click(screen.getByRole('tab', { name: /Performance & QA/ }));

    await waitFor(() => expect(screen.getAllByText('Answer rate').length).toBeGreaterThan(0));
    expect(screen.getAllByText('412').length).toBeGreaterThan(0);
    expect(screen.queryByText('Revenue')).not.toBeInTheDocument();
    expect(screen.queryByText(/attributed revenue/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
  });
});
