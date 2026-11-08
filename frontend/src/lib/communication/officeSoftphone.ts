import {
  createCtmSoftphone,
  type CreateCtmSoftphoneOptions,
  type CtmSoftphone,
  type SoftphoneFault,
} from './ctmSoftphone';

/**
 * Fix B — CTM softphone warm singleton.
 *
 * Root cause this fixes: every mounted <Softphone> previously owned its own
 * CtmSoftphone via useCtmSoftphone's create-on-mount / destroy-on-unmount
 * effect. Since <Softphone> only ever mounts while the dialer popup is open,
 * closing the dialer destroyed the whole CTM embed (script element + WebRTC
 * device + auth token) and reopening it cold-started the embed from scratch —
 * the multi-second latency this fix removes.
 *
 * This module gives the device a lifetime independent of any transient
 * popup: a single instance, created once and reused for the rest of the page
 * load, module-scope (not React state) so it survives component unmount.
 * useCtmSoftphone.ts (the per-consumer hook) goes through this module instead
 * of calling createCtmSoftphone directly. The device runs ONLY in the `/phone`
 * tab: that tab is the one surface whose hook may create it, and the tab's page
 * (usePhoneTabDeviceTeardown in phoneTabDevice.ts) is the one caller that tears
 * it down, on unmount and on logout. The main window boots no device at all.
 *
 * The `isReady` latch exists because the underlying 'ready' event fires at
 * most once per instance (real device-live handshake) — a subscriber that
 * shows up AFTER that already happened (e.g. a dialer opened after the device
 * finished booting) needs a synchronous way to see "already ready" instead of
 * waiting forever for an event that will never fire again.
 */

let instance: CtmSoftphone | null = null;
let isReady = false;
const readySubscribers = new Set<() => void>();
// The fault channel is the exact mirror of the ready channel above: one piece of
// module-scope state, one Set of subscribers, one getter, one subscribe, both
// cleared by teardownOfficeSoftphone(). It exists because "not ready" is not a
// diagnosis — before it, every distinguishable way the device could fail to boot
// rendered as the same eternal "Connecting…".
let currentFault: SoftphoneFault | null = null;
const faultSubscribers = new Set<() => void>();
// Whether a call is live on the device: from the moment one is dialled (or the
// device reports it started) until it ends. The /phone tab reads it so that
// leaving the tab can never silently drop a call. Unlike the two channels
// above, teardown NOTIFIES these subscribers instead of clearing them: a
// mounted page keeps listening across a logout teardown.
//
// A device 'error' clears it ONLY while the dialled call has not started yet
// (the dial itself failed). Once the call has started, an 'error' does not
// clear it: errors include token-refresh failures mid-call, and a stale "live"
// only makes the back link open a new tab, while a wrong "idle" would let it
// drop a real call.
let callActive = false;
let callStarted = false;
const callSubscribers = new Set<() => void>();
// Whether a device 'end' is still owed for a call WE hung up. Our Hang up
// clears the channel at once (the user ended the call; the device's 'end' may
// be late or never come), but if that late 'end' arrives after the user has
// already dialled the next call, it must not mark the NEW call idle. So a Hang
// up that clears a live call owes one 'end', and the next 'end' pays it off
// instead of clearing.
//
// Kept bounded so an 'end' the vendor never echoes cannot swallow later calls:
// the debt is capped at 1, and the device's 'start' for a new call settles it
// (a call that has started is a new call; whatever the old one owed is moot).
// What remains uncovered: the old call's 'end' arriving AFTER the new call's
// 'start' would clear the new call. The device runs one call at a time, so
// the old call's 'end' is expected before the next 'start'.
let endsOwed = 0;
// Bumped by every teardown. A consumer keyed on it remounts with fresh state
// once the old device is gone, instead of keeping the old device's latches
// (e.g. a "Ready" seeded from a device that no longer exists).
let generation = 0;
const generationSubscribers = new Set<() => void>();

function setCallActive(next: boolean) {
  if (callActive === next) return;
  callActive = next;
  callSubscribers.forEach((cb) => cb());
}

/** Return the existing instance, or create the ONE instance via
 *  createCtmSoftphone(opts) if none exists yet. Idempotent — at most one
 *  device ever exists at a time. */
export function ensureOfficeSoftphone(opts: CreateCtmSoftphoneOptions): CtmSoftphone {
  if (instance) return instance;
  instance = createCtmSoftphone(opts);
  instance.on('ready', () => {
    isReady = true;
    // Ready wins, always: a device that is live has nothing to complain about,
    // so a fault raised while it was still booting is retracted here. Together
    // with the readiness check in the 'fault' handler below, this is what keeps
    // ready and fault from ever both being true.
    if (currentFault !== null) {
      currentFault = null;
      faultSubscribers.forEach((cb) => cb());
    }
    readySubscribers.forEach((cb) => cb());
  });
  instance.on('start', () => {
    endsOwed = 0;
    callStarted = true;
    setCallActive(true);
  });
  instance.on('error', () => {
    // The dialled call never started: the dial failed, so nothing is live.
    if (callActive && !callStarted) setCallActive(false);
  });
  instance.on('end', () => {
    if (endsOwed > 0) {
      // The late 'end' of a call we already hung up: settle it, and leave the
      // channel as it is (idle, or live for a call dialled since).
      endsOwed -= 1;
      return;
    }
    setCallActive(false);
  });
  instance.on('fault', (payload) => {
    if (isReady) return; // see above — a booted device is never faulted
    const next = payload as SoftphoneFault;
    if (currentFault === next) return; // idempotent: no churn for a repeat
    currentFault = next;
    faultSubscribers.forEach((cb) => cb());
  });
  return instance;
}

/** The current instance, or null if never created / torn down. */
export function getOfficeSoftphone(): CtmSoftphone | null {
  return instance;
}

/** The current latch value, synchronously — lets a late subscriber see
 *  ready=true immediately instead of waiting for a 'ready' event that already
 *  fired in the past. */
export function isOfficeSoftphoneReady(): boolean {
  return isReady;
}

/** Register cb for FUTURE transitions to ready (i.e. the next time the
 *  underlying 'ready' event fires). Does NOT fire immediately even if already
 *  ready — callers seed their own state via isOfficeSoftphoneReady() first and
 *  subscribe here only for subsequent changes. Returns an unsubscribe fn. */
export function subscribeOfficeSoftphoneReady(cb: () => void): () => void {
  readySubscribers.add(cb);
  return () => readySubscribers.delete(cb);
}

/** The current fault, synchronously, or null if the device is healthy or has
 *  simply not run out of time yet. The exact counterpart of
 *  isOfficeSoftphoneReady(): it is how a consumer that mounts LATE (a dialer
 *  opened long after the device gave up) learns about a fault whose event fired
 *  in the past. Never non-null at the same time as isOfficeSoftphoneReady(). */
export function getOfficeSoftphoneFault(): SoftphoneFault | null {
  return currentFault;
}

/** Register cb for FUTURE fault transitions. Does NOT fire immediately even if a
 *  fault is already present — exactly like subscribeOfficeSoftphoneReady,
 *  callers seed their own state via getOfficeSoftphoneFault() first and
 *  subscribe here only for subsequent changes. Note that unlike the ready latch
 *  this channel is two-way (a fault is retracted when the device becomes ready),
 *  so a subscriber must RE-READ the getter rather than assume a fault appeared.
 *  Returns an unsubscribe fn. */
export function subscribeOfficeSoftphoneFault(cb: () => void): () => void {
  faultSubscribers.add(cb);
  return () => faultSubscribers.delete(cb);
}

/** True while a call is live on the device (see `callActive` above). */
export function isOfficeSoftphoneCallActive(): boolean {
  return callActive;
}

/** Record that a call was just dialled, before the device reports 'start'.
 *  The device's 'end' event clears it. */
export function markOfficeSoftphoneCallDialled(): void {
  if (!instance) return;
  if (!callActive) callStarted = false;
  setCallActive(true);
}

/** Record that the user hung up through ServWave: the call is over now, not
 *  when the device gets round to reporting 'end'. One 'end' is then owed (see
 *  `endsOwed`, capped at 1). A Hang up with no live call owes nothing. */
export function markOfficeSoftphoneCallHungUp(): void {
  if (!callActive) return;
  endsOwed = 1; // capped: see `endsOwed`
  setCallActive(false);
}

/** Register cb for changes to isOfficeSoftphoneCallActive(). Returns an
 *  unsubscribe fn. */
export function subscribeOfficeSoftphoneCall(cb: () => void): () => void {
  callSubscribers.add(cb);
  return () => callSubscribers.delete(cb);
}

/** The device generation: changes on every teardown. */
export function getOfficeSoftphoneGeneration(): number {
  return generation;
}

/** Register cb for generation changes (i.e. teardowns). Returns an unsubscribe fn. */
export function subscribeOfficeSoftphoneGeneration(cb: () => void): () => void {
  generationSubscribers.add(cb);
  return () => generationSubscribers.delete(cb);
}

/** Destroy the instance (if any), and reset all singleton state. Safe to call
 *  when no instance exists, and idempotent. This is the ONLY teardown path —
 *  the `/phone` tab's page calls it on unmount and on logout, never a
 *  transient consumer. */
export function teardownOfficeSoftphone(): void {
  instance?.destroy();
  instance = null;
  isReady = false;
  readySubscribers.clear();
  currentFault = null;
  faultSubscribers.clear();
  endsOwed = 0;
  callStarted = false;
  setCallActive(false);
  generation += 1;
  generationSubscribers.forEach((cb) => cb());
}
