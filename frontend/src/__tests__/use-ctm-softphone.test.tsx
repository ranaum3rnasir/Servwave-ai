// Slice 4 — office-softphone lifecycle hook. Verifies the DEVICE axis: the hook
// returns a handle for any signed-in user, whatever the role, of a comm-enabled
// org with the flag on, in the /phone tab ('phone-tab' surface), on a browser
// that is not a phone; null otherwise (→ the caller keeps the bridge/tel path).
// CTM is fully mocked; real behavior is live-QA'd.
//
// Fix B (warm singleton): the hook is now a SUBSCRIBER, not an owner — it goes
// through officeSoftphone.ts (ensureOfficeSoftphone / isOfficeSoftphoneReady /
// subscribeOfficeSoftphoneReady) instead of calling createCtmSoftphone
// directly, and it must NOT destroy the shared device on unmount. This file
// mocks officeSoftphone.ts wholesale so it stays a focused unit test of the
// HOOK's wiring/subscription behavior — officeSoftphone.ts's own
// singleton/idempotency logic is office-softphone.test.ts's job.
//
// Task A2 (surface gate): booting the device now also requires
// `surface: 'phone-tab'` (default is 'inline', which never boots) — every
// test below that exercises the boot path passes it explicitly so this file
// keeps testing the role/comm/flag "device axis" on its own terms. The
// inline-vs-phone-tab behavior itself is covered by
// useCtmSoftphone-gating.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/communication/ctmSoftphone', () => ({
  isCtmSoftphoneEnabled: vi.fn(),
}));
vi.mock('@/lib/communication/officeSoftphone', () => ({
  ensureOfficeSoftphone: vi.fn(),
  // call() records a dial so the /phone tab knows a call is live.
  markOfficeSoftphoneCallDialled: vi.fn(),
  markOfficeSoftphoneCallHungUp: vi.fn(),
  isOfficeSoftphoneReady: vi.fn(),
  subscribeOfficeSoftphoneReady: vi.fn(),
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

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup({ role = 'ADMIN', comm = true, flag = true } = {}) {
  vi.mocked(useAuthStore).mockImplementation((sel: any) => sel({ user: { role } }));
  vi.mocked(useFeature).mockReturnValue(comm);
  vi.mocked(isCtmSoftphoneEnabled).mockReturnValue(flag);
  // Sane defaults so tests that don't care about readiness still get a
  // well-formed subscription contract (an unsubscribe fn back from subscribe).
  vi.mocked(isOfficeSoftphoneReady).mockReturnValue(false);
  vi.mocked(subscribeOfficeSoftphoneReady).mockReturnValue(() => {});
}

function fakeSp() {
  const handlers: Record<string, ((p?: unknown) => void)[]> = {};
  return {
    ready: Promise.resolve(),
    call: vi.fn(),
    dialFrom: vi.fn(),
    mute: vi.fn(),
    hangup: vi.fn(),
    answer: vi.fn(),
    on: (ev: string, cb: (p?: unknown) => void) => {
      (handlers[ev] ??= []).push(cb);
      return () => {};
    },
    destroy: vi.fn(),
    __emit: (ev: string, p?: unknown) => (handlers[ev] ?? []).forEach((cb) => cb(p)),
  };
}

beforeEach(() => vi.clearAllMocks());

describe('useCtmSoftphone (device axis)', () => {
  it('gives a technician a handle too — roles are not special, the device decides', () => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeSp() as any);
    setup({ role: 'TECHNICIAN' });
    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(result.current).not.toBeNull();
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
  });

  it('returns null for a signed-out user (no user in the store) — never boots a device for nobody', () => {
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(fakeSp() as any);
    setup();
    vi.mocked(useAuthStore).mockImplementation((sel: any) => sel({ user: null }));
    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(result.current).toBeNull();
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
  });

  it('returns null when the flag is off (default — bridge unchanged)', () => {
    setup({ flag: false });
    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(result.current).toBeNull();
    expect(ensureOfficeSoftphone).not.toHaveBeenCalled();
  });

  it('returns null for a comm-disabled org', () => {
    setup({ comm: false });
    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(result.current).toBeNull();
  });

  it('gives an office user a handle and proxies call(dialFrom)/mute/hangup', () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup({ role: 'ADMIN' });

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(result.current).not.toBeNull();
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);

    act(() => result.current!.call('+15551234567', 'TPN-A'));
    expect(sp.dialFrom).toHaveBeenCalledWith('TPN-A');
    expect(sp.call).toHaveBeenCalledWith('+15551234567');

    act(() => result.current!.mute(true));
    expect(sp.mute).toHaveBeenCalledWith(true);

    act(() => result.current!.hangup());
    expect(sp.hangup).toHaveBeenCalledTimes(1);
  });

  it('routes CTM start/end/error lifecycle events to the handlers', () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup();
    const onStart = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();

    renderHook(() => useCtmSoftphone({ onStart, onEnd, onError, surface: 'phone-tab' }));
    act(() => sp.__emit('start'));
    act(() => sp.__emit('end'));
    act(() => sp.__emit('error', 'boom'));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('boom');
  });

  it('seeds ready=true synchronously when the singleton latch is already flipped (a late subscriber)', () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup();
    vi.mocked(isOfficeSoftphoneReady).mockReturnValue(true);

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));

    // True on the very first read — no fresh 'ready' event required, since the
    // event already fired once in the past (before this hook ever mounted).
    expect(result.current!.ready).toBe(true);
  });

  it('flips ready when a future officeSoftphone-ready transition fires (seeded false)', () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup();
    vi.mocked(isOfficeSoftphoneReady).mockReturnValue(false);
    let fireReady: (() => void) | null = null;
    vi.mocked(subscribeOfficeSoftphoneReady).mockImplementation((cb) => {
      fireReady = cb;
      return () => {
        fireReady = null;
      };
    });

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(result.current!.ready).toBe(false);

    act(() => fireReady?.());
    expect(result.current!.ready).toBe(true);
  });

  it('does NOT tear down the shared device on unmount — the singleton outlives the hook', () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup();
    const { unmount } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    unmount();
    expect(sp.destroy).not.toHaveBeenCalled();
  });

  it('calls ensureOfficeSoftphone on every mount (officeSoftphone.ts owns idempotency, not the hook)', () => {
    const sp1 = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp1 as any);
    setup();

    const { unmount } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(1);
    unmount();

    const sp2 = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp2 as any);
    renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(ensureOfficeSoftphone).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes the ready-transition listener on unmount', () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup();
    const unsubscribe = vi.fn();
    vi.mocked(subscribeOfficeSoftphoneReady).mockReturnValue(unsubscribe);

    const { unmount } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
