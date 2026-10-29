import { useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, User } from "lucide-react";
import { fmtPhone, matchByNumber, usePhoneCustomers } from "@/lib/api/communication";
import type { IncomingCallInfo } from "@/lib/communication/useCtmSoftphone";

/**
 * Task C2 — the `/phone` tab's real incoming-call UI. Mounted by
 * `Softphone.tsx` ONLY while a real device call is ringing/live (`Softphone`
 * owns the ONE `useCtmSoftphone` instance for the `/phone` surface — Task
 * A4's regression guard asserts `ensureOfficeSoftphone` is called exactly
 * once when the shell mounts, so the `onIncoming` subscription lives there
 * rather than in a second hook instance in `PhoneTabPage`); this component
 * itself just presents the ring/answer/in-call states and never talks to the
 * CTM device directly.
 *
 * Caller identity reuses the SAME lookup Softphone.tsx's own screen-pop uses
 * (`matchByNumber` against `usePhoneCustomers`) so an inbound ring and an
 * outbound placed-call show identical "who is this" resolution.
 *
 * `onAnswer`/`onDecline` are wired straight to the hook's REAL device methods
 * (`officeSoftphone.answer()` / `.hangup()`, Task C1) — there is no local
 * `setState("active")` simulation here (that simulation still lives in
 * Softphone.tsx, but only behind its `incomingNumber` prop, which the
 * `/phone` tab never passes — see Softphone.tsx's header comment).
 */
export interface IncomingCallCardProps {
  /** The caller-info payload carried by the device's 'incoming' event. */
  info: IncomingCallInfo;
  /** Calls the hook's REAL device answer() (Task C1). */
  onAnswer: () => void;
  /** Calls the hook's REAL device hangup() (Task C1) — used both to decline
   *  before answering and to hang up an in-progress call. */
  onDecline: () => void;
  /** Proxies to the REAL device's mute() (Task C1's officeSoftphone.mute). */
  onMute?: (muted: boolean) => void;
}

// The exact field the CTM `ctm:incomingCall` payload carries the caller's
// E.164 number under is unconfirmed pending live QA (see useCtmSoftphone.ts's
// IncomingCallInfo note) — the C1 test payload used `from`. Check a few
// plausible keys rather than trusting one so a live field-name surprise
// degrades to "Unknown number" instead of throwing.
const CALLER_NUMBER_KEYS = ["from", "caller_number", "caller_number_complete", "number", "caller"];

function extractCallerNumber(info: IncomingCallInfo): string | null {
  for (const key of CALLER_NUMBER_KEYS) {
    const value = info[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function IncomingCallCard({ info, onAnswer, onDecline, onMute }: IncomingCallCardProps) {
  const { data: customers = [] } = usePhoneCustomers();
  const [phase, setPhase] = useState<"ringing" | "active">("ringing");
  const [muted, setMuted] = useState(false);

  const callerNumber = extractCallerNumber(info);
  const match = callerNumber ? matchByNumber(customers, callerNumber) : null;

  function handleAnswer() {
    onAnswer();
    setPhase("active");
  }

  function handleMuteToggle() {
    setMuted((m) => {
      onMute?.(!m);
      return !m;
    });
  }

  return (
    <div
      role="region"
      aria-label="Incoming call"
      className="overflow-hidden rounded-card border border-primary/30 bg-surface-light shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-border bg-primary/5 px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-primary">
          {phase === "active" ? "On call" : "Incoming call"}
        </span>
      </div>

      <div className="p-3">
        <div className="mb-3 flex items-start gap-2">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <User className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            {match ? (
              <>
                <p className="truncate text-sm font-semibold text-text-primary">
                  {match.customer.name}
                </p>
                <p className="truncate text-[11px] text-text-secondary">
                  {match.contact.name}
                  {match.contact.role ? ` · ${match.contact.role}` : ""}
                </p>
              </>
            ) : (
              <p className="truncate text-sm font-semibold text-text-primary">Unknown caller</p>
            )}
            <p className="truncate font-mono text-[11px] text-text-secondary">
              {callerNumber ? fmtPhone(callerNumber) : "Unknown number"}
            </p>
          </div>
        </div>

        {phase === "ringing" ? (
          <div className="flex items-center gap-2">
            <button
              onClick={handleAnswer}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-success py-2 text-sm font-semibold text-on-fill shadow-sm transition hover:bg-success"
            >
              <Phone className="h-4 w-4" /> Answer
            </button>
            <button
              onClick={onDecline}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-danger py-2 text-sm font-semibold text-on-fill shadow-sm transition hover:bg-danger"
            >
              <PhoneOff className="h-4 w-4" /> Decline
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={handleMuteToggle}
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
              onClick={onDecline}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-danger py-2 text-sm font-semibold text-on-fill shadow-sm transition hover:bg-danger"
            >
              <PhoneOff className="h-4 w-4" /> Hang up
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
