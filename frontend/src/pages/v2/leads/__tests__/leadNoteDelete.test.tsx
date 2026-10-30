/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.25 - the delete control on a lead's notes. Renders the ROUTED lead page
   (pages/v2/leads/LeadDetailPage) and opens the Activity panel in its side rail, where the lead's notes are listed.

   Whether this person may delete a note is the server's per-note answer (`can_delete`). A lead never takes the job
   lock, and a closed lead (Won or Lost) locks only its contact entries, so a closed lead's notes delete like any
   other. A confirmed delete calls the lead's own route and refreshes the notes.
   ========================================================================== */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders, LEAD_FIXTURE } from '@/__tests__/helpers';
import { DESKTOP, emulateDevice } from '@/__tests__/support/deviceShape';

import LeadDetailPage from '../LeadDetailPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: LEAD_FIXTURE.id }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);

const note = (id: string, first: string, answer: Record<string, unknown>) => ({
  id, content: `Text of ${id}`, created_at: '2026-08-10T12:00:00.000Z',
  creator: { id: `u-${id}`, first_name: first, last_name: 'Tester' }, ...answer,
});
const MINE = note('mine', 'Mia', { can_delete: true, locked_actions: [] });
const THEIRS = note('theirs', 'Theo', { can_delete: false, locked_actions: [] });

let noteRows: unknown[] = [];

function renderLeadPage(over: Record<string, unknown> = {}) {
  const lead = { ...LEAD_FIXTURE, estimates: [], contact_entries: [], actions: [], ...over };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/leads/${LEAD_FIXTURE.id}/notes`) return { data: { notes: noteRows } };
    if (url.endsWith('/timeline')) return { data: { events: [] } };
    if (url.includes('/api/leads/')) return { data: { lead } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
  return renderWithProviders(<LeadDetailPage />, { ability: buildAbility([{ action: 'read', subject: 'Lead' }]) });
}

const openActivity = async () => {
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Activity' }));
  return within(await screen.findByTestId('icon-rail-panel'));
};

let restoreDevice: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  noteRows = [];
  restoreDevice = emulateDevice(DESKTOP);
});
afterEach(() => {
  restoreDevice?.();
});

describe('the lead page\'s Activity panel', () => {
  it('draws Delete on a note the person may delete and on no other', async () => {
    noteRows = [MINE, THEIRS];
    renderLeadPage();
    const panel = await openActivity();
    await panel.findByText('Text of mine');
    expect(panel.getByRole('button', { name: 'Delete note by Mia Tester' })).toBeEnabled();
    expect(panel.getByText('Text of theirs')).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Delete note by Theo Tester' })).not.toBeInTheDocument();
  });

  it.each(['WON', 'LOST'])('still draws Delete on the notes of a %s lead: the closed-lead lock covers contact entries only', async (status) => {
    noteRows = [MINE];
    renderLeadPage({ status });
    const panel = await openActivity();
    await panel.findByText('Text of mine');
    expect(panel.getByRole('button', { name: 'Delete note by Mia Tester' })).toBeEnabled();
  });

  it('asks first, then deletes through the lead\'s own route and refreshes the notes', async () => {
    noteRows = [MINE];
    renderLeadPage();
    const panel = await openActivity();
    await panel.findByText('Text of mine');
    const user = userEvent.setup();
    await user.click(panel.getByRole('button', { name: 'Delete note by Mia Tester' }));
    expect(mockApi.delete).not.toHaveBeenCalled();
    noteRows = [];
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}/notes/mine`));
    await waitFor(() => expect(panel.queryByText('Text of mine')).not.toBeInTheDocument());
  });
});
