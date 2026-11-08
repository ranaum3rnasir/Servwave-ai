// Task A2 — device-boot gate. Ground truth (master plan §A, "still says
// Ready"): the CTM device once had TWO boot paths — a main-window warm
// singleton (since deleted outright: the device runs only in the /phone tab,
// see main-window-no-phone-device.test.tsx) and this hook
// (`ensureOfficeSoftphone`). This closes the second path: only the dedicated
// `/phone` tab ('phone-tab' surface) may cold-boot the shared device. Every inline caller (the main-app GlobalDialer popup,
// entity call buttons, anything mounted inside AppLayout) must get a
// null handle instead — the SAME shape as `enabled=false` — so it falls
// back to the existing callback-bridge / `tel:` path (Softphone's plain
// "Ready" pill, covered by softphone-connecting-state.test.tsx).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/lib/communication/ctmSoftphone', () => ({
  isCtmSoftphoneEnabled: vi.fn(),
}));
vi.mock('@/lib/communication/officeSoftphone', () => ({
  ensureOfficeSoftphone: vi.fn(),
  // call() records a dial so the /phone tab knows a call is live.
  markOfficeSoftphoneCallDialled: vi.fn(),
  markOfficeSoftphoneCallHungUp: vi.fn(),
  isOfficeSoftphoneReady: vi.fn(),
  // Returns a real unsubscribe fn, like the new fault mock below: the hook's
  // cleanup CALLS whatever this returns, so a bare vi.fn() only survives because
  // every setup() here re-arms it. Self-sufficient is one keystroke cheaper than
  // that dependency.
  subscribeOfficeSoftphoneReady: vi.fn(() => () => {}),
  // Slice 3's fault channel. Healthy by default so every pre-existing case in
  // this file keeps exercising exactly the state it was written for.
  getOfficeSoftphoneFault: vi.fn(() => null),
  subscribeOfficeSoftphoneFault: vi.fn(() => () => {}),
}));
// WHEN the phone tab boots (its first-gesture trigger) is phoneTabDevice.ts's
// concern, covered by phoneTabDevice.test.ts and phone-tab-device-lifecycle
// .test.tsx. This file tests the hook's wiring once booting is allowed.
vi.mock('@/lib/communication/phoneTabDevice', () => ({
  usePhoneTabBootGate: (enabled: boolean) => enabled,
}));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(),
}));
vi.mock('@/lib/api/phoneNumbers', () => ({
  requestPhoneAccessToken: vi.fn().mockResolvedValue({ token: 'T' }),
}));

import { useCtmSoftphone } from '@/lib/communication/useCtmSoftphone';
import { isCtmSoftphoneEnabled } from '@/lib/communication/ctmSoftphone';
import {
  ensureOfficeSoftphone,
  isOfficeSoftphoneReady,
  subscribeOfficeSoftphoneReady,
} from '@/lib/communication/officeSoftphone';
import { useFeature } from '@/lib/entitlements';
import { useAuthStore } from '@/stores/auth.store';
import {
  DESKTOP,
  NARROW_DESKTOP_WINDOW,
  PHONE_LANDSCAPE,
  PHONE_PORTRAIT,
  TABLET,
  TABLET_SPLIT_VIEW,
  emulateDevice,
  type DeviceShape,
} from '@/__tests__/support/deviceShape';

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup({ role = 'ADMIN', comm = true, flag = true } = {}) {
  vi.mocked(useAuthStore).mockImplementation((sel: any) => sel({ user: { role } }));
  vi.mocked(useFeature).mockReturnValue(comm);
  vi.mocked(isCtmSoftphoneEnabled).mockReturnValue(flag);
  vi.mocked(isOfficeSoftphoneReady).mockReturnValue(false);
  vi.mocked(subscribeOfficeSoftphoneReady).mockReturnValue(() => {});
}

function fakeSp() {
  return {
    call: vi.fn(),
    dialFrom: vi.fn(),
    mute: vi.fn(),
    hangup: vi.fn(),
    on: () => () => {},
  };
}

beforeEach(() => vi.clearAllMocks());

describe('useCtmSoftphone — surface gate (Task A2)', () => {
  it("does NOT boot the device for the 'inline' surface (main app: GlobalDialer, entity call buttons)", () => {
    setup();
    const { result } = renderHook(() => useCtmSoftphone({ surface: 'inline' }));
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('does NOT boot the device when no surface is given — default is inline, so every pre-existing call site stays safe', () => {
    setup();
    const { result } = renderHook(() => useCtmSoftphone({}));
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("DOES boot the device for the 'phone-tab' surface (the dedicated /phone route)", () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup();

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));

    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
    expect(result.current).not.toBeNull();
  });

  it.each([
    ['the org has no phone entitlement', { comm: false }],
    ['the softphone flag is off', { flag: false }],
  ])('still returns null for the phone-tab surface when %s — surface never bypasses the other gates', (_label, opts) => {
    setup(opts);
    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));

    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});

// Ran, 2026-10-02: on a PHONE the browser phone never loads - every call goes
// out as the bridge (the phone service rings the user's own cell first). The
// real isPhoneDevice() runs here; only the browser's pointer and screen are
// emulated.
describe('useCtmSoftphone - no browser phone on a phone (bridge instead)', () => {
  let restoreDevice: (() => void) | null = null;
  afterEach(() => {
    restoreDevice?.();
    restoreDevice = null;
  });

  function onDevice(shape: DeviceShape) {
    restoreDevice = emulateDevice(shape);
  }

  it.each([
    ['upright', PHONE_PORTRAIT],
    ['sideways', PHONE_LANDSCAPE],
  ])('on a phone held %s: an office admin in the /phone tab gets no handle and the device never boots', (_label, shape) => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeSp() as any);
    setup();
    onDevice(shape);

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));

    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it.each([
    ['a computer', DESKTOP],
    ['a narrow browser window on a computer', NARROW_DESKTOP_WINDOW],
    ['a tablet', TABLET],
    ['a tablet in split view', TABLET_SPLIT_VIEW],
  ])('on %s: the same office admin keeps the browser phone', (_label, shape) => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeSp() as any);
    setup();
    onDevice(shape);

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
    expect(result.current).not.toBeNull();
  });

  // The device answer is read once per mount. A mid-session flip (devtools
  // device emulation, a monitor change) must never null the handle of a device
  // that already booted - that would drop the controls of a live call.
  it('on a computer with a booted device, the screen/pointer changing to a phone shape mid-session keeps the handle', () => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeSp() as any);
    setup();
    onDevice(DESKTOP);

    const { result, rerender } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
    expect(result.current).not.toBeNull();

    restoreDevice?.();
    onDevice(PHONE_PORTRAIT);
    rerender();

    expect(result.current).not.toBeNull();
  });
});

// Ran, 2026-10-03: roles are not special. The DEVICE decides how a call goes
// out, for every role: a browser that is not on a phone (computer or tablet)
// gets the browser phone in the /phone tab, a phone gets the bridge. A
// technician on a computer is no exception.
describe('useCtmSoftphone - the device picks the transport, never the role', () => {
  let restoreDevice: (() => void) | null = null;
  afterEach(() => {
    restoreDevice?.();
    restoreDevice = null;
  });

  const ROLES = ['ADMIN', 'DISPATCHER', 'SALES', 'TECHNICIAN'] as const;

  it.each(ROLES)('role %s on a computer gets the browser phone in the /phone tab', (role) => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeSp() as any);
    setup({ role });
    restoreDevice = emulateDevice(DESKTOP);

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));

    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
    expect(result.current).not.toBeNull();
  });

  it.each(ROLES)('role %s on a phone gets the bridge (no browser phone, device never boots)', (role) => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeSp() as any);
    setup({ role });
    restoreDevice = emulateDevice(PHONE_PORTRAIT);

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));

    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
