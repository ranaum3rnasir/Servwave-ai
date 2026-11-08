/**
 * The lead status menu offers Lost and Cancelled only to a user who may take the dedicated door.
 *
 * Setting LOST or CANCELLED from the menu does what "Mark lost" and "Cancel lead" do (the booked
 * walkthrough trips are cancelled with it), so the server now asks for `mark_lost Lead` and
 * `cancel Lead` on that request, exactly as it does on those doors. The menu follows the same
 * abilities, so a user who may edit a lead but not close it is not offered a choice that would be
 * refused. Gated on `ability.can(...)`, never a role name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE, NOTES_FIXTURE } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
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
type Rules = Parameters<typeof buildAbility>[0];
const EDIT_LEAD: Rules = [
  { action: 'read', subject: 'Lead' },
  { action: 'update', subject: 'Lead' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url.includes('/api/leads/')) return { data: { lead: { ...LEAD_FIXTURE, status: 'CONTACTED', estimates: [] } } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
});

async function openStatusMenu(rules: Rules) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderWithProviders(<LeadDetailPage />, { ability: buildAbility(rules) });
  await user.click(await screen.findByRole('button', { name: /lead status: contacted/i }));
  const items = await screen.findAllByRole('menuitem');
  return items.map((i) => i.textContent?.trim());
}

describe('lead status menu: Lost and Cancelled follow the dedicated doors', () => {
  it('offers every status to a user who may mark lost and cancel', async () => {
    const options = await openStatusMenu([
      ...EDIT_LEAD,
      { action: 'mark_lost', subject: 'Lead' },
      { action: 'cancel', subject: 'Lead' },
    ]);

    expect(options).toEqual([
      'New',
      'Contacted',
      'Walkthrough Scheduled',
      'Walkthrough Completed',
      'Estimate Sent',
      'Won',
      'Lost',
      'Cancelled',
    ]);
  });

  it('drops Lost for a user who may edit the lead but not mark it lost', async () => {
    const options = await openStatusMenu([...EDIT_LEAD, { action: 'cancel', subject: 'Lead' }]);

    expect(options).not.toContain('Lost');
    expect(options).toContain('Cancelled');
  });

  it('drops Cancelled for a user who may edit the lead but not cancel it', async () => {
    const options = await openStatusMenu([...EDIT_LEAD, { action: 'mark_lost', subject: 'Lead' }]);

    expect(options).toContain('Lost');
    expect(options).not.toContain('Cancelled');
  });

  it('drops both for a user who holds only lead edit', async () => {
    const options = await openStatusMenu([...EDIT_LEAD]);

    expect(options).toEqual(['New', 'Contacted', 'Walkthrough Scheduled', 'Walkthrough Completed', 'Estimate Sent', 'Won']);
  });
});

/**
 * Closing a lead always asks why (walkthrough lead-statuses PRD, D11). Picking Lost or Cancelled
 * from the status menu opens the same dialog the Mark Lost and Cancel Lead buttons open, and the
 * lead is closed through that dialog's door, with the typed reason. The menu itself never sends
 * a PATCH for these two.
 */
describe('lead status menu: Lost and Cancelled ask for a reason', () => {
  const CLOSE_RULES: Rules = [
    ...EDIT_LEAD,
    { action: 'mark_lost', subject: 'Lead' },
    { action: 'cancel', subject: 'Lead' },
  ];

  async function pickFromMenu(label: string) {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockApi.post.mockResolvedValue({ data: { lead: { ...LEAD_FIXTURE } } });
    renderWithProviders(<LeadDetailPage />, { ability: buildAbility(CLOSE_RULES) });
    await user.click(await screen.findByRole('button', { name: /lead status: contacted/i }));
    await user.click(await screen.findByRole('menuitem', { name: label }));
    return user;
  }

  it('Lost opens the Mark Lost dialog, and confirming closes the lead with the typed reason', async () => {
    const user = await pickFromMenu('Lost');

    expect(await screen.findByRole('heading', { name: 'Mark Lead as Lost' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/reason/i), 'Went with a competitor');
    await user.click(screen.getByRole('button', { name: 'Mark Lost' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`, {
        lost_reason: 'Went with a competitor',
      }),
    );
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('Cancelled opens the Cancel Lead dialog, and confirming cancels the lead with the typed reason', async () => {
    const user = await pickFromMenu('Cancelled');

    expect(await screen.findByRole('heading', { name: 'Cancel Lead' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/reason/i), 'Duplicate of another lead');
    await user.click(screen.getByRole('button', { name: 'Cancel Lead' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}/cancel`, {
        cancelled_reason: 'Duplicate of another lead',
      }),
    );
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('sends no PATCH just from picking Lost or Cancelled', async () => {
    await pickFromMenu('Lost');
    await screen.findByRole('heading', { name: 'Mark Lead as Lost' });

    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('the other statuses still change through the PATCH', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockApi.patch.mockResolvedValue({ data: {} });
    renderWithProviders(<LeadDetailPage />, { ability: buildAbility(CLOSE_RULES) });
    await user.click(await screen.findByRole('button', { name: /lead status: contacted/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Estimate Sent' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}`, { status: 'ESTIMATED' }),
    );
  });

  it('picking the status the lead already has opens no dialog and sends nothing', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
      if (url.includes('/api/leads/')) return { data: { lead: { ...LEAD_FIXTURE, status: 'LOST', estimates: [] } } };
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
    renderWithProviders(<LeadDetailPage />, { ability: buildAbility(CLOSE_RULES) });
    await user.click(await screen.findByRole('button', { name: /lead status: lost/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^Lost/ }));

    expect(screen.queryByRole('heading', { name: 'Mark Lead as Lost' })).not.toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  // PRD D10 + section 7.1: Lost is pickable "always", from a closed lead too, so a Won lead's menu
  // still opens the Mark Lost dialog and the typed reason goes to the mark-lost door.
  it('a Won lead can still be moved to Lost: the dialog opens and confirming sends the reason', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
      if (url.includes('/api/leads/')) return { data: { lead: { ...LEAD_FIXTURE, status: 'WON', estimates: [] } } };
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
    mockApi.post.mockResolvedValue({ data: { lead: { ...LEAD_FIXTURE } } });
    renderWithProviders(<LeadDetailPage />, { ability: buildAbility(CLOSE_RULES) });
    await user.click(await screen.findByRole('button', { name: /lead status: won/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^Lost/ }));

    expect(await screen.findByRole('heading', { name: 'Mark Lead as Lost' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/reason/i), 'Customer changed their mind');
    await user.click(screen.getByRole('button', { name: 'Mark Lost' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`, {
        lost_reason: 'Customer changed their mind',
      }),
    );
    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});
