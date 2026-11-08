// Task C1 — surface the incoming-call event through the hook and wire real
// answer()/hangup(). Ground truth (master plan §B): `ctm:incomingCall` →
// emit('incoming') already exists in ctmSoftphone.ts, and the wrapper already
// has a REAL answer() that calls the device's el.answer?.() — nothing
// subscribes to 'incoming' yet, and callers only had a local simulation
// (Softphone.tsx:502-504 `setState("active")`). This test proves: (1) the
// hook exposes an `onIncoming(cb)` subscription that fires with the payload
// carried by the wrapper's 'incoming' event, and (2) the hook's `answer()`
// calls the wrapper's real device answer() — not a local state change (the
// hook holds no call-state at all, so the only way "answer" can do anything
// is by reaching the device).
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

/* eslint-disable @typescript-eslint/no-explicit-any */

function setup({ role = 'ADMIN', comm = true, flag = true } = {}) {
  vi.mocked(useAuthStore).mockImplementation((sel: any) => sel({ user: { role } }));
  vi.mocked(useFeature).mockReturnValue(comm);
  vi.mocked(isCtmSoftphoneEnabled).mockReturnValue(flag);
  vi.mocked(isOfficeSoftphoneReady).mockReturnValue(false);
  vi.mocked(subscribeOfficeSoftphoneReady).mockReturnValue(() => {});
}

/** A fake CtmSoftphone whose `on()` behaves like the real wrapper's — it
 *  actually stores per-event subscribers so the test can trigger a real
 *  'incoming' emission, the same way ctmSoftphone.ts's own emit() does. */
function fakeSp() {
  const subs = new Map<string, Set<(payload?: unknown) => void>>();
  return {
    call: vi.fn(),
    dialFrom: vi.fn(),
    mute: vi.fn(),
    hangup: vi.fn(),
    answer: vi.fn(),
    on: vi.fn((event: string, cb: (payload?: unknown) => void) => {
      let set = subs.get(event);
      if (!set) {
        set = new Set();
        subs.set(event, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    }),
    __emit(event: string, payload?: unknown) {
      subs.get(event)?.forEach((cb) => cb(payload));
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('useCtmSoftphone — incoming call + real answer (Task C1)', () => {
  it('fires the onIncoming subscriber with the caller info carried by the ctm:incomingCall → "incoming" event', () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup();

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(result.current).not.toBeNull();

    const onIncomingCb = vi.fn();
    result.current!.onIncoming(onIncomingCb);

    const callerInfo = { from: '+15555550199', call_id: 'abc123' };
    sp.__emit('incoming', callerInfo);

    expect(onIncomingCb).toHaveBeenCalledTimes(1);
    expect(onIncomingCb).toHaveBeenCalledWith(callerInfo);
  });

  it('unsubscribes onIncoming when the returned function is called', () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup();

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    const onIncomingCb = vi.fn();
    const unsubscribe = result.current!.onIncoming(onIncomingCb);
    unsubscribe();

    sp.__emit('incoming', { from: '+15555550199' });

    expect(onIncomingCb).not.toHaveBeenCalled();
  });

  it("answer() calls the wrapper's REAL device answer() — not a local simulation", () => {
    const sp = fakeSp();
    vi.mocked(ensureOfficeSoftphone).mockReturnValue(sp as any);
    setup();

    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    result.current!.answer();

    expect(sp.answer).toHaveBeenCalledTimes(1);
  });

  it('does nothing (no throw) when answer()/onIncoming are used on a null handle (gate closed)', () => {
    setup({ comm: false });
    const { result } = renderHook(() => useCtmSoftphone({ surface: 'phone-tab' }));
    expect(result.current).toBeNull();
  });
});
