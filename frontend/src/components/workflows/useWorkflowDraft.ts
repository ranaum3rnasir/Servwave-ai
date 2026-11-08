/**
 * useWorkflowDraft — the builder's LOCAL draft state (no I/O, no timers).
 *
 * Owns the mutable working copy of a workflow while the office edits it: name,
 * trigger, send window, and an ordered list of steps each carrying a stable
 * client `uid` (so React keys + dnd-kit ids survive reorders). **Position is
 * array index** — there is no stored `position`; `draftToInput` renumbers from
 * order, matching the server's PATCH contract (steps REPLACE the array).
 *
 * The autosave orchestration (debounce, create-on-first-save, navigate-replace)
 * lives in WorkflowBuilderPage — it reads this state, calls the mutations, then
 * feeds the server response back via `markSaved`. Keeping this hook pure of
 * react-query keeps it trivially unit-testable and the "needs setup" verdict
 * server-owned (`state.server.issues`), never recomputed client-side.
 */

import { useCallback, useMemo, useState } from 'react';
import { isAuthorableStepType } from '@/lib/api/workflows';
import type {
  ApiWorkflow,
  AutomationTriggerType,
  ValidationIssue,
  WorkflowInput,
  WorkflowStatus,
  WorkflowStepType,
} from '@/lib/api/workflows';
import type { TriggerConfig } from '@/lib/workflows/triggerModel';

// ── pure reorder (unit-tested) ────────────────────────────────────────────────

/** Move `items[from]` to index `to`, returning a NEW array (input untouched). */
export function moveStep<T>(items: T[], from: number, to: number): T[] {
  if (from === to) return items;
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

// ── types ─────────────────────────────────────────────────────────────────────

export interface DraftStep {
  /** Stable client identity — dnd-kit sortable id + React key; NOT the server id. */
  uid: string;
  step_type: WorkflowStepType;
  config: Record<string, unknown>;
}

/** The server's truth, refreshed on every load/save — drives PublishControl + badges. */
export interface ServerSnapshot {
  id: string | undefined;
  status: WorkflowStatus;
  is_enabled: boolean;
  has_unpublished_changes: boolean;
  issues: ValidationIssue[];
}

/** `'trigger'` selects the trigger node; a uid selects that step; null = nothing. */
export type Selection = string | null;

export interface WorkflowDraftState {
  name: string;
  trigger_type: AutomationTriggerType;
  trigger_config: TriggerConfig | null;
  /** False only for a brand-new, never-touched draft — `trigger_type` still
   *  holds a placeholder value (a request body needs one), but nothing about
   *  it was ever chosen, so the UI must show a picker, not describe it as a
   *  real pick. True once the office sets a trigger, or a saved workflow (real
   *  or legacy) is loaded via `hydrate`. */
  triggerConfigured: boolean;
  steps: DraftStep[];
  selectedUid: Selection;
  dirty: boolean;
  /** Monotonic edit counter — lets autosave detect edits that land mid-save. */
  revision: number;
  lastSavedAt: number | null;
  server: ServerSnapshot;
}

// ── uid + defaults ────────────────────────────────────────────────────────────

let uidSeq = 0;
function newUid(): string {
  const rnd = globalThis.crypto?.randomUUID?.();
  return rnd ?? `uid-${Date.now()}-${uidSeq++}`;
}

/**
 * Sensible starting config per step type - WAIT reads "Wait 1 day" immediately;
 * the messaging/guard steps start empty (→ server flags "needs setup").
 *
 * BOTH messaging steps seed `recipients: []` - deliberately an EMPTY array rather than an
 * absent key, and deliberately with nobody pre-selected. Seeding an audience sends to a
 * recipient nobody chose, and the empty array (not a missing key) is what makes the server
 * answer with its own sentence - "Choose who this text message goes to" / "Choose who this
 * email goes to" - instead of zod's "Required".
 *
 * Spec C slice 8 made that trade for SEND_TEXT: its seed used to be `recipient: 'customer'`,
 * back when the customer was the only audience a text could reach, so the pre-selection cost
 * the admin nothing. Once a text reached whoever an email reached, it did.
 *
 * SEND_EMAIL kept `recipient: 'customer'` at the time, and Spec B is what made that
 * unpublishable: `task` is the first entity whose audience map has NO `customer` key, so on a
 * task trigger the seeded audience is not among the picker's options, cannot be unticked, and
 * - because `normalizeRecipientFields` folds a singular `recipient` INTO the array - rides
 * along beside whatever the admin does pick. The result was `recipients: ["customer",
 * "assignees"]` and a permanent 400 from publish. Seeding nothing is the fix; on the job /
 * lead / estimate / invoice triggers it costs the admin the same one tick SEND_TEXT already
 * costs.
 *
 * The switch runs on the AUTHORABLE narrowing, not the raw stored type: storage
 * is permanently wider than the authoring surface, and this factory only mints
 * NEW steps. A stored type that is no longer authorable gets nothing, and
 * re-adding a case for one is a compile error rather than a quiet re-offer.
 *
 * Exported for the step-form suites: what a form must open cleanly on is whatever THIS
 * function mints, and a hand-copied fixture of the seed keeps passing after the seed changes -
 * which is how the customer pre-selection survived Spec B's new task entity unnoticed.
 */
export function defaultConfig(type: WorkflowStepType): Record<string, unknown> {
  switch (isAuthorableStepType(type) ? type : null) {
    case 'WAIT':
      return { duration_minutes: 1440 };
    case 'SEND_TEXT':
      return { recipients: [], body: '' };
    case 'SEND_EMAIL':
      return { recipients: [], subject: '', body: '' };
    case 'STOP_IF':
      return { condition: '' };
    default:
      return {};
  }
}

function blankState(): WorkflowDraftState {
  return {
    name: 'Untitled automation',
    trigger_type: 'JOB_COMPLETED',
    trigger_config: null,
    triggerConfigured: false,
    steps: [],
    selectedUid: null,
    dirty: false,
    revision: 0,
    lastSavedAt: null,
    server: { id: undefined, status: 'DRAFT', is_enabled: false, has_unpublished_changes: false, issues: [] },
  };
}

function snapshotOf(w: ApiWorkflow): ServerSnapshot {
  return {
    id: w.id,
    status: w.status,
    is_enabled: w.is_enabled,
    has_unpublished_changes: w.has_unpublished_changes,
    issues: w.issues,
  };
}

// ── build the request body ────────────────────────────────────────────────────

/**
 * The full create/patch body from the draft. ALWAYS carries `trigger_type`
 * beside `trigger_config` (server ignores config without it) and renumbers step
 * positions from array order.
 *
 * Deliberately omits `send_window`: the builder no longer authors one. On
 * create the server defaults it to ANYTIME; on patch, omitting it leaves any
 * pre-existing value alone rather than silently rewriting old rows.
 */
export function draftToInput(state: WorkflowDraftState): WorkflowInput {
  return {
    name: state.name,
    trigger_type: state.trigger_type,
    trigger_config: state.trigger_config,
    steps: state.steps.map((s) => ({ step_type: s.step_type, config: s.config })),
  };
}

// ── the hook ──────────────────────────────────────────────────────────────────

export function useWorkflowDraft() {
  const [state, setState] = useState<WorkflowDraftState>(blankState);

  /** Apply an edit: merge the patch, mark dirty, bump the revision. */
  const edit = useCallback((patch: (s: WorkflowDraftState) => Partial<WorkflowDraftState>) => {
    setState((s) => ({ ...s, ...patch(s), dirty: true, revision: s.revision + 1 }));
  }, []);

  const setName = useCallback((name: string) => edit(() => ({ name })), [edit]);

  const setTrigger = useCallback(
    (trigger_type: AutomationTriggerType, trigger_config: TriggerConfig | null) =>
      edit(() => ({ trigger_type, trigger_config, triggerConfigured: true })),
    [edit],
  );

  const addStep = useCallback(
    (type: WorkflowStepType, atIndex?: number): string => {
      const uid = newUid();
      setState((s) => {
        const step: DraftStep = { uid, step_type: type, config: defaultConfig(type) };
        const idx = atIndex ?? s.steps.length;
        const steps = [...s.steps.slice(0, idx), step, ...s.steps.slice(idx)];
        return { ...s, steps, selectedUid: uid, dirty: true, revision: s.revision + 1 };
      });
      return uid;
    },
    [],
  );

  const moveStepAt = useCallback(
    (from: number, to: number) => edit((s) => ({ steps: moveStep(s.steps, from, to) })),
    [edit],
  );

  const removeStep = useCallback(
    (uid: string) =>
      edit((s) => ({
        steps: s.steps.filter((st) => st.uid !== uid),
        selectedUid: s.selectedUid === uid ? null : s.selectedUid,
      })),
    [edit],
  );

  const updateStepConfig = useCallback(
    (uid: string, config: Record<string, unknown>) =>
      edit((s) => ({ steps: s.steps.map((st) => (st.uid === uid ? { ...st, config } : st)) })),
    [edit],
  );

  // Selection is not a save-worthy change — never marks dirty.
  const selectStep = useCallback((uid: string) => setState((s) => ({ ...s, selectedUid: uid })), []);
  const selectTrigger = useCallback(() => setState((s) => ({ ...s, selectedUid: 'trigger' })), []);
  const clearSelection = useCallback(() => setState((s) => ({ ...s, selectedUid: null })), []);

  /** Load a server workflow into the draft (initial load). Not dirty. */
  const hydrate = useCallback((w: ApiWorkflow) => {
    setState((s) => ({
      ...s,
      name: w.name,
      trigger_type: w.trigger_type,
      trigger_config: w.trigger_config,
      triggerConfigured: true,
      steps: w.steps.map((st) => ({
        uid: newUid(),
        step_type: st.step_type,
        config: (st.config ?? {}) as Record<string, unknown>,
      })),
      selectedUid: null,
      dirty: false,
      lastSavedAt: w.updated_at ? Date.parse(w.updated_at) : Date.now(),
      server: snapshotOf(w),
    }));
  }, []);

  /**
   * Fold a save response back in. Clears dirty ONLY if no edit landed since the
   * save started (compared via `savedRevision`); always refreshes the server
   * snapshot (issues, status, id) + the "saved" stamp. Never touches the working
   * draft (name/steps) — the office may have typed on during the round-trip.
   */
  const markSaved = useCallback((savedRevision: number, w: ApiWorkflow) => {
    setState((s) => ({
      ...s,
      dirty: s.revision !== savedRevision,
      lastSavedAt: Date.now(),
      server: snapshotOf(w),
    }));
  }, []);

  const issuesByStepIndex = useMemo(() => {
    const map = new Map<number, ValidationIssue[]>();
    for (const issue of state.server.issues) {
      if (issue.step_index < 0) continue;
      const list = map.get(issue.step_index) ?? [];
      list.push(issue);
      map.set(issue.step_index, list);
    }
    return map;
  }, [state.server.issues]);

  return {
    state,
    setName,
    setTrigger,
    addStep,
    moveStep: moveStepAt,
    removeStep,
    updateStepConfig,
    selectStep,
    selectTrigger,
    clearSelection,
    hydrate,
    markSaved,
    issuesByStepIndex,
  };
}
