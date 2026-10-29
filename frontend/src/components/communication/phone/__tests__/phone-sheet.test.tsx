// Mobile slice 63: the same-tab dialer on a phone. Call opens a full-screen sheet in THIS tab (no
// window, no tab), the in-browser phone is never started, the sheet says the user's phone rings
// first, and a call in progress collapses to a small call bar that stays on screen while the user
// moves around the app and brings the call back when tapped.
//
// Real sheet, real dialer, real device check (the phone is emulated through the browser inputs it
// reads), real usePlaceCall over a stand-in HTTP client: nothing here can place a call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/axios', () => ({ default: http }));
vi.mock('@/lib/api/myOutboundNumber', () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));
vi.mock('@/lib/api/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/communication')>()),
  usePhoneCustomers: () => ({ data: [] }),
  useCallOutcome: () => ({ data: null }),
  useStashCallAttribution: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
    isPending: false,
  }),
}));

// The in-browser phone: if anything tries to boot it, this fires.
const ensureDevice = vi.hoisted(() => vi.fn());
vi.mock('@/lib/communication/officeSoftphone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/communication/officeSoftphone')>()),
  ensureOfficeSoftphone: ensureDevice,
}));
vi.mock('@/lib/communication/ctmSoftphone', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/communication/ctmSoftphone')>()),
  isCtmSoftphoneEnabled: () => true,
}));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));
vi.mock('@/stores/auth.store', async () => {
  const { create } = await import('zustand');
  const useAuthStore = create(() => ({
    user: { id: 'u1', organization_id: 'org-1', role: 'TECHNICIAN', first_name: 'T', last_name: 'U' },
    isAuthenticated: true,
  }));
  return { useAuthStore, userDisplayName: () => '' };
});

import { PHONE_PORTRAIT, emulateDevice } from '@/__tests__/support/deviceShape';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { usePhoneSheetStore } from '@/stores/phoneSheet.store';
import { PhoneCallBar, PhoneSheetHost } from '../PhoneSheetHost';

const CONTEXT = { customerId: 'cust-1', customerName: 'Dana Reyes', jobId: 'job-1', jobLabel: 'J00042' };

function Shell() {
  return (
    <>
      <PhoneCallBar />
      <nav>
        <Link to="/jobs/1">Job page link</Link>
        <Link to="/schedule">Schedule link</Link>
      </nav>
      <Routes>
        <Route path="/" element={<h1>Home page</h1>} />
        <Route path="/jobs/1" element={<h1>Job page</h1>} />
        <Route path="/schedule" element={<h1>Schedule page</h1>} />
        <Route path="/settings/profile" element={<h1>My Profile page</h1>} />
      </Routes>
      <PhoneSheetHost />
    </>
  );
}

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Shell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const callPosts = () => http.post.mock.calls.filter(([url]) => url === '/api/communication/calls');
const sheet = () => screen.getByRole('dialog', { name: 'Dialer' });
const bar = () => screen.getByRole('region', { name: 'Call in progress' });

let restoreDevice: (() => void) | null = null;
let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  usePhoneSheetStore.getState().reset();
  restoreDevice = emulateDevice(PHONE_PORTRAIT);
  openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
  http.get.mockResolvedValue({ data: { contacts: [] } });
  http.post.mockResolvedValue({ data: { outcome_since: '2026-10-05T10:00:00.000Z' } });
});
afterEach(() => {
  restoreDevice?.();
  restoreDevice = null;
  vi.restoreAllMocks();
});

describe('Call on a phone opens a same-tab sheet', () => {
  it('shows a full-screen dialer pre-filled with the number, says the phone rings first, and opens no window', async () => {
    renderShell();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => requestCall('5551234567', CONTEXT));

    const dialog = await screen.findByRole('dialog', { name: 'Dialer' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByLabelText('Number to call')).toHaveValue('5551234567');
    expect(within(dialog).getByText('Your phone will ring first, answer to connect.')).toBeInTheDocument();
    // Same tab: no window, no tab, and the in-browser phone never starts.
    expect(openSpy).not.toHaveBeenCalled();
    expect(ensureDevice).not.toHaveBeenCalled();
  });

  it('the header dialer button (no number) opens the same sheet, empty', async () => {
    renderShell();

    act(() => usePhoneSheetStore.getState().open());

    const dialog = await screen.findByRole('dialog', { name: 'Dialer' });
    expect(within(dialog).getByLabelText('Number to call')).toHaveValue('');
  });

  it('Call in the sheet rings the user first through the bridge, attributed to the record, never the in-browser phone', async () => {
    renderShell();
    act(() => requestCall('5551234567', CONTEXT));
    await screen.findByRole('dialog', { name: 'Dialer' });

    await userEvent.click(within(sheet()).getByRole('button', { name: 'Call' }));

    expect(callPosts()).toHaveLength(1);
    expect(callPosts()[0]![1]).toMatchObject({
      direction: 'out',
      to_number: '+15551234567',
      job_id: 'job-1',
      customer_id: 'cust-1',
    });
    expect(await within(sheet()).findByText(/Your phone will ring first - this call will be logged to J00042/)).toBeInTheDocument();
    expect(ensureDevice).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('with nothing in progress, Close and Escape both put the sheet away', async () => {
    renderShell();
    act(() => requestCall('5551234567'));
    await screen.findByRole('dialog', { name: 'Dialer' });

    await userEvent.click(within(sheet()).getByRole('button', { name: 'Close dialer' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => requestCall('5551234567'));
    await screen.findByRole('dialog', { name: 'Dialer' });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the sheet\'s controls are 44 px on touch: Close, the keypad, Call and delete', async () => {
    renderShell();
    act(() => requestCall('5551234567'));
    const dialog = await screen.findByRole('dialog', { name: 'Dialer' });

    // The kit's icon button grows to 44 px on a coarse pointer; the dialer's own raw buttons carry
    // the same minimum.
    expect(within(dialog).getByRole('button', { name: 'Close dialer' })).toHaveClass('touch:size-11');
    for (const name of ['1', '5', '0', '#', 'Call', 'Delete last digit']) {
      expect(within(dialog).getByRole('button', { name }), name).toHaveClass('touch:min-h-11');
    }
  });
});

describe('a call in progress collapses to a call bar that survives navigation', () => {
  async function placeCall() {
    renderShell();
    act(() => requestCall('5551234567', CONTEXT));
    await screen.findByRole('dialog', { name: 'Dialer' });
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Call' }));
    await within(sheet()).findByText(/Your phone will ring first - this call will be logged/);
  }

  it('Minimise turns the sheet into a call bar with the number; the call is not dropped', async () => {
    await placeCall();

    await userEvent.click(within(sheet()).getByRole('button', { name: 'Minimise dialer' }));

    expect(screen.queryByRole('dialog', { name: 'Dialer' })).not.toBeInTheDocument();
    expect(within(bar()).getByText('(555) 123-4567')).toBeInTheDocument();
    expect(within(bar()).getByText('Call in progress')).toBeInTheDocument();
    // Still the one call: nothing was hung up or re-placed.
    expect(callPosts()).toHaveLength(1);
  });

  it('the bar stays on screen on the job page and the schedule, and brings the same call back', async () => {
    await placeCall();
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Minimise dialer' }));

    await userEvent.click(screen.getByRole('link', { name: 'Job page link' }));
    expect(await screen.findByRole('heading', { name: 'Job page' })).toBeInTheDocument();
    expect(bar()).toBeVisible();

    await userEvent.click(screen.getByRole('link', { name: 'Schedule link' }));
    expect(await screen.findByRole('heading', { name: 'Schedule page' })).toBeInTheDocument();
    expect(bar()).toBeVisible();

    await userEvent.click(within(bar()).getByRole('button', { name: 'Open call' }));
    // The very same call: the placed message, not a fresh empty dialer.
    expect(await within(sheet()).findByText(/Your phone will ring first - this call will be logged to J00042/)).toBeInTheDocument();
    expect(callPosts()).toHaveLength(1);
  });

  it('Dismiss on the finished call clears the bar', async () => {
    await placeCall();
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Minimise dialer' }));
    await userEvent.click(within(bar()).getByRole('button', { name: 'Open call' }));

    await userEvent.click(within(sheet()).getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Call in progress' })).not.toBeInTheDocument();
  });

  it('tapping Call on another number while a call is in progress shows the live call and never re-places it', async () => {
    await placeCall();
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Minimise dialer' }));

    act(() => requestCall('5559998888', { customerId: 'cust-2' }));

    expect(await within(sheet()).findByText(/Your phone will ring first - this call will be logged to J00042/)).toBeInTheDocument();
    expect(callPosts()).toHaveLength(1);
  });

  it('the bar carries no vendor name', async () => {
    await placeCall();
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Minimise dialer' }));

    expect(bar().textContent ?? '').not.toMatch(/ctm|calltracking|supabase|render|vercel|twilio|resend|stripe/i);
  });
});

describe('leaving the page from inside the sheet', () => {
  it('the My Profile link of a refused call goes to the page and puts the sheet away (nothing is in progress)', async () => {
    http.post.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: {
          status: 409,
          data: {
            code: 'PROFILE_PHONE_REQUIRED',
            reason: 'missing',
            error: 'Add your phone number to your profile to place calls from your phone',
          },
        },
      }),
    );
    renderShell();
    act(() => requestCall('5551234567'));
    await screen.findByRole('dialog', { name: 'Dialer' });
    await userEvent.click(within(sheet()).getByRole('button', { name: 'Call' }));

    await userEvent.click(await within(sheet()).findByRole('link', { name: /go to my profile/i }));

    expect(await screen.findByRole('heading', { name: 'My Profile page' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
