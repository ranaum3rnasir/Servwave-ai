import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import type { AnchorKey, WaitDirection } from '@/lib/workflows/anchors';
import type { AutomationEntity } from '@/lib/workflows/entities';

// ── types (mirror backend/src/controllers/workflow.controller.ts + Prisma) ───

export type AutomationTriggerType =
  | 'JOB_SCHEDULED' | 'JOB_RESCHEDULED' | 'TECH_ASSIGNED' | 'JOB_COMPLETED' | 'JOB_CANCELLED'
  | 'ESTIMATE_SENT' | 'ESTIMATE_APPROVED' | 'ESTIMATE_DECLINED'
  | 'INVOICE_SENT' | 'INVOICE_PAID' | 'LEAD_CREATED'
  | 'LEAD_ASSIGNED' | 'WALKTHROUGH_SCHEDULED' | 'WALKTHROUGH_RESCHEDULED'
  | 'WALKTHROUGH_COMPLETED' | 'WALKTHROUGH_CANCELLED' | 'WALKTHROUGH_PERFORMER_ASSIGNED'
  | 'WALKTHROUGH_PERFORMER_REMOVED' | 'TECH_UNASSIGNED' | 'JOB_EN_ROUTE'
  | 'JOB_SUB_STATUS_ENTERED'
  | 'BEFORE_JOB_START' | 'AFTER_JOB_COMPLETED' | 'INVOICE_OVERDUE' | 'ESTIMATE_FOLLOW_UP'
  | 'JOB_DATE_ANCHORED' | 'LEAD_DATE_ANCHORED' | 'INVOICE_DATE_ANCHORED' | 'ESTIMATE_DATE_ANCHORED'
  // Spec B, one value per delivering slice (mirrors triggerModel.ts's own copy).
  | 'TASK_CREATED' | 'TASK_ASSIGNED' | 'TASK_COMMENT_ADDED' | 'TASK_DELETED'
  | 'TASK_DATE_ANCHORED'
  // "Task is done" and "Task is cancelled" (visits-and-task-categories slices 14 and 15).
  | 'TASK_COMPLETED' | 'TASK_CANCELLED';

/**
 * Every action type STORAGE can hold, mirroring the Prisma enum. Wider than the
 * served catalogue on purpose and permanently so, for the same reason
 * WorkflowStepType below is: the enum keeps every label it has ever had.
 */
export type AutomationActionType = 'SEND_EMAIL' | 'SEND_SMS' | 'NOTIFY_TEAM';

/**
 * The action types the catalogue still OFFERS. Mirrors backend/src/services/
 * automations/catalog.ts's `AuthorableActionType`, which is what ACTIONS and
 * AUDIENCES are keyed by there - so the types below describe the payload that
 * actually arrives rather than asserting it is complete over the Prisma enum.
 *
 * This matters more than the usual type-mirror tidiness: the builder reads
 * `audiences[trigger][action]` with a `?? []` fallback, so a claim that a key is
 * present when the server no longer sends it degrades to an empty multi-select
 * rather than to an error anyone would see.
 */
export type AuthorableActionType = Exclude<AutomationActionType, 'NOTIFY_TEAM'>;

export type AutomationSendWindow = 'ANYTIME' | 'BUSINESS_HOURS';

/**
 * Every step type STORAGE can hold, mirroring the Postgres enum. Wider than the
 * authoring surface on purpose and permanently so: the enum keeps every label it
 * has ever had, so a historic row still resolves. Surfaces that RENDER a stored
 * step (the Activity label/icon maps, a dry-run row) take this type.
 */
export type WorkflowStepType = 'WAIT' | 'SEND_TEXT' | 'SEND_EMAIL' | 'NOTIFY_TEAM' | 'STOP_IF';

/**
 * The step types an admin may still AUTHOR. Mirrors backend/src/services/
 * automations/workflowValidation.ts's `AuthorableStepType`, which is what the
 * write DTO spans - so a surface that creates, offers or configures a step
 * takes this type and cannot name a step the API would reject.
 */
export type AuthorableStepType = Exclude<WorkflowStepType, 'NOTIFY_TEAM'>;

/**
 * The authorable types at runtime, in picker order. The `satisfies` clause is
 * the guard: putting a retired label back in this list stops the build instead
 * of quietly widening what the builder will offer.
 */
export const AUTHORABLE_STEP_TYPES = [
  'WAIT',
  'SEND_TEXT',
  'SEND_EMAIL',
  'STOP_IF',
] as const satisfies readonly AuthorableStepType[];

/** Narrows a stored step type to the authorable subset - false for a retired one. */
export function isAuthorableStepType(type: WorkflowStepType): type is AuthorableStepType {
  return (AUTHORABLE_STEP_TYPES as readonly WorkflowStepType[]).includes(type);
}

export type WorkflowStatus = 'DRAFT' | 'PUBLISHED';

export type RecipientKey =
  | 'customer' | 'assigned_techs' | 'all_admins' | 'all_dispatchers' | 'specific_user' | 'custom';

/**
 * v2.1 multi-select audience keys (mirrors backend/src/services/automations/
 * recipients.ts's `RecipientKey`) — the 9-member replacement for the legacy
 * 6-member `RecipientKey` above. Named distinctly (not reusing `RecipientKey`)
 * because the legacy type is still load-bearing here: `ActionDef.recipients` and
 * the existing single-Select forms (lib/workflows/recipients.ts,
 * describeWorkflow.ts) all still speak the old 6-member shape - rewiring those
 * to the wider set is the multi-select UI migration, a later task.
 *
 * `AutomationTemplate.action_config.recipient` was on that list and no longer is:
 * Spec B slice 7 moved it to this type, because a task recipe addresses
 * `assignees` and the legacy list has never carried it. That field's real
 * legality gate was always the backend's audiencesFor, not the 6-member list.
 */
export type AudienceKey =
  | 'customer'
  | 'assigned_team'
  | 'dispatcher'
  | 'salesperson'
  | 'creator'
  | 'all_admins'
  | 'all_dispatchers'
  | 'specific_user'
  | 'custom'
  /** Legal only on TECH_UNASSIGNED / WALKTHROUGH_PERFORMER_REMOVED — see catalog.ts's audiencesFor. */
  | 'removed_user'
  /** Legal only on TECH_ASSIGNED / WALKTHROUGH_PERFORMER_ASSIGNED — see catalog.ts's audiencesFor. */
  | 'assigned_user'
  /** Legal only on a TASK trigger - the people doing it and the people following it. */
  | 'assignees'
  | 'watchers';

/** One legal recipient audience for a trigger+action pair, as served by the catalog. */
export interface AudienceOption {
  key: AudienceKey;
  label: string;
  /** Present only for the audiences that aren't guaranteed to resolve to anyone (e.g. salesperson). */
  hint?: string;
}

/**
 * A messaging step's config in the v2.1 multi-select shape (mirrors backend
 * workflowValidation.ts's `MessagingConfig`, post-normalization). `WorkflowStep.
 * config` below stays `Record<string, unknown>` — a step can be any of five
 * types, and stored/draft configs may still carry the legacy singular
 * `recipient`/`custom_email`/`user_id` — this is the typed shape for a
 * SEND_TEXT/SEND_EMAIL/NOTIFY_TEAM config once you already know which one.
 */
export interface MessagingStepConfig {
  recipients: AudienceKey[];
  body: string;
  subject?: string;
  custom_emails?: string[];
  user_ids?: string[];
}

/** A step as returned by the API — always has an id once persisted. */
export interface WorkflowStep {
  id?: string;
  position: number;
  step_type: WorkflowStepType;
  config: Record<string, unknown>;
}

/** A step as sent to create/patch — the server renumbers positions from array order. */
export interface WorkflowStepInput {
  step_type: WorkflowStepType;
  config: Record<string, unknown>;
}

export interface ValidationIssue {
  step_index: number; // -1 for workflow-level issues
  path: string;
  message: string;
}

/**
 * A date-anchored trigger's (JOB/LEAD/INVOICE/ESTIMATE_DATE_ANCHORED) timing —
 * anchor + direction + offset instead of a bare offset. Mirrors backend
 * workflowValidation.ts's DateAnchorTriggerConfig (Task A4).
 */
export interface DateAnchorTriggerConfig {
  anchor: AnchorKey;
  direction: 'before' | 'after';
  offset_minutes: number;
}

/** A JOB_SUB_STATUS_ENTERED trigger's config (SRVW-113) — mirrors backend
 *  workflowValidation.ts's SubStatusTriggerConfig. */
export interface SubStatusTriggerConfig {
  sub_status_id: string;
}

export interface ApiWorkflow {
  id: string;
  name: string;
  status: WorkflowStatus;
  is_enabled: boolean;
  trigger_type: AutomationTriggerType;
  trigger_config: { offset_minutes: number } | DateAnchorTriggerConfig | SubStatusTriggerConfig | null;
  send_window: AutomationSendWindow;
  template_key: string | null;
  legacy_rule_id: string | null;
  published_at: string | null;
  last_triggered_at: string | null;
  trigger_count: number;
  created_at: string;
  updated_at: string;
  steps: WorkflowStep[];
  issues: ValidationIssue[];
  has_unpublished_changes: boolean;
  published_version: { version: number; published_at: string } | null;
}

export interface WorkflowInput {
  name: string;
  trigger_type: AutomationTriggerType;
  trigger_config?: { offset_minutes: number } | DateAnchorTriggerConfig | SubStatusTriggerConfig | null;
  send_window?: AutomationSendWindow;
  template_key?: string;
  steps?: WorkflowStepInput[];
}

export type PatchWorkflowInput = Partial<WorkflowInput>;

export interface TriggerDef {
  label: string;
  description: string;
  category: 'events' | 'timed' | 'date';
  /** The ONE named entity union (lib/workflows/entities.ts), never a hand-written copy. */
  entity: AutomationEntity;
  timeBased: boolean;
  defaultOffsetMinutes?: number;
  mergeFields: string[];
}

export interface ActionDef {
  label: string;
  description: string;
  recipients: RecipientKey[];
  requiresSubject: boolean;
}

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  category: 'customer' | 'team' | 'money';
  trigger_type: AutomationTriggerType;
  /**
   * Mirrors the backend's AutomationTemplate. Two shapes: the legacy bare offset, and the
   * anchor + direction + offset of the date-anchored family - widened by Spec B slice 7 for
   * the task due-date recipes, which have no event to hang an anchored WAIT off.
   */
  trigger_config?: { offset_minutes: number } | DateAnchorTriggerConfig;
  /** Authorable: no gallery template installs a retired action any more. */
  action_type: AuthorableActionType;
  action_config: {
    /**
     * The AUDIENCE key, not the legacy six-member RecipientKey. Widened with the backend for
     * the task recipes, which address `assignees` - a key the legacy list never carried.
     */
    recipient: AudienceKey;
    subject?: string;
    body: string;
    custom_email?: string;
    user_id?: string;
  };
  /**
   * Optional full step sequence for multi-step recipes (e.g. an anchored WAIT
   * before a SEND_EMAIL). When present, `templateToWorkflowBody` uses it
   * verbatim instead of folding `action_type`/`action_config` into one step.
   */
  steps?: WorkflowStepInput[];
  send_window: AutomationSendWindow;
}

export interface WorkflowCatalog {
  triggers: Record<AutomationTriggerType, TriggerDef>;
  actions: Record<AuthorableActionType, ActionDef>;
  /** Legal v2.1 audiences per trigger+action pair, channel-constrained + entity-narrowed. */
  audiences: Record<AutomationTriggerType, Record<AuthorableActionType, AudienceOption[]>>;
  /**
   * Legal anchor options per entity, for the builder's date-anchored trigger + anchored WAIT UI.
   *
   * `directions` says which way round the offset may run for THIS anchor, and is served rather
   * than inferred here: a lead stage clock records a moment as it happens, so counting BEFORE one
   * can never fire, and the backend validator refuses to save it. Optional so a catalog fixture
   * written before the field existed still typechecks - read it through `anchorDirections`, which
   * treats an absent value as "both".
   */
  anchors: Record<AutomationEntity, Array<{ key: AnchorKey; label: string; directions?: WaitDirection[] }>>;
  merge_field_labels: Record<string, string>;
  sample_context: Record<string, string>;
  /**
   * The seeded "If empty, fill with" text per merge field. A send step stored without its own
   * `fallbacks` map renders these server-side, and the builder shows them in the chip popover
   * so what the author sees is what an untouched step sends. Optional so a catalog fixture
   * written before the field existed still typechecks.
   */
  default_fallbacks?: Record<string, string>;
  templates: AutomationTemplate[];
  stop_if: { conditions: Record<string, string[]>; labels: Record<string, string> };
  /** Per-org feature availability — e.g. whether the "Send text" step can be authored. */
  capabilities: { sms_available: boolean };
}

export interface DryRunStep {
  step_index: number;
  step_type: WorkflowStepType;
  outcome: 'would_send' | 'would_wait' | 'would_check' | 'needs_setup';
  detail?: string;
  rendered?: { subject?: string | null; body: string };
}

export interface TestWorkflowResult {
  steps: DryRunStep[];
  delivered: string[];
}

export interface ActivityRow {
  id: string;
  source: 'workflow' | 'legacy';
  when: string;
  step_index: number;
  step_type: WorkflowStepType;
  status: 'PENDING' | 'SENT' | 'SKIPPED' | 'FAILED' | 'STOPPED' | 'CONTINUED';
  recipient_summary: string | null;
  detail: string | null;
  entity_label: string | null;
  /**
   * One entry per resolved audience of a send step, in the step's configured order. The
   * step-level `status` is derived from these (any sent means SENT); this is what says
   * WHICH audience was reached. Empty on legacy rows and on runs recorded before the
   * ledger carried it.
   */
  audience_outcomes: AudienceOutcome[];
}

export interface AudienceOutcome {
  audience: AudienceKey;
  /** Plain-English name for the audience on that entity, e.g. "the customer". */
  label: string;
  outcome: 'sent' | 'skipped' | 'failed';
  /** One short line: who was reached, or why nobody was. */
  summary: string;
}

export interface WorkflowActivityResult {
  rows: ActivityRow[];
}

// ── functions ─────────────────────────────────────────────────────────────────

export function listWorkflows(): Promise<ApiWorkflow[]> {
  return api.get('/api/workflows').then((r) => r.data);
}

export function getWorkflow(id: string): Promise<ApiWorkflow> {
  return api.get(`/api/workflows/${id}`).then((r) => r.data);
}

export function createWorkflow(body: WorkflowInput): Promise<ApiWorkflow> {
  return api.post('/api/workflows', body).then((r) => r.data);
}

export function patchWorkflow(id: string, body: PatchWorkflowInput): Promise<ApiWorkflow> {
  return api.patch(`/api/workflows/${id}`, body).then((r) => r.data);
}

export function publishWorkflow(id: string, body?: { enable?: boolean }): Promise<ApiWorkflow> {
  return api.post(`/api/workflows/${id}/publish`, body ?? {}).then((r) => r.data);
}

export function toggleWorkflow(id: string, is_enabled: boolean): Promise<ApiWorkflow> {
  return api.post(`/api/workflows/${id}/toggle`, { is_enabled }).then((r) => r.data);
}

export function deleteWorkflow(id: string): Promise<void> {
  return api.delete(`/api/workflows/${id}`).then((r) => r.data);
}

/** `empty_fields` previews every merge field EMPTY, so the rendered copy shows the step's "If empty, fill with" text. */
export function testWorkflow(
  id: string,
  body: { send_to_me?: boolean; empty_fields?: boolean },
): Promise<TestWorkflowResult> {
  return api.post(`/api/workflows/${id}/test`, body).then((r) => r.data);
}

export function getWorkflowActivity(id: string, limit?: number): Promise<WorkflowActivityResult> {
  return api.get(`/api/workflows/${id}/activity`, { params: { limit } }).then((r) => r.data);
}

export function getWorkflowCatalog(): Promise<WorkflowCatalog> {
  return api.get('/api/workflows/catalog').then((r) => r.data);
}

// ── hooks ─────────────────────────────────────────────────────────────────────

export function useWorkflows() {
  return useQuery<ApiWorkflow[]>({
    queryKey: ['workflows'],
    queryFn: listWorkflows,
  });
}

export function useWorkflow(id: string | undefined) {
  return useQuery<ApiWorkflow>({
    queryKey: ['workflows', id],
    queryFn: () => getWorkflow(id as string),
    enabled: Boolean(id),
  });
}

export function useWorkflowCatalog() {
  return useQuery<WorkflowCatalog>({
    queryKey: ['workflows', 'catalog'],
    queryFn: getWorkflowCatalog,
    staleTime: 10 * 60 * 1000, // static vocabulary — no need to refetch per navigation
  });
}

export function useWorkflowActivity(id: string | undefined, limit?: number) {
  return useQuery<WorkflowActivityResult>({
    queryKey: ['workflows', id, 'activity', limit],
    queryFn: () => getWorkflowActivity(id as string, limit),
    enabled: Boolean(id),
  });
}

export function useCreateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: WorkflowInput) => createWorkflow(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
    onError: (err) =>
      toast({
        title: 'Could not create automation',
        description: extractApiError(err, 'Something went wrong saving the automation'),
        variant: 'destructive',
      }),
  });
}

export function usePatchWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: PatchWorkflowInput }) => patchWorkflow(id, data),
    onSuccess: (_workflow, variables) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflows', variables.id] });
    },
    onError: (err) =>
      toast({
        title: 'Could not save automation',
        description: extractApiError(err, 'Something went wrong saving the automation'),
        variant: 'destructive',
      }),
  });
}

export function usePublishWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enable }: { id: string; enable?: boolean }) => publishWorkflow(id, { enable }),
    onSuccess: (_workflow, variables) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflows', variables.id] });
    },
    onError: (err) =>
      toast({
        title: 'Could not publish automation',
        description: extractApiError(err, 'Something went wrong publishing the automation'),
        variant: 'destructive',
      }),
  });
}

export function useToggleWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, is_enabled }: { id: string; is_enabled: boolean }) => toggleWorkflow(id, is_enabled),
    onSuccess: (workflow, variables) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflows', variables.id] });
      toast({
        title: workflow.is_enabled ? 'Automation turned on' : 'Automation paused',
        description: workflow.name,
      });
    },
    onError: (err) =>
      toast({
        title: 'Could not update automation',
        description: extractApiError(err, 'Something went wrong'),
        variant: 'destructive',
      }),
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWorkflow(id),
    onSuccess: (_void, id) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflows', id] });
      toast({ title: 'Automation deleted' });
    },
    onError: (err) =>
      toast({
        title: 'Could not delete automation',
        description: extractApiError(err, 'Something went wrong'),
        variant: 'destructive',
      }),
  });
}

export function useTestWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, send_to_me, empty_fields }: { id: string; send_to_me?: boolean; empty_fields?: boolean }) =>
      testWorkflow(id, { send_to_me, empty_fields }),
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ['workflows'] });
      qc.invalidateQueries({ queryKey: ['workflows', variables.id] });
    },
    onError: (err) =>
      toast({
        title: 'Test failed',
        description: extractApiError(err, 'Could not send the test'),
        variant: 'destructive',
      }),
  });
}
