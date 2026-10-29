// Mobile slice 63: on a computer the call goes through the in-browser phone. When that phone cannot
// start - no phone-service agent for the user, the feature switched off, or a failure that shows up
// as a boot fault - the call falls back to the bridge, and slice 21's rule applies: the caller's
// profile phone rings first, and an empty profile blocks the call with a link to My Profile.
//
// The real dialer and the REAL usePlaceCall run; only the device handle (useCtmSoftphone) and the
// HTTP client underneath are replaced. No call can leave this file: the HTTP client is a stand-in.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/axios', () => ({ default: http }));
vi.mock('@/lib/api/myOutboundNumber', () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

type FakeDevice = {
  ready: boolean;
  awaitingStart: boolean;
  fault: SoftphoneFault | null;
  call: ReturnType<typeof vi.fn>;
  mute: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
};
const device = vi.hoisted(() => ({ current: null as null | FakeDevice }));
vi.mock('@/lib/communication/useCtmSoftphone', () => ({
  useCtmSoftphone: () => device.current,
}));

import type { SoftphoneFault } from '@/lib/communication/ctmSoftphone';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { Softphone } from '../Softphone';

const PROFILE_COPY = 'Add your phone number to your profile to place calls from your phone';
const FAULTS: SoftphoneFault[] = ['locked-out', 'station-check', 'unknown'];

function faultedDevice(fault: SoftphoneFault): FakeDevice {
  return { ready: false, awaitingStart: false, fault, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
}

function renderDialer(props: Partial<React.ComponentProps<typeof Softphone>> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 1, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/phone']}>
        <Routes>
          <Route path="/phone" element={<Softphone prefillNumber="5551234567" {...props} />} />
          <Route path="/settings/profile" element={<h1>My Profile page</h1>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const callPosts = () => http.post.mock.calls.filter(([url]) => url === '/api/communication/calls');

beforeEach(() => {
  vi.clearAllMocks();
  device.current = null;
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  http.get.mockResolvedValue({ data: { contacts: [] } });
  http.post.mockResolvedValue({ data: { outcome_since: '2026-10-05T10:00:00.000Z' } });
});

describe('Softphone on a computer whose in-browser phone cannot start', () => {
  it.each(FAULTS)('with a %s fault, Call is available and goes through the bridge, never the device', async (fault) => {
    device.current = faultedDevice(fault);
    renderDialer();

    const call = screen.getByRole('button', { name: 'Call' });
    expect(call).not.toBeDisabled();
    await userEvent.click(call);

    expect(device.current.call).not.toHaveBeenCalled();
    expect(callPosts()).toHaveLength(1);
    expect(callPosts()[0]![1]).toMatchObject({ direction: 'out', to_number: '+15551234567' });
    expect(await screen.findByText(/Your phone will ring first/)).toBeInTheDocument();
  });

  it('says plainly that the call will ring the user\'s own phone first, with no vendor name', () => {
    device.current = faultedDevice('unknown');
    renderDialer();

    const note = screen.getByText(/The in-browser phone isn't available/);
    expect(note).toHaveTextContent(/ring your phone first/);
    expect(note.textContent ?? '').not.toMatch(/ctm|calltracking|supabase|render|vercel|twilio/i);
  });

  it('an autoCallNumber (Call back) under a fault goes through the bridge too', async () => {
    device.current = faultedDevice('locked-out');
    renderDialer({ prefillNumber: undefined, autoCallNumber: '5551234567' });

    await vi.waitFor(() => expect(callPosts()).toHaveLength(1));
    expect(device.current.call).not.toHaveBeenCalled();
  });

  it('with an empty profile phone the bridge refuses: the call is blocked and the notification links to My Profile', async () => {
    device.current = faultedDevice('unknown');
    http.post.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        response: { status: 409, data: { code: 'PROFILE_PHONE_REQUIRED', reason: 'missing', error: PROFILE_COPY } },
      }),
    );
    renderDialer();

    await userEvent.click(screen.getByRole('button', { name: 'Call' }));

    expect(await screen.findByText(PROFILE_COPY)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /go to my profile/i });
    expect(link).toHaveAttribute('href', '/settings/profile');
    expect(callPosts()).toHaveLength(1); // blocked, and never retried into a second ring
    await userEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'My Profile page' })).toBeInTheDocument();
  });

  it('while the in-browser phone is merely still booting (no fault yet) Call stays blocked: no bridge, no device', async () => {
    device.current = { ...faultedDevice('unknown'), fault: null };
    renderDialer();

    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
    expect(screen.queryByText(/The in-browser phone isn't available/)).not.toBeInTheDocument();
    expect(callPosts()).toHaveLength(0);
  });

  it('a healthy in-browser phone still dials through the device, not the bridge', async () => {
    device.current = { ready: true, awaitingStart: false, fault: null, call: vi.fn(), mute: vi.fn(), hangup: vi.fn() };
    http.post.mockResolvedValue({ data: { queued: true } });
    renderDialer();

    await userEvent.click(screen.getByRole('button', { name: 'Call' }));

    await vi.waitFor(() => expect(device.current!.call).toHaveBeenCalledWith('+15551234567'));
    expect(callPosts()).toHaveLength(0);
  });
});
