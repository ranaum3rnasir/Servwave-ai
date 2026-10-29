/**
 * The lead page's status menu is rendered from the server's `status_options` (walkthrough
 * lead-statuses PRD 7.3 and 7.4): a locked status is shown locked with its reason, the meanings
 * show on hover, a refused change surfaces the server's own words, and a response without
 * `status_options` falls back to the plain list.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE, NOTES_FIXTURE } from '@/__tests__/helpers';
import { DESKTOP, emulateDevice } from '@/__tests__/support/deviceShape';
import { buildAbility } from '@/lib/ability';
import LeadDetailPage from '../LeadDetailPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: { error: toastError, success: vi.fn() },
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
const ALL: Rules = [
  { action: 'read', subject: 'Lead' },
  { action: 'update', subject: 'Lead' },
  { action: 'mark_lost', subject: 'Lead' },
  { action: 'cancel', subject: 'Lead' },
];

const NO_ESTIMATE = 'No estimate has been sent to this lead yet.';
const STATUS_OPTIONS = [
  { status: 'NEW', available: false, reason: "This lead already has a walkthrough or an estimate, so it's past New." },
  { status: 'CONTACTED', available: true, reason: null },
  { status: 'WALKTHROUGH_SCHEDULED', available: true, reason: null },
  { status: 'WALKTHROUGH_COMPLETED', available: false, reason: 'A walkthrough visit is still booked on this lead.' },
  { status: 'ESTIMATED', available: false, reason: NO_ESTIMATE },
  { status: 'WON', available: true, reason: null },
  { status: 'LOST', available: true, reason: null },
  { status: 'CANCELLED', available: true, reason: null },
];

let restoreDevice: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  restoreDevice = emulateDevice(DESKTOP);
});
afterEach(() => {
  restoreDevice?.();
});

function serveLead(statusOptions: unknown) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url.includes('/api/leads/')) {
      return { data: { lead: { ...LEAD_FIXTURE, status: 'CONTACTED', estimates: [], ...(statusOptions ? { status_options: statusOptions } : {}) } } };
    }
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
}

async function openMenu(rules: Rules = ALL) {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderWithProviders(<LeadDetailPage />, { ability: buildAbility(rules) });
  await user.click(await screen.findByRole('button', { name: /lead status: contacted/i }));
  await screen.findAllByRole('menuitem');
  return user;
}

describe('lead page status menu, from status_options', () => {
  it('locks exactly the options the server says are locked, and nothing else', async () => {
    serveLead(STATUS_OPTIONS);
    await openMenu();

    const locked = screen.getAllByRole('menuitem').filter((i) => i.getAttribute('aria-disabled') === 'true');
    expect(locked.map((i) => i.textContent?.trim())).toEqual(['New', 'Walkthrough Completed', 'Estimate Sent']);
  });

  it('does not send a status change when a locked option is clicked', async () => {
    serveLead(STATUS_OPTIONS);
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: /estimate sent/i }));

    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('shows the meaning and the server\'s reason on a locked option', async () => {
    serveLead(STATUS_OPTIONS);
    const user = await openMenu();

    await user.hover(screen.getByRole('menuitem', { name: /estimate sent/i }));

    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent("We've sent this lead an estimate.");
    expect(tip).toHaveTextContent(NO_ESTIMATE);
  });

  it('shows the meaning of every status on hover', async () => {
    serveLead(STATUS_OPTIONS);
    const user = await openMenu();
    const meanings: Array<[RegExp, string]> = [
      [/^new/i, 'A new lead. No one has reached out yet.'],
      [/walkthrough completed/i, 'The walkthrough is done, and nothing else is booked.'],
      [/^won/i, 'The customer approved doing the job.'],
      [/^lost/i, "This lead didn't turn into a job."],
      [/^cancelled/i, 'This lead was cancelled.'],
    ];
    for (const [name, text] of meanings) {
      await user.hover(screen.getByRole('menuitem', { name }));
      expect(await screen.findByRole('tooltip')).toHaveTextContent(text);
      await user.unhover(screen.getByRole('menuitem', { name }));
    }
  });

  it('still sends a change for an option the server says is available', async () => {
    serveLead(STATUS_OPTIONS);
    mockApi.patch.mockResolvedValue({ data: { lead: {} } });
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: /walkthrough scheduled/i }));

    expect(mockApi.patch).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}`, { status: 'WALKTHROUGH_SCHEDULED' });
  });

  it('shows the server\'s own words when it refuses a change', async () => {
    serveLead(STATUS_OPTIONS);
    mockApi.patch.mockRejectedValue({ response: { status: 409, data: { error: NO_ESTIMATE } } });
    const user = await openMenu();

    // Won is available, so it is sent; the server answers 409 (stale menu) and the user sees why.
    await user.click(screen.getByRole('menuitem', { name: /^won/i }));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]?.[1]).toMatchObject({ description: NO_ESTIMATE });
  });

  it('still hides Lost and Cancelled from a user who may not close the lead', async () => {
    serveLead(STATUS_OPTIONS);
    await openMenu([{ action: 'read', subject: 'Lead' }, { action: 'update', subject: 'Lead' }]);

    const names = screen.getAllByRole('menuitem').map((i) => i.textContent?.trim());
    expect(names).toEqual(['New', 'Contacted', 'Walkthrough Scheduled', 'Walkthrough Completed', 'Estimate Sent', 'Won']);
  });

  it('falls back to the plain list, with nothing locked, when status_options is absent', async () => {
    serveLead(null);
    await openMenu();

    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      'New', 'Contacted', 'Walkthrough Scheduled', 'Walkthrough Completed', 'Estimate Sent', 'Won', 'Lost', 'Cancelled',
    ]);
    items.forEach((i) => expect(i).not.toHaveAttribute('aria-disabled'));
  });
});
