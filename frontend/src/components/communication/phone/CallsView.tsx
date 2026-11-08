// Phone module — Calls view.
//
// Ported from Emanuel's PhonePage monolith (regions L1807-3028 + L3376-3540).
// The Calls filter/sort/stat machinery, the CallsView table, its CallDetailDrawer,
// and the Calls-local presentational helpers (RoundAction / QuickAction /
// InsightCell / RecordingPlayer) all live here. Cross-cutting helpers and the
// date-range picker come from the shared kernel; all domain data, label maps and
// value helpers come from the `@/lib/api/communication` seam.
//
// Faithful cut: behavior + prop signatures preserved verbatim. Two mechanical
// adaptations only:
//   1. Tailwind tokens swapped indigo/slate -> ALPHA design tokens. emerald,
//      amber, rose, sky, violet kept verbatim (status colors).
//   2. Data-dependent lookups (customerById / agentName / agentById) take their
//      data array as a leading argument — ALPHA feeds data from seam hooks, not
//      from module-scope imports.
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Briefcase,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Clock,
  Download,
  FileText,
  Filter,
  Loader2,
  Mic,
  MessageSquare,
  Pause,
  Phone,
  PhoneCall,
  PhoneMissed,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Sparkles,
  Users,
  UserPlus,
  X,
} from "lucide-react";

import { SelectField } from "@/components/form/SelectField";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Collapse } from "@/components/ui/collapse";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ResizableTable } from "@/components/data/ResizableTable";
import { EmptyState } from '@/components/ui/empty-state';
import { KpiTile } from "@/components/data/KpiStrip";

import { JobBadge } from "@/components/communication/shared/atoms";
import { CommJobMenu, type AttachPick } from "@/components/communication/shared/CommJobMenu";
import { useAttachTargets } from "@/components/communication/shared/useAttachTargets";
import { CallTranscriptBubbles } from "@/components/communication/phone/CallTranscript";

import {
  usePhoneCustomers,
  usePhoneAgents,
  useRecordingUrl,
  useCallTranscript,
  DISPOSITION_LABELS,
  fmtPhone,
} from "@/lib/api/communication";
import type {
  CallSession,
  PhoneAgent,
} from "@/lib/api/communication";
import type { DialerEntityContext } from "@/stores/dialer.store";
import { useReassignCallJob, useReassignCallLead } from "@/lib/api/callJob";

import {
  customerById,
  dateNumeric,
  timeLabel,
  dayLabel,
  shortTime,
  DirIcon,
  AnsweredBy,
  InfoRow,
} from "@/components/communication/phone/shared";
import type {
  DateRange,
  CallsFocus,
} from "@/components/communication/phone/shared";
import { toCSVRows, downloadCSV } from "@/lib/csv";

/** Rows-per-page choices. Module scope so the array identity is stable. */
const PAGE_SIZE_OPTIONS = [10, 25, 50].map((n) => ({ value: String(n), label: String(n) }));

// The Calls list pipeline + its filter/sort/stat helpers moved into a co-located,
// unit-tested hook. Re-exported here so sibling components (CallsTable) keep
// importing agentName/callSortValue/NUMERIC_SORT_KEYS/SortKey/SortState from CallsView.
import {
  useCallsPipeline,
  agentName,
  agentMatchesId,
  userLabel,
  NUMERIC_SORT_KEYS,
  EMPTY_FILTERS,
  type StatKey,
  type FacetKey,
  type CallFilters,
  type SortKey,
  type SortState,
} from "@/components/communication/phone/useCallsPipeline";
export {
  agentName,
  callSortValue,
  NUMERIC_SORT_KEYS,
  type SortKey,
  type SortState,
} from "@/components/communication/phone/useCallsPipeline";

// Dialer surfaces spawned from the call-detail drawer (text / conference).
// These belong to the Dialer module; the drawer only opens them. Call-back
// routes to the /phone tab via requestCall — never an in-page dialer popup.
import {
  MessagePanel,
  ConferencePicker,
} from "@/components/communication/phone/Dialer";
import { requestCall } from "@/lib/communication/phoneTabHandoff";
import { useIsDemoOrg } from "@/lib/useIsDemoOrg";
import { useScheduleTimezone } from '@/lib/schedule-tz';

/* ─────────────────── Calls-local helpers ─────────────────── */

function agentById(agents: PhoneAgent[], id?: string): PhoneAgent | undefined {
  // Matches on the agent row id OR its linked user id - see agentMatchesId.
  return id ? agents.find((a) => agentMatchesId(a, id)) : undefined;
}

function answeredByLabel(kind: CallSession["answeredBy"]["kind"]): string {
  switch (kind) {
    case "csr":
      return "CSR";
    case "ai":
      return "AI agent";
    case "voicemail":
      return "Voicemail";
    case "external":
      return "Forwarded phone";
    default:
      return "No answer";
  }
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export function durationLabel(sec?: number): string {
  if (!sec) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m} Min ${s} Sec` : `${s} Sec`;
}

/**
 * The entity context a call-back hands off to the /phone tab. A call can carry a
 * job AND a lead at once — attaching either end stamps the pair — and
 * DialerEntityContext holds both, so this forwards whichever are present rather
 * than choosing. Previously keyed off a `jobKind` field the API never emitted,
 * which meant a lead-anchored call handed off its lead id under `jobId`.
 */
function dialContext(c: CallSession, fallbackName: string): DialerEntityContext | null {
  if (!c.customerId) return null;
  return {
    customerId: c.customerId,
    customerName: fallbackName,
    ...(c.jobId && c.jobLabel ? { jobId: c.jobId, jobLabel: c.jobLabel } : {}),
    ...(c.linkedLead ? { leadId: c.linkedLead.id, leadLabel: c.linkedLead.leadNumber } : {}),
  };
}

/* ─────────────────── Focus banner labels ─────────────────── */

const FOCUS_LABELS: Record<Exclude<CallsFocus, "all">, string> = {
  callback: "Missed Calls",
  attention: "Needs Attention",
};

// StatKey + STAT_PREDICATES moved to ./useCallsPipeline (imported above).
const STAT_LABELS: Record<StatKey, string> = {
  calls: "All calls",
  repeat: "Repeat callers",
  missed: "Missed calls",
  active: "Active calls",
  newCust: "New customer calls",
  existingCust: "Existing customer calls",
  avg: "Answered calls",
  revenue: "Revenue-generating calls",
};

/* ── Faceted call filter (Workiz-style "Filter results") ── */

// FacetKey / CallFilters / EMPTY_FILTERS / statusGroup / userLabel / durationMatch /
// callMatchesFilters moved to ./useCallsPipeline (imported above).

function activeFilterCount(f: CallFilters): number {
  return Object.values(f).reduce((s, arr) => s + arr.length, 0);
}

const STATIC_FACETS: { key: FacetKey; title: string; options: { v: string; l: string }[] }[] = [
  {
    key: "direction",
    title: "Direction",
    options: [
      { v: "outbound", l: "Outgoing calls" },
      { v: "inbound", l: "Incoming calls" },
    ],
  },
  {
    key: "status",
    title: "Status",
    options: [
      { v: "answered", l: "Answered" },
      { v: "missed", l: "Missed" },
      { v: "active", l: "Active" },
      { v: "voicemail", l: "Voicemail" },
    ],
  },
  {
    key: "duration",
    title: "Duration",
    options: [
      { v: "u30", l: "Under 30 sec" },
      { v: "u1", l: "Under 1 min" },
      { v: "o1", l: "Over 1 min" },
      { v: "u3", l: "Under 3 min" },
      { v: "o3", l: "Over 3 min" },
      { v: "o5", l: "Over 5 min" },
    ],
  },
  {
    key: "customer",
    title: "Customer",
    options: [
      { v: "new", l: "New customers" },
      { v: "existing", l: "Existing customers" },
    ],
  },
  {
    key: "job",
    title: "Job",
    options: [
      { v: "linked", l: "Linked to a job" },
      { v: "none", l: "No job linked" },
    ],
  },
];

function CallFilterBar({
  agents,
  calls,
  filters,
  onChange,
}: {
  agents: PhoneAgent[];
  calls: CallSession[];
  filters: CallFilters;
  onChange: (f: CallFilters) => void;
}) {
  const [open, setOpen] = useState(false);

  // Dynamic option lists derived from the data.
  const dynamic = useMemo(() => {
    const uniq = (xs: (string | undefined)[]) =>
      [...new Set(xs.filter(Boolean) as string[])];
    return {
      source: uniq(calls.map((c) => c.trackingSource)),
      user: uniq(calls.map((c) => userLabel(agents, c))),
      tags: uniq(calls.flatMap((c) => c.tags ?? [])),
    };
  }, [calls, agents]);

  const columns: { key: FacetKey; title: string; options: { v: string; l: string }[] }[] = [
    STATIC_FACETS[0]!, // direction
    { key: "source", title: "Source", options: dynamic.source.map((v) => ({ v, l: v })) },
    STATIC_FACETS[1]!, // status
    STATIC_FACETS[2]!, // duration
    { key: "user", title: "User", options: dynamic.user.map((v) => ({ v, l: v })) },
    STATIC_FACETS[3]!, // customer
    STATIC_FACETS[4]!, // job
    { key: "tags", title: "Tags", options: dynamic.tags.map((v) => ({ v, l: v })) },
  ];

  const labelFor = (key: FacetKey, v: string) =>
    columns.find((c) => c.key === key)?.options.find((o) => o.v === v)?.l ?? v;

  function toggle(key: FacetKey, v: string) {
    const cur = filters[key];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    onChange({ ...filters, [key]: next });
  }

  const count = activeFilterCount(filters);
  const chips: { key: FacetKey; v: string }[] = (Object.keys(filters) as FacetKey[]).flatMap(
    (k) => filters[k].map((v) => ({ key: k, v })),
  );

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-light px-3 py-2 text-left text-sm text-text-secondary hover:border-primary"
          >
            <span className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-text-secondary" />
              {count > 0 ? (
                <span className="font-medium text-text-primary">
                  {count} filter{count > 1 ? "s" : ""} applied
                </span>
              ) : (
                "Filter results"
              )}
            </span>
            <ChevronDown
              className={`h-4 w-4 text-text-secondary transition ${open ? "rotate-180" : ""}`}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[var(--radix-popover-trigger-width)] max-h-[60vh] max-w-none overflow-y-auto border p-4"
        >
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-3 lg:grid-cols-5">
            {columns.map((col) => (
              <div key={col.key}>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  {col.title}
                </p>
                {col.options.length === 0 ? (
                  <p className="text-[12px] text-text-secondary">—</p>
                ) : (
                  <ul className="space-y-0.5">
                    {col.options.map((o) => {
                      const on = filters[col.key].includes(o.v);
                      return (
                        <li key={o.v}>
                          <button
                            type="button"
                            onClick={() => toggle(col.key, o.v)}
                            className={[
                              "w-full truncate rounded px-2 py-1 text-left text-[13px] transition",
                              on
                                ? "bg-primary/10 font-medium text-primary"
                                : "text-text-primary hover:bg-background-light",
                            ].join(" ")}
                            title={o.l}
                          >
                            {o.l}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Active filter chips */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map(({ key, v }) => (
            <span
              key={`${key}:${v}`}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2 pr-1 text-[11px] font-medium text-primary"
            >
              {labelFor(key, v)}
              <button
                type="button"
                onClick={() => toggle(key, v)}
                aria-label={`Remove ${labelFor(key, v)}`}
                className="rounded-full p-0.5 hover:bg-primary/20"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="ml-1 text-[11px] font-semibold text-text-secondary hover:text-text-primary"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────── Calls table sorting ─────────────────── */

// SortKey / SortState / NUMERIC_SORT_KEYS / callSortValue moved to
// ./useCallsPipeline (imported + re-exported above for CallsTable).

// NOTE: returns the button only — ResizableTable already renders the enclosing
// <th><span>…</span></th>, so wrapping our own <th> here nests <th> inside a
// <span> (invalid DOM). Exported so the Call Tracking report's CallsTable reuses
// the exact same sortable header.
export function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState | null;
  onSort: (k: SortKey) => void;
  align?: "left" | "right" | "center";
}) {
  const active = sort?.key === sortKey;
  const justifyCls =
    align === "right"
      ? "justify-end"
      : align === "center"
        ? "justify-center"
        : "justify-start";
  const Icon = !active ? ChevronsUpDown : sort!.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`group inline-flex w-full items-center gap-1 ${justifyCls} uppercase tracking-wide ${
        active ? "text-primary" : "hover:text-text-primary"
      }`}
    >
      {label}
      <Icon
        className={`h-3 w-3 ${active ? "opacity-100" : "opacity-30 group-hover:opacity-70"}`}
      />
    </button>
  );
}

/** The table's empty state.
 *
 *  Without a query this is a plain "nothing here" and stays exactly as it was.
 *  WITH a query it must not read as "that call does not exist": the Calls page
 *  opens on a 30-day window, so a six-week-old call is absent from the RESULT
 *  while being present in the SYSTEM, and the search box never said so. When
 *  the scope is bounded we name it and offer the one-click widening; when it is
 *  unbounded there is nothing to disclose, so we only echo the term. */
function CallsEmptyState({
  query,
  searchScope,
  onSearchAllTime,
}: {
  query: string;
  searchScope: string | null;
  onSearchAllTime?: () => void;
}) {
  if (!query) return <EmptyState title="No calls match your search." />;
  if (!searchScope) return <EmptyState title={`No calls match "${query}".`} />;
  return (
    <EmptyState
      title={`No calls match "${query}" in ${searchScope}.`}
      action={
        onSearchAllTime && (
          <button
            type="button"
            onClick={onSearchAllTime}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-light px-3 py-2 text-sm font-semibold text-text-primary hover:bg-background-light"
          >
            <Search className="h-4 w-4" /> Search all time
          </button>
        )
      }
    />
  );
}

export function CallsView({
  calls,
  range,
  searchScope = null,
  onSearchAllTime,
  focus,
  onClearFocus,
  onToast,
}: {
  calls: CallSession[];
  range: DateRange;
  /** Human name for the window `range` covers - `describeSearchScope()` in the
   *  phone kernel - or `null` when the range is unbounded. Only used to tell a
   *  fruitless search apart from a genuinely absent call; the page owns the
   *  preset, so the label arrives as a prop like `range` itself does. */
  searchScope?: string | null;
  /** Widen the page's date range to "All time", leaving the query alone.
   *  Always user-initiated: widening on its own would move the stat strip and
   *  the export under the user without being asked. */
  onSearchAllTime?: () => void;
  focus: CallsFocus;
  onClearFocus: () => void;
  onToast: (m: string) => void;
}) {
  const { data: customers = [] } = usePhoneCustomers();
  const { data: agents = [] } = usePhoneAgents();
  const tz = useScheduleTimezone();

  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(10);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [statKey, setStatKey] = useState<StatKey | null>(null);
  const [filters, setFilters] = useState<CallFilters>(EMPTY_FILTERS);
  const [selectedCall, setSelectedCall] = useState<CallSession | null>(null);
  const [sort, setSort] = useState<SortState | null>(null);

  // visible → ranged → focused → dated → repeatNumbers → statScoped → filtered → sorted.
  // Chain + filter/sort helpers moved verbatim into the tested useCallsPipeline hook.
  const { dated, repeatNumbers, filtered, sorted } = useCallsPipeline({
    calls,
    agents,
    customers,
    range,
    focus,
    filters,
    statKey,
    query,
    sort,
    dismissed,
  });

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: NUMERIC_SORT_KEYS.includes(key) ? "desc" : "asc" },
    );
  }

  const rows = sorted.slice(0, pageSize);

  // Stats — computed from the calls inside the selected date range.
  const stats = useMemo(() => {
    const missed = dated.filter(
      (c) => c.status === "missed" || c.status === "voicemail",
    ).length;
    const active = dated.filter(
      (c) => c.status === "active" || c.status === "ringing",
    ).length;
    const withDur = dated.filter((c) => c.durationSec);
    const avg = withDur.length
      ? Math.round(withDur.reduce((s, c) => s + (c.durationSec ?? 0), 0) / withDur.length)
      : 0;
    const revenue = dated.reduce((s, c) => s + (c.revenue ?? 0), 0);
    const existingCust = dated.filter((c) => c.customerId).length;
    const newCust = dated.length - existingCust;
    return {
      missed,
      total: dated.length,
      repeat: repeatNumbers.size,
      active,
      avg,
      revenue,
      newCust,
      existingCust,
    };
  }, [dated, repeatNumbers]);

  // Place a REAL call back to the call's external party (the counterpart
  // number) via the SAME /phone-tab handoff every entity surface uses. The old
  // in-page popup fell onto the click-to-call bridge, which originated the
  // call on the org's own tracking number and dropped the caller into that
  // number's call flow instead of a two-way call (o4f, live QA 2026-07-21).
  function callBack(c: CallSession) {
    const number = c.direction === "outbound" ? c.toNumber : c.fromNumber;
    const cust = customerById(customers, c.customerId);
    requestCall(number, dialContext(c, cust?.name ?? fmtPhone(number)));
  }

  function dismiss(id: string) {
    setDismissed((prev) => new Set(prev).add(id));
    onToast("✓ Call dismissed");
  }

  function exportCsv() {
    const headers = [
      "Date/Time",
      "Direction",
      "From",
      "To",
      "Status",
      "Duration (sec)",
      "Customer",
      "Job",
      "Answered By",
    ];
    const rows = filtered.map((c) => [
      c.startedAt,
      c.direction,
      c.fromNumber,
      c.toNumber,
      c.status,
      c.durationSec ?? "",
      customerById(customers, c.customerId)?.name ?? "",
      c.jobLabel ?? "",
      answeredByLabel(c.answeredBy.kind),
    ]);
    // Filename dated from the page range anchor (not Date.now) so it stays
    // deterministic; falls back to the current day only when "All time" is set.
    const anchor = range.end ?? new Date();
    const filename = `calls-${anchor.toISOString().slice(0, 10)}.csv`;
    downloadCSV(toCSVRows(headers, rows), filename);
    onToast(`⬇️ Exported ${filtered.length} calls to CSV`);
  }

  return (
    <div className="space-y-4 p-4">
      {/* Focus banner — set when a KPI tile (Missed Calls / Needs Attention) was
          clicked, so the stats + table are scoped to that subset. */}
      {focus !== "all" && (
        <div className="flex items-center justify-between rounded-card border border-primary/30 bg-primary/10 px-3 py-2">
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-primary">
            {focus === "callback" ? (
              <PhoneMissed className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
            Showing {FOCUS_LABELS[focus]} · {stats.total}
          </span>
          <button
            type="button"
            onClick={onClearFocus}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-semibold text-primary hover:bg-primary/20"
          >
            <X className="h-3.5 w-3.5" /> Clear filter
          </button>
        </div>
      )}

      {/* Faceted filter — narrow the whole page by direction, source, status,
          duration, who handled it, customer type, job linkage, tags, etc. */}
      <CallFilterBar agents={agents} calls={calls} filters={filters} onChange={setFilters} />

      {/* Stat strip — each card is a toggle that scopes the table below.
          The date-range picker lives in the page header (top-right). */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <KpiTile
          icon={PhoneMissed}
          value={String(stats.missed)}
          label="Missed calls"
          active={statKey === "missed"}
          onClick={() => setStatKey((k) => (k === "missed" ? null : "missed"))}
        />
        <KpiTile
          icon={Phone}
          value={String(stats.total)}
          label="Calls"
          active={statKey === "calls"}
          onClick={() => setStatKey((k) => (k === "calls" ? null : "calls"))}
        />
        <KpiTile
          icon={UserPlus}
          value={String(stats.newCust)}
          label="New customers"
          active={statKey === "newCust"}
          onClick={() => setStatKey((k) => (k === "newCust" ? null : "newCust"))}
        />
        <KpiTile
          icon={Users}
          value={String(stats.existingCust)}
          label="Existing customers"
          active={statKey === "existingCust"}
          onClick={() =>
            setStatKey((k) => (k === "existingCust" ? null : "existingCust"))
          }
        />
        <KpiTile
          icon={RotateCcw}
          value={String(stats.repeat)}
          label="Repeat callers"
          active={statKey === "repeat"}
          onClick={() => setStatKey((k) => (k === "repeat" ? null : "repeat"))}
        />
        <KpiTile
          icon={PhoneCall}
          value={String(stats.active)}
          label="Active Calls"
          active={statKey === "active"}
          onClick={() => setStatKey((k) => (k === "active" ? null : "active"))}
        />
        <KpiTile
          icon={Clock}
          value={durationLabel(stats.avg)}
          label="Avg call time"
          active={statKey === "avg"}
          onClick={() => setStatKey((k) => (k === "avg" ? null : "avg"))}
        />
      </div>

      {/* Active stat-card scope — shows which subset the table is filtered to. */}
      {statKey && (
        <div className="flex items-center gap-2 text-[12px] text-text-secondary">
          <span>
            Table scoped to <span className="font-semibold text-text-primary">{STAT_LABELS[statKey]}</span>
          </span>
          <button
            type="button"
            onClick={() => setStatKey(null)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 font-semibold text-text-secondary hover:bg-background-light"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search calls…"
            className="w-full rounded-md border border-border bg-surface-light py-2 pl-9 pr-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
          />
        </div>
        <div className="flex items-center gap-2">
          <SelectField
            value={String(pageSize)}
            onValueChange={(v) => setPageSize(Number(v))}
            aria-label="Rows per page"
            className="w-[76px]"
            options={PAGE_SIZE_OPTIONS}
          />
          <button
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-light px-3 py-2 text-sm font-semibold text-text-primary hover:bg-background-light"
          >
            <Download className="h-4 w-4" /> Export
          </button>
        </div>
      </div>

      {/* Calls table */}
      <ResizableTable
        rows={rows}
        getRowKey={(c) => c.id}
        onRowClick={(c) => setSelectedCall(c)}
        empty={<CallsEmptyState
          query={query.trim()}
          searchScope={searchScope}
          onSearchAllTime={onSearchAllTime}
        />}
        columns={[
          {
            id: "status",
            header: (
              <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
            ),
            width: 90,
            min: 72,
            cell: (c) => <DirIcon call={c} />,
          },
          {
            id: "from",
            header: <SortHeader label="From" sortKey="from" sort={sort} onSort={toggleSort} />,
            width: 160,
            min: 120,
            grow: 2,
            cell: (c) => {
              const cust = customerById(customers, c.customerId);
              return (
                <>
                  <p className="font-semibold text-text-primary">
                    {cust?.name ?? "Unknown"}
                  </p>
                  <p className="font-mono text-[11px] text-primary">
                    {fmtPhone(c.fromNumber)}
                  </p>
                </>
              );
            },
          },
          {
            id: "to",
            header: <SortHeader label="To" sortKey="to" sort={sort} onSort={toggleSort} />,
            width: 140,
            min: 110,
            cellClassName: "font-mono text-[11px] text-text-secondary",
            cell: (c) => fmtPhone(c.toNumber),
          },
          {
            id: "time",
            header: <SortHeader label="Time" sortKey="time" sort={sort} onSort={toggleSort} />,
            width: 150,
            min: 120,
            cell: (c) => (
              <>
                <p className="font-semibold text-text-primary">{dateNumeric(c.startedAt, tz)}</p>
                <p className="text-[11px] text-text-secondary">{timeLabel(c.startedAt, tz)}</p>
              </>
            ),
          },
          {
            id: "duration",
            header: "Duration",
            width: 110,
            min: 90,
            cellClassName: "text-text-secondary",
            cell: (c) => durationLabel(c.durationSec),
          },
          {
            id: "adSource",
            header: (
              <SortHeader label="Ad Source" sortKey="adSource" sort={sort} onSort={toggleSort} />
            ),
            width: 140,
            min: 110,
            cellClassName: "text-text-secondary",
            cell: (c) => c.trackingSource ?? "—",
          },
          {
            id: "tags",
            header: <SortHeader label="Tags" sortKey="tags" sort={sort} onSort={toggleSort} />,
            width: 180,
            min: 120,
            grow: 2,
            cell: (c) =>
              c.tags && c.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {c.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-medium text-text-secondary"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-text-secondary">—</span>
              ),
          },
          {
            id: "insights",
            header: (
              <SortHeader label="Insights" sortKey="insights" sort={sort} onSort={toggleSort} />
            ),
            width: 180,
            min: 120,
            grow: 2,
            cell: (c) => <InsightCell call={c} />,
          },
          {
            id: "answeredBy",
            header: (
              <SortHeader
                label="Answered By"
                sortKey="answeredBy"
                sort={sort}
                onSort={toggleSort}
              />
            ),
            width: 150,
            min: 120,
            cell: (c) => (
              <>
                <AnsweredBy call={c} />
                {(agentName(agents, c.answeredBy.id) ?? c.answeredBy.name) && (
                  <p className="text-[11px] text-text-secondary">
                    {agentName(agents, c.answeredBy.id) ?? c.answeredBy.name}
                  </p>
                )}
              </>
            ),
          },
          {
            id: "jobs",
            header: (
              <SortHeader
                label="Related"
                sortKey="jobs"
                sort={sort}
                onSort={toggleSort}
              />
            ),
            width: 140,
            min: 110,
            grow: 2,
            cell: (c) =>
              c.jobLabel ? (
                <span
                  className={[
                    "rounded-md px-1.5 py-0.5 text-[11px] font-semibold",
                    c.jobLabel === "Lead"
                      ? "bg-warning/10 text-warning"
                      : "bg-primary/10 text-primary",
                  ].join(" ")}
                >
                  {c.jobLabel}
                </span>
              ) : (
                <span className="text-text-secondary">—</span>
              ),
          },
          {
            id: "quickAction",
            header: "Quick Action",
            align: "center",
            width: 150,
            min: 120,
            grow: 0,
            cell: (c) => {
              const recoverable =
                c.status === "missed" || c.status === "voicemail";
              return (
                <div
                  className="flex items-center justify-center gap-4"
                  onClick={(e) => e.stopPropagation()}
                >
                  <QuickAction
                    icon={PhoneCall}
                    label="Call Back"
                    onClick={() => callBack(c)}
                  />
                  {recoverable && (
                    <QuickAction
                      icon={X}
                      label="Dismiss"
                      onClick={() => dismiss(c.id)}
                    />
                  )}
                </div>
              );
            },
          },
        ]}
      />
      <div className="flex items-center justify-between rounded-card border border-border bg-surface-light px-3 py-2 text-[11px] text-text-secondary">
        <span>
          Showing {rows.length} of {filtered.length} calls
        </span>
        <span>Live call log</span>
      </div>

      {selectedCall && (
        <CallDetailDrawer
          call={selectedCall}
          onClose={() => setSelectedCall(null)}
          onToast={onToast}
        />
      )}

    </div>
  );
}

/* ─────────────────── Call detail panel ─────────────────── */

const STATUS_LABELS: Record<CallSession["status"], string> = {
  ringing: "Ringing",
  active: "Active",
  completed: "Completed",
  voicemail: "Voicemail",
  missed: "Missed",
};

function scoreTone(score: number): string {
  if (score >= 90) return "bg-success/10 text-success ring-success/20";
  if (score >= 80) return "bg-warning/10 text-warning ring-warning/20";
  return "bg-danger/10 text-danger ring-danger/20";
}

const isUUID = (id: string) => /^[0-9a-f-]{36}$/.test(id);

export function CallDetailDrawer({
  call,
  onClose,
  onToast,
}: {
  call: CallSession;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const navigate = useNavigate();
  const { data: customers = [] } = usePhoneCustomers();
  const { data: agents = [] } = usePhoneAgents();

  const tz = useScheduleTimezone();
  const cust = customerById(customers, call.customerId);
  const agent = agentById(agents, call.answeredBy.id);
  const isDemo = useIsDemoOrg();
  // Lazy transcript + AI insight: fire whenever EITHER is still missing (the
  // backend fetches from CTM & persists on demand - it only needs ctm_call_id,
  // not a recording, so a call with no recording can still have a transcript).
  // CTM derives the summary from the transcript, so one can land without the
  // other; gating on the transcript alone would strand the insight forever.
  // Stored values win; a settled null → an honest "nothing here" state rather
  // than a perpetual "still generating" lie.
  const wantsTranscript = !call.transcriptPreview || !call.summary;
  const transcriptQuery = useCallTranscript(call.id, wantsTranscript);
  const transcript =
    call.transcriptPreview ?? transcriptQuery.data?.transcript ?? null;
  const summary = call.summary ?? transcriptQuery.data?.summary ?? null;
  // Structured, per-speaker turns (CTM's transcription.json outline[]) - the
  // flat `transcript` string above interleaves each channel fragment by
  // fragment and is unrecoverable once flattened, so the peek/reader render
  // turns when present and only fall back to the flat string for calls CTM
  // never diarized.
  const turns = transcriptQuery.data?.turns ?? null;
  const hasTurns = !!turns && turns.length > 0;
  const [readerOpen, setReaderOpen] = useState(false);
  const readerPlayerRef = useRef<RecordingPlayerHandle>(null);
  const otherNumber =
    call.direction === "outbound" ? call.toNumber : call.fromNumber;
  const title = call.direction === "outbound" ? "Outgoing Call" : "Incoming Call";
  const partyName = cust?.name ?? fmtPhone(otherNumber);

  const [textOpen, setTextOpen] = useState(false);
  const [confOpen, setConfOpen] = useState(false);
  // Call details (from/to/ad source/tags) collapse behind a disclosure - a
  // dash and "No tags" on effectively every real call, so it stays out of
  // the way of the summary/recording/transcript a user actually opens the
  // drawer to see.
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Job linkage — label only, never a derived/raw id (the spec kills the old
  // `job_…` → "J-…" fallback). Legacy rows that carry a jobId with no label
  // show nothing rather than lie; the backend aggregator resolves labels for
  // the job timeline. Local override = "act + cheap undo" after a reassign,
  // keyed by call id so switching rows falls back to the row's own data.
  const [jobOverride, setJobOverride] = useState<{
    forCallId: string;
    job: { id: string; kind: 'job' | 'lead'; label: string } | null;
  } | null>(null);
  // Prefer the job, fall back to the lead. A call carries BOTH once attached
  // (the server stamps the pair whichever end was picked), and the job is the
  // more specific of the two; a lead that has not become a job yet shows as the
  // lead. This used to read a `jobKind` field the API never emitted — only the
  // demo seed set it — so every real lead-anchored call rendered as a job.
  const linkedJob =
    jobOverride && jobOverride.forCallId === call.id
      ? jobOverride.job
      : call.jobLabel
        ? { id: call.jobId ?? "", kind: 'job' as const, label: call.jobLabel }
        : call.linkedLead
          ? { id: call.linkedLead.id, kind: 'lead' as const, label: call.linkedLead.leadNumber }
          : null;

  // Attach-to-job/lead (story 21, widened). Unknown callers used to get NO
  // control at all here, despite the API accepting the attach — that gap is what
  // useAttachTargets' search mode closes.
  const targets = useAttachTargets(call.customerId);
  const reassignCall = useReassignCallJob();
  const reassignCallLead = useReassignCallLead();

  function pickJob(target: AttachPick | null) {
    const prev = linkedJob;
    setJobOverride({
      forCallId: call.id,
      job: target ? { id: target.id, kind: target.kind, label: target.label } : null,
    });
    const onSuccess = () =>
      onToast(target ? `Attached to ${target.label}` : "Link removed");
    const onError = () => {
      setJobOverride({ forCallId: call.id, job: prev });
      onToast("Couldn't update the link — try again");
    };
    if (target?.kind === 'lead') {
      reassignCallLead.mutate({ callId: call.id, leadId: target.id }, { onSuccess, onError });
      return;
    }
    reassignCall.mutate(
      { callId: call.id, jobId: target?.id ?? null },
      { onSuccess, onError },
    );
  }

  return (
    <>
      <Sheet
        open
        onOpenChange={(o) => {
          if (!o) onClose();
        }}
      >
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          <SheetDescription className="sr-only">Call details for {partyName}</SheetDescription>
          {/* Title bar */}
          <div className="flex items-center border-b border-border px-5 py-3.5 pr-12">
            <SheetTitle className="text-base font-semibold">{title}</SheetTitle>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Contact + quick actions */}
          <div className="bg-background-light/70 px-5 py-4">
            <p className="text-lg font-semibold text-primary">
              {cust?.name ?? "Unknown caller"}
            </p>
            <p className="mt-0.5 text-sm text-text-primary">{fmtPhone(otherNumber)}</p>
            {/* Job/lead linkage — every call gets the attach / reassign menu.
                A known customer lists that customer's jobs and leads; an unknown
                caller searches the org instead (useAttachTargets). This used to
                be gated on call.customerId, which left exactly the calls that
                most need manual attribution with no control at all, even though
                the API has always accepted the attach. */}
            <div className="mt-1.5">
              <CommJobMenu
                jobs={targets.jobs}
                leads={targets.leads}
                onPick={pickJob}
                search={targets.search}
                onSearchChange={targets.setSearch}
                querying={targets.querying}
                needsMoreInput={targets.needsMoreInput}
                loading={targets.loading}
              >
                {linkedJob ? (
                  <button
                    type="button"
                    title={`Attached to ${linkedJob.label} — click to reassign`}
                    className="rounded-pill transition hover:opacity-80"
                  >
                    <JobBadge job={linkedJob.label} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] font-semibold text-primary transition hover:bg-primary/10"
                  >
                    <Briefcase className="h-3 w-3" /> Attach to job or lead
                  </button>
                )}
              </CommJobMenu>
            </div>
            <div className="mt-3 flex items-center justify-end gap-3">
              {/* Conference ("Add to call") is a demo-only affordance — hidden on
                  real orgs until multi-party calling is wired end-to-end. */}
              {isDemo && (
                <RoundAction
                  icon={Plus}
                  label="Add to call"
                  onClick={() => setConfOpen(true)}
                />
              )}
              <RoundAction
                icon={MessageSquare}
                label="Message"
                onClick={() => setTextOpen(true)}
              />
              <RoundAction
                icon={Phone}
                label="Call back"
                onClick={() => requestCall(otherNumber, dialContext(call, partyName))}
              />
            </div>
          </div>

          <div className="space-y-5 px-5 py-4">
            {/* Status row */}
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <DirIcon call={call} />
                {STATUS_LABELS[call.status]}
              </span>
              <span className="text-sm text-text-secondary">
                {dayLabel(call.startedAt, tz)}, {shortTime(call.startedAt, tz)}
              </span>
            </div>

            {/* Call insights - CTM's AI summary, then the recording */}
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                Call insights
                <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  <Sparkles className="h-3 w-3" /> AI
                </span>
              </p>
              {/* CTM writes the summary asynchronously alongside the transcript,
                  so the honest states are: text / still generating / none. */}
              {summary ? (
                <div className="mb-3 rounded-card bg-background-light p-3">
                  <p className="text-[13px] leading-relaxed text-text-primary">{summary}</p>
                </div>
              ) : transcriptQuery.isLoading ? (
                <p className="mb-3 flex items-center gap-1.5 text-[12px] text-text-secondary">
                  <Loader2 className="h-3 w-3 animate-spin" /> The AI insight is still being
                  generated…
                </p>
              ) : (
                <p className="mb-3 text-[12px] text-text-secondary">
                  No AI insight for this call.
                </p>
              )}
              {call.hasRecording ? (
                <RecordingPlayer call={call} onToast={onToast} />
              ) : (
                <div className="flex flex-col items-center justify-center rounded-card bg-background-light px-4 py-8 text-center text-text-secondary">
                  <Mic className="mb-2 h-7 w-7" />
                  <p className="text-sm font-medium text-text-secondary">No recording for this call</p>
                  <p className="text-[12px]">
                    {call.status === "missed"
                      ? "The call was missed before it connected."
                      : "This call was not recorded."}
                  </p>
                </div>
              )}
            </div>

            {/* Transcript — shown regardless of hasRecording: CTM transcribes
                asynchronously and the backend only needs ctm_call_id, not a
                recording, to hydrate one on demand. Turns (structured,
                per-speaker) render as a short bubble peek with a reader
                trigger; the flat string is the fallback for calls CTM never
                diarized into turns. */}
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                <FileText className="h-3 w-3" /> Transcript
              </p>
              {hasTurns ? (
                <CallTranscriptBubbles turns={turns!.slice(0, 3)} />
              ) : transcript ? (
                <div className="rounded-card bg-background-light p-3">
                  <p className="line-clamp-3 text-[13px] italic leading-relaxed text-text-primary">
                    “{transcript}”
                  </p>
                </div>
              ) : transcriptQuery.isLoading ? (
                <p className="flex items-center gap-1.5 text-[12px] text-text-secondary">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading transcript…
                </p>
              ) : (
                <p className="text-[12px] text-text-secondary">
                  No transcript available for this call.
                </p>
              )}
              {(hasTurns || transcript) && (
                <Button
                  type="button"
                  variant="link"
                  onClick={() => setReaderOpen(true)}
                  className="mt-2 h-auto p-0"
                >
                  <Text size="xs" weight="medium">
                    {hasTurns ? `Open transcript (${turns!.length} turns)` : "Open transcript"}
                  </Text>
                </Button>
              )}
              {call.reviewFlag && (
                <p className="mt-2 flex items-center gap-1.5 rounded-md bg-danger/10 px-2.5 py-1.5 text-[11px] font-medium text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" /> {call.reviewFlag}
                </p>
              )}
            </div>

            {/* Outcome — answered-by, call score, and the linked job merged
                into one block: three facets of "how did this call resolve." */}
            <div className="space-y-3 rounded-card border border-border p-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                    Answered by
                  </p>
                  <p className="mt-0.5 text-[13px] font-semibold text-text-primary">
                    {agent?.name ?? call.answeredBy.name ?? answeredByLabel(call.answeredBy.kind)}
                  </p>
                  {agent && <p className="text-[11px] text-text-secondary">{agent.role}</p>}
                  {agent && (
                    <div
                      className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${scoreTone(agent.scriptAdherencePct)}`}
                    >
                      Agent QA {agent.scriptAdherencePct}
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                    Call score
                  </p>
                  {typeof call.qaScore === "number" ? (
                    <>
                      <span
                        className={`mt-1 inline-flex items-center rounded-full px-2.5 py-0.5 text-lg font-bold ring-1 ${scoreTone(call.qaScore)}`}
                      >
                        {call.qaScore}
                      </span>
                      {call.sentiment && (
                        <p className="mt-1 text-[11px] capitalize text-text-secondary">
                          Sentiment: {call.sentiment}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="mt-0.5 text-[12px] text-text-secondary">Not scored</p>
                  )}
                  {call.disposition && (
                    <p className="text-[11px] text-text-secondary">
                      {DISPOSITION_LABELS[call.disposition]}
                    </p>
                  )}
                </div>
              </div>

              {/* Linked job — navigation row. Navigates to the job or lead
                  when the id is a real UUID; shows as inert text for
                  dev-mock ids. */}
              {linkedJob && (
                isUUID(linkedJob.id) ? (
                  <button
                    type="button"
                    onClick={() =>
                      linkedJob.kind === 'lead'
                        ? navigate(`/leads/${linkedJob.id}`)
                        : navigate(`/jobs/${linkedJob.id}`)
                    }
                    className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2.5 text-left hover:border-primary hover:bg-primary/10"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                      <Briefcase className="h-4 w-4 text-text-secondary" />
                      {linkedJob.kind === 'lead' ? 'Linked lead' : 'Linked job'}
                    </span>
                    <JobBadge job={linkedJob.label} />
                  </button>
                ) : (
                  <div className="flex w-full items-center justify-between rounded-card border border-border px-3 py-2.5">
                    <span className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                      <Briefcase className="h-4 w-4 text-text-secondary" />
                      {linkedJob.kind === 'lead' ? 'Linked lead' : 'Linked job'}
                    </span>
                    <JobBadge job={linkedJob.label} />
                  </div>
                )
              )}
            </div>

            {/* Call details — from/to/ad source/tags, collapsed: a dash and
                "No tags" on effectively every real call. */}
            <div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDetailsOpen((o) => !o)}
                className="h-auto w-full justify-between p-0"
              >
                <Text size="3xs" weight="semibold" tone="secondary" transform="uppercase" tracking="wide">
                  Call details
                </Text>
                <ChevronDown className={`h-3.5 w-3.5 transition ${detailsOpen ? "rotate-180" : ""}`} />
              </Button>
              <Collapse open={detailsOpen} className="mt-2">
                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <InfoRow label="From" value={fmtPhone(call.fromNumber)} />
                    <InfoRow label="To" value={fmtPhone(call.toNumber)} />
                    <InfoRow label="Ad source" value={call.trackingSource ?? "—"} />
                  </div>
                  <div>
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                      Tags ({call.tags?.length ?? 0})
                    </p>
                    {call.tags && call.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {call.tags.map((t) => (
                          <span
                            key={t}
                            className="rounded-full bg-background-light px-2 py-0.5 text-[11px] font-medium text-text-secondary"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-[12px] text-text-secondary">No tags</span>
                    )}
                  </div>
                </div>
              </Collapse>
            </div>
          </div>
          </div>
        </SheetContent>
      </Sheet>

      {textOpen && (
        <MessagePanel
          customer={cust}
          number={otherNumber}
          onClose={() => setTextOpen(false)}
          onConference={() => setConfOpen(true)}
          onToast={onToast}
        />
      )}
      {confOpen && (
        <ConferencePicker
          onClose={() => setConfOpen(false)}
          onToast={onToast}
        />
      )}

      {/* Reader — the full transcript over the dimmed drawer. Esc/overlay
          click returns to the call (Dialog's default behavior). Clicking a
          turn seeks this reader's own docked player, not the drawer's. */}
      <Dialog open={readerOpen} onOpenChange={setReaderOpen}>
        <DialogContent width="lg" className="max-h-[85vh] grid-rows-[auto_1fr_auto]">
          <DialogHeader divider>
            <DialogTitle>Transcript</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto py-2">
            {hasTurns ? (
              <CallTranscriptBubbles
                turns={turns!}
                onTurnClick={(turn) =>
                  turn.startSec != null && readerPlayerRef.current?.seek(turn.startSec)
                }
              />
            ) : (
              <p className="text-[13px] italic leading-relaxed text-text-primary">
                “{transcript}”
              </p>
            )}
          </div>
          {call.hasRecording && (
            <div className="border-t border-border pt-3">
              <RecordingPlayer ref={readerPlayerRef} call={call} onToast={onToast} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RoundAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-on-fill transition hover:bg-primary/90"
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

/* ─────────────────── Recording player ─────────────────── */

/* Real <audio> player over the private-bucket recording. The signed URL is
 * fetched LAZILY — nothing hits the network until the first Play click
 * (useRecordingUrl is enabled:false). A 404 means the recording is still
 * being ingested → quiet "Processing…" text, no toast. A media error mid-
 * playback (the 300s signed URL expired) silently refetches a fresh URL,
 * swaps src and restores position + play state. */
export interface RecordingPlayerHandle {
  /** Load the recording if needed, then seek + play from `sec` - the reader's
   *  "click a turn to hear it" affordance. */
  seek: (sec: number) => void;
}

const RecordingPlayer = forwardRef<RecordingPlayerHandle, {
  call: CallSession;
  onToast?: (m: string) => void;
}>(function RecordingPlayer({ call }, ref) {
  const speeds = [1, 1.5, 2];
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Restore point across a silent src swap (expired URL recovery).
  const resumeAtRef = useRef<number | null>(null);
  const resumePlayRef = useRef(false);
  // Guards expired-URL recovery against an UNPLAYABLE src (e.g. a CSP-blocked
  // source): a fresh URL that also errors before it ever loads must not refetch
  // again, or onError↔refetch loops and hammers the mint endpoint. Reset to 0
  // once a src successfully loads metadata (proving it is genuinely playable).
  const recoverAttemptsRef = useRef(0);

  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [duration, setDuration] = useState(call.durationSec ?? 0);
  const [speed, setSpeed] = useState(1);
  const [loaded, setLoaded] = useState(false); // a src is attached
  const [loadState, setLoadState] = useState<"idle" | "processing" | "error">("idle");
  const { refetch, isFetching } = useRecordingUrl(call.id);

  const pct = duration > 0 ? Math.min(100, (pos / duration) * 100) : 0;

  // playbackRate follows the speed chip (and survives src swaps via
  // handleLoadedMetadata below).
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  async function fetchUrl(): Promise<string | null> {
    const res = await refetch();
    if (res.data?.url) {
      setLoadState("idle");
      return res.data.url;
    }
    const status = (res.error as { response?: { status?: number } } | null)?.response?.status;
    setLoadState(status === 404 ? "processing" : "error");
    return null;
  }

  async function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      return;
    }
    if (!loaded) {
      const url = await fetchUrl();
      if (!url) return;
      audio.src = url;
      audio.playbackRate = speed;
      setLoaded(true);
    }
    void audio.play().catch(() => {
      /* recovered by the onError handler (expired/blocked src) */
    });
  }

  function seekTo(sec: number) {
    const audio = audioRef.current;
    if (!audio || !loaded) return;
    const clamped = Math.min(Math.max(0, sec), duration || 0);
    audio.currentTime = clamped;
    setPos(clamped);
  }

  useImperativeHandle(ref, () => ({
    async seek(sec: number) {
      const audio = audioRef.current;
      if (!audio) return;
      if (!loaded) {
        const url = await fetchUrl();
        if (!url) return;
        // Same restore-point plumbing the expired-URL recovery uses: stamp
        // the target position + autoplay intent, then let onLoadedMetadata
        // apply them once the src is actually playable.
        resumeAtRef.current = sec;
        resumePlayRef.current = true;
        audio.src = url;
        audio.playbackRate = speed;
        setLoaded(true);
        return;
      }
      seekTo(sec);
      void audio.play().catch(() => {});
    },
  }));

  function seekBy(delta: number) {
    seekTo((audioRef.current?.currentTime ?? pos) + delta);
  }

  // Expired-signed-URL recovery: silently refetch, swap src, restore position
  // and play state. No toast — the listener just hears a brief gap.
  async function handleAudioError() {
    const audio = audioRef.current;
    if (!audio || !loaded) return;
    // A second failure with no successful load in between means the fresh URL
    // isn't playable (blocked/corrupt), not merely expired — stop, don't loop.
    if (recoverAttemptsRef.current >= 1) {
      setPlaying(false);
      setLoadState("error");
      return;
    }
    recoverAttemptsRef.current += 1;
    resumeAtRef.current = audio.currentTime || pos;
    resumePlayRef.current = playing;
    setPlaying(false);
    const url = await fetchUrl();
    if (!url) return;
    audio.src = url; // seek + resume run in handleLoadedMetadata
    audio.playbackRate = speed;
    audio.load();
  }

  function handleLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) return;
    // A src that loads metadata is genuinely playable — clear the recovery
    // guard so a later genuine URL expiry can still silently recover once.
    recoverAttemptsRef.current = 0;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      setDuration(audio.duration);
    }
    if (resumeAtRef.current != null) {
      audio.currentTime = resumeAtRef.current;
      resumeAtRef.current = null;
    }
    audio.playbackRate = speed;
    if (resumePlayRef.current) {
      resumePlayRef.current = false;
      void audio.play().catch(() => {});
    }
  }

  // Download reuses the exact same signed URL as playback.
  async function handleDownload() {
    let url: string | null = loaded ? (audioRef.current?.currentSrc || audioRef.current?.src || null) : null;
    if (!url) url = await fetchUrl();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `call-recording-${call.id}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div>
      {/* Hidden media element — all control goes through the custom UI. */}
      <audio
        ref={audioRef}
        className="hidden"
        preload="none"
        onTimeUpdate={() => setPos(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => void handleAudioError()}
      />
      <div className="flex items-center gap-2 rounded-card bg-background-light px-3 py-2.5">
        <button
          type="button"
          onClick={() => setSpeed((s) => speeds[(speeds.indexOf(s) + 1) % speeds.length]!)}
          className="rounded bg-surface-light px-2 py-1 text-[11px] font-semibold text-text-secondary shadow-sm"
        >
          {speed}x
        </button>
        <div className="flex flex-1 items-center justify-center gap-4">
          <button
            type="button"
            aria-label="Back 15 seconds"
            onClick={() => seekBy(-15)}
            className="text-text-secondary hover:text-text-primary"
          >
            <RotateCcw className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            disabled={isFetching}
            onClick={() => void togglePlay()}
            className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-border text-text-primary hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : playing ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            aria-label="Forward 15 seconds"
            onClick={() => seekBy(15)}
            className="text-text-secondary hover:text-text-primary"
          >
            <RotateCw className="h-5 w-5" />
          </button>
        </div>
        <button
          type="button"
          aria-label="Download recording"
          onClick={() => void handleDownload()}
          className="text-text-secondary hover:text-text-primary"
        >
          <Download className="h-5 w-5" />
        </button>
      </div>
      {loadState === "processing" ? (
        <p className="mt-2 text-center text-[12px] text-text-secondary">
          Recording is still processing — try again shortly.
        </p>
      ) : loadState === "error" ? (
        <p className="mt-2 text-center text-[12px] text-danger">
          Couldn&apos;t load the recording — try again.
        </p>
      ) : (
        <p className="mt-2 text-center text-[12px] font-mono text-text-secondary">
          {clock(pos)}/{clock(duration)}
        </p>
      )}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Seek recording"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(Math.min(pos, duration))}
        aria-valuetext={`${clock(pos)} of ${clock(duration)}`}
        aria-disabled={!loaded}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          if (rect.width <= 0) return;
          const ratio = (e.clientX - rect.left) / rect.width;
          seekTo(ratio * (duration || 0));
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            seekBy(-5);
          } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            seekBy(5);
          } else if (e.key === "Home") {
            e.preventDefault();
            seekTo(0);
          } else if (e.key === "End") {
            e.preventDefault();
            seekTo(duration || 0);
          }
        }}
        className="mt-1 h-1.5 w-full cursor-pointer overflow-hidden rounded-full bg-border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
});

/* ─────────────────── Calls-local presentational cells ─────────────────── */

// Insights column. A review flag outranks everything; otherwise a compact chip
// marks that CTM produced an AI summary - the prose itself lives in the detail
// drawer, which has room for it. The sentiment branch below is retained for the
// seeded Call Tracking report data; CTM's live payloads carry no sentiment
// field at all, so real calls resolve on the summary chip or the em dash.
export function InsightCell({ call }: { call: CallSession }) {
  if (call.reviewFlag) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
        <AlertTriangle className="h-3 w-3" /> Needs review
      </span>
    );
  }
  if (call.summary) {
    return (
      <span
        title={call.summary}
        className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
      >
        <Sparkles className="h-3 w-3" /> Summary
      </span>
    );
  }
  if (!call.sentiment) return <span className="text-text-secondary">—</span>;
  const tone =
    call.sentiment === "positive"
      ? "bg-success/10 text-success"
      : call.sentiment === "negative"
        ? "bg-danger/10 text-danger"
        : "bg-background-light text-text-secondary";
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      <Sparkles className="h-3 w-3" /> {call.sentiment}
    </span>
  );
}

function QuickAction({
  icon: Icon,
  label,
  onClick,
  tone = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  const danger = tone === "danger";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1 text-[10px] font-medium ${
        danger
          ? "text-text-secondary hover:text-danger"
          : "text-text-secondary hover:text-primary"
      }`}
    >
      <span
        className={`flex h-8 w-8 items-center justify-center rounded-full border border-border transition ${
          danger
            ? "hover:border-danger/20 hover:bg-danger/10"
            : "hover:border-primary hover:bg-primary/10"
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      {label}
    </button>
  );
}
