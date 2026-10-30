/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions S08.12 - the Communication tab on a job follows View transcript: the call row's preview line (the
// call summary) comes from the server empty without the switch, so the row shows no summary, and the call drawer it
// opens shows no transcript or summary and never asks for them. This renders the job tab, clicks a call row, and lets
// the REAL entity drawer fetch the call and mount the real call drawer; only the network is stubbed.
//
// The switch values are the built-in roles' preset columns, read from the backend catalog file itself (the module is
// not importable into the browser build).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import type { AppAbility } from '@/lib/ability';
import { abilityWithSwitches, presetSwitchLabels, type PresetRole } from './support/backendSwitchCatalog';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';

const mockApi = vi.mocked(api);

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
const CALL_ID = 'ca000000-0000-4000-8000-000000000001';
const SUMMARY = 'Confirmed Thursday 8am.';
const TRANSCRIPT = 'Already stored words.';

/** The tab row as the server sends it: the preview line is the call summary, empty without View transcript. */
const callRow = (preview: string) => ({
  id: CALL_ID,
  channel: 'call',
  direction: 'in',
  who: 'Daniel Cohen',
  title: 'Inbound call · 4m 07s',
  preview,
  at: '2026-06-01T14:32:00.000Z',
  jobId: JOB_ID,
  jobLabel: 'J00042',
});

const CALL = {
  id: CALL_ID,
  direction: 'inbound',
  fromNumber: '+15551230000',
  toNumber: '+12019037784',
  status: 'completed',
  answeredBy: { kind: 'none' },
  startedAt: '2026-06-01T14:32:00.000Z',
  durationSec: 247,
};

function stubNetwork(row: ReturnType<typeof callRow>, callAnswer: Record<string, unknown>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/communications`) return { data: { items: [row] } };
    if (url === `/api/communication/calls/${CALL_ID}`) return { data: { call: callAnswer } };
    if (url === '/api/communication/contacts') return { data: { contacts: [] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    return { data: {} };
  });
}

const abilityOf = (role: PresetRole): AppAbility => abilityWithSwitches(...presetSwitchLabels(role));

function renderTab(ability: AppAbility) {
  return renderWithProviders(
    <JobCommunicationsTab jobId={JOB_ID} jobNumber="J00042" customerId="c0000000-0000-0000-0000-000000000001" customerName="Daniel Cohen" />,
    { ability },
  );
}

async function openTheCall(ability: AppAbility) {
  const user = userEvent.setup();
  renderTab(ability);
  await user.click(await screen.findByText('Inbound call · 4m 07s'));
  // The drawer is lazy-loaded; its title is the first thing it paints.
  await screen.findByText('Incoming Call');
}

const askedForTranscript = () => mockApi.get.mock.calls.some(([url]) => String(url).includes('/transcript'));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the job tab and the call drawer it opens follow View transcript', () => {
  it("with the Dispatcher preset's values shows the summary on the row and the summary and transcript in the drawer", async () => {
    stubNetwork(callRow(SUMMARY), { ...CALL, summary: SUMMARY, transcriptPreview: TRANSCRIPT });
    await openTheCall(abilityOf('DISPATCHER'));

    // The row's preview line, and the drawer's own insight block.
    expect(screen.getAllByText(SUMMARY).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Already stored words\./)).toBeInTheDocument();
  });

  it("with the Technician preset's values shows no summary on the row and no transcript or summary in the drawer", async () => {
    stubNetwork(callRow(''), CALL);
    await openTheCall(abilityOf('TECHNICIAN'));

    expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument();
    expect(screen.queryByText('Transcript')).not.toBeInTheDocument();
    expect(screen.queryByText('Call insights')).not.toBeInTheDocument();
    expect(screen.queryByText('No transcript available for this call.')).not.toBeInTheDocument();
    expect(screen.queryByText('No AI insight for this call.')).not.toBeInTheDocument();
    // The transcript route would refuse this person, so the drawer must not call it.
    expect(askedForTranscript()).toBe(false);
  });

  it('asks for the transcript of a call with none stored when the person holds the switch', async () => {
    stubNetwork(callRow(''), CALL);
    await openTheCall(abilityWithSwitches('View transcript'));

    expect(askedForTranscript()).toBe(true);
  });
});
