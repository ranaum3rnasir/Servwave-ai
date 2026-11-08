// Phone module — shared kernel.
//
// Extracted from Emanuel's PhonePage monolith BEFORE it was split into 17
// per-section view files. Everything here is used by >=2 of those future view
// files; single-view symbols stay local to their view. Logic is verbatim from
// the monolith; only two things changed:
//   1. Tailwind tokens swapped indigo/slate -> ALPHA design tokens (primary /
//      text-primary / text-secondary / border / background-light). emerald,
//      amber, rose, sky, violet are kept verbatim (status colors).
//   2. Data-dependent lookups (customerById) take their data array as the FIRST
//      param — ALPHA feeds data from the `@/lib/api/communication` seam hooks,
//      not from module-scope imports.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot,
  ChevronDown,
  Mic,
  PhoneForwarded,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Voicemail,
} from "lucide-react";
import type { CallSession, PhoneCustomer } from "@/lib/api/communication";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DatePicker } from "@/components/form/DatePicker";
import {
  useScheduleTimezone,
  formatInstant,
  isoToOrgDay,
  addOrgDays,
  orgToday,
  orgDayStart,
  orgDayEnd,
} from "@/lib/schedule-tz";

/* ─────────────────── Shared types ─────────────────── */

export type Tab = "calls" | "inbox" | "dispatch" | "performance";

export type CallsFocus = "all" | "callback" | "attention";

/* ─────────────────── Data-as-param lookups ─────────────────── */

/** Resolve a customer by id. The monolith closed over the module-scope
 *  `customers` array; in ALPHA the array comes from a seam hook, so callers
 *  pass it in as the first argument. */
export function customerById(
  customers: PhoneCustomer[],
  id?: string,
): PhoneCustomer | undefined {
  return id ? customers.find((c) => c.id === id) : undefined;
}

/* ─────────────────── Pure helpers ─────────────────── */

export function shortTime(iso: string, tz: string): string {
  return formatInstant(iso, tz, { hour: "numeric", minute: "2-digit" });
}

/** The external party's number on a call — the customer side. On inbound that's
 *  who called us (From); on outbound it's who we dialed (To). Used so repeat
 *  callers aren't confused with our own business line. */
export function partyNumber(c: CallSession): string {
  return c.direction === "inbound" ? c.fromNumber : c.toNumber;
}

/** Owner-review flag — surfaces any call the owner should personally check:
 *  after-hours emergencies, manager-needed calls, angry customers (negative
 *  sentiment), or a low-confidence / flagged AI insight. */
export function callNeedsAttention(c: CallSession): boolean {
  return (
    c.disposition === "after_hours_emergency" ||
    c.disposition === "needs_manager" ||
    c.sentiment === "negative" ||
    !!c.reviewFlag
  );
}

const ORDINAL = (d: number) => {
  if (d > 3 && d < 21) return "th";
  switch (d % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
};

export function dayLabel(iso: string, tz: string): string {
  const day = isoToOrgDay(iso, tz);
  if (!day) return "";
  // The day-of-month comes from the org-zone day token, never `d.getDate()` -
  // that reads the viewer's calendar, and the ordinal would then disagree with
  // the weekday and month beside it on any evening that straddles midnight.
  const dom = Number(day.slice(8, 10));
  const wd = formatInstant(iso, tz, { weekday: "short" });
  const mo = formatInstant(iso, tz, { month: "short" });
  return `${wd} ${mo} ${dom}${ORDINAL(dom)}`;
}

/** Numeric calendar date, month-day-year (e.g. "07-17-2026"). */
export function dateNumeric(iso: string, tz: string): string {
  const day = isoToOrgDay(iso, tz);
  if (!day) return "";
  return `${day.slice(5, 7)}-${day.slice(8, 10)}-${day.slice(0, 4)}`;
}

/** Wall-clock time of day the call happened, on the ORG's clock (e.g. "3:27 PM"). */
export function timeLabel(iso: string, tz: string): string {
  return formatInstant(iso, tz, { hour: "numeric", minute: "2-digit" });
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

export function scoreTone(score: number): string {
  if (score >= 90) return "bg-success/10 text-success ring-success/20";
  if (score >= 80) return "bg-warning/10 text-warning ring-warning/20";
  return "bg-danger/10 text-danger ring-danger/20";
}

export function primaryPhone(c: PhoneCustomer): string {
  return (
    c.contacts.flatMap((ct) => ct.channels).find((ch) => ch.kind === "phone")
      ?.value ?? ""
  );
}

/* ─────────────────── Date-range picker plumbing ───────────────────
 * Demo orgs render fixed mock call data seeded around 2026-05-30, so their
 * presets stay anchored to that prototype date; real orgs must anchor to the
 * actual current time or every preset except "All time" hides real CTM data. */

// Trailing 'Z' is deliberate. Without it this parses against the BROWSER's zone,
// so the demo anchor itself slid by up to a day between viewers - the same defect
// the presets below had, one line earlier in the chain.
export const DEMO_NOW = new Date("2026-05-30T23:59:59Z");

export type RangePreset =
  | "today"
  | "7d"
  | "30d"
  | "month"
  | "90d"
  | "all"
  | "custom";

export const RANGE_PRESETS: { key: RangePreset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "month", label: "This month" },
  { key: "90d", label: "Last 90 days" },
  { key: "all", label: "All time" },
];

/** Count calls whose `startedAt` falls on the same ORG calendar day as `anchor`.
 * The KPI passes `DEMO_NOW` for demo orgs and the real `new Date()` otherwise —
 * the SAME anchor the date-range presets use — so "Calls today" agrees with the
 * "Today" preset instead of showing the all-time `calls.length`. */
export function countCallsOnDay(
  calls: Array<{ startedAt: string }>,
  anchor: Date,
  tz: string,
): number {
  const day = orgToday(tz, anchor);
  const lo = orgDayStart(day, tz).getTime();
  const hi = orgDayEnd(day, tz).getTime();
  return calls.reduce((n, c) => {
    const t = new Date(c.startedAt).getTime();
    return Number.isFinite(t) && t >= lo && t <= hi ? n + 1 : n;
  }, 0);
}

export type DateRange = { start: Date | null; end: Date | null };

/** Preset -> a pair of true instants, with both edges on the ORG's midnights.
 *  These bound which calls the table shows, so building them on the viewer's
 *  clock made "Today" a different set of rows in Manila than in New York. */
export function computeRange(
  preset: RangePreset,
  customStart: string,
  customEnd: string,
  tz: string,
  isDemoOrg = false,
): DateRange {
  const today = orgToday(tz, isDemoOrg ? DEMO_NOW : new Date());
  const end = orgDayEnd(today, tz);
  const from = (n: number) => orgDayStart(addOrgDays(today, n), tz);
  switch (preset) {
    case "today":
      return { start: from(0), end };
    case "7d":
      return { start: from(-6), end };
    case "30d":
      return { start: from(-29), end };
    case "month":
      return { start: orgDayStart(`${today.slice(0, 7)}-01`, tz), end };
    case "90d":
      return { start: from(-89), end };
    case "all":
      return { start: null, end: null };
    case "custom":
      // The two custom inputs are DatePicker 'YYYY-MM-DD' strings - already
      // zoneless day tokens, so they need no parsing, only org-zone anchoring.
      return {
        start: customStart ? orgDayStart(customStart, tz) : null,
        end: customEnd ? orgDayEnd(customEnd, tz) : null,
      };
  }
}

export function longDate(d: Date, tz: string): string {
  const day = isoToOrgDay(d.toISOString(), tz);
  const dom = Number(day.slice(8, 10));
  const mo = formatInstant(d, tz, { month: "short" });
  return `${mo} ${dom}${ORDINAL(dom)}, ${day.slice(0, 4)}`;
}

export function rangeSubLabel(range: DateRange, tz: string): string {
  if (!range.start && !range.end) return "All recorded calls";
  if (range.start && range.end) return `${longDate(range.start, tz)} – ${longDate(range.end, tz)}`;
  if (range.start) return `From ${longDate(range.start, tz)}`;
  return `Until ${longDate(range.end as Date, tz)}`;
}

/** Preset -> the phrase that names it inside a sentence. Deliberately the SAME
 *  words as `RANGE_PRESETS` above, so a user told their search covered
 *  "Last 30 days" can find that exact entry in the date-range picker. "all" and
 *  "custom" are absent on purpose: "all" is unbounded (nothing to name) and
 *  "custom" has no fixed label, only its own bounds. */
const RANGE_SCOPE_LABELS: Partial<Record<RangePreset, string>> = Object.fromEntries(
  RANGE_PRESETS.filter((p) => p.key !== "all").map((p) => [p.key, p.label]),
);

/** Name the window a range-scoped search actually covered, or `null` when the
 *  scope is unbounded.
 *
 *  A list that opens on a 30-day default answers "no results" for two very
 *  different reasons - the record does not exist, and the record exists outside
 *  a window the search box never mentioned. Only the second one is worth a
 *  sentence, so `null` (unbounded: "All time", or a "custom" range with neither
 *  bound filled in) means "nothing was hidden - say nothing".
 *
 *  Pure: same arguments as `computeRange`, no React, no clock of its own. The
 *  demo anchor arrives through `isDemoOrg` exactly as it does for the range
 *  itself, so the description always names the window the rows were drawn from.
 *
 *  Returns e.g. `"Last 30 days (May 1st, 2026 – May 30th, 2026)"`, meant to be
 *  read after "in". */
export function describeSearchScope(
  preset: RangePreset,
  customStart: string,
  customEnd: string,
  tz: string,
  isDemoOrg = false,
): string | null {
  const range = computeRange(preset, customStart, customEnd, tz, isDemoOrg);
  if (!range.start && !range.end) return null;
  const bounds = rangeSubLabel(range, tz);
  return `${RANGE_SCOPE_LABELS[preset] ?? "Custom range"} (${bounds})`;
}

/* ─────────────────── Shared components ─────────────────── */

/** Direction / status glyph for a call row. */
export function DirIcon({ call }: { call: CallSession }) {
  if (call.status === "missed")
    return <PhoneMissed className="h-3.5 w-3.5 text-warning" />;
  if (call.status === "voicemail")
    return <Voicemail className="h-3.5 w-3.5 text-info" />;
  return call.direction === "inbound" ? (
    <PhoneIncoming className="h-3.5 w-3.5 text-success" />
  ) : (
    <PhoneOutgoing className="h-3.5 w-3.5 text-info" />
  );
}

/** Who answered the call - AI, CSR, a forwarded external line, voicemail, or
 *  no-answer. 'external' is a call picked up on a forward-to number outside the
 *  CTM app (no agent identity in the payload) - it WAS answered, so it must not
 *  render as the warning-toned "No answer" (SERV10X-65). */
export function AnsweredBy({ call }: { call: CallSession }) {
  const k = call.answeredBy.kind;
  if (k === "ai")
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ai-600">
        <Bot className="h-3 w-3" /> AI
      </span>
    );
  if (k === "csr")
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
        <Mic className="h-3 w-3" /> CSR
      </span>
    );
  if (k === "external")
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-text-secondary">
        <PhoneForwarded className="h-3 w-3" /> Forwarded phone
      </span>
    );
  if (k === "voicemail")
    return <span className="text-[11px] text-text-secondary">Voicemail</span>;
  return <span className="text-[11px] text-warning">No answer</span>;
}

/** Compact label/value metric tile (mono value on a tinted chip). */
export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-background-light px-2 py-1.5">
      <p className="text-[9px] font-semibold uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="font-mono text-sm font-semibold text-text-primary">{value}</p>
    </div>
  );
}

/** Stacked label-over-value row used in detail/info panels. */
export function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="text-[13px] text-text-secondary">{value}</p>
    </div>
  );
}

/** The Calls date-range picker — preset grid + custom from/to inputs. */
export function DateRangeControl({
  preset,
  customStart,
  customEnd,
  range,
  onPreset,
  onCustom,
}: {
  preset: RangePreset;
  customStart: string;
  customEnd: string;
  range: DateRange;
  onPreset: (p: RangePreset) => void;
  onCustom: (start: string, end: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const tz = useScheduleTimezone();
  const title =
    preset === "custom"
      ? "Custom range"
      : RANGE_PRESETS.find((p) => p.key === preset)?.label ?? "Date range";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex min-w-[230px] items-center justify-between gap-3 rounded-lg border border-border bg-surface-light px-4 py-2 text-left transition hover:border-primary hover:shadow-sm"
        >
          <span className="flex flex-col">
            <span className="text-[11px] font-semibold text-text-secondary">{title}</span>
            <span className="text-[13px] font-semibold text-text-primary">
              {rangeSubLabel(range, tz)}
            </span>
          </span>
          <ChevronDown
            className={`h-4 w-4 flex-shrink-0 text-text-secondary transition ${open ? "rotate-180" : ""}`}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2 ring-border">
        <div className="grid grid-cols-2 gap-1">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                onPreset(p.key);
                setOpen(false);
              }}
              className={[
                "rounded-md px-2.5 py-2 text-left text-[12px] font-medium transition",
                preset === p.key
                  ? "bg-primary-subtle text-primary"
                  : "text-text-secondary hover:bg-background-light",
              ].join(" ")}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="mt-2 border-t border-border pt-2">
          <p className="mb-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            Custom range
          </p>
          <div className="flex items-center gap-2">
            <DatePicker
              value={customStart}
              max={customEnd || undefined}
              onChange={(v) => onCustom(v, customEnd)}
              inputClassName="text-[12px]"
            />
            <span className="text-[11px] text-text-secondary">to</span>
            <DatePicker
              value={customEnd}
              min={customStart || undefined}
              onChange={(v) => onCustom(customStart, v)}
              inputClassName="text-[12px]"
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ─────────────────── Portaled select ───────────────────
 * Hand-rolled, portal-based <select> (measure + flip-up). Used by both
 * TextingView and CallMaskingView — deduped here from two near-identical
 * copies (same portal + getBoundingClientRect positioning logic) rather than
 * reimplemented on top of ui/select.tsx, since the portal escapes an
 * overflow:hidden ancestor that a plain popover-based select would not. The
 * `tone` prop preserves each caller's original accent color (TextingView used
 * an "info" tone, CallMaskingView used "primary") without forking the logic. */
export type CleanSelectTone = "primary" | "info";

export function CleanSelect({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder = "Select…",
  size = "sm",
  widthClass = "inline-block w-auto",
  menuWidthClass = "min-w-full",
  align = "left",
  tone = "primary",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ariaLabel?: string;
  placeholder?: string;
  size?: "sm" | "md";
  widthClass?: string;
  menuWidthClass?: string;
  align?: "left" | "right";
  tone?: CleanSelectTone;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    flipUp: boolean;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      const flipUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(160, (flipUp ? spaceAbove : spaceBelow) - 12);
      setCoords({
        top: flipUp ? r.top - 4 : r.bottom + 4,
        left: align === "right" ? r.right : r.left,
        width: r.width,
        maxHeight: Math.min(288, maxHeight),
        flipUp,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align]);

  const triggerSize =
    size === "md"
      ? "rounded-lg px-3 py-2.5 text-sm"
      : "rounded-md px-2.5 py-2 text-[13px]";

  const toneRing = tone === "info" ? "ring-primary/20" : "ring-primary/10";
  const toneHoverBorder = tone === "info" ? "hover:border-text-secondary" : "hover:border-primary";
  const tonePlaceholder = tone === "info" ? "text-text-secondary/60" : "text-text-secondary";
  const toneActiveRow = tone === "info" ? "bg-info" : "bg-primary";

  const rowCls = (active: boolean) =>
    [
      "block w-full px-3.5 py-2 text-left text-[14px] transition",
      active
        ? `${toneActiveRow} font-semibold text-on-fill`
        : "text-text-secondary hover:bg-background-light",
    ].join(" ");

  return (
    <div className={`relative ${widthClass}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={[
          "flex w-full items-center justify-between gap-2 border bg-surface-light text-left transition",
          triggerSize,
          open ? `border-primary ring-2 ${toneRing}` : `border-border ${toneHoverBorder}`,
          selected ? "font-medium text-text-secondary" : tonePlaceholder,
        ].join(" ")}
      >
        <span className="truncate">{selected ? selected.label : placeholder}</span>
        <ChevronDown
          className={`h-4 w-4 flex-shrink-0 text-text-secondary transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        coords &&
        createPortal(
          <>
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-[90] cursor-default"
            />
            <div
              role="listbox"
              style={{
                position: "fixed",
                top: coords.top,
                left: align === "right" ? undefined : coords.left,
                right:
                  align === "right"
                    ? window.innerWidth - coords.left
                    : undefined,
                width:
                  menuWidthClass === "w-full" || menuWidthClass === "min-w-full"
                    ? coords.width
                    : undefined,
                minWidth: coords.width,
                maxHeight: coords.maxHeight,
                transform: coords.flipUp ? "translateY(-100%)" : undefined,
              }}
              className="z-[91] flex flex-col overflow-hidden rounded-md border border-border bg-surface-light py-1 shadow-xl ring-1 ring-border"
            >
              <div className="min-h-0 flex-1 overflow-y-auto">
                {options.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    className={rowCls(o.value === value)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
