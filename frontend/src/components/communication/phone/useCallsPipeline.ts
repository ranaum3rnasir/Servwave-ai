// Phone module — Calls list pipeline.
//
// The `visible → ranged → focused → dated → repeatNumbers → statScoped →
// filtered → sorted` chain, lifted verbatim out of CallsView so the page is a
// thin caller. The Calls-local filter/sort/stat helpers (callMatchesFilters,
// STAT_PREDICATES, callSortValue, agentName, …) moved here alongside the chain;
// CallsView re-exports the ones its sibling components import (agentName,
// callSortValue, NUMERIC_SORT_KEYS, SortKey, SortState). Chain order and every
// dependency array are unchanged — behavior is identical regardless of whether
// `calls` comes from mock or live data.
import { useMemo } from 'react';
import { DISPOSITION_LABELS, fmtPhone } from '@/lib/api/communication';
import type { CallSession, PhoneAgent, PhoneCustomer } from '@/lib/api/communication';
import {
  customerById,
  partyNumber,
  callNeedsAttention,
} from '@/components/communication/phone/shared';
import type { DateRange, CallsFocus } from '@/components/communication/phone/shared';

/**
 * Does this agent row represent whoever `id` names?
 *
 * A real call's `answeredBy.id` is a ServWave USER id, while a PhoneAgent has
 * its own primary key and links to a user via `userId`. Comparing the two
 * directly - as every call site used to - never matched on live data, so the
 * Calls table showed no answerer and the per-agent Performance drawer counted
 * zero calls for everyone. The demo seed keys `answeredBy.id` to the agent row
 * id instead, so both identities have to keep working.
 *
 * The `!id` guard is load-bearing: without it an unlinked agent (`userId`
 * undefined) would match every unattributed call.
 */
export function agentMatchesId(agent: PhoneAgent, id?: string): boolean {
  if (!id) return false;
  return agent.id === id || agent.userId === id;
}

export function agentName(agents: PhoneAgent[], id?: string): string | undefined {
  return id ? agents.find((a) => agentMatchesId(a, id))?.name : undefined;
}

// Which subset of the table each clickable stat card scopes to. The stat
// numbers themselves stay fixed — only the rows below are filtered.
export type StatKey =
  | "calls"
  | "missed"
  | "repeat"
  | "active"
  | "newCust"
  | "existingCust"
  | "avg"
  | "revenue";
// A call is from an EXISTING customer when its caller matched a record in the
// database (customerId is set); otherwise it's a NEW customer call.
// Note: "repeat" is context-dependent (needs the whole set), so it's handled
// specially in statScoped rather than via a per-call predicate here.
export const STAT_PREDICATES: Record<StatKey, (c: CallSession) => boolean> = {
  calls: () => true,
  repeat: () => true,
  missed: (c) => c.status === "missed" || c.status === "voicemail",
  active: (c) => c.status === "active" || c.status === "ringing",
  newCust: (c) => !c.customerId,
  existingCust: (c) => !!c.customerId,
  avg: (c) => !!c.durationSec,
  revenue: (c) => (c.revenue ?? 0) > 0,
};

export type FacetKey =
  | "direction"
  | "callFlow"
  | "source"
  | "status"
  | "duration"
  | "user"
  | "customer"
  | "job"
  | "tags";

export type CallFilters = Record<FacetKey, string[]>;

export const EMPTY_FILTERS: CallFilters = {
  direction: [],
  callFlow: [],
  source: [],
  status: [],
  duration: [],
  user: [],
  customer: [],
  job: [],
  tags: [],
};

function statusGroup(c: CallSession): string {
  if (c.status === "missed") return "missed";
  if (c.status === "voicemail") return "voicemail";
  if (c.status === "active" || c.status === "ringing") return "active";
  return "answered";
}

export function userLabel(agents: PhoneAgent[], c: CallSession): string {
  const k = c.answeredBy.kind;
  if (k === "ai") return agentName(agents, c.answeredBy.id) ?? "AI receptionist";
  if (k === "csr") return agentName(agents, c.answeredBy.id) ?? "CSR";
  // Answered on a forward-to number outside the CTM app - answered, not missed.
  if (k === "external") return c.answeredBy.name ?? "Forwarded phone";
  if (k === "voicemail") return "Voicemail";
  return "No answer";
}

function durationMatch(sec: number | undefined, bucket: string): boolean {
  const d = sec ?? 0;
  switch (bucket) {
    case "u30":
      return d < 30;
    case "u1":
      return d < 60;
    case "o1":
      return d >= 60;
    case "u3":
      return d < 180;
    case "o3":
      return d >= 180;
    case "o5":
      return d >= 300;
    default:
      return true;
  }
}

export function callMatchesFilters(
  agents: PhoneAgent[],
  c: CallSession,
  f: CallFilters,
): boolean {
  if (f.direction.length && !f.direction.includes(c.direction)) return false;
  if (f.status.length && !f.status.includes(statusGroup(c))) return false;
  if (f.callFlow.length && !(c.callFlow && f.callFlow.includes(c.callFlow)))
    return false;
  if (f.source.length && !(c.trackingSource && f.source.includes(c.trackingSource)))
    return false;
  if (f.user.length && !f.user.includes(userLabel(agents, c))) return false;
  if (f.duration.length && !f.duration.some((b) => durationMatch(c.durationSec, b)))
    return false;
  if (f.customer.length && !f.customer.includes(c.customerId ? "existing" : "new"))
    return false;
  if (f.job.length && !f.job.includes(c.jobLabel ? "linked" : "none")) return false;
  if (f.tags.length && !(c.tags && c.tags.some((t) => f.tags.includes(t))))
    return false;
  return true;
}

export type SortKey =
  | "status"
  | "from"
  | "to"
  | "time"
  | "callFlow"
  | "adSource"
  | "tags"
  | "insights"
  | "answeredBy"
  | "jobs"
  | "revenue";

export type SortState = { key: SortKey; dir: "asc" | "desc" };

// Numeric columns default to highest-first on the first click; text columns to A→Z.
export const NUMERIC_SORT_KEYS: SortKey[] = ["time", "revenue"];

export function callSortValue(
  customers: PhoneCustomer[],
  c: CallSession,
  key: SortKey,
): string | number {
  switch (key) {
    case "status":
      return c.status;
    case "from":
      return (customerById(customers, c.customerId)?.name ?? fmtPhone(c.fromNumber)).toLowerCase();
    case "to":
      return c.toNumber;
    case "time":
      return new Date(c.startedAt).getTime();
    case "callFlow":
      return (c.callFlow ?? "").toLowerCase();
    case "adSource":
      return (c.trackingSource ?? "").toLowerCase();
    case "tags":
      return (c.tags ?? []).join(",").toLowerCase();
    // Mirrors InsightCell's precedence: review flag, then the CTM AI summary,
    // then the seed-data sentiment. Sorting must rank what the cell renders.
    case "insights":
      return c.reviewFlag ? "review" : c.summary ? "summary" : c.sentiment ?? "";
    case "answeredBy":
      return c.answeredBy.kind;
    case "jobs":
      return c.jobLabel ?? "";
    case "revenue":
      return c.revenue ?? 0;
  }
}

export interface CallsPipelineArgs {
  calls: CallSession[];
  agents: PhoneAgent[];
  customers: PhoneCustomer[];
  range: DateRange;
  focus: CallsFocus;
  filters: CallFilters;
  statKey: StatKey | null;
  query: string;
  sort: SortState | null;
  dismissed: Set<string>;
}

export interface UseCallsPipelineReturn {
  visible: CallSession[];
  ranged: CallSession[];
  focused: CallSession[];
  dated: CallSession[];
  repeatNumbers: Set<string>;
  statScoped: CallSession[];
  filtered: CallSession[];
  sorted: CallSession[];
}

export function useCallsPipeline({
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
}: CallsPipelineArgs): UseCallsPipelineReturn {
  const visible = useMemo(
    () => calls.filter((c) => !dismissed.has(c.id)),
    [calls, dismissed],
  );

  // Date-range filter — drives both the stat strip and the table.
  const ranged = useMemo(() => {
    return visible.filter((c) => {
      const t = new Date(c.startedAt).getTime();
      if (range.start && t < range.start.getTime()) return false;
      if (range.end && t > range.end.getTime()) return false;
      return true;
    });
  }, [visible, range]);

  // KPI-tile focus — scope the page to e.g. the callback queue or items that
  // need the owner's attention.
  const focused = useMemo(() => {
    if (focus === "callback")
      return ranged.filter(
        (c) => c.status === "missed" || c.status === "voicemail",
      );
    if (focus === "attention") return ranged.filter(callNeedsAttention);
    return ranged;
  }, [ranged, focus]);

  // Faceted "Filter results" — drives the stats + table together.
  const dated = useMemo(
    () => focused.filter((c) => callMatchesFilters(agents, c, filters)),
    [focused, filters, agents],
  );

  // Repeat callers — external numbers that appear in 2+ calls this period.
  const repeatNumbers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of dated) {
      const n = partyNumber(c);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    return new Set(
      [...counts.entries()].filter(([, n]) => n >= 2).map(([num]) => num),
    );
  }, [dated]);

  // Stat-card scope — clicking a card filters the table rows to that subset.
  const statScoped = useMemo(() => {
    if (!statKey) return dated;
    if (statKey === "repeat")
      return dated.filter((c) => repeatNumbers.has(partyNumber(c)));
    return dated.filter(STAT_PREDICATES[statKey]);
  }, [dated, statKey, repeatNumbers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return statScoped;
    return statScoped.filter((c) => {
      const cust = customerById(customers, c.customerId);
      const hay = [
        cust?.name,
        fmtPhone(c.fromNumber),
        fmtPhone(c.toNumber),
        c.callFlow,
        c.jobLabel,
        c.trackingSource,
        c.disposition ? DISPOSITION_LABELS[c.disposition] : "",
        ...(c.tags ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [statScoped, query, customers]);

  // Column sort — clicking a header sorts by that column; clicking the active
  // header flips direction. Numeric columns lead with highest-first.
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const { key, dir } = sort;
    return [...filtered].sort((a, b) => {
      const av = callSortValue(customers, a, key);
      const bv = callSortValue(customers, b, key);
      const cmp =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv));
      return dir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sort, customers]);

  return { visible, ranged, focused, dated, repeatNumbers, statScoped, filtered, sorted };
}
