// Phone module — Dialer (global header dialer + workspace + active-call /
// SMS / conference overlays).
//
// Originally cut from Emanuel's PhonePage monolith (GlobalDialer + DialerWorkspace
// + JobHistoryPanel L1144-1602 — the latter reworked into CustomerPanel in slice
// 2.2; ActiveCallPopup + MessagePanel + ConferencePicker L3029-3375). Changes
// from the monolith:
//   1. Tailwind tokens swapped indigo/slate -> ALPHA design tokens
//      (primary / text-primary / text-secondary / border / background-light).
//      emerald, amber, rose, sky, violet are kept verbatim (status colors);
//      the SMS bubble keeps its indigo->primary treatment.
//   2. Data comes from the seams. Communication data (calls, message threads,
//      fmtPhone, DISPOSITION_LABELS) loads from `@/lib/api/communication`;
//      purchase orders load from `@/lib/api/inventory`. Cross-cutting
//      helpers/components (shortTime, dayLabel, DirIcon) come from the kernel.
//   3. Search is REAL (#666/#357): the old demo dialIndex (useInventoryJobs +
//      usePurchaseOrders + usePhoneCustomers joined by demo-seed linkedJobIds)
//      is gone — DialerWorkspace queries the canonical
//      GET /api/communication/dialer-search endpoint (debounced input), which
//      returns tenant customers (with open jobs), jobs, and a phone-identity
//      resolution. Picking a result loads CustomerPanel (job chips deep-link
//      to /jobs/:id); a phone-shaped query with no match offers
//      Create customer / Create lead prefilled with the number.
//
// ActiveCallPopup and ConferencePicker now compose the shared `ui/modal`
// primitive (overlays consolidation) instead of their former hand-rolled fixed
// overlays — chrome only, business logic kept verbatim. MessagePanel is a
// docked (bottom-right) SMS panel, not a centered dialog, so it stays
// hand-rolled — it isn't the concept `ui/modal` covers.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Briefcase,
  CheckCircle2,
  ChevronDown,
  FileText,
  Hash,
  MessageSquare,
  Mic,
  Phone,
  Plus,
  Search,
  Send,
  User,
  UserPlus,
  Users,
  Wrench,
  X,
} from "lucide-react";
import {
  DISPOSITION_LABELS,
  fmtPhone,
  smsSendErrorMessage,
  useCallTranscript,
  useDialerSearch,
  useMessageThreads,
  usePhoneAgents,
  useSendSms,
  deliveryNote,
  outboundBubbleClass,
  type CallSession,
  type DialerIdentity,
  type DialerSearchCustomer,
  type DialerSearchJob,
  type Message,
  type PhoneCustomer,
} from "@/lib/api/communication";
import { usePurchaseOrders, useTechs, type Tech } from "@/lib/api/inventory";
import {
  dayLabel,
  DirIcon,
  shortTime,
} from "@/components/communication/phone/shared";
import { useSettingsGuard } from "@/stores/settingsGuard.store";
import { type DialerEntityContext } from "@/stores/dialer.store";
import { openPhoneTab } from "@/lib/communication/phoneTabHandoff";
import { Softphone } from "./Softphone";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useScheduleTimezone } from '@/lib/schedule-tz';

/* ───────────────────────── Global dialer ─────────────────────────
 * Header entry point: a phone button that opens the dedicated `/phone`
 * pop-out tab — the ONE CTM softphone device owner (Task A3) — instead of the
 * old in-app overlay popup. It shares the singleton `servwave-phone` tab with
 * every entity "Call" button (phoneTabHandoff), so the header button, a call
 * from a Job, and a call from a Customer all land on the same live phone tab.
 * The full search + softphone + right-panel workspace now lives inside that
 * tab (PhoneTabPage → DialerWorkspace), not here. */

export function GlobalDialer() {
  return (
    <button
      type="button"
      onClick={() => openPhoneTab()}
      aria-label="Open dialer"
      title="Dialer — open the phone"
      className="rounded-md p-2 text-text-secondary transition hover:bg-background-light hover:text-primary"
    >
      <Phone className="h-4 w-4" />
    </button>
  );
}

/* ───────────────────────── Dialer workspace ─────────────────────────
 * Desktop-only: search a job #, customer, or phone number to pull their
 * number and see the customer's open jobs + history while you call. */

/** Display any wire phone — the dialer-search contract sends bare 10-digit
 *  strings, identities send E.164 — as (XXX) XXX-XXXX. */
function displayPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return fmtPhone(`+1${d}`);
  if (d.length === 11 && d.startsWith("1")) return fmtPhone(`+${d}`);
  return fmtPhone(raw);
}

/** SCREAMING_SNAKE job status → human words (capitalized via CSS). */
const statusLabel = (s: string) => s.replace(/_/g, " ").toLowerCase();

/** One open-job chip on the customer panel — a REAL job row (UUID id). */
export type DialerJobChip = {
  id: string;
  number: string;
  status: string;
  location: string;
};

/** The right-panel selection a picked search result resolves to. */
export type DialerSelection = {
  customer: { id: string; name: string; phone: string | null; site?: string | null };
  /** Open-job chips — when a job result was picked it is first + focused. */
  jobs: DialerJobChip[];
  /** The picked job's id (drives the highlight + the PO section). */
  focusedJobId?: string;
};

export function DialerWorkspace({
  calls,
  onToast,
  incomingNumber,
  onConsumedIncoming,
  openNumber,
  openContext,
  openNonce,
  onOpenNumberConsumed,
  surface,
  callerIdOverride,
  callerIdNumberId,
}: {
  calls: CallSession[];
  onToast: (m: string) => void;
  /** When set, the embedded softphone rings with a screen-pop (used by the
   *  "Simulate incoming call" demo now that the standalone dock is gone). */
  incomingNumber?: string | null;
  onConsumedIncoming?: () => void;
  /** When set, seed the softphone dial field with this number and consume (#572). */
  openNumber?: string | null;
  /** Entity context riding openNumber (E2) — captured with it, threads to the
   *  softphone so the placed call posts job_id/lead_id/customer_id. */
  openContext?: DialerEntityContext | null;
  /** Bumped per dial by the /phone receiver so re-dialing the SAME number
   *  still re-fires the seed/auto-pick effect (openNumber alone wouldn't
   *  change value). */
  openNonce?: number;
  onOpenNumberConsumed?: () => void;
  /** Device axis (Task A2): only 'phone-tab' cold-boots the shared CTM device.
   *  The Communication hub + any inline host omit it, staying zero-boot so
   *  the `/phone` tab remains the sole device owner. */
  surface?: "phone-tab" | "inline";
  /** Per-call caller-ID override (TPN id) from the /phone "Calling from"
   *  picker — threaded straight to the softphone. */
  callerIdOverride?: string;
  /** The same pick as ServWave's own phone_number_id - what the bridge call
   *  sends as from_number_id. Threaded straight to the softphone. */
  callerIdNumberId?: string;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [prefill, setPrefill] = useState<string | null>(null);
  const [prefillContext, setPrefillContext] = useState<DialerEntityContext | null>(null);
  const [selected, setSelected] = useState<DialerSelection | null>(null);
  const [showResults, setShowResults] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement>(null);
  // A dial waiting for its search to resolve so the right panel can auto-select
  // the caller's customer/job (set by the openNumber effect, consumed by the
  // auto-pick effect once results land).
  const pendingAutoPickRef = useRef<{ phone: string; ctx: DialerEntityContext | null } | null>(
    null,
  );

  // A dial arriving from an entity Call button (or the header handoff) seeds the
  // softphone AND drives the right panel: we run a search by the dialed number
  // so the customer + their open jobs surface, then the auto-pick effect below
  // selects the right one (focusing the job from context). openNonce is in the
  // deps so re-dialing the same number re-fires this.
  useEffect(() => {
    if (!openNumber) return;
    setPrefill(openNumber);
    setPrefillContext(openContext ?? null);
    setQuery(openNumber);
    setDebouncedQuery(openNumber);
    setShowResults(false); // auto-pick silently — don't pop the search dropdown
    pendingAutoPickRef.current = { phone: openNumber, ctx: openContext ?? null };
    onOpenNumberConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNumber, openNonce]);

  // Debounce the search input (~250ms, house pattern — GlobalSearch.tsx) so the
  // server query doesn't fire on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  // REAL tenant search — GET /api/communication/dialer-search (#666/#357).
  const { data: search, isFetching } = useDialerSearch(debouncedQuery);
  const hasQuery = debouncedQuery.length >= 2;
  // Gate on the live query: keepPreviousData may hold stale rows after a pick
  // clears the input.
  const result = hasQuery ? search : undefined;
  const customers = result?.customers ?? [];
  const jobs = result?.jobs ?? [];
  const identity = result?.identity ?? null;
  // Phone-shaped query with zero matches → the panel offers create actions.
  const unknownNumber =
    result &&
    result.query.isPhone &&
    !result.identity &&
    customers.length === 0 &&
    jobs.length === 0
      ? result.query.e164
      : null;

  function closeSearch() {
    setQuery("");
    setDebouncedQuery("");
    setShowResults(false);
  }

  /** Seed the softphone with the picked party's number (customer context in
   *  the toast); parties without a phone just load the panel. A known customer
   *  id rides along so even hub-placed calls attribute explicitly (E2); a
   *  picked JOB rides too — dropping it here is exactly how a dialer-search
   *  call missed its job's Communication tab (o4g, live QA 2026-07-21).
   *  The context is built whenever EITHER is present — gating it on customerId
   *  alone silently dropped a picked job whose customer is null or has no
   *  phone on file (o4g residual gap): the entity context describes what the
   *  eventual call is ABOUT, independent of whether a number could be
   *  auto-prefilled for it. */
  function ready(
    name: string,
    phone: string | null,
    customerId?: string,
    job?: { id: string; number: string },
  ) {
    setPrefillContext(
      customerId || job
        ? {
            ...(customerId && { customerId, customerName: name }),
            ...(job && { jobId: job.id, jobLabel: job.number }),
          }
        : null,
    );
    if (!phone) return;
    setPrefill(phone);
    onToast(`☎️ ${name} — ${displayPhone(phone)} ready, press Call`);
  }

  function pickCustomer(c: DialerSearchCustomer) {
    setSelected({
      customer: { id: c.id, name: c.name, phone: c.phone, site: c.site },
      jobs: c.openJobs,
    });
    ready(c.name, c.phone, c.id);
    closeSearch();
  }

  function pickJob(j: DialerSearchJob) {
    const chip = { id: j.id, number: j.number, status: j.status, location: j.location };
    // When the same customer also surfaced as a customer hit, pull its other
    // open jobs so the panel shows the full picture (picked job first).
    const known = j.customer ? customers.find((c) => c.id === j.customer?.id) : undefined;
    const siblings = (known?.openJobs ?? []).filter((o) => o.id !== j.id);
    setSelected({
      customer: {
        id: j.customer?.id ?? "",
        name: j.customer?.name ?? "Unknown customer",
        phone: j.customer?.phone ?? null,
        site: known?.site,
      },
      jobs: [chip, ...siblings],
      focusedJobId: j.id,
    });
    ready(j.customer?.name ?? j.number, j.customer?.phone ?? null, j.customer?.id, {
      id: j.id,
      number: j.number,
    });
    closeSearch();
  }

  /** The Recognized banner — select the resolved customer in the panel. */
  function pickIdentity(idt: DialerIdentity) {
    if (!idt.customerId) return;
    const known = customers.find((c) => c.id === idt.customerId);
    if (known) {
      pickCustomer(known);
      return;
    }
    setSelected({
      customer: { id: idt.customerId, name: idt.label, phone: result?.query.e164 ?? null },
      jobs: [],
    });
    ready(idt.label, result?.query.e164 ?? null, idt.customerId);
    closeSearch();
  }

  // Auto-select the right panel once a dial-triggered search resolves, so a
  // call placed from a Job/Customer lands on `/phone` already showing WHO is
  // being called and WHAT it's about. This builds the selection DIRECTLY (not
  // via pickCustomer/pickJob) so the softphone keeps the DIALED number and the
  // FULL handoff context — the pick* helpers would clobber both with the picked
  // customer's number + a reduced {customerId} context, dropping job_id/lead_id
  // attribution. Customer precedence: ctx.customerId → resolved phone identity →
  // a sole customer match. If none resolve, the number simply stays prefilled
  // for a manual pick.
  useEffect(() => {
    const pending = pendingAutoPickRef.current;
    if (!pending || !search) return;
    if (debouncedQuery !== pending.phone) return; // stale — results for another query
    pendingAutoPickRef.current = null;

    const cs = search.customers ?? [];
    const idt = search.identity ?? null;
    const ctx = pending.ctx;

    let cust = ctx?.customerId ? cs.find((c) => c.id === ctx.customerId) : undefined;
    if (!cust && idt?.customerId) cust = cs.find((c) => c.id === idt.customerId);
    if (!cust && cs.length === 1) cust = cs[0];

    if (cust) {
      // Focus the job from context when it's one of this customer's open jobs
      // (a phone search surfaces jobs via the customer, not the top-level list).
      const focusedJobId =
        ctx?.jobId && cust.openJobs.some((o) => o.id === ctx.jobId) ? ctx.jobId : undefined;
      const jobs = focusedJobId
        ? [
            ...cust.openJobs.filter((o) => o.id === focusedJobId),
            ...cust.openJobs.filter((o) => o.id !== focusedJobId),
          ]
        : cust.openJobs;
      setSelected({
        customer: { id: cust.id, name: cust.name, phone: cust.phone, site: cust.site },
        jobs,
        focusedJobId,
      });
      onToast(`☎️ ${cust.name} — ${displayPhone(pending.phone)} ready, press Call`);
    }

    // The softphone dials the number that was requested, and carries the full
    // handoff context (job_id/lead_id/customer_id) — or, for a bare dial that
    // only resolved via identity/sole-match, attributes to that customer.
    setPrefill(pending.phone);
    setPrefillContext(
      ctx ?? (cust ? { customerId: cust.id, customerName: cust.name } : null),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, debouncedQuery]);

  // Dismiss the results dropdown on outside click or Escape — only wired
  // while the dropdown is open.
  useEffect(() => {
    if (!showResults) return;
    function onMouseDown(ev: MouseEvent) {
      if (
        searchBoxRef.current &&
        !searchBoxRef.current.contains(ev.target as Node)
      ) {
        setShowResults(false);
      }
    }
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === "Escape") setShowResults(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showResults]);

  return (
    <div className="rounded-card bg-surface-light p-3 shadow-sm">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        {/* Left: search (desktop) + softphone */}
        <div className="space-y-3">
          <div className="hidden md:block" ref={searchBoxRef}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setShowResults(true);
                }}
                onFocus={() => {
                  if (query.trim()) setShowResults(true);
                }}
                placeholder="Search a job #, customer, or phone…"
                className="w-full rounded-md border border-border bg-surface-light py-2 pl-9 pr-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
              />
            </div>
            {showResults && hasQuery && (
              <div className="mt-1.5 max-h-56 overflow-y-auto rounded-md border border-border">
                {/* Phone-identity banner — a resolved caller above the results. */}
                {identity &&
                  result?.query.isPhone &&
                  (identity.customerId ? (
                    <button
                      type="button"
                      onClick={() => pickIdentity(identity)}
                      className="flex w-full items-center gap-1.5 border-b border-border bg-primary-subtle px-3 py-2 text-left text-[11px] font-semibold text-primary transition hover:bg-primary/10"
                    >
                      <User className="h-3.5 w-3.5 flex-shrink-0" />
                      Recognized: {identity.label} ({identity.kind})
                    </button>
                  ) : (
                    <p className="flex items-center gap-1.5 border-b border-border bg-primary-subtle px-3 py-2 text-[11px] font-semibold text-primary">
                      <User className="h-3.5 w-3.5 flex-shrink-0" />
                      Recognized: {identity.label} ({identity.kind})
                    </p>
                  ))}
                {!result ? (
                  isFetching ? (
                    <p className="px-3 py-3 text-center text-[12px] text-text-secondary">Searching…</p>
                  ) : (
                    <EmptyState density="compact" title={`No customer or job matches “${debouncedQuery}”.`} />
                  )
                ) : customers.length === 0 && jobs.length === 0 ? (
                  <EmptyState density="compact" title={`No customer or job matches “${debouncedQuery}”.`} />
                ) : (
                  <>
                    {customers.length > 0 && (
                      <div>
                        <p className="bg-background-light px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-text-secondary">
                          Customers
                        </p>
                        <ul className="divide-y divide-border">
                          {customers.map((c) => (
                            <li key={c.id}>
                              <button
                                type="button"
                                onClick={() => pickCustomer(c)}
                                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-primary/10"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-[13px] font-semibold text-text-primary">
                                    {c.name}
                                  </span>
                                  <span className="block truncate text-[11px] text-text-secondary">
                                    {c.phone ? displayPhone(c.phone) : "No phone"} ·{" "}
                                    {c.openJobs.length} open job
                                    {c.openJobs.length === 1 ? "" : "s"}
                                  </span>
                                </span>
                                <Phone className="h-3 w-3 flex-shrink-0 text-primary" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {jobs.length > 0 && (
                      <div>
                        <p className="bg-background-light px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-text-secondary">
                          Jobs
                        </p>
                        <ul className="divide-y divide-border">
                          {jobs.map((j) => (
                            <li key={j.id}>
                              <button
                                type="button"
                                onClick={() => pickJob(j)}
                                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-primary/10"
                              >
                                <span className="min-w-0">
                                  <span className="block truncate text-[13px] font-semibold text-text-primary">
                                    {j.number}
                                  </span>
                                  <span className="block truncate text-[11px] text-text-secondary">
                                    {j.customer?.name ?? j.location}
                                    {j.customer?.phone
                                      ? ` · ${displayPhone(j.customer.phone)}`
                                      : ""}
                                  </span>
                                </span>
                                <Hash className="h-3 w-3 flex-shrink-0 text-primary" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <Softphone
            surface={surface}
            callerIdOverride={callerIdOverride}
            callerIdNumberId={callerIdNumberId}
            prefillNumber={prefill}
            onConsumedPrefill={() => setPrefill(null)}
            entityContext={prefillContext}
            incomingNumber={incomingNumber}
            onConsumedIncoming={onConsumedIncoming}
          />

          <p className="text-center text-[11px] text-text-secondary md:hidden">
            Job search &amp; call history are available on desktop.
          </p>
        </div>

        {/* Right: customer panel / unknown-number affordance (desktop only) */}
        <div className="hidden md:block">
          {unknownNumber ? (
            <UnknownNumberPanel e164={unknownNumber} />
          ) : selected ? (
            <CustomerPanel
              selection={selected}
              calls={calls}
              onCall={(phone, ctx) => {
                setPrefill(phone);
                setPrefillContext(ctx ?? null);
                onToast(`☎️ ${displayPhone(phone)} ready — press Call`);
              }}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed border-border px-4 py-8 text-center">
              <Briefcase className="h-6 w-6 text-text-secondary" />
              <p className="mt-2 text-[13px] font-semibold text-text-primary">
                Search your customers &amp; jobs
              </p>
              <p className="mt-1 text-[11px] text-text-secondary">
                Type a job #, customer name, or phone number — pick a result to
                load their number, open jobs, and history.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Phone-shaped query with no tenant match — offer to save the number as a
 *  new customer or lead ( ?phone= prefills the create forms). */
function UnknownNumberPanel({ e164 }: { e164: string }) {
  const navigate = useNavigate();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  const phoneParam = encodeURIComponent(e164);
  return (
    <div className="flex h-full flex-col items-center justify-center rounded-md border border-dashed border-border px-4 py-8 text-center">
      <Phone className="h-6 w-6 text-text-secondary" />
      <p className="mt-2 text-[13px] font-semibold text-text-primary">
        No match for {fmtPhone(e164)}
      </p>
      <p className="mt-1 text-[11px] text-text-secondary">
        Save this number to reach them later.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => requestLeave(() => navigate(`/customers/new?phone=${phoneParam}`))}
          className="inline-flex items-center gap-1.5 rounded-md bg-success px-3 py-1.5 text-[12px] font-semibold text-on-fill transition hover:bg-success/90"
        >
          <UserPlus className="h-3.5 w-3.5" /> Create customer
        </button>
        <button
          type="button"
          onClick={() => requestLeave(() => navigate(`/leads/new?phone=${phoneParam}`))}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-light px-3 py-1.5 text-[12px] font-semibold text-text-primary transition hover:bg-background-light"
        >
          <Plus className="h-3.5 w-3.5" /> Create lead
        </button>
      </div>
    </div>
  );
}

/** One call-history row — its own component (not inlined in a .map) so the
 *  lazy transcript hook can be called per-row per Rules of Hooks. Fetches
 *  on demand once expanded (t4): the stored transcriptPreview no longer
 *  gates the affordance at all — CTM transcribes asynchronously, so a call
 *  with none yet can still resolve one from the backend. */
function CallHistoryRow({
  call,
  open,
  onToggle,
  tz,
}: {
  call: CallSession;
  open: boolean;
  onToggle: () => void;
  /** Org zone, passed down rather than re-subscribed per row - this list can be
   *  long, and one query subscription per row is a real render cost. */
  tz: string;
}) {
  const transcriptQuery = useCallTranscript(call.id, open);
  const transcript = call.transcriptPreview ?? transcriptQuery.data?.transcript ?? null;
  return (
    <li className="rounded-md border border-border bg-surface-light p-2">
      <div className="flex items-center gap-1.5">
        <DirIcon call={call} />
        <span className="text-[11px] font-semibold text-text-primary">
          {dayLabel(call.startedAt, tz)} · {shortTime(call.startedAt, tz)}
        </span>
        {call.disposition && (
          <span className="ml-auto rounded-full bg-background-light px-1.5 py-0.5 text-[9px] font-medium text-text-secondary">
            {DISPOSITION_LABELS[call.disposition]}
          </span>
        )}
      </div>
      {call.summary && (
        <p className="mt-1 text-[11px] leading-snug text-text-secondary">{call.summary}</p>
      )}
      <button
        type="button"
        onClick={onToggle}
        className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-primary hover:text-primary/90"
      >
        <FileText className="h-3 w-3" />
        {open ? "Hide transcript" : "View transcript"}
        <ChevronDown className={`h-3 w-3 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-1 rounded-md bg-background-light p-2">
          {call.hasRecording && (
            <p className="mb-1 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-text-secondary">
              <Mic className="h-2.5 w-2.5" /> Recorded call · transcript
            </p>
          )}
          {transcript ? (
            <p className="text-[11px] italic leading-snug text-text-secondary">“{transcript}”</p>
          ) : transcriptQuery.isLoading ? (
            <p className="text-[11px] text-text-secondary">Loading transcript…</p>
          ) : (
            <p className="text-[11px] text-text-secondary">No transcript available for this call.</p>
          )}
        </div>
      )}
    </li>
  );
}

/** The picked customer/job — customer header + Call/Text actions, REAL
 *  open-job chips deep-linking to /jobs/:id, POs for the picked job (#536
 *  behavior preserved), and recent call history. */
export function CustomerPanel({
  selection,
  calls,
  onCall,
}: {
  selection: DialerSelection;
  calls: CallSession[];
  /** ctx carries { customerId, customerName } when the selection is a real
   *  customer row — hub calls attribute the customer explicitly (E2). */
  onCall: (phone: string, ctx?: DialerEntityContext) => void;
}) {
  const tz = useScheduleTimezone();
  const { customer, jobs, focusedJobId } = selection;
  const navigate = useNavigate();
  const requestLeave = useSettingsGuard((s) => s.requestLeave);
  const { data: purchaseOrders = [] } = usePurchaseOrders();
  const [openPO, setOpenPO] = useState<string | null>(null);
  const [openCall, setOpenCall] = useState<string | null>(null);

  const focusedJob = focusedJobId ? jobs.find((j) => j.id === focusedJobId) : undefined;
  // The PO section stays keyed off the picked JOB (dialer-po-link #357/#536).
  const pos = focusedJob
    ? purchaseOrders.filter((p) => p.jobNumber === focusedJob.number)
    : [];
  const history = calls
    .filter(
      (c) =>
        c.customerId === customer.id ||
        (focusedJob && c.jobLabel === focusedJob.number),
    )
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, 6);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto rounded-md border border-border bg-background-light/60 p-3">
      {/* Customer header + actions */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{customer.name}</p>
          {customer.site && (
            <p className="truncate text-[11px] text-text-secondary">{customer.site}</p>
          )}
          <p className="text-[11px] text-text-secondary">
            {customer.phone ? displayPhone(customer.phone) : "No phone on file"}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <button
            type="button"
            aria-label="Call customer"
            onClick={() =>
              customer.phone &&
              onCall(
                customer.phone,
                customer.id
                  ? {
                      customerId: customer.id,
                      customerName: customer.name,
                      // A job-picked panel keeps that job on the call (o4g).
                      ...(focusedJob
                        ? { jobId: focusedJob.id, jobLabel: focusedJob.number }
                        : {}),
                    }
                  : undefined,
              )
            }
            disabled={!customer.phone}
            className="inline-flex items-center gap-1 rounded-md bg-success px-2.5 py-1.5 text-[12px] font-semibold text-on-fill transition hover:bg-success/90 disabled:cursor-not-allowed disabled:bg-border disabled:text-text-secondary"
          >
            <Phone className="h-3.5 w-3.5" /> Call
          </button>
          <button
            type="button"
            aria-label="Text customer"
            onClick={() =>
              requestLeave(() => navigate(`/communication/text?customerId=${customer.id}`))
            }
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-[12px] font-semibold text-text-primary transition hover:bg-background-light"
          >
            <MessageSquare className="h-3.5 w-3.5" /> Text
          </button>
        </div>
      </div>

      {/* Open jobs — REAL rows; each chip deep-links to the job page. */}
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          Open jobs
        </p>
        {jobs.length === 0 ? (
          <p className="text-[11px] text-text-secondary">No open jobs.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {jobs.map((j) => {
              const focused = j.id === focusedJobId;
              return (
                <li key={j.id}>
                  <button
                    type="button"
                    title={j.location}
                    onClick={() => requestLeave(() => navigate(`/jobs/${j.id}`))}
                    className={[
                      "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold transition",
                      focused
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-surface-light text-text-primary hover:border-primary/40 hover:text-primary",
                    ].join(" ")}
                  >
                    <Hash className="h-3 w-3" />
                    {j.number}
                    <span className="font-medium capitalize text-text-secondary">
                      {statusLabel(j.status)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {focusedJob?.location && (
          <p className="mt-1.5 text-[11px] text-text-secondary">{focusedJob.location}</p>
        )}
      </div>

      {/* Linked POs — press to see line items */}
      {pos.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            Purchase orders
          </p>
          <ul className="space-y-1">
            {pos.map((p) => {
              const open = openPO === p.id;
              return (
                <li key={p.id} className="overflow-hidden rounded-md border border-border bg-surface-light">
                  <div className="flex w-full items-center gap-2 px-2 py-1.5 text-[11px]">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        requestLeave(() =>
                          navigate(
                            `/inventory/purchase-orders?q=${encodeURIComponent(p.poNumber)}&status=${encodeURIComponent(p.status)}`,
                          ),
                        );
                      }}
                      className="font-semibold text-text-primary hover:underline hover:text-primary"
                    >
                      {p.poNumber}
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpenPO(open ? null : p.id)}
                      className="flex flex-1 items-center gap-2 hover:bg-background-light rounded-md -mx-1 px-1"
                    >
                      <span className="truncate text-text-secondary">{p.vendor}</span>
                      <span className="ml-auto rounded-full bg-background-light px-1.5 py-0.5 font-medium capitalize text-text-secondary">
                        {p.status}
                      </span>
                      <ChevronDown
                        className={`h-3.5 w-3.5 flex-shrink-0 text-text-secondary transition ${open ? "rotate-180" : ""}`}
                      />
                    </button>
                  </div>
                  {open && (
                    <div className="border-t border-border px-2 py-1.5">
                      {p.expectedDate && (
                        <p className="mb-1 text-[10px] text-text-secondary">
                          Expected {dayLabel(p.expectedDate, tz)}
                        </p>
                      )}
                      <ul className="space-y-0.5">
                        {p.lines.map((ln) => (
                          <li
                            key={ln.itemSku}
                            className="flex items-center justify-between gap-2 text-[11px]"
                          >
                            <span className="truncate text-text-primary">{ln.itemName}</span>
                            <span className="flex-shrink-0 font-mono text-text-secondary">
                              {ln.qtyReceived}/{ln.qtyOrdered} {ln.uom}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Call history — press to read the transcript before calling */}
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
          Recent activity
        </p>
        {history.length === 0 ? (
          <p className="text-[11px] text-text-secondary">No call history yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {history.map((c) => (
              <CallHistoryRow
                key={c.id}
                call={c}
                tz={tz}
                open={openCall === c.id}
                onToggle={() => setOpenCall(openCall === c.id ? null : c.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────── Active-call popup ─────────────────────────
 * Composes ui/modal: a softphone in call-now mode plus a Conference
 * escalation shortcut. */

export function ActiveCallPopup({
  number,
  customerName,
  onClose,
  onConference,
}: {
  number: string;
  customerName: string;
  onClose: () => void;
  onConference: () => void;
}) {
  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-1.5 truncate">
          <Phone className="h-4 w-4" /> {customerName}
        </span>
      }
      size="sm"
    >
      <Softphone
        autoCallNumber={number}
        onConference={onConference}
        onEnded={onClose}
      />
    </Modal>
  );
}

/** Docked SMS conversation panel (bottom-right) with the customer, with a
 *  Conference shortcut to escalate to a call (§14.16). Sends are REAL — the
 *  same POST /api/communication/sms the SMS inbox uses: the bubble commits on
 *  the 201 (delivery:'failed' renders the failed bubble, no success toast) and
 *  a 409 from the compliance gate surfaces inline (danger tokens). Calls with
 *  no matched customer get a disabled composer — there is no thread to target. */
function MessagePanel({
  customer,
  number,
  onClose,
  onConference,
  onToast,
}: {
  customer?: PhoneCustomer;
  number: string;
  onClose: () => void;
  onConference: () => void;
  onToast: (m: string) => void;
}) {
  const tz = useScheduleTimezone();
  const { data: threads = [] } = useMessageThreads();
  const sendSms = useSendSms();
  const seed = customer
    ? threads.find((t) => t.customerId === customer.id)
    : undefined;
  const [msgs, setMsgs] = useState<Message[]>(seed?.messages ?? []);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const noCustomer = !customer;

  function send() {
    const body = draft.trim();
    if (!body || !customer || sendSms.isPending) return;
    setSendError(null);
    sendSms.mutate(
      { customerId: customer.id, body },
      {
        onSuccess: (data) => {
          // Echo the status the server settled on - never assume "sent".
          setMsgs((prev) => [
            ...prev,
            {
              id: data?.message?.id ?? `m_${Date.now()}`,
              direction: "out",
              body,
              ts: data?.message?.ts ?? new Date().toISOString(),
              status: data?.message?.status ?? "queued",
              ...(data?.message?.statusReason
                ? { statusReason: data.message.statusReason }
                : {}),
            },
          ]);
          setDraft("");
          // Only a real send gets a "sent" toast - a suppressed one would be
          // the same false success the row no longer claims.
          if (data?.delivery === "sent") onToast(`✉️ Text sent to ${customer.name}`);
        },
        onError: (err) => setSendError(smsSendErrorMessage(err)),
      },
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-[72] flex h-[26rem] w-80 flex-col overflow-hidden rounded-xl border border-border bg-surface-light shadow-2xl">
      <div className="flex items-center justify-between border-b border-border bg-background-light px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">
            {customer?.name ?? fmtPhone(number)}
          </p>
          <p className="text-[11px] text-text-secondary">{fmtPhone(number)} · SMS</p>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onConference}
            title="Conference call — add the office"
            className="rounded-md p-1.5 text-primary transition hover:bg-primary/10"
          >
            <Users className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close conversation"
            className="rounded-md p-1.5 text-text-secondary transition hover:bg-background-light"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto bg-background-light px-3 py-2.5">
        {msgs.length === 0 ? (
          <p className="mt-8 text-center text-[12px] text-text-secondary">
            No messages yet — start the conversation.
          </p>
        ) : (
          msgs.map((m) => (
            <div
              key={m.id}
              className={[
                "flex",
                m.direction === "out" ? "justify-end" : "justify-start",
              ].join(" ")}
            >
              <div
                className={[
                  "max-w-[80%] rounded-2xl px-3 py-1.5 text-[13px]",
                  m.direction === "out"
                    ? `rounded-br-sm ${outboundBubbleClass(deliveryNote(m).tone)}`
                    : "rounded-bl-sm border border-border bg-surface-light text-text-primary",
                ].join(" ")}
              >
                {m.body}
                {deliveryNote(m).label && (
                  <span
                    title={deliveryNote(m).title}
                    className="mt-0.5 block text-[9px] font-semibold"
                  >
                    {deliveryNote(m).label}
                  </span>
                )}
                <span
                  className={[
                    "mt-0.5 block text-[9px]",
                    m.direction === "out"
                      ? deliveryNote(m).tone === "danger"
                        ? "text-danger/70"
                        : deliveryNote(m).tone === "muted"
                          ? "text-text-secondary"
                          : "text-on-fill/70"
                      : "text-text-secondary",
                  ].join(" ")}
                >
                  {shortTime(m.ts, tz)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* No matched customer → nothing to thread the text onto; the composer
          is disabled with a muted explanation instead of a fake send. */}
      {noCustomer && (
        <p className="border-t border-border bg-background-light px-3 py-1.5 text-[11px] text-text-secondary">
          No customer matched — open Text to start a conversation
        </p>
      )}
      {sendError && (
        <p
          role="status"
          className="border-t border-danger/20 bg-danger/10 px-3 py-1.5 text-[11px] font-medium text-danger"
        >
          {sendError}
        </p>
      )}
      <div className="flex items-center gap-2 border-t border-border bg-surface-light px-2 py-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type an SMS…"
          disabled={noCustomer}
          className="flex-1 rounded-md border border-border px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle disabled:cursor-not-allowed disabled:bg-background-light disabled:text-text-secondary"
        />
        <button
          type="button"
          onClick={send}
          disabled={noCustomer || !draft.trim() || sendSms.isPending}
          aria-label="Send"
          className="rounded-md bg-primary p-2 text-on-fill transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-border disabled:text-text-secondary"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

const TECH_ROLE_LABEL: Record<Tech["role"], string> = {
  field_tech: "Field technician",
  warehouse_lead: "Warehouse lead",
  counter: "Counter",
  subcontractor: "Subcontractor",
};

/** Conference picker — choose office staff / field techs to add to the call, or
 *  dial an individual number (§14.16). */
function ConferencePicker({
  onClose,
  onToast,
}: {
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const { data: phoneAgents = [] } = usePhoneAgents();
  const { data: techs = [] } = useTechs();
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [num, setNum] = useState("");

  const groups: {
    title: string;
    kind: "office" | "tech";
    people: { id: string; name: string; role: string }[];
  }[] = [
    {
      title: "Office staff",
      kind: "office",
      people: phoneAgents
        .filter((a) => a.kind === "human")
        .map((a) => ({ id: a.id, name: a.name, role: a.role })),
    },
    {
      title: "Field technicians",
      kind: "tech",
      people: techs.map((t) => ({
        id: t.id,
        name: t.name,
        role: TECH_ROLE_LABEL[t.role],
      })),
    },
  ];

  function add(id: string, name: string) {
    setAdded((prev) => new Set(prev).add(id));
    onToast(`➕ ${name} added to the call`);
  }
  function dialIndividual() {
    const n = num.trim();
    if (!n) return;
    const e164 = n.startsWith("+") ? n : `+1${n.replace(/\D/g, "")}`;
    onToast(`📞 Adding ${fmtPhone(e164)} to the call…`);
    setNum("");
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-1.5">
          <Users className="h-4 w-4 text-primary" /> Conference — add to call
        </span>
      }
      size="sm"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[12px] text-text-secondary">
            {added.size > 0 ? `${added.size} on the call` : "No one added yet"}
          </span>
          <Button onClick={onClose}>Done</Button>
        </div>
      }
    >
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.title}>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                {g.title}
              </p>
              <ul className="space-y-1">
                {g.people.map((p) => {
                  const on = added.has(p.id);
                  return (
                    <li
                      key={p.id}
                      className="flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2"
                    >
                      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-background-light text-text-secondary">
                        {g.kind === "tech" ? (
                          <Wrench className="h-4 w-4" />
                        ) : (
                          <User className="h-4 w-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-text-primary">
                          {p.name}
                        </span>
                        <span className="block truncate text-[11px] text-text-secondary">
                          {p.role}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => add(p.id, p.name)}
                        disabled={on}
                        className={[
                          "inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition",
                          on
                            ? "cursor-default bg-success/10 text-success"
                            : "bg-primary text-on-fill hover:bg-primary/90",
                        ].join(" ")}
                      >
                        {on ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5" /> Added
                          </>
                        ) : (
                          <>
                            <Plus className="h-3.5 w-3.5" /> Add
                          </>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          <div className="border-t border-border pt-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Or call an individual number
            </p>
            <div className="flex items-center gap-2">
              <input
                value={num}
                onChange={(e) => setNum(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && dialIndividual()}
                placeholder="Enter a number"
                inputMode="tel"
                className="flex-1 rounded-md border border-border px-2.5 py-2 font-mono text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
              />
              <button
                type="button"
                onClick={dialIndividual}
                disabled={!num.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-success px-3 py-2 text-[13px] font-semibold text-on-fill transition hover:bg-success disabled:bg-border disabled:text-text-secondary"
              >
                <Phone className="h-4 w-4" /> Call
              </button>
            </div>
          </div>
        </div>
    </Modal>
  );
}

export { ConferencePicker, MessagePanel };
