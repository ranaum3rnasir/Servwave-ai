// Phone module — Training view.
//
// Ported from Emanuel's PhonePage monolith (region L4906–6403): the call-training
// page. A trainee picks a role + scenario; the matching AI trainer bot places a
// role-play "call" (browser SpeechSynthesis / SpeechRecognition, gracefully
// degraded) and drills the company script. Also the History sub-tab (who trained,
// score, recording) and the live SimulationModal.
//
// Faithful cut-and-reskin:
//   • Domain data comes from the `@/lib/api/communication` seam hooks
//     (useTrainingScenarios / useTrainingSessions) instead of module-scope
//     constants; label maps / role list / mutation come from the same seam.
//   • Cross-cutting helpers (scoreTone, initials, InfoRow, dayLabel, shortTime,
//     clock) come from the shared phone kernel.
//   • Tailwind tokens swapped indigo/slate → ALPHA design tokens; emerald / amber
//     / rose / sky / violet / lime status tints kept verbatim.
//   • Hand-rolled overlays (TrainingSessionDrawer, SimulationModal) kept as-is —
//     only token-swapped. Speech mocks and their capability guards are preserved.
import { useState, useEffect, useMemo, useRef } from "react";
import {
  Headphones,
  Wrench,
  Receipt,
  Truck,
  GraduationCap,
  ListChecks,
  Bot,
  FileText,
  Phone,
  Filter,
  Search,
  Play,
  X,
  Sparkles,
  Mic,
  MicOff,
  ChevronsUpDown,
  ChevronUp,
  ChevronDown,
  PhoneOff,
  User,
  Send,
  Volume2,
  VolumeX,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";

import {
  useTrainingScenarios,
  useTrainingSessions,
  useStartTrainingSession,
  TRAINING_ROLES,
  TRAINING_OUTCOME_LABELS,
} from "@/lib/api/communication";
import type {
  TrainingScenario,
  TrainingTurn,
  TrainingOutcome,
  TrainingSession,
  TrainingRoleId,
} from "@/lib/api/communication";

import { SelectField } from "@/components/form/SelectField";
import { Modal } from "@/components/ui/modal";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import {
  scoreTone,
  InfoRow,
  dayLabel,
  shortTime,
  clock,
} from "@/components/communication/phone/shared";
import { getInitials } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { useScheduleTimezone } from '@/lib/schedule-tz';

/** Filter-strip option lists. Module scope so the array identity is stable. */
const ROLE_FILTER_OPTIONS = [
  { value: "all", label: "All roles" },
  ...TRAINING_ROLES.map((r) => ({ value: r.id as string, label: r.label })),
];
const OUTCOME_FILTER_OPTIONS = [
  { value: "all", label: "All results" },
  { value: "passed", label: "Passed" },
  { value: "needs_work", label: "Needs work" },
  { value: "incomplete", label: "Incomplete" },
];

/* ── Minimal Web Speech API surface ──────────────────────────────
 * The browser SpeechRecognition API is not in the standard DOM lib types.
 * Declare only the members this view actually reads, so we can drop the
 * `as any` casts without pulling in a full ambient typing dependency. */
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
type SpeechWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };

/* ───────────────────────── Training ─────────────────────────
 * Call-training simulations: pick a role + scenario, and an AI trainer bot
 * places a role-play call to drill the company script. */

const TRAINING_ROLE_ICON: Record<
  TrainingRoleId,
  React.ComponentType<{ className?: string }>
> = {
  office: Headphones,
  technician: Wrench,
  billing: Receipt,
  dispatch: Truck,
};

const DIFFICULTY_TONE: Record<string, string> = {
  Beginner: "bg-success/10 text-success",
  Intermediate: "bg-warning/10 text-warning",
  Advanced: "bg-danger/10 text-danger",
};

export function TrainingView({
  onToast,
}: {
  onToast: (m: string) => void;
}) {
  const [view, setView] = useState<"run" | "history">("run");
  const [roleId, setRoleId] = useState<TrainingRoleId | null>(null);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [running, setRunning] = useState<TrainingScenario | null>(null);
  const [showScript, setShowScript] = useState(false);

  const { data: allScenarios = [] } = useTrainingScenarios();
  const { data: sessions = [] } = useTrainingSessions();

  const scenarios = useMemo(
    () => allScenarios.filter((s) => s.roleId === roleId),
    [allScenarios, roleId],
  );
  const selected = scenarios.find((s) => s.id === scenarioId) ?? null;

  return (
    <div className="space-y-6 p-6">
      {/* Intro */}
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-text-primary">Call training</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Run live phone simulations against the company script. Pick your role
          and a scenario — the matching AI trainer bot calls you and role-plays
          the customer, so the whole office answers the phone the same way.
        </p>
      </div>

      {/* Sub-tabs — run a new simulation, or review who's been trained. */}
      <div className="flex items-center gap-1 border-b border-border">
        <TrainingSubTab
          active={view === "run"}
          onClick={() => setView("run")}
          label="Run training"
          icon={GraduationCap}
        />
        <TrainingSubTab
          active={view === "history"}
          onClick={() => setView("history")}
          label="History"
          icon={ListChecks}
          count={sessions.length}
        />
      </div>

      {view === "history" && <TrainingHistory onToast={onToast} />}

      {view === "run" && (
        <>
          {/* Step 1 — role */}
          <div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
          1 · Choose your role
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TRAINING_ROLES.map((r) => {
            const Icon = TRAINING_ROLE_ICON[r.id];
            const active = roleId === r.id;
            const count = allScenarios.filter((s) => s.roleId === r.id).length;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  setRoleId(r.id);
                  setScenarioId(null);
                }}
                className={[
                  "rounded-lg border p-4 text-left transition",
                  active
                    ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                    : "border-border bg-surface-light hover:border-primary/30 hover:bg-primary/5",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      "flex h-9 w-9 items-center justify-center rounded-full",
                      active ? "bg-primary text-on-fill" : "bg-background-light text-text-secondary",
                    ].join(" ")}
                  >
                    <Icon className="h-4.5 w-4.5" />
                  </span>
                  <span className="text-sm font-semibold text-text-primary">{r.label}</span>
                </div>
                <p className="mt-2 text-[12px] leading-snug text-text-secondary">{r.blurb}</p>
                <p className="mt-2 text-[11px] font-medium text-text-secondary">
                  {count} scenario{count === 1 ? "" : "s"}
                </p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step 2 — scenario */}
      {roleId && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            2 · Choose a scenario
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {scenarios.map((s) => {
              const active = scenarioId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setScenarioId(s.id)}
                  className={[
                    "rounded-lg border p-4 text-left transition",
                    active
                      ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
                      : "border-border bg-surface-light hover:border-primary/30 hover:bg-primary/5",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-text-primary">{s.title}</span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${DIFFICULTY_TONE[s.difficulty]}`}
                    >
                      {s.difficulty}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-snug text-text-secondary">
                    {s.scriptFocus}
                  </p>
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-text-secondary">
                    <span className="inline-flex items-center gap-1">
                      <Bot className="h-3 w-3" /> {s.trainerName}
                    </span>
                    <span>·</span>
                    <span>~{s.durationMin} min</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Start panel */}
      {selected && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-primary/20 bg-primary/5 p-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary">{selected.title}</p>
              <p className="mt-0.5 text-[12px] text-text-secondary">
                AI trainer <span className="font-medium">{selected.trainerName}</span> will
                role-play: {selected.persona}
              </p>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setShowScript((s) => !s)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-light px-3 py-2.5 text-sm font-semibold text-text-secondary hover:bg-background-light"
              >
                <FileText className="h-4 w-4" />
                {showScript ? "Hide script" : "View full script"}
              </button>
              <button
                type="button"
                onClick={() => setRunning(selected)}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-on-fill shadow-sm hover:bg-primary/90"
              >
                <Phone className="h-4 w-4" />
                Start simulation call
              </button>
            </div>
          </div>

          {/* Readable script — what the AI customer says and the on-script
              answer the trainee practices, turn by turn. */}
          {showScript && (
            <div className="rounded-card border border-border bg-surface-light p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                  Company script · {selected.scriptFocus}
                </p>
                <span className="text-[11px] text-text-secondary">
                  {selected.dialogue.length} exchanges
                </span>
              </div>
              <ol className="space-y-3">
                {selected.dialogue.map((turn, i) => (
                  <li key={i} className="border-l-2 border-border pl-3">
                    <div className="flex items-start gap-2">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-background-light text-text-secondary">
                        <Bot className="h-3 w-3" />
                      </span>
                      <p className="text-[13px] leading-snug text-text-secondary">
                        <span className="font-medium text-text-secondary">Customer:</span>{" "}
                        {turn.customer}
                      </p>
                    </div>
                    <div className="mt-1.5 flex items-start gap-2">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Headphones className="h-3 w-3" />
                      </span>
                      <p className="text-[13px] font-medium leading-snug text-text-secondary">
                        <span className="text-primary">You:</span> {turn.rep}
                      </p>
                    </div>
                    {turn.cue && (
                      <p className="mt-1 pl-7 text-[11px] text-text-secondary">💡 {turn.cue}</p>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
        </>
      )}

      {running && (
        <SimulationModal
          scenario={running}
          onClose={() => setRunning(null)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

function TrainingSubTab({
  active,
  onClick,
  label,
  icon: Icon,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition",
        active
          ? "border-primary text-text-primary"
          : "border-transparent text-text-secondary hover:text-text-secondary",
      ].join(" ")}
    >
      <Icon className="h-4 w-4" />
      {label}
      {typeof count === "number" && (
        <span className="ml-0.5 rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">
          {count}
        </span>
      )}
    </button>
  );
}

const TRAINING_OUTCOME_TONE: Record<TrainingOutcome, string> = {
  passed: "bg-success/10 text-success ring-success/20",
  needs_work: "bg-warning/10 text-warning ring-warning/20",
  incomplete: "bg-background-light text-text-secondary ring-border",
};

/* Training → History: who trained, on what, the score, when — filterable, with
 * a retained recording for review (PHONE-SYSTEM-PRD §14.9). */
function TrainingHistory({ onToast }: { onToast: (m: string) => void }) {
  const tz = useScheduleTimezone();
  const [trainee, setTrainee] = useState<string>("all");
  const [role, setRole] = useState<string>("all");
  const [outcome, setOutcome] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [statView, setStatView] = useState<TrainStatKey | null>(null);
  const [sort, setSort] = useState<{ key: TrainSortKey; dir: "asc" | "desc" }>({
    key: "when",
    dir: "desc",
  });
  const [selected, setSelected] = useState<TrainingSession | null>(null);

  const { data: sessions = [] } = useTrainingSessions();

  const trainees = useMemo(
    () => [...new Set(sessions.map((s) => s.traineeName))].sort(),
    [sessions],
  );
  // The count is read inside SelectField (DESIGN_SYSTEM.md §4.2), so this list
  // becomes searchable on its own once an org has ten-plus trained people.
  const traineeOptions = useMemo(
    () => [
      { value: "all", label: "All people" },
      ...trainees.map((t) => ({ value: t, label: t })),
    ],
    [trainees],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions
      .filter((s) => trainee === "all" || s.traineeName === trainee)
      .filter((s) => role === "all" || s.roleId === role)
      .filter((s) => outcome === "all" || s.outcome === outcome)
      .filter(
        (s) =>
          !q ||
          [s.traineeName, s.scenarioTitle, s.trainerName, s.coachingNote]
            .join(" ")
            .toLowerCase()
            .includes(q),
      )
      .sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  }, [sessions, trainee, role, outcome, query]);

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const outcomeRank: Record<string, number> = {
      passed: 3,
      needs_work: 2,
      incomplete: 1,
    };
    const val = (s: TrainingSession): string | number => {
      switch (sort.key) {
        case "trainee":
          return s.traineeName.toLowerCase();
        case "scenario":
          return s.scenarioTitle.toLowerCase();
        case "trainer":
          return s.trainerName.toLowerCase();
        case "score":
          return s.score ?? -1;
        case "result":
          return outcomeRank[s.outcome] ?? 0;
        case "length":
          return s.durationSec;
        case "when":
        default:
          return s.completedAt;
      }
    };
    return [...filtered].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [filtered, sort]);

  function toggleSort(key: TrainSortKey) {
    setSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "trainee" || key === "scenario" || key === "trainer" ? "asc" : "desc" },
    );
  }

  const scored = filtered.filter((s) => s.score != null);
  const avg = scored.length
    ? Math.round(scored.reduce((sum, s) => sum + (s.score ?? 0), 0) / scored.length)
    : 0;
  const passRate = filtered.length
    ? Math.round(
        (100 * filtered.filter((s) => s.outcome === "passed").length) /
          filtered.length,
      )
    : 0;
  const people = new Set(filtered.map((s) => s.traineeName)).size;

  const breakdown = useMemo<{ rows: BreakdownRow[]; total: number }>(() => {
    if (!statView) return { rows: [], total: 0 };

    if (statView === "sessions" || statView === "pass") {
      const buckets: { key: string; label: string; tone: string }[] = [
        { key: "passed", label: "Passed", tone: "bg-success" },
        { key: "needs_work", label: "Needs work", tone: "bg-warning" },
        { key: "incomplete", label: "Incomplete", tone: "bg-text-secondary" },
      ];
      const rows = buckets.map((b) => ({
        ...b,
        count: filtered.filter((s) => s.outcome === b.key).length,
      }));
      return { rows, total: filtered.length };
    }

    if (statView === "people") {
      const byName = new Map<string, { count: number; role: string }>();
      for (const s of filtered) {
        const cur = byName.get(s.traineeName) ?? { count: 0, role: s.traineeRole };
        cur.count += 1;
        byName.set(s.traineeName, cur);
      }
      const rows = [...byName.entries()]
        .map(([name, v]) => ({
          key: name,
          label: name,
          sub: `${v.role} · ${v.count} session${v.count === 1 ? "" : "s"}`,
          count: v.count,
          tone: "bg-primary",
        }))
        .sort((a, b) => b.count - a.count);
      return { rows, total: filtered.length };
    }

    // score distribution
    const bands: { key: string; label: string; tone: string; test: (n: number) => boolean }[] = [
      { key: "b90", label: "90–100", tone: "bg-success", test: (n) => n >= 90 },
      { key: "b80", label: "80–89", tone: "bg-success/60", test: (n) => n >= 80 && n < 90 },
      { key: "b70", label: "70–79", tone: "bg-warning", test: (n) => n >= 70 && n < 80 },
      { key: "blow", label: "Below 70", tone: "bg-danger", test: (n) => n < 70 },
    ];
    const rows = bands.map((b) => ({
      key: b.key,
      label: b.label,
      tone: b.tone,
      count: scored.filter((s) => b.test(s.score ?? 0)).length,
    }));
    return { rows, total: scored.length };
  }, [statView, filtered, scored]);

  function toggleStat(k: TrainStatKey) {
    setStatView((cur) => (cur === k ? null : k));
  }

  const activeFilters =
    (trainee !== "all" ? 1 : 0) +
    (role !== "all" ? 1 : 0) +
    (outcome !== "all" ? 1 : 0) +
    (query.trim() ? 1 : 0);

  function reset() {
    setTrainee("all");
    setRole("all");
    setOutcome("all");
    setQuery("");
  }

  return (
    <div className="space-y-4">
      {/* Summary — press a card to drill into the numbers */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <TrainStat
          label="Sessions"
          value={String(filtered.length)}
          active={statView === "sessions"}
          onClick={() => toggleStat("sessions")}
        />
        <TrainStat
          label="People trained"
          value={String(people)}
          active={statView === "people"}
          onClick={() => toggleStat("people")}
        />
        <TrainStat
          label="Avg score"
          value={scored.length ? `${avg}` : "—"}
          active={statView === "score"}
          onClick={() => toggleStat("score")}
        />
        <TrainStat
          label="Pass rate"
          value={`${passRate}%`}
          active={statView === "pass"}
          onClick={() => toggleStat("pass")}
        />
      </div>

      {statView && (
        <TrainStatBreakdown
          statKey={statView}
          rows={breakdown.rows}
          total={breakdown.total}
          onClose={() => setStatView(null)}
        />
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-light p-3">
        <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-text-secondary">
          <Filter className="h-4 w-4 text-text-secondary" /> Filter
        </span>
        <SelectField
          value={trainee}
          onValueChange={setTrainee}
          aria-label="Filter by trainee"
          className="inline-flex h-9 min-w-[150px] text-[13px]"
          options={traineeOptions}
        />
        <SelectField
          value={role}
          onValueChange={setRole}
          aria-label="Filter by role"
          className="inline-flex h-9 min-w-[150px] text-[13px]"
          options={ROLE_FILTER_OPTIONS}
        />
        <SelectField
          value={outcome}
          onValueChange={setOutcome}
          aria-label="Filter by result"
          className="inline-flex h-9 min-w-[150px] text-[13px]"
          options={OUTCOME_FILTER_OPTIONS}
        />
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search training…"
            className="w-full rounded-md border border-border bg-surface-light py-2 pl-8 pr-3 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
          />
        </div>
        {activeFilters > 0 && (
          <button
            type="button"
            onClick={reset}
            className="text-[12px] font-semibold text-text-secondary hover:text-text-secondary"
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-card border border-border bg-surface-light">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-[13px]">
            <thead>
              <tr className="border-b border-border bg-background-light text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                <TrainSortHeader label="Trainee" sortKey="trainee" sort={sort} onSort={toggleSort} />
                <TrainSortHeader label="Scenario" sortKey="scenario" sort={sort} onSort={toggleSort} />
                <TrainSortHeader label="Trainer" sortKey="trainer" sort={sort} onSort={toggleSort} />
                <TrainSortHeader label="Score" sortKey="score" sort={sort} onSort={toggleSort} />
                <TrainSortHeader label="Result" sortKey="result" sort={sort} onSort={toggleSort} />
                <TrainSortHeader label="When" sortKey="when" sort={sort} onSort={toggleSort} />
                <TrainSortHeader label="Length" sortKey="length" sort={sort} onSort={toggleSort} />
                <th className="px-3 py-2">Recording</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-text-secondary">
                    <EmptyState title="No training sessions match these filters." />
                  </td>
                </tr>
              ) : (
                sorted.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => setSelected(s)}
                    className="cursor-pointer align-top hover:bg-background-light"
                  >
                    <td className="px-3 py-2.5">
                      <p className="font-semibold text-text-primary">{s.traineeName}</p>
                      <p className="text-[11px] text-text-secondary">{s.traineeRole}</p>
                    </td>
                    <td className="px-3 py-2.5">
                      <p className="text-text-secondary">{s.scenarioTitle}</p>
                      <span
                        className={`mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${DIFFICULTY_TONE[s.difficulty]}`}
                      >
                        {s.difficulty}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-text-secondary">
                      <span className="inline-flex items-center gap-1">
                        <Bot className="h-3 w-3 text-text-secondary" />
                        {s.trainerName.replace(" (AI trainer)", "")}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {s.score == null ? (
                        <span className="text-text-secondary">—</span>
                      ) : (
                        <span
                          className={`inline-flex h-7 min-w-[34px] items-center justify-center rounded-md px-1.5 text-[12px] font-bold ring-1 ${scoreTone(s.score)}`}
                        >
                          {s.score}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${TRAINING_OUTCOME_TONE[s.outcome]}`}
                      >
                        {TRAINING_OUTCOME_LABELS[s.outcome]}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-text-secondary">
                      <p>{dayLabel(s.completedAt, tz)}</p>
                      <p className="text-[11px] text-text-secondary">
                        {shortTime(s.completedAt, tz)}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-text-secondary">
                      {clock(s.durationSec)}
                    </td>
                    <td className="px-3 py-2.5">
                      {s.hasRecording ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToast(
                              `▶️ Playing ${s.traineeName}'s recording — ${s.scenarioTitle}`,
                            );
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2 py-1 text-[11px] font-semibold text-text-secondary hover:bg-background-light"
                        >
                          <Play className="h-3 w-3" /> Play
                        </button>
                      ) : (
                        <span className="text-[11px] text-text-secondary">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-text-secondary">
        Recordings are retained for training and QA review. Showing{" "}
        {filtered.length} of {sessions.length} sessions. Press a row for
        the full session.
      </p>

      {selected && (
        <TrainingSessionDrawer
          session={selected}
          onClose={() => setSelected(null)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

/* Right-side slide-over with the full record of one training session
 * (PHONE-SYSTEM-PRD §14.9). Mirrors the call detail drawer. */
function TrainingSessionDrawer({
  session: s,
  onClose,
  onToast,
}: {
  session: TrainingSession;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const tz = useScheduleTimezone();
  const trainer = s.trainerName.replace(" (AI trainer)", "");

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="sm:max-w-md flex flex-col p-0">
        <SheetHeader divider className="px-5 py-3.5">
          <SheetTitle>Training session</SheetTitle>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Trainee + outcome header */}
          <div className="bg-background-light/70 px-5 py-4">
            <p className="text-lg font-semibold text-text-primary">{s.traineeName}</p>
            <p className="mt-0.5 text-sm text-text-secondary">{s.traineeRole}</p>
            <div className="mt-3 flex items-center gap-2">
              {s.score == null ? (
                <span className="inline-flex h-9 min-w-[44px] items-center justify-center rounded-md bg-background-light px-2 text-sm font-bold text-text-secondary">
                  —
                </span>
              ) : (
                <span
                  className={`inline-flex h-9 min-w-[44px] items-center justify-center rounded-md px-2 text-sm font-bold ring-1 ${scoreTone(s.score)}`}
                >
                  {s.score}
                </span>
              )}
              <span
                className={`inline-block rounded-full px-2.5 py-1 text-[12px] font-semibold ring-1 ${TRAINING_OUTCOME_TONE[s.outcome]}`}
              >
                {TRAINING_OUTCOME_LABELS[s.outcome]}
              </span>
            </div>
          </div>

          <div className="space-y-5 px-5 py-4">
            {/* Scenario */}
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                Scenario
              </p>
              <p className="text-sm font-medium text-text-primary">{s.scenarioTitle}</p>
              <span
                className={`mt-1 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${DIFFICULTY_TONE[s.difficulty]}`}
              >
                {s.difficulty}
              </span>
            </div>

            {/* Facts grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <InfoRow label="AI trainer" value={trainer} />
              <InfoRow label="Role" value={s.traineeRole} />
              <InfoRow label="When" value={`${dayLabel(s.completedAt, tz)}, ${shortTime(s.completedAt, tz)}`} />
              <InfoRow label="Length" value={clock(s.durationSec)} />
            </div>

            {/* AI coaching note */}
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                AI coaching summary
                <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                  <Sparkles className="h-3 w-3" /> AI
                </span>
              </p>
              <p className="rounded-card border border-border bg-background-light/70 p-3 text-[13px] leading-relaxed text-text-secondary">
                {s.coachingNote}
              </p>
            </div>

            {/* Recording */}
            <div>
              <p className="mb-2 text-sm font-semibold text-text-primary">Recording</p>
              {s.hasRecording ? (
                <button
                  type="button"
                  onClick={() =>
                    onToast(`▶️ Playing ${s.traineeName}'s recording — ${s.scenarioTitle}`)
                  }
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-light px-3 py-1.5 text-[13px] font-semibold text-text-secondary hover:bg-background-light"
                >
                  <Play className="h-4 w-4" /> Play recording
                </button>
              ) : (
                <p className="text-[13px] text-text-secondary">
                  No recording — the run was not completed.
                </p>
              )}
            </div>

            {/* Transcript */}
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-primary">
                Transcript
                {s.transcript && s.transcript.length > 0 && (
                  <span className="inline-flex items-center gap-1 rounded bg-background-light px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">
                    <Mic className="h-3 w-3" /> {s.transcript.length} turns
                  </span>
                )}
              </p>
              {s.transcript && s.transcript.length > 0 ? (
                <div className="space-y-2.5 rounded-card border border-border bg-background-light/50 p-3">
                  {s.transcript.map((turn, i) => {
                    const isTrainee = turn.speaker === "trainee";
                    const who = isTrainee ? s.traineeName : trainer;
                    const role = isTrainee ? s.traineeRole : "AI trainer";
                    return (
                      <div key={i} className="flex gap-2.5">
                        <span
                          className={`mt-0.5 inline-flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold ${
                            isTrainee
                              ? "bg-primary/10 text-primary"
                              : "bg-background-light text-text-secondary"
                          }`}
                        >
                          {getInitials(who)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <span className="text-[12px] font-semibold text-text-primary">
                              {who}
                            </span>
                            <span className="text-[10px] uppercase tracking-wide text-text-secondary">
                              {role}
                            </span>
                            <span className="ml-auto text-[10px] tabular-nums text-text-secondary">
                              {turn.at}
                            </span>
                          </div>
                          <p
                            className={`mt-0.5 rounded-lg px-2.5 py-1.5 text-[13px] leading-relaxed ${
                              isTrainee
                                ? "bg-primary/10 text-text-secondary"
                                : "bg-surface-light text-text-secondary ring-1 ring-border"
                            }`}
                          >
                            {turn.text}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[13px] text-text-secondary">
                  No transcript available for this run.
                </p>
              )}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

type TrainSortKey =
  | "trainee"
  | "scenario"
  | "trainer"
  | "score"
  | "result"
  | "when"
  | "length";

function TrainSortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: TrainSortKey;
  sort: { key: TrainSortKey; dir: "asc" | "desc" };
  onSort: (k: TrainSortKey) => void;
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th className="px-3 py-2">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`group inline-flex items-center gap-1 uppercase tracking-wide ${
          active ? "text-primary" : "hover:text-text-secondary"
        }`}
      >
        {label}
        <Icon
          className={`h-3 w-3 ${active ? "opacity-100" : "opacity-30 group-hover:opacity-70"}`}
        />
      </button>
    </th>
  );
}

function TrainStat({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group flex w-full flex-col rounded-lg border px-3 py-2.5 text-left transition ${
        active
          ? "border-primary bg-primary ring-1 ring-primary"
          : "border-border bg-surface-light hover:border-border hover:bg-background-light"
      }`}
    >
      <span
        className={`flex items-center justify-between text-[11px] font-medium uppercase tracking-wide ${
          active ? "text-on-fill/70" : "text-text-secondary"
        }`}
      >
        {label}
        <ChevronDown
          className={`h-3.5 w-3.5 transition ${
            active
              ? "text-on-fill/70"
              : "-rotate-90 text-text-secondary group-hover:text-text-secondary"
          }`}
        />
      </span>
      <span
        className={`mt-0.5 text-xl font-bold ${active ? "text-on-fill" : "text-text-primary"}`}
      >
        {value}
      </span>
    </button>
  );
}

type TrainStatKey = "sessions" | "people" | "score" | "pass";

type BreakdownRow = { key: string; label: string; sub?: string; count: number; tone: string };

function TrainStatBreakdown({
  statKey,
  rows,
  total,
  onClose,
}: {
  statKey: TrainStatKey;
  rows: BreakdownRow[];
  total: number;
  onClose: () => void;
}) {
  const titles: Record<TrainStatKey, string> = {
    sessions: "Sessions by result",
    people: "People trained — by trainee",
    score: "Score distribution",
    pass: "Pass rate breakdown",
  };
  return (
    <div className="rounded-card border border-border bg-surface-light p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[12px] font-semibold text-text-secondary">{titles[statKey]}</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-text-secondary hover:bg-background-light hover:text-text-secondary"
          aria-label="Close breakdown"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="py-4 text-center text-[12px] text-text-secondary">
          No data for the current filters.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const pct = total ? Math.round((100 * r.count) / total) : 0;
            return (
              <li key={r.key} className="flex items-center gap-3">
                <div className="w-36 shrink-0">
                  <p className="truncate text-[12px] font-medium text-text-secondary">
                    {r.label}
                  </p>
                  {r.sub && (
                    <p className="truncate text-[10px] text-text-secondary">{r.sub}</p>
                  )}
                </div>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-background-light">
                  <div
                    className={`h-full rounded-full ${r.tone}`}
                    style={{ width: `${Math.max(pct, r.count > 0 ? 4 : 0)}%` }}
                  />
                </div>
                <div className="w-16 shrink-0 text-right">
                  <span className="text-[12px] font-bold text-text-primary">{r.count}</span>
                  <span className="ml-1 text-[10px] text-text-secondary">{pct}%</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type SimTurn = { who: "customer" | "rep"; text: string };

function SimulationModal({
  scenario,
  onClose,
  onToast,
}: {
  scenario: TrainingScenario;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  type Phase = "ringing" | "incall" | "done";
  // Within "incall": "bot" = AI customer is speaking, "you" = trainee's turn,
  // "wrap" = all turns done, ready to finish.
  type Stage = "bot" | "you" | "wrap";
  const dialogue: TrainingTurn[] = scenario.dialogue;

  // Mock persistence seam — the prototype scores locally; this lets a future API
  // record completed runs without changing the on-screen behavior.
  const startSession = useStartTrainingSession();

  const [phase, setPhase] = useState<Phase>("ringing");
  const [stage, setStage] = useState<Stage>("bot");
  const [turnIdx, setTurnIdx] = useState(0);
  const [transcript, setTranscript] = useState<SimTurn[]>([]);
  const [interim, setInterim] = useState("");
  const [typed, setTyped] = useState("");
  const [listening, setListening] = useState(false);
  const [ttsOn, setTtsOn] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [score, setScore] = useState(0);

  // Capability detection — fall back gracefully when the browser can't do
  // speech synthesis / recognition (or mic permission is denied).
  const ttsSupported =
    typeof window !== "undefined" && "speechSynthesis" in window;
  const sttSupported =
    typeof window !== "undefined" &&
    !!((window as SpeechWindow).SpeechRecognition ||
      (window as SpeechWindow).webkitSpeechRecognition);

  // Refs let async speech callbacks read the latest values without stale closures.
  const turnIdxRef = useRef(0);
  const ttsOnRef = useRef(true);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const commitRepRef = useRef<(t: string) => void>(() => {});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  ttsOnRef.current = ttsOn;

  // Elapsed-time clock while the call is live.
  useEffect(() => {
    if (phase !== "incall") return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Auto-scroll the transcript as new lines land.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, interim]);

  // Tear down any speech on unmount.
  useEffect(() => {
    return () => {
      if (ttsSupported) window.speechSynthesis.cancel();
      try {
        recRef.current?.stop?.();
      } catch {
        /* ignore */
      }
    };
  }, [ttsSupported]);

  function speak(text: string, onEnd?: () => void) {
    if (!ttsSupported || !ttsOnRef.current) {
      // No voice — give the reader a beat to read the line, then continue.
      window.setTimeout(() => onEnd?.(), 700);
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    u.pitch = 1;
    u.onend = () => onEnd?.();
    u.onerror = () => onEnd?.();
    window.speechSynthesis.speak(u);
  }

  // The AI customer speaks turn `idx`, then hands the mic to the trainee.
  function playCustomerTurn(idx: number) {
    const turn = dialogue[idx];
    if (!turn) return;
    setTurnIdx(idx);
    turnIdxRef.current = idx;
    setStage("bot");
    setTranscript((t) => [...t, { who: "customer", text: turn.customer }]);
    speak(turn.customer, () => setStage("you"));
  }

  function stopListening() {
    try {
      recRef.current?.stop?.();
    } catch {
      /* ignore */
    }
    setListening(false);
  }

  // The trainee's line (spoken or typed) lands, then the AI replies.
  function commitRep(text: string) {
    const clean = text.trim();
    if (!clean) return;
    setTranscript((t) => [...t, { who: "rep", text: clean }]);
    setTyped("");
    setInterim("");
    stopListening();
    const next = turnIdxRef.current + 1;
    if (next < dialogue.length) {
      window.setTimeout(() => playCustomerTurn(next), 550);
    } else {
      setStage("wrap");
    }
  }
  commitRepRef.current = commitRep;

  function startListening() {
    if (!sttSupported) return;
    if (!recRef.current) {
      const w = window as SpeechWindow;
      const Rec = (w.SpeechRecognition || w.webkitSpeechRecognition)!;
      const r = new Rec();
      r.lang = "en-US";
      r.interimResults = true;
      r.continuous = false;
      r.onresult = (e: SpeechRecognitionEventLike) => {
        let finalT = "";
        let interimT = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (!res) continue;
          if (res.isFinal) finalT += res[0].transcript;
          else interimT += res[0].transcript;
        }
        if (interimT) setInterim(interimT);
        if (finalT) commitRepRef.current(finalT);
      };
      r.onend = () => setListening(false);
      r.onerror = () => setListening(false);
      recRef.current = r;
    }
    try {
      if (ttsSupported) window.speechSynthesis.cancel();
      recRef.current.start();
      setListening(true);
    } catch {
      /* already started */
    }
  }

  function accept() {
    setPhase("incall");
    onToast("▶️ Training simulation started");
    // Kick off the first customer line.
    window.setTimeout(() => playCustomerTurn(0), 300);
  }

  function endCall() {
    if (ttsSupported) window.speechSynthesis.cancel();
    stopListening();
    const finalScore = Math.round(85 + Math.random() * 13);
    setScore(finalScore);
    // Fire-and-forget record of the completed run (mock no-op under the seam).
    startSession.mutate({
      scenarioId: scenario.id,
      score: finalScore,
      durationSec: elapsed,
    });
    setPhase("done");
  }

  function restart() {
    if (ttsSupported) window.speechSynthesis.cancel();
    stopListening();
    setPhase("ringing");
    setStage("bot");
    setTurnIdx(0);
    turnIdxRef.current = 0;
    setTranscript([]);
    setInterim("");
    setTyped("");
    setElapsed(0);
  }

  function close() {
    if (ttsSupported) window.speechSynthesis.cancel();
    stopListening();
    onClose();
  }

  const modelLine = dialogue[turnIdx];
  const progress = transcript.filter((t) => t.who === "rep").length;

  const phaseLabel =
    phase === "ringing"
      ? "Training call · incoming…"
      : phase === "incall"
        ? `Simulation live · ${clock(elapsed)} · line ${Math.min(progress + 1, dialogue.length)}/${dialogue.length}`
        : "Simulation complete";

  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={
        <span className="inline-flex items-center gap-2">
          <span
            className={[
              "flex h-9 w-9 items-center justify-center rounded-full bg-primary text-on-fill",
              stage === "bot" && phase === "incall" ? "animate-pulse ring-4 ring-primary/20" : "",
            ].join(" ")}
          >
            <Bot className="h-4 w-4" />
          </span>
          {scenario.trainerName}
        </span>
      }
      subtitle={phaseLabel}
    >
      {phase === "ringing" && (
            <div className="space-y-4 text-center">
              <div>
                <p className="text-sm font-semibold text-text-primary">{scenario.title}</p>
                <p className="mt-1 text-[12px] text-text-secondary">{scenario.persona}</p>
                <p className="mt-2 text-[11px] text-text-secondary">
                  {scenario.trainerName} will call and role-play the customer out
                  loud. Answer back — by voice or by typing — and stay on script.
                </p>
              </div>
              <div className="flex items-center justify-center gap-6">
                <button
                  type="button"
                  onClick={close}
                  className="flex flex-col items-center gap-1 text-[11px] font-medium text-text-secondary"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
                    <PhoneOff className="h-5 w-5" />
                  </span>
                  Decline
                </button>
                <button
                  type="button"
                  onClick={accept}
                  className="flex flex-col items-center gap-1 text-[11px] font-medium text-text-secondary"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-success text-on-fill">
                    <Phone className="h-5 w-5" />
                  </span>
                  Accept
                </button>
              </div>
            </div>
          )}

          {phase === "incall" && (
            <div className="space-y-3">
              {/* Live transcript */}
              <div
                ref={scrollRef}
                className="h-60 space-y-2.5 overflow-y-auto rounded-card bg-background-light p-3"
              >
                {transcript.map((t, i) => (
                  <div
                    key={i}
                    className={`flex items-end gap-2 ${t.who === "rep" ? "flex-row-reverse" : ""}`}
                  >
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                        t.who === "rep" ? "bg-primary/10 text-primary" : "bg-background-light text-text-secondary"
                      }`}
                    >
                      {t.who === "rep" ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                    </span>
                    <p
                      className={`max-w-[80%] rounded-2xl px-3 py-2 text-[13px] leading-snug ${
                        t.who === "rep"
                          ? "rounded-br-sm bg-primary text-on-fill"
                          : "rounded-bl-sm bg-surface-light text-text-secondary ring-1 ring-border"
                      }`}
                    >
                      {t.text}
                    </p>
                  </div>
                ))}
                {interim && (
                  <div className="flex flex-row-reverse items-end gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <User className="h-3.5 w-3.5" />
                    </span>
                    <p className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary/70 px-3 py-2 text-[13px] italic leading-snug text-on-fill">
                      {interim}…
                    </p>
                  </div>
                )}
                {stage === "bot" && (
                  <p className="pl-8 text-[11px] italic text-text-secondary">
                    {scenario.trainerName} is speaking…
                  </p>
                )}
              </div>

              {/* Your line — the on-script model answer to read aloud */}
              {stage !== "wrap" && modelLine && (
                <div className="rounded-card border border-primary/20 bg-primary/5 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-primary/60">
                    Your line — read it aloud
                  </p>
                  <p className="mt-0.5 text-[13px] font-medium text-text-secondary">
                    “{modelLine.rep}”
                  </p>
                  {modelLine.cue && (
                    <p className="mt-1 text-[11px] text-primary">💡 {modelLine.cue}</p>
                  )}
                </div>
              )}

              {stage === "wrap" && (
                <div className="rounded-card border border-success/20 bg-success/10 p-3 text-center">
                  <p className="text-[13px] font-medium text-success">
                    You worked the whole script — nice. Finish to get your score.
                  </p>
                </div>
              )}

              {/* Controls */}
              <div className="space-y-2">
                {stage === "you" && (
                  <div className="flex items-center gap-2">
                    {sttSupported ? (
                      <button
                        type="button"
                        onClick={() => (listening ? stopListening() : startListening())}
                        className={[
                          "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2.5 text-[12px] font-semibold transition",
                          listening
                            ? "bg-danger text-on-fill hover:bg-danger"
                            : "bg-primary text-on-fill hover:bg-primary/90",
                        ].join(" ")}
                      >
                        {listening ? (
                          <>
                            <span className="h-2 w-2 animate-pulse rounded-full bg-on-fill" /> Listening — tap to stop
                          </>
                        ) : (
                          <>
                            <Mic className="h-4 w-4" /> Tap to talk
                          </>
                        )}
                      </button>
                    ) : (
                      <span className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-background-light px-3 py-2.5 text-[12px] font-medium text-text-secondary">
                        <MicOff className="h-4 w-4" /> Mic not available — type below
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => modelLine && commitRep(modelLine.rep)}
                      title="Auto-answer with the model line"
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-light px-3 py-2.5 text-[12px] font-semibold text-text-secondary hover:bg-background-light"
                    >
                      Use model line
                    </button>
                  </div>
                )}

                {stage === "you" && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      commitRep(typed);
                    }}
                    className="flex items-center gap-2"
                  >
                    <input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder="…or type what you'd say"
                      className="flex-1 rounded-md border border-border bg-surface-light px-3 py-2 text-[13px] focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-subtle"
                    />
                    <button
                      type="submit"
                      disabled={!typed.trim()}
                      className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-3 py-2 text-on-fill hover:bg-primary/90 disabled:opacity-40"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </form>
                )}

                <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      const nv = !ttsOn;
                      setTtsOn(nv);
                      if (!nv && ttsSupported) window.speechSynthesis.cancel();
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-light px-3 py-2 text-[12px] font-semibold text-text-secondary hover:bg-background-light"
                  >
                    {ttsOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                    {ttsOn ? "Voice on" : "Voice off"}
                  </button>
                  <div className="flex items-center gap-2">
                    {stage === "wrap" ? (
                      <button
                        type="button"
                        onClick={endCall}
                        className="inline-flex items-center gap-1.5 rounded-md bg-success px-3 py-2 text-[12px] font-semibold text-on-fill hover:bg-success"
                      >
                        <CheckCircle2 className="h-4 w-4" /> Finish
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={endCall}
                      className="inline-flex items-center gap-1.5 rounded-md bg-danger px-3 py-2 text-[12px] font-semibold text-on-fill hover:bg-danger"
                    >
                      <PhoneOff className="h-4 w-4" /> End
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {phase === "done" && (
            <div className="space-y-4 text-center">
              <div className="flex flex-col items-center">
                <span
                  className={`flex h-20 w-20 items-center justify-center rounded-full text-2xl font-bold ring-4 ${scoreTone(score)}`}
                >
                  {score}
                </span>
                <p className="mt-3 text-sm font-semibold text-text-primary">
                  Training complete
                </p>
                <p className="mt-1 text-[12px] text-text-secondary">
                  {scenario.title} · {clock(elapsed)} · {scenario.trainerName}
                </p>
              </div>
              <div className="rounded-card bg-background-light p-3 text-left">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  Coaching note
                </p>
                <p className="text-[13px] text-text-secondary">
                  {score >= 90
                    ? "Strong run — greeting, qualifying, and close all on-script. Keep it up."
                    : "Good run. Tighten up the qualifying questions and quote framing before the close."}
                </p>
              </div>
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={restart}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-light px-3 py-2 text-[12px] font-semibold text-text-secondary hover:bg-background-light"
                >
                  <RotateCcw className="h-4 w-4" /> Run again
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[12px] font-semibold text-on-fill hover:bg-primary/90"
                >
                  Done
                </button>
              </div>
            </div>
          )}
    </Modal>
  );
}
