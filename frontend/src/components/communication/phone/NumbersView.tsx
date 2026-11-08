// Phone module — Numbers view.
//
// Ported from Emanuel's PhonePage monolith (region L6404–7526), rewired to the
// real numbers platform in slice 7. Manage owned phone numbers: assign each to
// a call flow (PATCH /api/communication/numbers/:id) + a local ad-group tag,
// and provision new numbers via the "Get a number" slide-over (real CTM
// inventory search + purchase — no price anywhere; numbers are included in
// the plan).
//
// Cut-and-reskin notes:
//   • Tokens swapped indigo/slate → ALPHA design tokens. emerald/amber/rose and
//     the deliberate solid-blue active-row finish (bg-info) are kept verbatim.
//   • Data comes from the `@/lib/api/communication` seam: useNumbers() feeds
//     the table (via PhonePage's lifted state), useSearchNumbers/useBuyNumber
//     drive the dialog, useReassignNumberFlow persists row flow changes. Flow
//     choices are the org's REAL call flows only (server-validated UUIDs) —
//     the monolith's fake "Forward to <person>" built-ins are gone.
//   • CASL gates the view (read/manage Communication, coarse subject).
//   • Overlays consolidation: FlowSelect/AdGroupSelect now compose ui/popover
//     instead of their former hand-rolled/createPortal click-catchers; the
//     "Get a number" panel now composes ui/modal (centered, not a slide-over)
//     with its purchase-confirm layer as a nested ui/confirm-dialog. Chrome
//     only — business logic kept verbatim.
//   • AD_GROUP_SEED stays a local UI seed (ad attribution is not backed yet);
//     the fake pause/release row actions were removed rather than wired to
//     nothing.

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Plus, RotateCw, Search } from "lucide-react";
import {
  customFlowOptions,
  flowNameForId,
  fmtPhone,
  mapOwnedNumber,
  useBuyNumber,
  useSearchNumbers,
  useReassignNumberFlow,
  useRefreshNumbers,
  useReleaseNumber,
  useUpdateNumberForwarding,
} from "@/lib/api/communication";
import { useBackgroundNumberSync } from "@/lib/api/backgroundNumberSync";
import type {
  AvailableNumber,
  CallFlow,
  NumberSyncResponse,
  NumberType,
  OwnedNumber,
  PhoneNumberRow,
} from "@/lib/api/communication";
import { useAppAbility } from "@/contexts/AbilityContext";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { useScheduleTimezone, formatInstant, isoToOrgDay } from '@/lib/schedule-tz';

/* ─────────────────── Local helpers ─────────────────── */

/** Human-readable API error (axios shape) with a fallback. */
function apiErrorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } } };
  return e?.response?.data?.error ?? fallback;
}

const numbersPhrase = (count: number) => (count === 1 ? "1 number" : `${count} numbers`);

/** What the Sync button reports: numbers added and texting switched on, plus
 *  any number whose texting could not be switched on (the next sync retries). */
function syncResultMessage(data: NumberSyncResponse): string {
  const done = `Sync complete: ${numbersPhrase(data.added)} added, texting switched on for ${numbersPhrase(data.texting_enabled)}`;
  return data.texting_failed > 0
    ? `${done}. Texting could not be switched on for ${numbersPhrase(data.texting_failed)} yet`
    : done;
}

function numberCreatedLabel(iso: string, tz: string): string {
  const day = isoToOrgDay(iso, tz);
  if (!day) return "";
  const wd = formatInstant(iso, tz, { weekday: "short" });
  const mo = formatInstant(iso, tz, { month: "short" });
  const t = formatInstant(iso, tz, { hour: "2-digit", minute: "2-digit" }).toLowerCase();
  return `${wd} ${mo} ${Number(day.slice(8, 10))}, ${day.slice(0, 4)} · ${t}`;
}

/** Call-flow picker used in each number row and in the "Get a number" dialog.
 *  A custom dropdown (not a native <select>) so the open panel matches the
 *  clean, white finish of the other pickers: white surface, section label, and
 *  the active choice filled solid blue. Lists the org's REAL call flows only —
 *  routing is persisted server-side, so fake built-in targets are gone. Empty
 *  value renders the "Assign a flow…" prompt. */
function FlowSelect({
  value,
  onChange,
  flows,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  flows: { id: string; label: string }[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = flows.find((f) => f.id === value);

  const rowCls = (active: boolean) =>
    [
      "block w-full px-3.5 py-2 text-left text-[14px] transition",
      active
        ? "bg-info font-semibold text-on-fill"
        : "text-text-secondary hover:bg-background-light",
    ].join(" ");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? "Assign call flow"}
          className={[
            "flex w-full max-w-[230px] items-center justify-between gap-2 rounded-md border bg-surface-light px-2.5 py-1.5 text-left text-[13px] transition",
            open
              ? "border-primary ring-2 ring-primary/20"
              : "border-border hover:border-text-secondary",
            selected ? "font-medium text-text-primary" : "text-text-secondary/60",
          ].join(" ")}
        >
          <span className="truncate">
            {selected ? selected.label : "Assign a flow…"}
          </span>
          <ChevronDown
            className={`h-4 w-4 flex-shrink-0 text-text-secondary transition ${open ? "rotate-180" : ""}`}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 max-h-80 overflow-auto p-1">
        <button
          type="button"
          onClick={() => {
            onChange("");
            setOpen(false);
          }}
          className={rowCls(!selected)}
        >
          Assign a flow…
        </button>
        {flows.length > 0 ? (
          <div>
            <p className="px-3.5 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              My flows
            </p>
            {flows.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  onChange(f.id);
                  setOpen(false);
                }}
                className={rowCls(f.id === value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        ) : (
          <p className="px-3.5 py-2 text-[13px] text-text-secondary/60">
            No call flows yet — create one in the Call flows tab.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/* Ad groups a tracking number can be attributed to (online + offline campaigns,
 * PHONE-SYSTEM-PRD §14.10). */
type AdGroup = { id: string; label: string };

const AD_GROUP_SEED: AdGroup[] = [
  { id: "office", label: "Office" },
  { id: "account", label: "Account" },
  { id: "alpha_return", label: "Returning customer" },
  { id: "google", label: "Google" },
  { id: "google_lsa", label: "Google Local Services Ad" },
  { id: "reserve_google", label: "Reserve with Google" },
  { id: "return_customer", label: "Return customer" },
  { id: "village", label: "Village" },
];

function adGroupLabel(groups: AdGroup[], id?: string): string {
  return groups.find((g) => g.id === id)?.label ?? "";
}

/** Ad-group picker with a clean, square white menu — a custom dropdown (not a
 *  native <select>) so the open panel matches the requested finish: white
 *  surface, square rows, the active choice filled solid blue. Includes an
 *  inline "+ Create new ad group" affordance so new groups can be added without
 *  leaving the dropdown. */
function AdGroupSelect({
  value,
  onChange,
  groups,
  onCreateGroup,
  ariaLabel,
}: {
  value?: string;
  onChange: (v: string) => void;
  groups: AdGroup[];
  onCreateGroup: (label: string) => string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const selected = groups.find((g) => g.id === value);

  function close() {
    setOpen(false);
    setCreating(false);
    setDraft("");
  }

  function submitNew() {
    const label = draft.trim();
    if (!label) return;
    const id = onCreateGroup(label);
    onChange(id);
    close();
  }

  const rowCls = (active: boolean) =>
    [
      "block w-full px-3.5 py-2.5 text-left text-[14px] transition",
      active
        ? "bg-info font-semibold text-on-fill"
        : "text-text-secondary hover:bg-background-light",
    ].join(" ");

  return (
    <Popover open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? "Assign an ad group"}
          className={[
            "flex w-full max-w-[230px] items-center justify-between gap-2 rounded-md border bg-surface-light px-2.5 py-1.5 text-left text-[13px] transition",
            open
              ? "border-warning/20 ring-2 ring-warning/20"
              : "border-border hover:border-text-secondary",
            selected ? "font-medium text-text-primary" : "text-text-secondary/60",
          ].join(" ")}
        >
          <span className="truncate">
            {selected ? selected.label : "Assign An Ad Group"}
          </span>
          <ChevronDown
            className={`h-4 w-4 flex-shrink-0 text-text-secondary transition ${open ? "rotate-180" : ""}`}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-80 w-64 flex-col overflow-hidden p-0"
      >
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          <button
            type="button"
            onClick={() => {
              onChange("");
              close();
            }}
            className={rowCls(!selected)}
          >
            Assign An Ad Group
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => {
                onChange(g.id);
                close();
              }}
              className={rowCls(g.id === value)}
            >
              {g.label}
            </button>
          ))}
        </div>

        {/* Create-new affordance */}
        <div className="border-t border-border">
          {creating ? (
            <div className="flex items-center gap-1.5 p-2">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitNew();
                  if (e.key === "Escape") {
                    setCreating(false);
                    setDraft("");
                  }
                }}
                placeholder="New ad group name"
                className="min-w-0 flex-1 rounded border border-border px-2 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="button"
                onClick={submitNew}
                disabled={!draft.trim()}
                className="flex-shrink-0 rounded bg-primary px-2.5 py-1.5 text-[13px] font-semibold text-on-fill hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[14px] font-semibold text-primary hover:bg-primary/10"
            >
              <Plus className="h-4 w-4" />
              Create new ad group
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Where a number's calls ring, and the only place it can be changed.
 *
 *  This is the number's routing, not a label: saving re-points the live dial
 *  route. The server fails the request outright rather than reporting a success
 *  it did not achieve, so an error here means calls still reach the OLD
 *  destination - which is what the error copy has to say, because the dangerous
 *  failure is the silent one where the owner believes calls moved. */
function ForwardToCell({
  n,
  canManage,
  onToast,
}: {
  n: OwnedNumber;
  canManage: boolean;
  onToast: (m: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const updateForwarding = useUpdateNumberForwarding();

  const draftE164 = toUsE164(draft);
  const saving = updateForwarding.isPending;

  function open() {
    setDraft(n.forwardTo ?? "");
    setEditing(true);
  }

  function save() {
    if (!draftE164 || saving) return;
    updateForwarding.mutate(
      { id: n.id, forwardToE164: draftE164 },
      {
        onSuccess: () => {
          setEditing(false);
          onToast(`${n.number} now rings ${fmtPhone(draftE164)}`);
        },
        onError: (err) =>
          onToast(
            apiErrorMessage(
              err,
              `Could not change where ${n.number} rings - it still reaches its old destination`,
            ),
          ),
      },
    );
  }

  if (!editing) {
    return (
      <div className="space-y-1">
        {n.forwardTo ? (
          <span className="block font-mono text-[13px] text-text-primary">
            {fmtPhone(n.forwardTo)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
            Not routed
          </span>
        )}
        {canManage && (
          <button
            type="button"
            onClick={open}
            className="block text-[11px] font-semibold text-primary hover:text-primary/80"
          >
            {n.forwardTo ? "Change" : "Set destination"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder="(555) 123-4567"
        inputMode="tel"
        aria-label={`Forward ${n.number} to`}
        aria-invalid={draft.trim() !== "" && !draftE164}
        className="w-full max-w-[180px] rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!draftE164 || saving}
          className="rounded bg-primary px-2.5 py-1 text-[11px] font-semibold text-on-fill hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={saving}
          className="text-[11px] font-semibold text-text-secondary hover:text-text-primary"
        >
          Cancel
        </button>
      </div>
      {draft.trim() !== "" && !draftE164 && (
        <p className="text-[11px] font-medium text-danger">Enter a 10-digit US number.</p>
      )}
    </div>
  );
}

/* ─────────────────── NumbersView ─────────────────── */

export function NumbersView({
  numbers,
  setNumbers,
  callFlows,
  loading = false,
  onToast,
}: {
  numbers: OwnedNumber[];
  setNumbers: React.Dispatch<React.SetStateAction<OwnedNumber[]>>;
  callFlows: CallFlow[];
  /** True while the numbers query is in flight — shows a loading row instead
   *  of flashing the "No phone numbers yet" empty state. */
  loading?: boolean;
  onToast: (m: string) => void;
}) {
  const ability = useAppAbility();
  const canManage = ability.can("manage", "Communication");
  const tz = useScheduleTimezone();

  const [adGroups, setAdGroups] = useState<AdGroup[]>(AD_GROUP_SEED);
  const [query, setQuery] = useState("");
  const [getOpen, setGetOpen] = useState(false);
  // The number awaiting a release confirmation. Releasing is irreversible at
  // the provider, so it never fires straight off the row button.
  const [releasing, setReleasing] = useState<OwnedNumber | null>(null);
  // What the owner has typed to confirm the release. A confirm dialog alone is
  // one muscle-memory click away from permanently losing a working business
  // line, so the number itself has to be re-entered. Digits only, so the
  // formatting of the label is not part of the puzzle.
  const [releaseTyped, setReleaseTyped] = useState("");
  const releaseNumber = useReleaseNumber();
  const digitsOf = (s: string) => s.replace(/\D/g, "");
  const releaseConfirmed =
    !!releasing && digitsOf(releaseTyped) !== "" && digitsOf(releaseTyped) === digitsOf(releasing.number);

  // Flow choices are the org's REAL call flows (server-validated UUIDs).
  const resolveFlowLabel = (flowId: string): string =>
    flowNameForId(callFlows, flowId) ?? "Unassigned";
  const customFlows = useMemo(() => customFlowOptions(callFlows), [callFlows]);

  // Row flow-reassign persists through PATCH /api/communication/numbers/:id.
  const reassignFlow = useReassignNumberFlow();

  // The table is otherwise a connect-time snapshot of the org's numbers.
  const refreshNumbers = useRefreshNumbers();
  // Opening the screen syncs in the background; the list is replaced only when
  // the sync changed something, and a failure leaves it as it is. The hook
  // writes the shared numbers query, which PhonePage seeds `numbers` from.
  useBackgroundNumberSync();

  function syncFromProvider() {
    refreshNumbers.mutate(undefined, {
      onSuccess: (data) => {
        setNumbers(data.numbers.map(mapOwnedNumber));
        onToast(syncResultMessage(data));
      },
      onError: (err) => onToast(apiErrorMessage(err, "Could not sync numbers - try again")),
    });
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return numbers;
    return numbers.filter(
      (n) =>
        n.number.toLowerCase().includes(q) ||
        (n.tag ?? "").toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q) ||
        (n.forwardTo ?? "").toLowerCase().includes(q) ||
        resolveFlowLabel(n.flowId).toLowerCase().includes(q) ||
        adGroupLabel(adGroups, n.adGroupId).toLowerCase().includes(q),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numbers, adGroups, query, callFlows]);

  function createAdGroup(label: string): string {
    const id = `grp_${Date.now()}`;
    setAdGroups((prev) => [...prev, { id, label }]);
    onToast(`Ad group “${label}” created`);
    return id;
  }

  /** Persist first, commit locally on success (no optimistic flicker; the
   *  numbers-query invalidation re-hydrates PhonePage's lifted copy anyway). */
  function setFlow(id: string, flowId: string) {
    const n = numbers.find((x) => x.id === id);
    reassignFlow.mutate(
      { id, callFlowId: flowId || null },
      {
        onSuccess: () => {
          setNumbers((prev) =>
            prev.map((x) => (x.id === id ? { ...x, flowId } : x)),
          );
          if (n) {
            onToast(
              flowId
                ? `${n.number} → ${resolveFlowLabel(flowId)}`
                : `Flow removed from ${n.number}`,
            );
          }
        },
        onError: (err) =>
          onToast(
            apiErrorMessage(err, `Could not update the flow for ${n?.number ?? "this number"}`),
          ),
      },
    );
  }

  function setAdGroup(id: string, adGroupId: string) {
    const n = numbers.find((x) => x.id === id);
    setNumbers((prev) =>
      prev.map((x) => (x.id === id ? { ...x, adGroupId } : x)),
    );
    if (n) {
      onToast(
        adGroupId
          ? `${n.number} → ${adGroupLabel(adGroups, adGroupId)} ad group`
          : `Ad group cleared from ${n.number}`,
      );
    }
  }

  function confirmRelease() {
    // The disabled Confirm button is the visible gate; this is the real one.
    if (!releasing || releaseNumber.isPending || !releaseConfirmed) return;
    const target = releasing;
    releaseNumber.mutate(
      { id: target.id },
      {
        onSuccess: () => {
          setNumbers((prev) =>
            prev.map((x) => (x.id === target.id ? { ...x, status: "released" } : x)),
          );
          setReleasing(null);
          onToast(`${target.number} released - it will not be billed again`);
        },
        onError: (err) => {
          onToast(apiErrorMessage(err, `Could not release ${target.number} - it is still active`));
          setReleasing(null);
        },
      },
    );
  }

  function addNumber(num: OwnedNumber) {
    setNumbers((prev) => [num, ...prev.filter((x) => x.id !== num.id)]);
    setGetOpen(false);
    onToast(`Purchased ${num.number}`);
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-secondary">
          Manage your phone numbers and assign them to call flows. Get multiple
          numbers and use them across your online and offline campaigns.
        </p>
        {canManage && (
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              onClick={syncFromProvider}
              disabled={refreshNumbers.isPending}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-light px-3.5 py-2 text-sm font-semibold text-text-primary hover:bg-background-light disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCw
                className={`h-4 w-4 ${refreshNumbers.isPending ? "animate-spin" : ""}`}
              />
              {refreshNumbers.isPending ? "Syncing…" : "Sync numbers"}
            </button>
            <button
              onClick={() => setGetOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-semibold text-on-fill shadow-sm hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              Get a number
            </button>
          </div>
        )}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search numbers…"
          className="w-full rounded-md border border-border bg-surface-light py-2 pl-9 pr-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {/* Numbers table — each number is its own row. */}
      <div className="overflow-x-auto rounded-card border border-border bg-surface-light">
        <table className="w-full min-w-[1040px] text-sm">
          <thead className="bg-background-light text-[10px] uppercase tracking-wide text-text-secondary">
            <tr>
              <th className="px-4 py-2.5 text-left">Number</th>
              <th className="px-4 py-2.5 text-left">Type</th>
              <th className="px-4 py-2.5 text-left">Rings at</th>
              <th className="px-4 py-2.5 text-left">Ad group</th>
              <th className="px-4 py-2.5 text-left">Assigned flow</th>
              <th className="px-4 py-2.5 text-left">Status</th>
              <th className="px-4 py-2.5 text-left">Created</th>
              <th className="px-4 py-2.5 text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && numbers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-[13px] text-text-secondary/60">
                  Loading numbers…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-[13px] text-text-secondary/60">
                  <EmptyState
                    title={
                      numbers.length === 0
                        ? "No phone numbers yet — use “Get a number” to provision your first one."
                        : `No numbers match “${query.trim()}”.`
                    }
                  />
                </td>
              </tr>
            ) : (
              filtered.map((n) => (
                <tr key={n.id} className="align-top hover:bg-background-light">
                  <td className="px-4 py-3">
                    <span className="block font-mono font-semibold text-text-primary">
                      {n.number}
                    </span>
                    {n.tag && (
                      <span className="mt-1 inline-block rounded bg-background-light px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                        {n.tag}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{n.type}</td>
                  <td className="px-4 py-3">
                    <ForwardToCell n={n} canManage={canManage} onToast={onToast} />
                  </td>
                  <td className="px-4 py-3">
                    <AdGroupSelect
                      value={n.adGroupId}
                      onChange={(v) => setAdGroup(n.id, v)}
                      groups={adGroups}
                      onCreateGroup={createAdGroup}
                      ariaLabel={`Assign ad group for ${n.number}`}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <FlowSelect
                      value={n.flowId}
                      onChange={(v) => setFlow(n.id, v)}
                      flows={customFlows}
                      ariaLabel={`Assign flow for ${n.number}`}
                    />
                    {n.flowId && (
                      <button
                        type="button"
                        onClick={() => setFlow(n.id, "")}
                        className="mt-1 block text-[11px] font-semibold text-danger hover:text-danger"
                      >
                        Remove flow
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {/* Display-only: status comes from the server row. */}
                    {n.status === "released" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-background-light px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                        <span className="h-1.5 w-1.5 rounded-full bg-text-secondary/50" />
                        Released
                      </span>
                    ) : n.status === "pending" ? (
                      /* Claimed before the purchase was attempted. Still showing
                         this means the purchase never finished - visible on
                         purpose, since the alternative was an invisible charge. */
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
                        Purchase incomplete
                      </span>
                    ) : n.status === "failed" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
                        Purchase failed
                      </span>
                    ) : n.flowId === "" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
                        No flow
                      </span>
                    ) : (
                      <span
                        className={[
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                          n.status === "active"
                            ? "bg-success/10 text-success"
                            : "bg-background-light text-text-secondary",
                        ].join(" ")}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            n.status === "active" ? "bg-success" : "bg-text-secondary/50"
                          }`}
                        />
                        {n.status === "active" ? "Active" : "Paused"}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-text-secondary">
                    {numberCreatedLabel(n.createdAt, tz)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canManage && n.status !== "released" && (
                      <button
                        type="button"
                        onClick={() => {
                          setReleaseTyped("");
                          setReleasing(n);
                        }}
                        className="text-[11px] font-semibold text-danger hover:text-danger/80"
                      >
                        Release
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!releasing}
        onOpenChange={(o) => {
          if (!o) {
            setReleasing(null);
            setReleaseTyped("");
          }
        }}
        title="Release this number?"
        description={
          releasing
            ? `${releasing.number} will stop ringing immediately and cannot be recovered - it goes back to the carrier pool, and someone else may take it. Calls already on record keep their history.`
            : ""
        }
        confirmLabel={releaseNumber.isPending ? "Releasing…" : "Release number"}
        onConfirm={confirmRelease}
        isLoading={releaseNumber.isPending}
        confirmDisabled={!releaseConfirmed}
        variant="destructive"
      >
        {releasing && (
          <div className="mt-4 space-y-2">
            <label htmlFor="release-confirm" className="block text-sm text-secondary">
              Type <span className="font-medium text-primary">{releasing.number}</span> to confirm
            </label>
            <input
              id="release-confirm"
              type="text"
              inputMode="tel"
              autoComplete="off"
              autoFocus
              value={releaseTyped}
              onChange={(e) => setReleaseTyped(e.target.value)}
              placeholder={releasing.number}
              className="w-full rounded border border-border px-2 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
        )}
      </ConfirmDialog>

      <GetNumberDialog
        open={getOpen}
        onClose={() => setGetOpen(false)}
        onConfirm={addNumber}
        flows={customFlows}
        onToast={onToast}
      />
    </div>
  );
}

/* ─────────────────── "Get a number" dialog ───────────────────
 * Pick a type + area code, search CTM's live inventory, choose a number, give
 * a REQUIRED forward-to number (where calls ring), optionally pick a call
 * flow, then buy. No price anywhere — numbers are included in the plan
 * (plan §2: CTM's per-number cost never reaches the UI). */

/** Basic US phone validation → E.164, or null while invalid. Accepts 10
 *  digits (assumed +1) or 11 digits starting with 1, any formatting. */
function toUsE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function GetNumberDialog({
  open,
  onClose,
  onConfirm,
  flows,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (n: OwnedNumber) => void;
  flows: { id: string; label: string }[];
  onToast: (m: string) => void;
}) {
  const [type, setType] = useState<NumberType>("Local");
  const [areaCode, setAreaCode] = useState("201");
  const [flowId, setFlowId] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [available, setAvailable] = useState<AvailableNumber[]>([]);
  const [searched, setSearched] = useState(false);
  // The number the user tapped to buy — drives the purchase-confirm step.
  const [pending, setPending] = useState<AvailableNumber | null>(null);
  const searchNumbers = useSearchNumbers();
  const buyNumber = useBuyNumber();

  const forwardE164 = toUsE164(forwardTo);

  // Reset when the panel opens. No auto-search: a search is a live CTM
  // inventory call, so it only fires on an explicit click.
  useEffect(() => {
    if (open) {
      setAvailable([]);
      setSearched(false);
      setPending(null);
      setFlowId("");
      setForwardTo("");
    }
  }, [open]);

  function runSearch(nextType: NumberType = type) {
    const digits = areaCode.replace(/\D/g, "").slice(0, 3);
    searchNumbers.mutate(
      {
        type: nextType === "Toll-free" ? "tollfree" : "local",
        ...(nextType !== "Toll-free" && digits.length === 3
          ? { areacode: digits }
          : {}),
      },
      {
        onSuccess: (nums) => {
          setAvailable(nums);
          setSearched(true);
        },
        onError: (err) => {
          setAvailable([]);
          setSearched(true);
          onToast(apiErrorMessage(err, "Number search failed — try again"));
        },
      },
    );
  }

  function confirmBuy(num: AvailableNumber) {
    // Real purchase. Forward-to is REQUIRED (an unrouted number would eat
    // calls), the flow is optional, and the pending-disable below is the
    // double-buy protection.
    if (!forwardE164 || buyNumber.isPending) return;
    buyNumber.mutate(
      {
        phone_number: num.e164,
        forward_to_e164: forwardE164,
        ...(flowId ? { call_flow_id: flowId } : {}),
      },
      {
        onSuccess: (data: { number: PhoneNumberRow; warnings?: string[] }) => {
          (data.warnings ?? []).forEach((w) => onToast(w));
          onConfirm(mapOwnedNumber(data.number));
          setFlowId("");
          setPending(null);
        },
        onError: (err) => {
          onToast(
            apiErrorMessage(err, "Purchase failed — the number may no longer be available"),
          );
          setPending(null);
        },
      },
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Get a number" size="lg">
      <div className="space-y-5">
          {/* Number type toggle */}
          <div>
            <p className="mb-1.5 text-sm font-semibold text-text-secondary">
              Number type
            </p>
            <div className="grid grid-cols-2 gap-1 rounded-card border border-border bg-background-light p-1">
              {(["Local", "Toll-free"] as NumberType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setType(t);
                    runSearch(t);
                  }}
                  className={[
                    "rounded-md px-3 py-2 text-sm font-semibold transition",
                    type === t
                      ? "bg-surface-light text-primary shadow-sm"
                      : "text-text-secondary hover:text-text-primary",
                  ].join(" ")}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Area code */}
          <input
            value={type === "Toll-free" ? "" : areaCode}
            disabled={type === "Toll-free"}
            onChange={(e) => setAreaCode(e.target.value)}
            placeholder="Area code"
            inputMode="numeric"
            maxLength={3}
            aria-label="Area code"
            className="w-full rounded-lg border border-border bg-surface-light px-3 py-2.5 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-background-light disabled:text-text-secondary/60"
          />

          {/* Refresh + Search */}
          <div className="flex items-center justify-end gap-4">
            <button
              type="button"
              onClick={() => runSearch()}
              disabled={searchNumbers.isPending}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCw
                className={`h-4 w-4 ${searchNumbers.isPending ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => runSearch()}
              disabled={searchNumbers.isPending}
              className="rounded-full border border-border bg-surface-light px-5 py-2 text-sm font-semibold text-text-primary hover:bg-background-light disabled:cursor-not-allowed disabled:opacity-50"
            >
              {searchNumbers.isPending ? "Searching…" : "Search"}
            </button>
          </div>

          {/* REQUIRED forward-to — where calls to the new number ring. */}
          <div>
            <label
              htmlFor="get-number-forward-to"
              className="mb-1.5 block text-sm font-semibold text-text-secondary"
            >
              Forward calls to{" "}
              <span className="font-normal text-text-secondary/60">(required)</span>
            </label>
            <input
              id="get-number-forward-to"
              value={forwardTo}
              onChange={(e) => setForwardTo(e.target.value)}
              placeholder="(555) 123-4567"
              inputMode="tel"
              aria-invalid={forwardTo.trim() !== "" && !forwardE164}
              className="w-full rounded-lg border border-border bg-surface-light px-3 py-2.5 text-sm text-text-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p className="mt-1 text-[12px] leading-snug text-text-secondary/60">
              US number, 10 digits — e.g. (555) 123-4567. Calls to your new
              number ring here.
            </p>
            {forwardTo.trim() !== "" && !forwardE164 && (
              <p className="mt-1 text-[12px] font-medium text-danger">
                Enter a valid US phone number (10 digits).
              </p>
            )}
          </div>

          {/* Optional flow assignment for the number being provisioned */}
          <div>
            <p className="mb-1.5 text-sm font-semibold text-text-secondary">
              Assign flow{" "}
              <span className="font-normal text-text-secondary/60">(optional)</span>
            </p>
            <FlowSelect
              value={flowId}
              onChange={setFlowId}
              flows={flows}
              ariaLabel="Assign flow for new number"
            />
          </div>

          {/* Results */}
          <div>
            <p className="mb-2 text-sm font-semibold text-text-secondary">
              Choose a number from the list
            </p>
            {available.length === 0 ? (
              <p className="rounded-lg bg-background-light px-4 py-6 text-center text-[13px] text-text-secondary/60">
                {searchNumbers.isPending
                  ? "Searching available numbers…"
                  : searched
                    ? "No numbers available — try another area code."
                    : "Search to see available numbers."}
              </p>
            ) : (
              <ul className="space-y-2.5">
                {available.map((num) => (
                  <li key={num.e164}>
                    <button
                      type="button"
                      onClick={() => setPending(num)}
                      className="flex w-full items-center justify-between rounded-lg bg-background-light px-4 py-3.5 text-left transition hover:bg-primary/10 hover:ring-1 hover:ring-primary/20"
                    >
                      <span className="font-mono text-[15px] font-medium text-text-primary">
                        {num.display}
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-secondary">
                        <Check className="h-4 w-4" />
                        Get number
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-4 text-[13px] leading-snug text-text-secondary/60">
              Numbers are included in your plan. Choosing a number opens a
              confirmation before anything is provisioned.
            </p>
          </div>
        </div>

      {/* Purchase confirmation — provisioning is permanent enough to deserve
          an explicit approve step (and forward-to must be valid by now).
          Nested ui/confirm-dialog: stacked Radix Dialogs dismiss the
          innermost (this one) first on Escape, so no manual key handling
          is needed here. */}
      <ConfirmDialog
        open={!!pending}
        onOpenChange={(o) => {
          if (!o) setPending(null);
        }}
        title="Confirm number"
        description="You're adding a new phone number to your account. Review the details, then confirm."
        confirmLabel={buyNumber.isPending ? "Buying…" : "Confirm"}
        onConfirm={() => pending && confirmBuy(pending)}
        isLoading={buyNumber.isPending}
      >
        {pending && (
          <>
            <div className="mt-4 space-y-2 rounded-card border border-border bg-background-light p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">Number</span>
                <span className="font-mono font-semibold text-text-primary">
                  {pending.display}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">Type</span>
                <span className="font-medium text-text-secondary">{type}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">Forwards to</span>
                <span className="font-mono font-medium text-text-secondary">
                  {forwardE164 ?? "Enter a number"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">Assigned flow</span>
                <span className="font-medium text-text-secondary">
                  {flows.find((f) => f.id === flowId)?.label ?? "None (optional)"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between border-t border-border pt-2">
                <span className="font-semibold text-text-secondary">Price</span>
                <span className="text-[13px] font-medium text-text-secondary/60">
                  Included in plan
                </span>
              </div>
            </div>

            {!forwardE164 && (
              <p className="mt-3 text-[12px] leading-snug text-warning">
                Enter a valid forward-to number before confirming — every
                number must route somewhere.
              </p>
            )}
          </>
        )}
      </ConfirmDialog>
    </Modal>
  );
}

// Compatibility re-export — OwnedNumber now lives in the shared seam layer
// (lib/api/communication-shared/phone-numbers.ts); existing imports from this
// component keep working.
export type { OwnedNumber };
