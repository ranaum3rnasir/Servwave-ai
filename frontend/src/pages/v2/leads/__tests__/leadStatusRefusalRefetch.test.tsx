/**
 * #2756. The lead page's copy of the lead can be stale (changed in another tab or by another person), and the app's
 * query client keeps it fresh for 5 minutes without refetching on focus. When the server refuses a status change
 * because of that - from the status menu, Mark Lost or Reopen - the page must re-read the lead so it shows the
 * server's current lead, instead of offering the same refused choice again.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import api from '@/lib/axios';
import { LEAD_FIXTURE, NOTES_FIXTURE } from '@/__tests__/helpers';
import { DESKTOP, emulateDevice } from '@/__tests__/support/deviceShape';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { TooltipProvider as KitTooltipProvider } from '@/ui-kit/components/ui/tooltip';
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
const LEAD_URL = `/api/leads/${LEAD_FIXTURE.id}`;
const NO_WALKTHROUGH_BOOKED = "There's no walkthrough booked on this lead right now.";

// What the page loaded: a walkthrough was booked, so Walkthrough Scheduled could be picked.
const STALE_OPTIONS = [
  { status: 'NEW', available: true, reason: null },
  { status: 'CONTACTED', available: true, reason: null },
  { status: 'WALKTHROUGH_SCHEDULED', available: true, reason: null },
  { status: 'WALKTHROUGH_COMPLETED', available: false, reason: 'A walkthrough visit is still booked on this lead.' },
  { status: 'ESTIMATED', available: false, reason: 'No estimate has been sent to this lead yet.' },
  { status: 'WON', available: true, reason: null },
  { status: 'LOST', available: true, reason: null },
];
// What the server holds now: the visit was called off elsewhere, so Walkthrough Scheduled is locked.
const CURRENT_OPTIONS = STALE_OPTIONS.map((o) =>
  o.status === 'WALKTHROUGH_SCHEDULED' ? { ...o, available: false, reason: NO_WALKTHROUGH_BOOKED } : o,
);

let leadGets = 0;
function serveLead() {
  leadGets = 0;
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url === LEAD_URL) {
      leadGets += 1;
      const status_options = leadGets === 1 ? STALE_OPTIONS : CURRENT_OPTIONS;
      return { data: { lead: { ...LEAD_FIXTURE, status: 'CONTACTED', estimates: [], status_options } } };
    }
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
  mockApi.patch.mockRejectedValue({ response: { status: 409, data: { error: NO_WALKTHROUGH_BOOKED } } });
}

/** The app's own query defaults (lib/queryClient.ts): fresh for 5 minutes, no refetch on focus. */
function renderLikeTheApp() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const ability = buildAbility([
    { action: 'read', subject: 'Lead' },
    { action: 'update', subject: 'Lead' },
    { action: 'mark_lost', subject: 'Lead' },
    { action: 'reopen', subject: 'Lead' },
  ]);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <AbilityProvider ability={ability}>
      <QueryClientProvider client={queryClient}>
        <KitTooltipProvider delayDuration={320}>
          <MemoryRouter>{children}</MemoryRouter>
        </KitTooltipProvider>
      </QueryClientProvider>
    </AbilityProvider>
  );
  render(<LeadDetailPage />, { wrapper: Wrapper });
}

async function pickRefusedStatus() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderLikeTheApp();
  await user.click(await screen.findByRole('button', { name: /lead status: contacted/i }));
  // One read of the lead so far: the page holds the stale copy.
  expect(leadGets).toBe(1);
  await user.click(await screen.findByRole('menuitem', { name: /walkthrough scheduled/i }));
  await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  expect(toastError.mock.calls[0]?.[1]).toMatchObject({ description: NO_WALKTHROUGH_BOOKED });
  return user;
}

let restoreDevice: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  restoreDevice = emulateDevice(DESKTOP);
});
afterEach(() => {
  restoreDevice?.();
});

describe('a refused (409) lead status change re-reads the lead', () => {
  it('shows the refused option locked with the server reason, so a second click sends nothing', async () => {
    serveLead();
    const user = await pickRefusedStatus();

    // Let any refetch land, then open the menu again.
    await new Promise((r) => setTimeout(r, 300));
    await user.click(await screen.findByRole('button', { name: /lead status: contacted/i }));
    const item = await screen.findByRole('menuitem', { name: /walkthrough scheduled/i });
    expect(item).toHaveAttribute('aria-disabled', 'true');

    await user.click(item);
    await new Promise((r) => setTimeout(r, 300));
    expect(mockApi.patch).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});

/** The lead the page loads first, then the lead the server holds now (changed elsewhere in between). */
function serveChangedLead(loaded: Record<string, unknown>, now: Record<string, unknown>) {
  leadGets = 0;
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url === LEAD_URL) {
      leadGets += 1;
      return { data: { lead: { ...LEAD_FIXTURE, estimates: [], ...(leadGets === 1 ? loaded : now) } } };
    }
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
}

const CLOSED_LEAD_STATUS_LOCK = 'To change the status, reopen the lead first.';

describe('a refused Mark Lost re-reads the lead', () => {
  it('a lead Won elsewhere: Mark Lost is refused, and on closing the dialog the page shows Won', async () => {
    serveChangedLead({ status: 'CONTACTED', status_options: STALE_OPTIONS }, { status: 'WON', status_options: STALE_OPTIONS });
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: CLOSED_LEAD_STATUS_LOCK } } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLikeTheApp();

    await user.click(await screen.findByRole('button', { name: /lead status: contacted/i }));
    await user.click(await screen.findByRole('menuitem', { name: /^lost/i }));
    await user.type(await screen.findByLabelText(/reason/i), 'went elsewhere');
    await user.click(screen.getByRole('button', { name: /^mark lost$/i }));
    expect(await screen.findByText(CLOSED_LEAD_STATUS_LOCK)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: /lead status: won/i }, { timeout: 2000 })).toBeInTheDocument();
  });
});

describe('a refused Reopen re-reads the lead', () => {
  it('a lead reopened elsewhere: Reopen is refused, and on going back the page shows the open lead', async () => {
    const closed = STALE_OPTIONS.map((o) => ({ ...o, available: o.status === 'WON', reason: o.status === 'WON' ? null : CLOSED_LEAD_STATUS_LOCK }));
    serveChangedLead(
      { status: 'WON', actions: ['reopen'], status_options: closed },
      { status: 'CONTACTED', status_options: STALE_OPTIONS },
    );
    mockApi.post.mockRejectedValue({ response: { status: 400, data: { error: 'This lead is already open.' } } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderLikeTheApp();

    await user.click((await screen.findAllByRole('button', { name: 'Reopen lead' }))[0]!);
    await user.type(await screen.findByLabelText(/why is this lead being reopened/i), 'customer called back');
    await user.click(screen.getByRole('button', { name: /^reopen$/i }));
    expect(await screen.findByText('This lead is already open.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(await screen.findByRole('button', { name: /lead status: contacted/i }, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Reopen lead' })).toHaveLength(0);
  });
});
