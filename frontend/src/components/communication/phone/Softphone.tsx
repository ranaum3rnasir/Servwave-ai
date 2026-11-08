import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Delete,
  Mic,
  MicOff,
  Phone,
  PhoneIncoming,
  PhoneOff,
  PhoneOutgoing,
  User,
  UserPlus,
} from "lucide-react";
import {
  BUSINESS_NUMBER,
  fmtPhone,
  usePhoneCustomers,
  usePlaceCall,
  useStashCallAttribution,
  useCallOutcome,
} from "@/lib/api/communication";
import type { Contact, PhoneCustomer } from "@/lib/api/communication";
import type { DialerEntityContext } from "@/stores/dialer.store";
import { useCtmSoftphone, type IncomingCallInfo } from "@/lib/communication/useCtmSoftphone";
import type { SoftphoneFault } from "@/lib/communication/ctmSoftphone";
import { BROWSER_INBOUND_ANSWER_ENABLED } from "@/lib/communication/ctmSoftphone";
import { useMyOutboundNumber } from "@/lib/api/myOutboundNumber";
import { providerNumberIdOf } from "@/lib/api/providerNumberId";
import { IncomingCallCard } from "@/pages/phone/IncomingCallCard";
import { useSettingsGuard } from "@/stores/settingsGuard.store";
import { isFinalCallStatus } from "@/lib/api/communication-shared";

const MY_PROFILE_PATH = "/settings/profile";
// How far before the dial second the fallback outcome floor reaches. Mirrors
// OUTCOME_FLOOR_DRIFT_MS in backend comm-calls.controller.ts (the server's own
// floor, which replaces this one whenever the bridge answers with it).
const OUTCOME_FLOOR_DRIFT_MS = 2_000;

// Bridge refusals the caller must act on (mobile slice 21). The server sends
// plain ServWave copy; each code keeps its OWN fallback in case it is absent.
const BRIDGE_REFUSAL_FALLBACKS: Record<string, string> = {
  PROFILE_PHONE_REQUIRED: "Add your phone number to your profile to place calls from your phone",
  PHONE_CALLING_NOT_SET_UP:
    "Calling from your phone isn't set up for your account yet. Contact ServWave support",
  CALLER_IS_CUSTOMER: "You can't call your own profile phone",
};

// "Go to My Profile" from a refused call. A real link (href, keyboard, open in
// new tab), but a plain click goes through the settings unsaved-changes guard
// like every other exit path. Its own component so the router hooks only run
// when the link is actually shown.
function MyProfileLink() {
  const navigate = useNavigate();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  return (
    <Link
      to={MY_PROFILE_PATH}
      className="underline"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        requestLeave(() => navigate(MY_PROFILE_PATH));
      }}
    >
      Go to My Profile
    </Link>
  );
}

// In-CRM softphone console (PHONE-SYSTEM-PRD §8.2). A component, not a global
// docked bar. Outbound calls are REAL (CTM click-to-call bridge): the backend
// rings the agent's phone first, then dials the customer — so placing a call
// ends in a terminal "placed" state (the physical phone is the UI; master plan
// §2: no polling, no fake connect).
//
// Two SEPARATE inbound paths coexist, gated by which surface renders this
// component (Task C2):
//  - The `incomingNumber` prop below drives a SIMULATED ring (`ringing_in`
//    state, local `answer()`) — the main app's inline dialer (Dialer.tsx,
//    `surface` omitted) still uses this for its "Simulate incoming call" demo
//    (TrainingView.tsx). Left untouched: it never runs on the `/phone` tab.
//  - `officeSoftphone.onIncoming` (Task C1) drives a REAL device ring — the
//    ONLY path `/phone` (`surface="phone-tab"`) can reach, since that's the
//    only surface with a non-null `officeSoftphone`. It renders
//    `IncomingCallCard` (Task C2) and answers/hangs up on the ACTUAL CTM
//    device, not local state. `Softphone` stays the sole call site allowed to
//    boot the device (Task A4's regression guard), so this lives here rather
//    than in a second `useCtmSoftphone` instance in `PhoneTabPage`.

type CallState = "idle" | "dialing" | "ringing_in" | "active" | "placed";

// A settled call's length, in the same m:ss shape as the live in-call timer.
// Deliberately no "ended" CallState: the bridge's terminal state is still
// "placed", and whether the call has SETTLED is a property of the ingested
// CallSession, not of local state - so it is derived from the outcome row
// rather than duplicated into the state machine.
function fmtDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

// DTMF dual-tone frequencies per key (so the keypad sounds like a real phone).
const DTMF: Record<string, [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};

/** Resolve a Customer/Contact from an inbound E.164 number (the screen-pop
 *  identity step, PHONE-SYSTEM-PRD §4.1.B). The monolith closed over a
 *  module-scope `customers` array; in ALPHA the array comes from the
 *  `usePhoneCustomers` seam hook, so callers pass it in as the first arg.
 *  Returns null for unknown callers. */
function matchByNumber(
  customers: PhoneCustomer[],
  e164: string,
): { customer: PhoneCustomer; contact: Contact } | null {
  for (const customer of customers) {
    for (const contact of customer.contacts) {
      if (contact.channels.some((c) => c.value === e164)) {
        return { customer, contact };
      }
    }
  }
  return null;
}

type Props = {
  /** A number to simulate an inbound call from (set by the page's "Simulate
   *  incoming call" button). Cleared by the parent after the ring is consumed. */
  incomingNumber?: string | null;
  onConsumedIncoming?: () => void;
  /** A number to drop into the dial field (e.g. picked from a job/PO search).
   *  Cleared by the parent after it's consumed. */
  prefillNumber?: string | null;
  onConsumedPrefill?: () => void;
  /** Entity attribution (E2): the job/lead/customer this dialer was opened from.
   *  Its ids ride the placed call (POST body on the bridge, /calls/attribution on
   *  the softphone) so the webhook stamps the CallSession. Follows the ENTITY, not
   *  the exact number — editing the number keeps it (a dispatcher editing to reach
   *  a cell is still calling about this job/lead); it clears when the dialer
   *  closes (this component unmounts). */
  entityContext?: DialerEntityContext | null;
  /** A number to *immediately place a call to* (e.g. "Call back" from the call
   *  detail drawer). The console opens straight into the dialing/active state. */
  autoCallNumber?: string | null;
  onConsumedAutoCall?: () => void;
  /** When provided, a "Conference / Add person" control appears during an active
   *  call (opens the office-contacts picker). */
  onConference?: () => void;
  /** Fired when the call ends (hang up / decline) — lets a host popup close. */
  onEnded?: () => void;
  /** Device-boot surface (Task A3 — passed through verbatim to
   *  `useCtmSoftphone`). The dedicated `/phone` tab (`PhoneTabPage`) is the
   *  ONLY caller that passes `'phone-tab'`, making it the sole CTM device
   *  owner; every other host (the main-app GlobalDialer popup,
   *  ActiveCallPopup) omits this, defaulting to `'inline'` — unchanged,
   *  zero-boot behavior (Task A2). */
  surface?: 'phone-tab' | 'inline';
  /** Task B3 — a per-call caller-ID override (the `/phone` tab's from-number
   *  picker). A `provider_number_id` ("TPN…") the caller explicitly picked
   *  from PhoneTabPage's allow-list; when set (non-empty), it wins over the
   *  resolved default (Task B2) for the NEXT call only. `PhoneTabPage` is the
   *  sole caller that passes this — every other host omits it, keeping the
   *  resolved-default behavior unchanged. */
  callerIdOverride?: string;
  /** The same "Calling from" pick as ServWave's own phone_number_id. The bridge
   *  path (no browser phone: every phone, every non-/phone host) sends it as
   *  `from_number_id`; the server honours it only when the number is assigned
   *  to the caller. Unset = no field, and the server picks the default. Never
   *  the phone service's id - that one stays on the browser-phone path. */
  callerIdNumberId?: string;
};

/**
 * The one place a device fault becomes words. Every string is ServWave's own —
 * the naming boundary in CLAUDE.md means the telephony vendor is never named in
 * anything a user can see, so these describe the SYMPTOM and the REMEDY, never
 * the provider or its internals ("station check", "device lock", an account id).
 * Each says what the user can actually do about it:
 *   locked-out    → the other tab is theirs; closing it is the whole fix.
 *   station-check → the browser wants a microphone check we cannot surface
 *                   inside our own UI, so a reload into the vendor-free path is
 *                   the honest ask.
 *   unknown       → we genuinely do not know; say so rather than guess.
 */
const SOFTPHONE_FAULT_TEXT: Record<SoftphoneFault, string> = {
  "locked-out": "Phone active in another tab",
  "station-check": "Audio check required",
  unknown: "Phone unavailable — reload to retry",
};

export function Softphone({
  incomingNumber,
  onConsumedIncoming,
  prefillNumber,
  onConsumedPrefill,
  entityContext,
  autoCallNumber,
  onConsumedAutoCall,
  onConference,
  onEnded,
  surface,
  callerIdOverride,
  callerIdNumberId,
}: Props) {
  const { data: customers = [] } = usePhoneCustomers();
  const placeCall = usePlaceCall();
  const stashAttribution = useStashCallAttribution();
  const [state, setState] = useState<CallState>("idle");
  const [dial, setDial] = useState("");
  const [activeNumber, setActiveNumber] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  // `profileLink`: the server refused because the caller has no usable profile
  // phone (PROFILE_PHONE_REQUIRED), so the message carries a link to My Profile.
  const [placeError, setPlaceError] = useState<{ text: string; profileLink?: boolean } | null>(null);
  const [match, setMatch] = useState<{ customer: PhoneCustomer; contact: Contact } | null>(
    null,
  );
  // The context the in-flight/placed call was attributed with — drives the
  // "logged to J00042" copy on the placed screen.
  const [placedContext, setPlacedContext] = useState<DialerEntityContext | null>(null);
  // When the bridge call was handed to CTM, as the floor for the outcome poll
  // below. Set once per placed call so an old call to the same customer can
  // never be mistaken for this one.
  const [placedAt, setPlacedAt] = useState<string | null>(null);
  // Bridge path only: the browser is never on this call, so the ONLY way to
  // learn it ended is the CallSession the 'end' webhook writes ~30-40s after
  // hangup. Ask for exactly this call while it sits in the "placed" state; the
  // query disables itself outside it, and stops the moment the row lands.
  const { data: placedOutcome } = useCallOutcome(
    state === "placed" ? activeNumber : null,
    state === "placed" ? placedAt : null,
  );
  // The placed call has SETTLED: the webhook's CallSession landed, so the call
  // is provably over. Still the "placed" state - this is a property of the
  // ingested row, not a new state (see fmtDuration's note).
  // Only a FINAL row counts: a 'starts' webhook writes the call as ringing
  // while it is still going.
  const callSettled = state === "placed" && isFinalCallStatus(placedOutcome?.status);
  // Task C2 — a REAL inbound ring on the device, entirely separate from the
  // `incomingNumber`-prop simulation above `state`/`match` drive: non-null
  // ONLY between a real 'incoming' event and that call ending (Decline before
  // answer, Hang up after, or the remote party hanging up), and ONLY
  // reachable on the officeSoftphone path (null everywhere `officeSoftphone`
  // is null, since the subscribing effect below no-ops there).
  const [deviceIncoming, setDeviceIncoming] = useState<IncomingCallInfo | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const dialInputRef = useRef<HTMLInputElement>(null);

  // Office WebRTC softphone (slice 4): non-null for any role in a comm-enabled
  // org WHEN the softphone flag is on, in the /phone tab, not on a phone
  // (computer or tablet) — otherwise the callback bridge below runs unchanged
  // (the device picks the transport, never the role).
  // Real CTM lifecycle events drive the SAME in-call UI as the simulation.
  const officeSoftphone = useCtmSoftphone({
    onStart: () => setState("active"),
    onEnd: () => {
      setState("idle");
      setActiveNumber(null);
      setMatch(null);
      setMuted(false);
      setPlacedContext(null);
      setDeviceIncoming(null);
      onEnded?.();
    },
    onError: () => {
      setPlaceError({ text: "The softphone couldn't connect — try again" });
      setState("idle");
      setActiveNumber(null);
      setDeviceIncoming(null);
    },
    surface,
  });

  // Fix B (warm singleton): the shared device may still be booting when this
  // console mounts (the /phone tab boots it as the page mounts). An honest
  // "Connecting…" state beats a Call button that silently does nothing. No-op
  // on the bridge/tel path (officeSoftphone null).
  const softphoneConnecting = !!officeSoftphone && !officeSoftphone.ready;
  // ...except when nothing has started booting at all: with the /phone tab's
  // 'first-gesture' trigger the device waits for a click in the tab, and
  // "Connecting…" would be a lie. Still blocked (it is not ready), with copy
  // that says what starts it.
  const softphoneAwaitingStart = softphoneConnecting && officeSoftphone.awaitingStart;

  // Slice 3 — why it is not ready, when that is knowable. Null on the bridge/tel
  // path (no handle) and null while the device is merely still booting, so
  // "Connecting…" remains the normal pre-ready state and a fault only ever
  // REPLACES it once one exists.
  const softphoneFault: SoftphoneFault | null = officeSoftphone?.fault ?? null;

  // Every "can we dial?" gate reads this rather than `softphoneConnecting`.
  // The `!!softphoneFault` half is REDUNDANT TODAY and kept on purpose:
  // officeSoftphone.ts guarantees ready and fault are never both set, so a
  // faulted handle already reports ready=false and is already blocked. It is
  // defence-in-depth against that invariant being broken two modules away —
  // the failure it prevents (a Call button that looks live while the pill says
  // the phone is unavailable) is worse than the line costs.
  const softphoneBlocked = softphoneConnecting || !!softphoneFault;

  // Task C2 — subscribe to the REAL device ring (Task C1's onIncoming).
  // Depends on `hasOfficeSoftphone` (a stable boolean), not `officeSoftphone`
  // itself: the hook returns a fresh object every render, so depending on the
  // object directly would tear down and resubscribe on every render. The
  // subscription still reaches the ACTUAL live device regardless of which
  // render's closure created it — `onIncoming` reads the hook's own stable
  // device ref at call time, not at closure-creation time. Optional-chained
  // (`?.`) like every other officeSoftphone call here: pre-C1/C2 test doubles
  // for this hook only stub `call/hangup/mute/ready`, so a bare call would
  // throw on those suites.
  const hasOfficeSoftphone = !!officeSoftphone;
  useEffect(() => {
    // Outbound-only lock (2026-07-20): the browser device never answers inbound
    // calls — those ring the staff member's cell via the CTM mobile app. Skip
    // the device-ring subscription entirely so no in-browser answer card can
    // appear (and a warm background device can never double-ring the cell).
    // Flip BROWSER_INBOUND_ANSWER_ENABLED to restore the Task C1/C2 path.
    if (!BROWSER_INBOUND_ANSWER_ENABLED) return;
    const unsubscribe = officeSoftphone?.onIncoming?.((info) => setDeviceIncoming(info));
    return () => unsubscribe?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasOfficeSoftphone]);

  // Task B2 — the caller's resolved outbound number (Task B1), fetched ONLY
  // on the office-softphone path (the `/phone` tab); the bridge/tel path
  // resolves its from-number server-side and never needs this. Its
  // provider_number_id ("TPN…") becomes `fromTpnId` below, so an outbound WebRTC
  // call presents the user's own number (else org default) as caller ID.
  const { data: resolvedOutboundNumber } = useMyOutboundNumber(!!officeSoftphone);
  const resolvedFromTpnId =
    resolvedOutboundNumber && !("none" in resolvedOutboundNumber)
      ? providerNumberIdOf(resolvedOutboundNumber)
      : undefined;
  // Task B3 - an explicit per-call pick (PhoneTabPage's caller-ID picker) wins
  // over the resolved default; falls back to it when unset (every other host
  // of <Softphone/> never passes callerIdOverride, so this is a no-op there).
  const fromTpnId = callerIdOverride || resolvedFromTpnId;

  // Keep the latest customers list in a ref so the imperative handlers/effects
  // (which capture stale closures) always match against fresh seam data.
  const customersRef = useRef<PhoneCustomer[]>(customers);
  customersRef.current = customers;

  // --- Audio engine (Web Audio) — synthesizes ringtone / DTMF / connect cue
  // so the simulated inbound flow is actually audible for a web test. ---
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ringRef = useRef<{ stop: () => void } | null>(null);

  function getCtx(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!audioCtxRef.current) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      audioCtxRef.current = new Ctor();
    }
    void audioCtxRef.current.resume();
    return audioCtxRef.current;
  }

  /** One-shot blend of sine tones (DTMF, connect cue). */
  function beep(freqs: number[], ms: number, vol = 0.08) {
    try {
      const ctx = getCtx();
      if (!ctx) return;
      const gain = ctx.createGain();
      gain.gain.value = vol;
      gain.connect(ctx.destination);
      const oscs = freqs.map((f) => {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        o.connect(gain);
        o.start();
        return o;
      });
      window.setTimeout(() => {
        oscs.forEach((o) => {
          try {
            o.stop();
          } catch {
            /* already stopped */
          }
        });
      }, ms);
    } catch {
      /* audio unavailable — stay silent */
    }
  }

  /** Repeating ring cadence ( on/off) until stopped. */
  function startTone(freqs: number[], onMs: number, offMs: number) {
    let stopped = false;
    let oscs: OscillatorNode[] = [];
    let t: ReturnType<typeof setTimeout> | undefined;
    function cycle() {
      if (stopped) return;
      try {
        const ctx = getCtx();
        if (!ctx) return;
        const gain = ctx.createGain();
        gain.gain.value = 0.07;
        gain.connect(ctx.destination);
        oscs = freqs.map((f) => {
          const o = ctx.createOscillator();
          o.type = "sine";
          o.frequency.value = f;
          o.connect(gain);
          o.start();
          return o;
        });
      } catch {
        /* ignore */
      }
      t = setTimeout(() => {
        oscs.forEach((o) => {
          try {
            o.stop();
          } catch {
            /* noop */
          }
        });
        oscs = [];
        t = setTimeout(cycle, offMs);
      }, onMs);
    }
    cycle();
    return {
      stop() {
        stopped = true;
        if (t) clearTimeout(t);
        oscs.forEach((o) => {
          try {
            o.stop();
          } catch {
            /* noop */
          }
        });
        oscs = [];
      },
    };
  }

  // Drive call audio off the call state: ring on a (simulated) inbound call,
  // connect cue on answer. Outbound plays no fake ringback — the user's own
  // phone rings for real once CTM bridges the call.
  useEffect(() => {
    ringRef.current?.stop();
    ringRef.current = null;

    if (state === "ringing_in") {
      ringRef.current = startTone([480, 620], 1100, 900);
    } else if (state === "active") {
      beep([600, 900], 160, 0.06); // connect cue
    }

    return () => {
      ringRef.current?.stop();
      ringRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Parent asked us to ring for an inbound call → resolve screen-pop identity.
  useEffect(() => {
    if (incomingNumber) {
      setActiveNumber(incomingNumber);
      setMatch(matchByNumber(customersRef.current, incomingNumber));
      setState("ringing_in");
      onConsumedIncoming?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingNumber]);

  // Parent dropped a number into the dialer (e.g. picked from a job search). Any
  // accompanying entity context (entityContext prop) attributes the placed call
  // to that job/lead/customer regardless of later edits to the dialed number.
  useEffect(() => {
    if (prefillNumber) {
      setState("idle");
      setDial(prefillNumber);
      onConsumedPrefill?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNumber]);

  // Parent asked us to place a call immediately (e.g. "Call back" from the call
  // detail drawer) — place the real call straight away.
  useEffect(() => {
    if (!autoCallNumber) return;
    setDial(autoCallNumber);
    startOutbound(autoCallNumber);
    onConsumedAutoCall?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCallNumber]);

  // Live call timer.
  useEffect(() => {
    if (state === "active") {
      timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } else {
      setSeconds(0);
      if (timer.current) clearInterval(timer.current);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [state]);

  // Keyboard dialing — type digits anywhere in the dialer to fill the number,
  // and press Enter to place the call (or answer a ringing call). Typing inside
  // another field (e.g. the job/PO search) is left alone so it isn't hijacked,
  // and the number input handles its own typing natively to avoid double entry.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (state === "active") return;
      const el = document.activeElement as HTMLElement | null;
      const inOtherField =
        !!el &&
        el !== dialInputRef.current &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      if (inOtherField) return;

      if (e.key === "Enter") {
        // Let a focused button (keypad / Call) handle its own Enter click, and
        // let the number input handle Enter via its own onKeyDown.
        if (el && el.tagName === "BUTTON") return;
        if (el === dialInputRef.current) return;
        if (state === "ringing_in") {
          e.preventDefault();
          answer();
        } else if (state === "idle" && dial.trim()) {
          e.preventDefault();
          startOutbound();
        }
        return;
      }

      if (state !== "idle") return;
      // The number input handles its own typing/backspace when focused.
      if (el === dialInputRef.current) return;

      if (/^[0-9*#+]$/.test(e.key)) {
        e.preventDefault();
        press(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        backspace();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, dial]);

  function press(d: string) {
    if (DTMF[d]) beep(DTMF[d], 130, 0.06); // audible keypad tone
    setDial((v) => (v.length < 18 ? v + d : v));
  }
  function backspace() {
    setDial((v) => v.slice(0, -1));
  }
  /** Place a REAL outbound call (CTM click-to-call). The webhook is the source
   *  of truth for the CallSession row — success lands in the terminal "placed"
   *  state (your phone rings first); there is no polling and no fake connect.
   *  Fix B: guarded by `softphoneBlocked` so EVERY entry point (Call button,
   *  autoCallNumber, global/keyboard Enter) is honestly blocked while the
   *  shared device is still booting, or has reported a fault — not just the
   *  Call button's `disabled` prop, which a keyboard-triggered call bypasses
   *  entirely. */
  function startOutbound(raw?: string) {
    const num = (raw ?? dial).trim();
    if (!num || placeCall.isPending || softphoneBlocked) return;
    const e164 = num.startsWith("+") ? num : `+1${num.replace(/\D/g, "")}`;
    // Entity attribution (E2): the placed call is attributed to the entity this
    // dialer was opened from, whatever number ends up dialed (editing to reach a
    // cell is still about this job/lead). Only defined ids ride the body.
    const ctx = entityContext ?? null;

    // Office softphone (flag on): talk THROUGH THE BROWSER. The CTM lifecycle
    // events (start→active, end→idle) drive the in-call UI — there is no bridge
    // "placed" state and the agent's cell is never called. Entity attribution
    // still applies here: this branch bypasses the createCall bridge, so it writes
    // the PendingCallAttribution stash itself (POST /calls/attribution) before it
    // rings. Caller ID (Task B2) dials from the resolved fromTpnId below; a
    // per-call override picker is still Task B3.
    if (officeSoftphone) {
      const sp = officeSoftphone;
      setActiveNumber(e164);
      setMatch(matchByNumber(customersRef.current, e164));
      setMuted(false);
      setPlaceError(null);
      setPlacedContext(ctx);
      setState("dialing");
      // Server pre-dial checkpoint (O-0, live QA 2026-07-21): the WebRTC
      // device dials CTM directly from the browser, so this POST is the ONLY
      // place the server sees the destination before it rings. It runs on
      // EVERY dial (bare numbers included) and doubles as the attribution
      // stash. An allowlist 409 BLOCKS the dial; any other failure (network,
      // 5xx) stays best-effort — attribution must not gate availability.
      void (async () => {
        try {
          await stashAttribution.mutateAsync({
            to_number: e164,
            ...(ctx?.jobId ? { job_id: ctx.jobId } : {}),
            ...(ctx?.leadId ? { lead_id: ctx.leadId } : {}),
            ...(ctx?.customerId ? { customer_id: ctx.customerId } : {}),
          });
        } catch (err) {
          const axiosErr = err as { response?: { data?: { code?: string } } };
          if (axiosErr.response?.data?.code === "NOT_IN_TEST_ALLOWLIST") {
            setPlaceError({ text: "This number isn't on the test allowlist (Phase-0 guard)" });
            setState("idle");
            setActiveNumber(null);
            return;
          }
          /* attribution is best-effort — place the call regardless */
        }
        // Caller ID (Task B2): pass the resolved TPN id ONLY when one
        // resolved — the hook's own call() threads it through dialFrom()
        // before dialing (useCtmSoftphone.ts:113-116). Omitting the second
        // arg entirely (rather than passing `undefined`) when nothing
        // resolved keeps the device's own default behavior untouched.
        if (fromTpnId) {
          sp.call(e164, fromTpnId);
        } else {
          sp.call(e164);
        }
      })();
      return;
    }

    setActiveNumber(e164);
    setMatch(matchByNumber(customersRef.current, e164));
    setMuted(false);
    setPlaceError(null);
    setPlacedContext(ctx);
    // Fallback floor for the outcome poll, stamped at DIAL time. The bridge's
    // own answer (outcome_since, server clock) replaces it on success: the
    // phone service stamps started_at in whole seconds on ITS clock, so a
    // millisecond floor from this device's clock can sit after the row and the
    // poll never matches. Rounded down and padded the same way as the server's.
    setPlacedAt(new Date(Math.floor(Date.now() / 1000) * 1000 - OUTCOME_FLOOR_DRIFT_MS).toISOString());
    setState("dialing");
    placeCall.mutate(
      // The backend resolves the real from-number (the org's CTM tracking
      // number); from_number here only feeds the not-connected mock-path row.
      {
        direction: "out",
        from_number: BUSINESS_NUMBER,
        to_number: e164,
        status: "ringing",
        ...(callerIdNumberId ? { from_number_id: callerIdNumberId } : {}),
        ...(ctx?.jobId ? { job_id: ctx.jobId } : {}),
        ...(ctx?.leadId ? { lead_id: ctx.leadId } : {}),
        ...(ctx?.customerId ? { customer_id: ctx.customerId } : {}),
      },
      {
        onSuccess: (data) => {
          const floor = (data as { outcome_since?: unknown } | undefined)?.outcome_since;
          if (typeof floor === "string") setPlacedAt(floor);
          setState("placed");
        },
        // No retry (usePlaceCall sets retry: false): every refusal here is a
        // 4xx/502 the user has to act on, and a retried bridge could ring twice.
        onError: (err) => {
          const axiosErr = err as { response?: { data?: { code?: string; error?: string } } };
          const code = axiosErr.response?.data?.code;
          const serverCopy = axiosErr.response?.data?.error;
          if (code && BRIDGE_REFUSAL_FALLBACKS[code]) {
            setPlaceError({
              text: serverCopy || BRIDGE_REFUSAL_FALLBACKS[code],
              profileLink: code === "PROFILE_PHONE_REQUIRED",
            });
          } else {
            setPlaceError({
              text:
                code === "NO_PHONE_NUMBER"
                  ? "No phone number available — buy one in the Numbers tab"
                  : code === "NOT_IN_TEST_ALLOWLIST"
                    ? "This number isn't on the test allowlist (Phase-0 guard)"
                    : "Couldn't place the call — try again",
            });
          }
          setState("idle");
          setActiveNumber(null);
        },
      },
    );
  }
  function answer() {
    setMuted(false);
    setState("active");
  }
  function hangUp() {
    // End the live WebRTC call too (no-op on the bridge path).
    officeSoftphone?.hangup();
    setState("idle");
    setActiveNumber(null);
    setMatch(null);
    setDial("");
    setPlaceError(null);
    setPlacedContext(null);
    setPlacedAt(null);
    onEnded?.();
  }

  // Tidy up audio when the console unmounts.
  useEffect(() => {
    return () => {
      ringRef.current?.stop();
    };
  }, []);

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  // Task C2 — a real inbound ring takes over the ENTIRE console (ringing
  // through the live call) rather than sitting alongside it: the same
  // officeSoftphone device drives both this and the state==="active" block
  // below (a real answer() eventually fires the SAME 'start' event this
  // console's own onStart listens for), so showing both at once would double
  // up mute/hang-up controls. IncomingCallCard owns its own ringing→active
  // in-call UI end to end; the normal console returns once the call ends
  // (onEnd/onError clear deviceIncoming above).
  // Dormant under the outbound-only lock: `deviceIncoming` is only ever set by
  // the (now-gated) subscription above, so this branch never renders while
  // BROWSER_INBOUND_ANSWER_ENABLED is false. Kept intact for a one-flag revert.
  if (deviceIncoming) {
    return (
      <IncomingCallCard
        info={deviceIncoming}
        onAnswer={() => officeSoftphone?.answer()}
        onDecline={() => {
          officeSoftphone?.hangup();
          setDeviceIncoming(null);
        }}
        onMute={(nextMuted) => officeSoftphone?.mute(nextMuted)}
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface-light shadow-sm">
      <div className="flex items-center justify-between border-b border-border bg-background-light px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          Softphone
        </span>
        <span
          className={[
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
            state === "active"
              ? "bg-success/10 text-success"
              : callSettled
                ? "bg-background-light text-text-secondary"
                : state === "placed"
                  ? "bg-primary/10 text-primary"
                  : state === "ringing_in" || state === "dialing"
                    ? "bg-warning/10 text-warning"
                    : "bg-background-light text-text-secondary",
          ].join(" ")}
        >
          <span
            className={[
              "h-1.5 w-1.5 rounded-full",
              state === "active"
                ? "bg-success"
                : callSettled
                  ? "bg-text-secondary"
                  : state === "placed"
                    ? "bg-primary"
                    : state === "ringing_in" || state === "dialing"
                      ? "animate-pulse bg-warning"
                      : "bg-text-secondary",
            ].join(" ")}
          />
          {state === "active"
            ? "On call"
            : callSettled
              ? "Call ended"
              : state === "placed"
                ? "Call placed"
                : state === "dialing"
                  ? "Calling…"
                  : state === "ringing_in"
                    ? "Ringing"
                    : softphoneFault
                      ? SOFTPHONE_FAULT_TEXT[softphoneFault]
                      : softphoneAwaitingStart
                        ? "Click anywhere to start the phone"
                        : softphoneConnecting
                          ? "Connecting…"
                          : "Ready"}
        </span>
      </div>

      <div className="p-3">
        {/* Screen-pop context for an identified caller (§4.1.B). */}
        {state !== "idle" && (
          <div className="mb-3 rounded-md border border-border bg-background-light p-2.5">
            {match ? (
              <div className="flex items-start gap-2">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <User className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">
                    {match.customer.name}
                  </p>
                  <p className="truncate text-[11px] text-text-secondary">
                    {match.contact.name}
                    {match.contact.role ? ` · ${match.contact.role}` : ""}
                  </p>
                  <p className="truncate text-[11px] text-text-secondary">
                    {match.customer.site}
                  </p>
                  {match.customer.membershipTier && (
                    <span className="mt-1 inline-block rounded-full bg-warning/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning">
                      {match.customer.membershipTier}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-text-secondary">
                <span className="font-semibold text-text-primary">Unknown caller</span>{" "}
                · no match — will create a provisional contact
              </p>
            )}
          </div>
        )}

        {/* Active / ringing display */}
        {state !== "idle" ? (
          <div className="mb-3 text-center">
            <p className="font-mono text-lg font-semibold tracking-wide text-text-primary">
              {activeNumber ? fmtPhone(activeNumber) : "—"}
            </p>
            <p className="text-[11px] text-text-secondary">
              {state === "active" ? (
                <span className="font-mono">
                  {mm}:{ss}
                </span>
              ) : state === "dialing" ? (
                <span className="inline-flex items-center gap-1 text-warning">
                  <PhoneOutgoing className="h-3 w-3 animate-pulse" /> Calling…
                </span>
              ) : state === "placed" ? (
                callSettled && placedOutcome ? (
                  <span className="inline-flex items-center gap-1 text-text-secondary">
                    <PhoneOutgoing className="h-3 w-3" /> Call ended
                    {placedOutcome.durationSec != null && (
                      <span className="font-mono">
                        {" "}
                        {fmtDuration(placedOutcome.durationSec)}
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-primary">
                    <PhoneOutgoing className="h-3 w-3" /> Call placed
                  </span>
                )
              ) : (
                <span className="inline-flex items-center gap-1 text-warning">
                  <PhoneIncoming className="h-3 w-3" /> Incoming call…
                </span>
              )}
            </p>
          </div>
        ) : (
          <div className="mb-2">
            <input
              ref={dialInputRef}
              value={dial}
              onChange={(e) => setDial(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && dial.trim()) {
                  e.preventDefault();
                  startOutbound();
                }
              }}
              placeholder="Enter a number"
              inputMode="tel"
              autoFocus
              className="w-full rounded-md border border-border bg-surface-light px-3 py-2 text-center font-mono text-lg tracking-wide focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
            />
          </div>
        )}

        {/* Dialpad (only when idle) */}
        {state === "idle" && (
          <div className="mb-3 grid grid-cols-3 gap-1.5">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map((d) => (
              <button
                key={d}
                onClick={() => press(d)}
                className="rounded-md border border-border bg-surface-light py-2 text-base font-semibold text-text-secondary transition hover:bg-background-light active:bg-background-light"
              >
                {d}
              </button>
            ))}
          </div>
        )}

        {/* Action row */}
        {state === "idle" && (
          <>
            <div className="flex items-center gap-2">
              <button
                onClick={() => startOutbound()}
                disabled={!dial.trim() || placeCall.isPending || softphoneBlocked}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-success py-2 text-sm font-semibold text-on-fill shadow-sm transition hover:bg-success disabled:cursor-not-allowed disabled:bg-background-light disabled:text-text-secondary"
              >
                <Phone className="h-4 w-4" /> Call
              </button>
              <button
                onClick={backspace}
                disabled={!dial}
                aria-label="Delete last digit"
                className="rounded-md border border-border bg-surface-light p-2 text-text-secondary transition hover:bg-background-light disabled:opacity-40"
              >
                <Delete className="h-4 w-4" />
              </button>
            </div>
            {placeError && (
              <p role="status" className="mt-2 text-center text-[11px] font-medium text-danger">
                {placeError.text}
                {placeError.profileLink && (
                  <>
                    {" "}
                    <MyProfileLink />
                  </>
                )}
              </p>
            )}
          </>
        )}

        {/* Placing the call — the POST is in flight; no cancel, no fake answer. */}
        {state === "dialing" && (
          <p className="text-center text-[11px] text-text-secondary">Placing call…</p>
        )}

        {/* Terminal state for a real click-to-call: the webhook logs the call;
            the physical phone is the UI from here (plan §2 — no polling). When
            the call carried an entity context the copy names where it logs. */}
        {state === "placed" && (
          <div className="space-y-2">
            <p
              role="status"
              className="rounded-md border border-border bg-background-light p-2.5 text-center text-[11px] text-text-secondary"
            >
              {callSettled
                ? placedContext?.jobLabel
                  ? `Call ended. Logged to ${placedContext.jobLabel}.`
                  : placedContext?.leadLabel
                    ? `Call ended. Logged to ${placedContext.leadLabel}.`
                    : "Call ended and logged to the call history."
                : placedContext?.jobLabel
                  ? `Your phone will ring first — this call will be logged to ${placedContext.jobLabel}.`
                  : placedContext?.leadLabel
                    ? `Your phone will ring first — this call will be logged to ${placedContext.leadLabel}.`
                    : "Your phone will ring first — answer to connect."}
            </p>
            <button
              onClick={hangUp}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-surface-light py-2 text-sm font-semibold text-text-secondary transition hover:bg-background-light"
            >
              {callSettled ? "Done" : "Dismiss"}
            </button>
          </div>
        )}

        {state === "ringing_in" && (
          <div className="flex items-center gap-2">
            <button
              onClick={answer}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-success py-2 text-sm font-semibold text-on-fill shadow-sm transition hover:bg-success"
            >
              <Phone className="h-4 w-4" /> Answer
            </button>
            <button
              onClick={hangUp}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-danger py-2 text-sm font-semibold text-on-fill shadow-sm transition hover:bg-danger"
            >
              <PhoneOff className="h-4 w-4" /> Decline
            </button>
          </div>
        )}

        {state === "active" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  setMuted((m) => {
                    officeSoftphone?.mute(!m); // proxy to the live device (no-op on bridge)
                    return !m;
                  })
                }
                className={[
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 text-sm font-semibold transition",
                  muted
                    ? "bg-primary text-on-fill hover:bg-primary-dark"
                    : "border border-border bg-surface-light text-text-secondary hover:bg-background-light",
                ].join(" ")}
              >
                {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {muted ? "Muted" : "Mute"}
              </button>
              <button
                onClick={hangUp}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-danger py-2 text-sm font-semibold text-on-fill shadow-sm transition hover:bg-danger"
              >
                <PhoneOff className="h-4 w-4" /> Hang up
              </button>
            </div>
            {onConference && (
              <button
                onClick={onConference}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 py-2 text-sm font-semibold text-primary transition hover:bg-primary/20"
              >
                <UserPlus className="h-4 w-4" /> Conference / Add person
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
