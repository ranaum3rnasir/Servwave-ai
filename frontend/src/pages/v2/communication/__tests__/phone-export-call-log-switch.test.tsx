/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 8, slice S08.14 - Export call log, and what stays on every call.
//
// Renders the ROUTED Phone page (pages/v2/communication/PhonePage) with the real Calls tab and call drawer. The person's
// ability is compiled from the backend switch catalog, for a custom role that holds exactly the switches under test:
//   - the call log's Export button shows only with Export call log;
//   - the file holds exactly the calls the log shows (the rows the server sent, after the person's own search), with
//     a sentiment / review-flag column only for See call insights and a revenue column only for See company figures
//     (a column a person may not see is absent from the file, never blank);
//   - with the Technician preset's values the call screens show no player, transcript, summary, insights or export, and
//     do show Answered By, the call score, the call details, call back and text;
//   - the call log offers no way to delete a call, whatever the switches.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import type { AppAbility } from '@/lib/ability';
import { abilityWithSwitches, presetSwitchLabels } from '@/__tests__/support/backendSwitchCatalog';
import { technicianAbility } from '@/__tests__/support/technicianPreset';

vi.mock('@/components/communication/phone/DispatchView', () => ({ DispatchView: () => null }));
vi.mock('@/components/communication/phone/TrainingView', () => ({ TrainingView: () => null }));
vi.mock('@/components/communication/phone/NumbersView', () => ({ NumbersView: () => null }));
vi.mock('@/components/communication/phone/BlockedCallersView', () => ({ BlockedCallersView: () => null }));
vi.mock('@/components/communication/phone/CallFlows', () => ({ CallFlowsView: () => null }));
vi.mock('@/components/communication/phone/CallGroups', () => ({ CallGroupsView: () => null }));
vi.mock('@/components/communication/phone/CallMaskingView', () => ({ CallMaskingView: () => null }));
vi.mock('@/pages/v2/communication/components/planUsage', () => ({ PlanUsage: () => null }));

const downloaded = vi.hoisted(() => ({ calls: [] as Array<{ csv: string; filename: string }> }));
vi.mock('@/lib/csv', async () => {
  const actual = await vi.importActual<typeof import('@/lib/csv')>('@/lib/csv');
  return {
    ...actual,
    downloadCSV: (csv: string, filename: string) => {
      downloaded.calls.push({ csv, filename });
    },
  };
});

import { useAuthStore } from '@/stores/auth.store';
import PhonePage from '@/pages/v2/communication/PhonePage';

const mockApi = vi.mocked(api);

const COMPANY_LINE = '+12019037784';
const AGENT_USER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AGENT_NAME = 'Dana Lee';
const REVIEW_FLAG = 'Low-confidence booking';
const SUMMARY = 'Caller wants a quote for a garage door spring.';
const TRANSCRIPT = 'Hello, I would like a quote for a spring.';

let sequence = 0;
function call(fields: Record<string, unknown>) {
  sequence += 1;
  return {
    id: `cd000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    direction: 'inbound', toNumber: COMPANY_LINE, status: 'completed', answeredBy: { kind: 'none' },
    startedAt: new Date().toISOString(), durationSec: 60, fromNumber: '+15551110001', ...fields,
  };
}

/** A call as it reaches a holder of every call switch: recording, transcript, summary, insights and revenue. */
const FULL_CALL = () =>
  call({
    answeredBy: { kind: 'csr', id: AGENT_USER }, qaScore: 87, sentiment: 'negative', reviewFlag: REVIEW_FLAG,
    hasRecording: true, summary: SUMMARY, transcriptPreview: TRANSCRIPT, revenue: 4321, fromNumber: '+15551110001',
    tags: ['spring'],
  });
const SECOND_CALL = () => call({ fromNumber: '+15552220002', durationSec: 90 });

const AGENT = {
  id: 'ag000000-0000-4000-8000-000000000001', kind: 'human', name: AGENT_NAME, role: 'Front desk', userId: AGENT_USER,
  linkedUser: { id: AGENT_USER, name: AGENT_NAME, email: 'dana@example.test' },
};

function renderPhone(ability: AppAbility, calls: unknown[]) {
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
    if (url === '/api/communication/calls') return { data: { calls } };
    if (url === '/api/communication/agents') return { data: { agents: [AGENT] } };
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
const exportButton = () => screen.queryByRole('button', { name: /^Export$/ });

/** The header row and the data rows of the file the Export button handed to the browser. */
function exportedFile() {
  expect(downloaded.calls).toHaveLength(1);
  const [header, ...rows] = downloaded.calls[0]!.csv.split('\r\n');
  return { header: header!.split(','), rows, filename: downloaded.calls[0]!.filename };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  downloaded.calls.length = 0;
});

describe('the call log\'s Export button', () => {
  it('is absent without Export call log', async () => {
    renderPhone(abilityWithSwitches(...SECTION), [FULL_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    expect(exportButton()).not.toBeInTheDocument();
    expect(screen.queryByText(/export/i)).not.toBeInTheDocument();
  });

  it('is present with Export call log, and hands the browser a file', async () => {
    renderPhone(abilityWithSwitches(...SECTION, 'Export call log'), [FULL_CALL(), SECOND_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    fireEvent.click(exportButton()!);
    const file = exportedFile();
    expect(file.header.slice(0, 3)).toEqual(['Date/Time', 'Direction', 'From']);
    expect(file.rows).toHaveLength(2);
  });

  it('puts no vendor name in the file name or the column headers', async () => {
    renderPhone(abilityWithSwitches(...SECTION, 'Export call log', 'See call insights', 'See prices', 'See company figures'), [FULL_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    fireEvent.click(exportButton()!);
    const file = exportedFile();
    expect(`${file.filename},${file.header.join(',')}`).not.toMatch(/ctm|calltracking|supabase|render|stripe|twilio|resend/i);
  });
});

describe('what the exported file carries', () => {
  it('holds exactly the calls the log shows: the ones the server sent, narrowed by the person\'s own search', async () => {
    const mine = FULL_CALL();
    const other = SECOND_CALL();
    renderPhone(abilityWithSwitches(...SECTION, 'Export call log'), [mine, other]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    fireEvent.click(exportButton()!);
    const everything = exportedFile();
    expect(everything.rows).toHaveLength(2);
    expect(everything.rows.join('\n')).toContain('+15551110001');
    expect(everything.rows.join('\n')).toContain('+15552220002');

    downloaded.calls.length = 0;
    fireEvent.change(screen.getByPlaceholderText('Search calls…'), { target: { value: '222-0002' } });
    await waitFor(() => expect(screen.queryByText(AGENT_NAME)).not.toBeInTheDocument());
    fireEvent.click(exportButton()!);
    const narrowed = exportedFile();
    expect(narrowed.rows).toHaveLength(1);
    expect(narrowed.rows[0]).toContain('+15552220002');
    expect(narrowed.rows[0]).not.toContain('+15551110001');
  });

  it('has no sentiment, review-flag or revenue column for a person without See call insights and See company figures', async () => {
    // Even if a call arrives carrying them, nothing about them reaches the file.
    renderPhone(abilityWithSwitches(...SECTION, 'Export call log'), [FULL_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    fireEvent.click(exportButton()!);
    const file = exportedFile();
    expect(file.header.join(',')).not.toMatch(/sentiment|review|insight|revenue/i);
    expect(file.rows.join('\n')).not.toContain(REVIEW_FLAG);
    expect(file.rows.join('\n')).not.toContain('negative');
    expect(file.rows.join('\n')).not.toContain('4321');
  });

  it('adds the sentiment and review-flag columns with See call insights, and no revenue column without See company figures', async () => {
    renderPhone(abilityWithSwitches(...SECTION, 'Export call log', 'See call insights'), [FULL_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    fireEvent.click(exportButton()!);
    const file = exportedFile();
    expect(file.header).toContain('Sentiment');
    expect(file.header).toContain('Review flag');
    expect(file.header.join(',')).not.toMatch(/revenue/i);
    expect(file.rows[0]).toContain('negative');
    expect(file.rows[0]).toContain(REVIEW_FLAG);
    expect(file.rows[0]).not.toContain('4321');
  });

  it('adds the revenue column with See company figures, and no insight columns without See call insights', async () => {
    renderPhone(abilityWithSwitches(...SECTION, 'Export call log', 'See prices', 'See company figures'), [FULL_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    fireEvent.click(exportButton()!);
    const file = exportedFile();
    expect(file.header).toContain('Revenue');
    expect(file.header.join(',')).not.toMatch(/sentiment|review/i);
    expect(file.rows[0]).toContain('4321');
    expect(file.rows[0]).not.toContain('negative');
  });

  it('leaves the revenue column out when no call in the file carries a revenue figure, rather than a column of blanks', async () => {
    renderPhone(abilityWithSwitches(...SECTION, 'Export call log', 'See prices', 'See company figures'), [SECOND_CALL()]);
    await waitFor(() => expect(screen.getByText('(555) 222-0002')).toBeInTheDocument());

    fireEvent.click(exportButton()!);
    expect(exportedFile().header.join(',')).not.toMatch(/revenue/i);
  });
});

describe('a person with the Technician preset\'s values', () => {
  it('sees no player, transcript, summary, insights or export on the call screens', async () => {
    renderPhone(technicianAbility(), [FULL_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    expect(exportButton()).not.toBeInTheDocument();
    expect(screen.queryAllByRole('columnheader').map((h) => h.textContent?.trim())).not.toContain('Insights');

    fireEvent.click(screen.getByText(AGENT_NAME));
    const drawer = await screen.findByRole('dialog');
    expect(drawer.querySelector('audio')).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /play|download/i })).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/Transcript/)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(TRANSCRIPT)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/Call insights/)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(SUMMARY)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/Sentiment/)).not.toBeInTheDocument();
    expect(within(drawer).queryByText(REVIEW_FLAG)).not.toBeInTheDocument();
  });

  it('keeps Answered By, the call score, the call details, call back and text', async () => {
    renderPhone(technicianAbility(), [FULL_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    // In the list: who answered, and the row's call back.
    expect(screen.getAllByText(AGENT_NAME).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /Call Back/i }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText(AGENT_NAME));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Answered by')).toBeInTheDocument();
    expect(within(drawer).getByText(AGENT_NAME)).toBeInTheDocument();
    expect(within(drawer).getByText('Call score')).toBeInTheDocument();
    expect(within(drawer).getByText('87')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: /Call details/i }));
    expect(within(drawer).getByText('Ad source')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Call back' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Message' })).toBeInTheDocument();
  });
});

describe('call back and text follow Contact customers', () => {
  it('are offered with it and withheld without it, in the list and in the drawer', async () => {
    renderPhone(abilityWithSwitches(...SECTION, 'Contact customers'), [FULL_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /Call Back/i }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText(AGENT_NAME));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('button', { name: 'Call back' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Message' })).toBeInTheDocument();
  });

  it('are not offered to a person who reads calls but may not contact customers', async () => {
    renderPhone(abilityWithSwitches(...SECTION), [FULL_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Call Back/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(AGENT_NAME));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Answered by')).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Call back' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Message' })).not.toBeInTheDocument();
  });
});

describe('deleting a call', () => {
  it('is offered nowhere on the call log or the call drawer, with every switch on', async () => {
    const everySwitch = presetSwitchLabels('ADMIN');
    renderPhone(abilityWithSwitches(...everySwitch), [FULL_CALL()]);
    await waitFor(() => expect(screen.getByText(AGENT_NAME)).toBeInTheDocument());

    const deleteControls = () =>
      screen.queryAllByRole('button').filter((b) => /delete|trash/i.test(`${b.textContent} ${b.getAttribute('aria-label')} ${b.getAttribute('title')}`));
    expect(deleteControls()).toEqual([]);

    fireEvent.click(screen.getByText(AGENT_NAME));
    await screen.findByRole('dialog');
    expect(deleteControls()).toEqual([]);
    expect(screen.queryAllByRole('menuitem').filter((m) => /delete/i.test(m.textContent ?? ''))).toEqual([]);
    expect(mockApi.delete).not.toHaveBeenCalled();
  });
});
