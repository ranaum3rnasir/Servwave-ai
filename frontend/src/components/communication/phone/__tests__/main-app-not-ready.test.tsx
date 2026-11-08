/// <reference types="@testing-library/jest-dom/vitest" />
// Task A4 — regression guard: "still says Ready" (the ground-truth root
// cause in the master plan, §A) is provably gone. This ties A1 (no warm
// singleton mounted in AppLayout) + A2 (the dialer hook's surface gate) +
// A3 (`/phone`/PhoneTabPage is the sole device-owner surface) together at an
// INTEGRATION level: unlike softphone-connecting-state.test.tsx (which
// stubs `useCtmSoftphone` itself), this file uses the REAL hook so the
// actual surface-gating logic runs. Only the CTM-adjacent seams
// (officeSoftphone.ts's device singleton, the flag, comm access, the
// communication data hooks) are mocked.
//
// Conditions are deliberately set to the ones that used to cold-boot the
// #813 warm singleton pre-fix: softphone flag ON + a comm-enabled org +
// a non-technician (ADMIN, the setup.ts default). If A1 or A2 regressed,
// the "never boots the device" assertion below would fail for the main
// app, and the "/phone" suite proves the ONLY legitimate way to see
// "Ready" is a real device-ready transition.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/api/communication', () => ({
  BUSINESS_NUMBER: '(551) 282-7064',
  fmtPhone: (n: string) => n,
  usePhoneCustomers: () => ({ data: [] }),
  usePlaceCall: () => ({ mutate: vi.fn(), isPending: false }),
  useCallOutcome: () => ({ data: null }),
  useStashCallAttribution: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
    isPending: false,
  }),
  // PhoneTabPage hosts the full DialerWorkspace (search + softphone + panel);
  // its data hooks are out of scope for this "still says Ready" guard — stub to
  // empty so the search never fires and the panel stays idle.
  useCalls: () => ({ data: [] }),
  useDialerSearch: () => ({ data: undefined, isFetching: false }),
}));

vi.mock('@/lib/api/phoneNumbers', () => ({
  requestPhoneAccessToken: vi.fn().mockResolvedValue({ token: 'T' }),
  // Task B3 - PhoneTabPage's caller-ID picker is out of scope for this "still
  // says Ready" regression guard; stub it to no data (covered separately by
  // phone-shell-caller-id-picker.test.tsx).
  useMyNumbers: () => ({ data: undefined }),
}));

// Task B2 — the resolved caller-ID fetch is out of scope for this "still
// says Ready" regression guard; stub it to no data (covered separately by
// softphone-dialfrom.test.tsx).
vi.mock('@/lib/api/myOutboundNumber', () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

// A comm-enabled org — one of the two conditions (with the flag) that used
// to be enough to cold-boot the warm singleton.
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(() => true),
}));

// The softphone feature flag — ON, per the task brief.
vi.mock('@/lib/communication/ctmSoftphone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/communication/ctmSoftphone')>();
  return { ...actual, isCtmSoftphoneEnabled: vi.fn(() => true) };
});

// The only thing genuinely mocked here: the CTM device singleton itself.
// `subscribeOfficeSoftphoneReady` captures its callbacks in a real Set so a
// test can fire a "ctm:ready" transition by invoking them directly — the
// same shape officeSoftphone.ts uses in production (the underlying
// device's real 'ready' event flips the latch and notifies subscribers).
const readySubscribers = vi.hoisted(() => new Set<() => void>());
// Slice 3 — the fault channel, modelled the same way: a real Set plus a
// mutable latch, so a test can drive `emit('fault', …)` → getter + notify
// exactly as officeSoftphone.ts does in production.
const faultSubscribers = vi.hoisted(() => new Set<() => void>());
const faultLatch = vi.hoisted(() => ({ current: null as string | null }));

vi.mock('@/lib/communication/officeSoftphone', () => ({
  ensureOfficeSoftphone: vi.fn(),
  // PhoneTabPage owns the device's end (usePhoneTabDeviceTeardown) and reads
  // whether a call is live (for its "Back to ServWave" link).
  teardownOfficeSoftphone: vi.fn(),
  isOfficeSoftphoneCallActive: vi.fn(() => false),
  subscribeOfficeSoftphoneCall: vi.fn(() => () => {}),
  markOfficeSoftphoneCallDialled: vi.fn(),
  markOfficeSoftphoneCallHungUp: vi.fn(),
  getOfficeSoftphoneGeneration: vi.fn(() => 0),
  subscribeOfficeSoftphoneGeneration: vi.fn(() => () => {}),
  isOfficeSoftphoneReady: vi.fn(() => false),
  subscribeOfficeSoftphoneReady: vi.fn((cb: () => void) => {
    readySubscribers.add(cb);
    return () => readySubscribers.delete(cb);
  }),
  getOfficeSoftphoneFault: vi.fn(() => faultLatch.current),
  subscribeOfficeSoftphoneFault: vi.fn((cb: () => void) => {
    faultSubscribers.add(cb);
    return () => faultSubscribers.delete(cb);
  }),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Softphone } from '../Softphone';
import PhoneTabPage from '@/pages/v2/communication/PhoneTabPage';
import { ensureOfficeSoftphone } from '@/lib/communication/officeSoftphone';

function fakeDevice() {
  return { call: vi.fn(), dialFrom: vi.fn(), mute: vi.fn(), hangup: vi.fn(), on: vi.fn(() => () => {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  readySubscribers.clear();
  faultSubscribers.clear();
  faultLatch.current = null;
});

/** Drive a fault the way officeSoftphone.ts does: set the latch, then notify. */
function emitFault(fault: string | null) {
  faultLatch.current = fault;
  act(() => {
    faultSubscribers.forEach((cb) => cb());
  });
}

describe('Main app (GlobalDialer\'s Softphone, no surface) — "still says Ready" is gone', () => {
  it('never boots the CTM device, even with the flag on + comm access granted — a "Ready" pill here can ONLY be the plain fallback', () => {
    // Exactly `<Softphone prefillNumber={...} .../>` at Dialer.tsx:450 — the
    // main-app GlobalDialer's call site, which passes no `surface` prop.
    render(<Softphone />);

    // The device is never created at all — not merely "not ready yet".
    // With no instance, there is no way a live CTM event produced the pill
    // text below; it can only be the `officeSoftphone === null` fallback.
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });
});

describe('/phone (PhoneTabPage, Task A3) - "Ready" only after a real ctm:ready event', () => {
  it('reads "Connecting…", not "Ready", before the device fires ready', () => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeDevice() as any);

    render(
      <MemoryRouter>
        <PhoneTabPage />
      </MemoryRouter>,
    );

    // The phone tab is the sole caller that boots a device at all.
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('flips to "Ready" only once the mocked ctm:ready transition fires — never before', () => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeDevice() as any);

    render(
      <MemoryRouter>
        <PhoneTabPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Connecting…')).toBeInTheDocument();

    // Simulate the real device's 'ready' event (bridged in officeSoftphone.ts
    // by flipping its isReady latch and notifying subscribers) — the exact
    // path a genuine `ctm:ready` from CTM drives in production.
    act(() => {
      readySubscribers.forEach((cb) => cb());
    });

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });
});

// Slice 3 — the same integration seam, for the fault channel. Same real hook,
// same real surface gating; only officeSoftphone.ts (the device singleton) is
// mocked, so what is exercised here is the whole path a live CTM signal takes:
// singleton fault latch → useCtmSoftphone → Softphone's pill.
describe('/phone (PhoneTabPage) — a fault replaces "Connecting…" with why', () => {
  function renderPhoneTab() {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeDevice() as any);
    render(
      <MemoryRouter>
        <PhoneTabPage />
      </MemoryRouter>,
    );
  }

  it.each([
    ['locked-out', 'Phone active in another tab'],
    ['station-check', 'Audio check required'],
    ['unknown', 'Phone unavailable — reload to retry'],
  ])('shows the %s sentence once the device reports it', (fault, text) => {
    renderPhoneTab();
    // The normal pre-ready window is untouched — the fault only ever replaces it.
    expect(screen.getByText('Connecting…')).toBeInTheDocument();

    emitFault(fault);

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Call' })).toBeDisabled();
  });

  it('picks up a fault that was raised BEFORE the dialer mounted (seeded, not missed)', () => {
    // The 'fault' event fires once, in the past. A console opened afterwards
    // must read the latch synchronously rather than wait for an event that will
    // never fire again — the same rule the ready latch follows.
    faultLatch.current = 'locked-out';
    renderPhoneTab();

    expect(screen.getByText('Phone active in another tab')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
  });

  it('drops the fault again if the device finally boots', () => {
    renderPhoneTab();
    emitFault('station-check');
    expect(screen.getByText('Audio check required')).toBeInTheDocument();

    // officeSoftphone.ts retracts the fault on ctm:ready and notifies BOTH
    // channels; drive them in that order.
    emitFault(null);
    act(() => {
      readySubscribers.forEach((cb) => cb());
    });

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Audio check required')).not.toBeInTheDocument();
  });
});

describe('Main app (GlobalDialer\'s Softphone, no surface) — faults never leak to a surface with no device', () => {
  it('keeps reading "Ready" even while the shared singleton is reporting a fault', () => {
    // The inline surface never boots a device (Task A2's surface gate), so the
    // hook returns null and there is nothing here that could have failed. This
    // is the answer to "does the fault cover both surfaces?": it covers both by
    // riding the one handle, and the surface without a handle correctly says
    // nothing rather than blaming the user's other tab for a phone it never had.
    faultLatch.current = 'locked-out';

    render(<Softphone />);

    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Phone active in another tab')).not.toBeInTheDocument();
  });
});
