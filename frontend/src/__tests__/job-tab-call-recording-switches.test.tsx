/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions S08.11 - the call drawer opened from a record's Communication tab follows the same two switches
// as the one on the Phone page. This renders the job tab, clicks a call row, and lets the REAL entity drawer fetch the
// call and mount the real call drawer; only the network is stubbed.
//
// The switch values are the built-in roles' preset columns, read from the backend catalog file itself (the module is
// not importable into the browser build).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { catalogToggle, type PresetRole } from './support/backendSwitchCatalog';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';

const mockApi = vi.mocked(api);

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
const CALL_ID = 'ca000000-0000-4000-8000-000000000001';

const CALL_ROW = {
  id: CALL_ID,
  channel: 'call',
  direction: 'in',
  who: 'Daniel Cohen',
  title: 'Inbound call · 4m 07s',
  preview: 'Confirmed Thursday 8am.',
  at: '2026-06-01T14:32:00.000Z',
  jobId: JOB_ID,
  jobLabel: 'J00042',
};

const CALL = {
  id: CALL_ID,
  direction: 'inbound',
  fromNumber: '+15551230000',
  toNumber: '+12019037784',
  status: 'completed',
  answeredBy: { kind: 'none' },
  startedAt: '2026-06-01T14:32:00.000Z',
  durationSec: 247,
  transcriptPreview: 'Already stored.',
  summary: 'Confirmed Thursday.',
};

/** What the server answers for this call: the "has recording" flag only goes to a holder of either switch. */
function stubNetwork(callAnswer: Record<string, unknown>) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/communications`) return { data: { items: [CALL_ROW] } };
    if (url === `/api/communication/calls/${CALL_ID}`) return { data: { call: callAnswer } };
    if (url === '/api/communication/contacts') return { data: { contacts: [] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    return { data: {} };
  });
}

/** The ability rules of a built-in role's preset values for the recording switches. */
function rulesOf(role: PresetRole): AbilityRule[] {
  const rules: AbilityRule[] = [{ action: 'read', subject: 'Communication' }];
  if (catalogToggle('Play recording').presets[role]) rules.push({ action: 'play_recording', subject: 'Communication' });
  if (catalogToggle('Download recording').presets[role]) rules.push({ action: 'download_recording', subject: 'Communication' });
  return rules;
}

async function openTheCall(rules: AbilityRule[]) {
  const user = userEvent.setup();
  renderWithProviders(
    <JobCommunicationsTab jobId={JOB_ID} jobNumber="J00042" customerId="c0000000-0000-0000-0000-000000000001" customerName="Daniel Cohen" />,
    { ability: buildAbility(rules) },
  );
  await user.click(await screen.findByText('Inbound call · 4m 07s'));
  // The drawer is lazy-loaded; its title is the first thing it paints.
  await screen.findByText('Incoming Call');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the call drawer opened from a job tab follows Play recording and Download recording', () => {
  it('with the Dispatcher preset\'s values shows the player and no download control', async () => {
    stubNetwork({ ...CALL, hasRecording: true });
    await openTheCall(rulesOf('DISPATCHER'));

    expect(screen.getByRole('slider', { name: 'Seek recording' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download recording' })).not.toBeInTheDocument();
  });

  it('with the Technician preset\'s values shows neither, and no line about whether it was recorded', async () => {
    stubNetwork(CALL);
    await openTheCall(rulesOf('TECHNICIAN'));

    expect(screen.queryByRole('slider', { name: 'Seek recording' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download recording' })).not.toBeInTheDocument();
    expect(screen.queryByText('No recording for this call')).not.toBeInTheDocument();
  });

  it('with the Admin preset\'s values shows both', async () => {
    stubNetwork({ ...CALL, hasRecording: true });
    await openTheCall(rulesOf('ADMIN'));

    expect(screen.getByRole('slider', { name: 'Seek recording' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download recording' })).toBeInTheDocument();
  });
});
