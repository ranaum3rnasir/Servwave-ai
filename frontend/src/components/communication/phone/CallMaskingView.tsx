// Phone module - Call masking view.
//
// PROTOTYPE, NOT A FEATURE. There is no call-masking backend - no Prisma model,
// no route, no service (`git grep -i mask` over backend/src + backend/prisma
// returns only card-mask prose in payments-report.ts and log redaction). Every
// number on this page is a string literal: BUSINESS_NUMBER and MASKING_NUMBER
// come from lib/api/communication-shared/call-config.ts, and the tech names,
// caller-id options and AI-guardrail examples below are fabrications. "Save
// masking rules" only fires a toast - nothing is persisted, no request is made.
//
// It is therefore rendered ONLY for demo orgs. PhonePage's DEMO_ONLY_SECTIONS
// drops the "Call masking" tab from the module nav and sends a
// /communication/phone/masking deep link back to Calls for every real org. That
// gate is locked by
// src/pages/communication/__tests__/phone-masking-demo-gate.test.tsx - widen it
// and that suite goes red on purpose.
//
// Decision of record: SRVW-132 (Ran, 2026-07-31) - keep it, test organization
// only. Do not build it against CTM and do not delete it.
//
// Faithful cut from Emanuel's PhonePage monolith (L7527-8157): the
// consent/disclaimer constants, the CleanSelect picker, MaskStep, AiGuardrail,
// and CallMaskingView. (The cut also carried SECTION_META, a dead duplicate of
// PhonePage's own copy - removed under SRVW-132.) Proxy-number setup so a
// tech's and a client's real numbers are never exposed on a job
// (PHONE-SYSTEM-PRD §14.18) - a 5-step accordion flow plus an AI-guardrails
// section (leak guard / summary / sentiment).
//
// Faithful cut: prop signatures and behavior preserved verbatim. Changes are:
//   1. Import-shape — React-18 (no React-19 APIs).
//   2. Data from the seams — `MASKING_NUMBER` / `BUSINESS_NUMBER` come from the
//      `@/lib/api/communication` seam; the tech roster + `TECH_ROLE_LABEL` come
//      from the `@/lib/api/inventory` seam (`useTechs()` hook, not a module-load
//      import). `Switch` is the shared ui/ toggle primitive.
//   3. Token-swap — indigo/slate -> ALPHA design tokens (primary / text-primary /
//      text-secondary / border / background-light). emerald/amber/rose tints are
//      kept verbatim (status colors). The Web-Speech disclaimer preview is a
//      faithful mock (no real telephony).
//
// `CleanSelect` is the shared kernel copy (`@/components/communication/phone/
// shared`), deduped from the near-identical copy that lived in TextingView.tsx
// — same portal-based, measure + flip-up positioning logic; tone="primary"
// (the default) preserves this view's original accent color.
import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  FileText,
  Play,
  Shield,
  Sparkles,
  Users,
} from "lucide-react";
import { BUSINESS_NUMBER, MASKING_NUMBER } from "@/lib/api/communication";
import { useTechs, TECH_ROLE_LABEL } from "@/lib/api/inventory";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { CleanSelect } from "@/components/communication/phone/shared";

/* ─────────────────── Call masking ─────────────────── */
/* Proxy-number setup so a tech's & client's real numbers are never exposed on a
 * job (PHONE-SYSTEM-PRD §14.18). Mirrors the reference 4-step flow, in our clean
 * module styling, plus an AI guardrails section (leak guard / summary / sentiment). */

type ConsentStyle = "one_party" | "all_party";

const CONSENT_OPTIONS: { value: ConsentStyle; label: string }[] = [
  { value: "one_party", label: "One-party consent (notice only)" },
  { value: "all_party", label: "All-party consent (explicit)" },
];

const DISCLAIMER_TEMPLATES: Record<ConsentStyle, string> = {
  one_party:
    "Hi, this is ServWave. Just so you know, this call may be recorded for quality and training purposes. Thanks!",
  all_party:
    "Hi, this is ServWave. Before we begin, please note this call is being recorded for quality and training purposes. By staying on the line you consent to the recording. Thank you!",
};

/** Numbered, collapsible setup step (the reference's accordion cards). */
function MaskStep({
  index,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  index: number;
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      className={[
        "rounded-xl border bg-surface-light transition",
        open ? "border-border ring-1 ring-border" : "border-border",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
      >
        <span className="flex items-center gap-3">
          <span
            className={[
              "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold",
              open ? "bg-text-primary text-on-fill" : "bg-background-light text-text-secondary",
            ].join(" ")}
          >
            {index}
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] font-bold text-text-primary">{title}</span>
            {!open && summary && (
              <span className="block truncate text-[12px] text-text-secondary">{summary}</span>
            )}
          </span>
        </span>
        <ChevronDown
          className={["h-4 w-4 flex-shrink-0 text-text-secondary transition", open ? "rotate-180" : ""].join(" ")}
        />
      </button>
      {open && <div className="border-t border-border px-4 py-4">{children}</div>}
    </section>
  );
}

/** One AI guardrail: header row (icon + title + toggle) and an example card. */
function AiGuardrail({
  icon: Icon,
  title,
  desc,
  on,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
  on: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <Card padding="sm" flat>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </span>
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-text-primary">
              {title}
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">
                AI
              </span>
            </p>
            <p className="mt-0.5 text-[12px] leading-snug text-text-secondary">{desc}</p>
          </div>
        </div>
        <Switch checked={on} onCheckedChange={onToggle} aria-label={title} />
      </div>
      {on && children && <div className="mt-3">{children}</div>}
    </Card>
  );
}

export function CallMaskingView({ onToast }: { onToast: (m: string) => void }) {
  const { data: techs = [] } = useTechs();
  const eligible = techs;
  // Company-wide by default: everyone is masked, and new users auto-join (§14.18).
  const [masked, setMasked] = useState<Set<string>>(
    () => new Set(eligible.map((t) => t.id)),
  );
  const [autoMask, setAutoMask] = useState(true);
  const [recordMode, setRecordMode] = useState<"off" | "on">("on");
  const [consent, setConsent] = useState<ConsentStyle>("all_party");
  const [disclaimer, setDisclaimer] = useState("");
  const [callerId, setCallerId] = useState(BUSINESS_NUMBER);
  const [smartCallback, setSmartCallback] = useState(true);
  const [useForLeads, setUseForLeads] = useState(true);
  const [leakGuard, setLeakGuard] = useState(true);
  const [aiSummary, setAiSummary] = useState(true);
  const [sentiment, setSentiment] = useState(true);
  const [howOpen, setHowOpen] = useState(false);
  const [open, setOpen] = useState<Record<"techs" | "record" | "caller" | "mask" | "ai", boolean>>({
    techs: false,
    record: false,
    caller: false,
    mask: false,
    ai: false,
  });
  const toggleSec = (k: keyof typeof open) => setOpen((p) => ({ ...p, [k]: !p[k] }));

  function toggleTech(id: string) {
    setMasked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) {
        n.delete(id);
        setAutoMask(false); // managing individually now — not everyone is masked
      } else {
        n.add(id);
        if (n.size === eligible.length) setAutoMask(true);
      }
      return n;
    });
  }

  function draftDisclaimer() {
    setDisclaimer(DISCLAIMER_TEMPLATES[consent]);
    onToast("✨ AI drafted a recording disclaimer");
  }

  function tryItOut() {
    const text = disclaimer.trim() || DISCLAIMER_TEMPLATES[consent];
    try {
      window.speechSynthesis?.cancel();
      window.speechSynthesis?.speak(new SpeechSynthesisUtterance(text));
    } catch {
      /* speech synthesis unavailable — toast still confirms the action */
    }
    onToast("▶️ Playing the disclaimer preview");
  }

  const callerOptions = [
    { value: BUSINESS_NUMBER, label: `${BUSINESS_NUMBER} · Main` },
    { value: "(718) 555-0142", label: "(718) 555-0142 · Google Ads" },
    { value: "(888) 555-0199", label: "(888) 555-0199 · Toll-free" },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      {/* Intro + primary action */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-text-secondary">
          Protect tech and customer privacy with proxy numbers, so personal
          numbers are never exposed when calling about a job.
        </p>
        <button
          type="button"
          onClick={() => onToast("✓ Masking settings saved")}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-on-fill shadow-sm transition hover:bg-primary/90"
        >
          <Check className="h-4 w-4" /> Save masking rules
        </button>
      </div>

      {/* 1 — Which techs get masked numbers */}
      <MaskStep
        index={1}
        title="Which field techs will get masked phone numbers?"
        summary={`${masked.size} of ${eligible.length} techs masked`}
        open={open.techs}
        onToggle={() => toggleSec("techs")}
      >
        {/* Company-wide default: new users auto-join masking */}
        <div className="mb-3 flex items-start justify-between gap-3 rounded-card border border-border bg-background-light px-3 py-2.5">
          <div className="flex items-start gap-2.5">
            <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-text-primary text-on-fill">
              <Users className="h-4 w-4" />
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">
                Auto-mask everyone in the company
              </p>
              <p className="mt-0.5 text-[12px] leading-snug text-text-secondary">
                Every new user added to the system automatically joins call
                masking. Turn this off to add people one by one instead.
              </p>
            </div>
          </div>
          <Switch
            checked={autoMask}
            onCheckedChange={(v) => {
              setAutoMask(v);
              if (v) setMasked(new Set(eligible.map((t) => t.id)));
              onToast(
                v
                  ? "All users masked — new users auto-join"
                  : "Auto-mask off — add users manually",
              );
            }}
            aria-label="Auto-mask everyone in the company"
          />
        </div>
        <p className="text-[13px] text-text-secondary">
          These techs get a “masked” number when assigned to a job.
        </p>
        <div className="mt-2 flex items-center gap-3 text-[13px]">
          <button
            type="button"
            onClick={() => {
              setMasked(new Set(eligible.map((t) => t.id)));
              setAutoMask(true);
            }}
            className="font-semibold text-primary hover:text-primary/90"
          >
            Check all
          </button>
          <span className="text-border">/</span>
          <button
            type="button"
            onClick={() => {
              setMasked(new Set());
              setAutoMask(false);
            }}
            className="font-semibold text-primary hover:text-primary/90"
          >
            Uncheck all
          </button>
          <span className="ml-auto rounded-full bg-background-light px-2 py-0.5 text-[12px] font-semibold text-text-secondary">
            {masked.size} masked
          </span>
        </div>

        {/* AI nudge tied to the leak guard */}
        {leakGuard && (
          <div className="mt-3 flex items-start gap-2 rounded-card border border-warning/20 bg-warning/10 px-3 py-2 text-[12px] text-warning">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
            <span>
              <span className="font-semibold">AI suggests</span> masking{" "}
              <span className="font-semibold">Rom</span> and{" "}
              <span className="font-semibold">Itay</span> — they shared a personal
              number with a client in the last 30 days.
            </span>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
          {eligible.map((t) => {
            const on = masked.has(t.id);
            return (
              <label key={t.id} className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleTech(t.id)}
                  className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-border text-primary focus:ring-primary"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {t.name}
                  </span>
                  <span className="block truncate text-[11px] text-text-secondary">
                    {TECH_ROLE_LABEL[t.role]} · {t.branch}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </MaskStep>

      {/* 2 — Record calls */}
      <MaskStep
        index={2}
        title="Record calls?"
        summary={recordMode === "on" ? "Record tech calls" : "Don't record tech calls"}
        open={open.record}
        onToggle={() => toggleSec("record")}
      >
        <p className="text-[13px] text-text-secondary">
          All calls are saved automatically under the relevant job and client page.
        </p>
        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="record"
              checked={recordMode === "off"}
              onChange={() => setRecordMode("off")}
              className="h-4 w-4 text-primary focus:ring-primary"
            />
            Don’t record tech calls
          </label>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="record"
              checked={recordMode === "on"}
              onChange={() => setRecordMode("on")}
              className="h-4 w-4 text-primary focus:ring-primary"
            />
            Record tech calls
          </label>
        </div>

        {recordMode === "on" && (
          <div className="mt-4 space-y-3 rounded-card border border-border bg-background-light/70 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] font-medium text-text-secondary">
                Disclaimer for clients (outgoing calls)
              </p>
              <div className="flex items-center gap-2">
                <CleanSelect
                  value={consent}
                  onChange={(v) => setConsent(v as ConsentStyle)}
                  options={CONSENT_OPTIONS}
                  ariaLabel="Consent style"
                  widthClass="inline-block min-w-[220px]"
                />
                <button
                  type="button"
                  onClick={draftDisclaimer}
                  className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-md border border-primary/20 bg-primary/10 px-2.5 py-2 text-[13px] font-semibold text-primary transition hover:bg-primary/20"
                >
                  <Sparkles className="h-3.5 w-3.5" /> Draft with AI
                </button>
              </div>
            </div>
            <textarea
              value={disclaimer}
              onChange={(e) => setDisclaimer(e.target.value)}
              placeholder={'I.E — "Calls may be recorded for training and quality purposes…"'}
              rows={3}
              className="w-full resize-none rounded-md border border-border bg-surface-light p-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10"
            />
            <button
              type="button"
              onClick={tryItOut}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-light px-3 py-1.5 text-[13px] font-semibold text-text-secondary transition hover:bg-background-light"
            >
              <Play className="h-3.5 w-3.5" /> Try it out
            </button>
            <p className="text-[11px] leading-relaxed text-text-secondary">
              ☝️ Federal law requires notifying when a call may be recorded.
              Recording-consent laws vary by state (one-party vs. all-party). The
              AI draft adapts to the consent style you pick; ServWave reads the prompt
              to the receiving party as text-to-speech.
            </p>
          </div>
        )}
      </MaskStep>

      {/* 3 — What number the client sees */}
      <MaskStep
        index={3}
        title="What phone number will the client see?"
        summary={`Clients see ${callerId}`}
        open={open.caller}
        onToggle={() => toggleSec("caller")}
      >
        <p className="text-[13px] text-text-secondary">
          When techs call a client, this is the number the client sees. You can{" "}
          <button
            type="button"
            onClick={() => onToast("Opening number provisioning…")}
            className="font-semibold text-primary hover:text-primary/90"
          >
            get another number if you need one.
          </button>
        </p>
        <div className="mt-3 max-w-xs">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            Caller ID number
          </p>
          <CleanSelect
            value={callerId}
            onChange={setCallerId}
            options={callerOptions}
            ariaLabel="Caller ID number"
            size="md"
            widthClass="block w-full"
          />
        </div>
        <label className="mt-4 flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={smartCallback}
            onChange={(e) => setSmartCallback(e.target.checked)}
            className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-border text-primary focus:ring-primary"
          />
          <span>
            <span className="block text-sm font-semibold text-text-primary">
              Use smart tech callback
            </span>
            <span className="block text-[12px] text-text-secondary">
              When clients call back this number, forward the call to the relevant
              tech while the job is open. Client-to-tech calls are also recorded and
              auto-saved.
            </span>
          </span>
        </label>
      </MaskStep>

      {/* 4 — Your masking number */}
      <MaskStep
        index={4}
        title="Your masking number"
        summary={`Techs will call ${MASKING_NUMBER}`}
        open={open.mask}
        onToggle={() => toggleSec("mask")}
      >
        <p className="font-mono text-2xl font-bold tracking-tight text-text-primary">
          {MASKING_NUMBER}
        </p>
        <p className="mt-1 text-[13px] text-text-secondary">
          Every job gets a temporary 3-digit extension that connects to the client.
        </p>
        <button
          type="button"
          onClick={() => setHowOpen((v) => !v)}
          className="mt-1 text-[13px] font-semibold text-primary hover:text-primary/90"
        >
          {howOpen ? "Hide" : "Show me how it works"}
        </button>
        {howOpen && (
          <ol className="mt-2 space-y-1.5 rounded-card bg-background-light p-3 text-[12px] text-text-secondary">
            <li>1. Tech is assigned a job → gets {MASKING_NUMBER} + a 3-digit ext.</li>
            <li>2. Tech dials the masking number; the ext routes to the client.</li>
            <li>3. Client sees {callerId} — never the tech’s real number.</li>
            <li>4. The extension expires when the job closes.</li>
          </ol>
        )}
        <label className="mt-3 flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={useForLeads}
            onChange={(e) => setUseForLeads(e.target.checked)}
            className="h-4 w-4 flex-shrink-0 rounded border-border text-primary focus:ring-primary"
          />
          <span className="text-sm font-medium text-text-primary">Use masking for leads.</span>
        </label>
      </MaskStep>

      {/* 5 — AI guardrails & insights */}
      <MaskStep
        index={5}
        title="AI guardrails & insights"
        summary="Leak guard · summaries · sentiment"
        open={open.ai}
        onToggle={() => toggleSec("ai")}
      >
        <p className="text-[13px] text-text-secondary">
          ServWave’s AI watches masked tech↔client calls to protect your customer
          relationships and surface what matters — without you listening to every call.
        </p>
        <div className="mt-3 space-y-2.5">
          <AiGuardrail
            icon={Shield}
            title="Off-platform leak guard"
            desc="Flags when a tech shares a personal number or tries to take the job off-platform — the core risk masking prevents. Alerts the owner."
            on={leakGuard}
            onToggle={setLeakGuard}
          >
            <div className="rounded-card border border-danger/20 bg-danger/10 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[12px] font-semibold text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" /> High-risk · masked call
                </span>
                <span className="rounded bg-danger px-1.5 py-0.5 text-[10px] font-bold text-on-fill">
                  OWNER ALERTED
                </span>
              </div>
              <p className="mt-1.5 text-[12px] italic text-text-secondary">
                “…just Venmo me directly next time and we’ll skip the platform fee…”
              </p>
              <p className="mt-1 text-[11px] text-text-secondary">
                Ohad → client · J-1862 · detected 2:14 PM
              </p>
            </div>
          </AiGuardrail>

          <AiGuardrail
            icon={FileText}
            title="Call summary + transcript"
            desc="Every masked call is auto-transcribed and summarized to the job and client page — key points, promised price/time, next steps."
            on={aiSummary}
            onToggle={setAiSummary}
          >
            <div className="rounded-card border border-border bg-surface-light p-3 text-[12px] text-text-secondary">
              <p className="font-semibold text-text-secondary">Summary → J-1862</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                <li>Reader at Lobby 1 offline; client wants same-day fix.</li>
                <li>Tech quoted $180 diagnostic, arrival ~4 PM.</li>
                <li>Next: confirm COI before arrival.</li>
              </ul>
            </div>
          </AiGuardrail>

          <AiGuardrail
            icon={AlertTriangle}
            title="Sentiment & escalation alerts"
            desc="Detects an upset client or risky language on a masked call and pings dispatch in real time so they can step in."
            on={sentiment}
            onToggle={setSentiment}
          >
            <div className="flex items-center gap-2 rounded-card border border-warning/20 bg-warning/10 p-3 text-[12px] text-warning">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>
                <span className="font-semibold">Escalation:</span> client frustration
                rising on a masked call (J-1851) — dispatch pinged to step in.
              </span>
            </div>
          </AiGuardrail>
        </div>
      </MaskStep>
    </div>
  );
}
