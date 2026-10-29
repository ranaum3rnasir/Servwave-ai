/**
 * workflow.controller.ts — multi-step Workflow Builder REST API (/api/workflows).
 *
 * The Automation Center v2 surface: draft CRUD, publish gating, live/pause
 * toggle, dry-run preview and a legacy+new activity union. Route chain
 * (workflow.routes.ts): authenticate → attachAbility → canDo(…, 'Automation')
 * → validate(schema). Shares the 'Automation' CASL subject with the legacy
 * single-action rules, so ADMIN manages via manage-all, DISPATCHER via explicit
 * grants, SALES/TECHNICIAN 403.
 *
 * TWO validation tiers — the design's core:
 *  - DRAFT tier (create/patch Zod): structurally sound, allowed to be INCOMPLETE.
 *    The builder autosaves half-configured steps; "needs setup" is a UI state the
 *    SERVER computes (validateWorkflowDefinition → `issues`), never a 400.
 *  - PUBLISH tier: validateWorkflowDefinition must return [] — enforced only in
 *    publishWorkflow, which freezes an immutable WorkflowVersion snapshot.
 */

import { Request, Response } from 'express';
import { z } from 'zod';
import {
  AutomationTriggerType,
  AutomationSendWindow,
  WorkflowStepType,
  Prisma,
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import { sendAutomationEmail, esc } from '../lib/email';
import { emit } from '../services/notifications/notificationService';
import {
  TRIGGERS,
  ACTIONS,
  TEMPLATES,
  MERGE_FIELD_LABELS,
  SAMPLE_CONTEXT,
  AUDIENCES,
  ANCHOR_OPTIONS,
  type AutomationEntity,
} from '../services/automations/catalog';
import { renderMergeFields } from '../services/automations/renderMergeFields';
import { fallbacksFor, DEFAULT_MERGE_FIELD_FALLBACKS } from '../services/automations/mergeFieldFallbacks';
import { audienceLabel, type RecipientKey } from '../services/automations/recipients';
import { hasFeature } from '../lib/entitlements/resolve';
import {
  validateWorkflowDefinition,
  STOP_IF_CONDITIONS,
  STOP_IF_LABELS,
  dateAnchorTriggerConfigSchema,
  subStatusTriggerConfigSchema,
  isSupportedStepType,
  UNSUPPORTED_STEP_MESSAGE,
  retiredInAppStepMessage,
  type WorkflowDefinition,
} from '../services/automations/workflowValidation';
import { isAnchoredWait, describeAnchoredWait } from '../services/automations/anchors';

/** Express 5 types params as string | string[]; route params here are always single. */
function param(req: Request, name: string): string {
  return req.params[name] as string;
}

// ── validation (DRAFT tier) ─────────────────────────────────────────────────────

// The draft tier spans the STORAGE enum, not the authorable narrowing. The builder
// re-sends every step it hydrated on each autosave and Duplicate posts a workflow's
// steps verbatim, so refusing the retired label HERE would block every save on a
// workflow that already holds one, in zod's words rather than the product's. The
// retirement is enforced at publish (validateStep) and reported on every read.
const draftStepSchema = z
  .object({
    step_type: z.nativeEnum(WorkflowStepType),
    config: z
      .record(z.string(), z.unknown())
      .refine((c) => JSON.stringify(c).length <= 20_000, { message: 'Step configuration is too large' }),
  })
  .strict();

export const createWorkflowSchema = z
  .object({
    name: z.string().min(1).max(120),
    trigger_type: z.nativeEnum(AutomationTriggerType),
    // Union: legacy timed triggers carry a bare offset; the *_DATE_ANCHORED
    // triggers (A2, plus Spec B's TASK_DATE_ANCHORED) carry anchor+direction+
    // offset_minutes (A4's own schema, reused verbatim so the two never drift);
    // JOB_SUB_STATUS_ENTERED (SRVW-113) carries a bare sub_status_id.
    // patchWorkflowSchema derives it via .partial().strict(), so PATCH matches.
    trigger_config: z
      .union([
        z.object({ offset_minutes: z.number().int().min(5).max(60 * 24 * 90) }).strict(),
        dateAnchorTriggerConfigSchema,
        subStatusTriggerConfigSchema,
      ])
      .nullish(),
    send_window: z.nativeEnum(AutomationSendWindow).optional(),
    template_key: z.string().max(80).optional(),
    steps: z.array(draftStepSchema).max(25).optional(),
  })
  .strict();

// PATCH: any subset; `steps`, when present, REPLACES the whole array.
export const patchWorkflowSchema = createWorkflowSchema.partial().strict();
export const publishWorkflowSchema = z.object({ enable: z.boolean().optional() }).strict();
export const toggleWorkflowSchema = z.object({ is_enabled: z.boolean() }).strict();
export const testWorkflowSchema = z
  .object({
    send_to_me: z.boolean().optional(),
    /** Preview with every merge field EMPTY, so the author sees their "If empty, fill with" text. */
    empty_fields: z.boolean().optional(),
  })
  .strict();

// ── shared helpers ──────────────────────────────────────────────────────────────

type StepRow = { id: string; position: number; step_type: WorkflowStepType; config: unknown };
type WorkflowRow = {
  id: string;
  status: string;
  trigger_type: AutomationTriggerType;
  trigger_config: unknown;
  send_window: AutomationSendWindow;
  published_version_id: string | null;
  name: string;
  [key: string]: unknown;
};
type VersionRow = { version: number; published_at: Date; definition: unknown };

/**
 * Human recipient label(s) for the dry-run detail line. v2.1 configs carry
 * `recipients[]` (the multi-select); legacy stored/draft configs may still
 * carry only the singular `recipient` — fall back to `[recipient]` so both
 * preview identically. The legacy `assigned_techs` key folds to its canonical
 * `assigned_team` first (audienceLabel only knows the canonical 9-member set).
 */
function recipientPreviewLabel(cfg: { recipient?: unknown; recipients?: unknown }, entity: AutomationEntity): string {
  const raw = Array.isArray(cfg.recipients)
    ? cfg.recipients
    : cfg.recipient != null
      ? [cfg.recipient]
      : [];
  const labels = raw
    .filter((r): r is string => typeof r === 'string')
    .map((r) => (r === 'assigned_techs' ? 'assigned_team' : r))
    .map((r) => audienceLabel(r as RecipientKey, entity));
  return labels.join(', ') || 'no one';
}

/** Plain-English wait duration: '1 hour', '2 days', '45 minutes'. Mirrors enrollment.ts. */
function humanizeDuration(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Normalize the workflow's stored trigger_config to the definition shape: legacy
 * offset-only, or date-anchored (anchor/direction/offset_minutes — A7). Both
 * shapes are already DTO-validated on write (createWorkflowSchema's union), so
 * re-parsing against A4's own schema here is a safe single-source-of-truth narrow
 * rather than a hand-rolled duplicate of its field list — and crucially, unlike a
 * plain `{ offset_minutes }` extraction, it does NOT drop anchor/direction (which
 * would make validateWorkflowDefinition see an incomplete anchored config and
 * flag a spurious "anchor is required" issue on every otherwise-valid one).
 */
function normalizeTriggerConfig(raw: unknown): WorkflowDefinition['trigger_config'] {
  const anchored = dateAnchorTriggerConfigSchema.safeParse(raw);
  if (anchored.success) return anchored.data;
  const subStatus = subStatusTriggerConfigSchema.safeParse(raw);
  if (subStatus.success) return subStatus.data;
  const tc = raw as { offset_minutes?: number } | null | undefined;
  return tc && typeof tc.offset_minutes === 'number' ? { offset_minutes: tc.offset_minutes } : null;
}

/** The canonical, engine-ready WorkflowDefinition for a workflow + its draft steps. */
function buildDefinition(workflow: WorkflowRow, steps: StepRow[]): WorkflowDefinition {
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  return {
    trigger_type: workflow.trigger_type,
    trigger_config: normalizeTriggerConfig(workflow.trigger_config),
    send_window: workflow.send_window,
    steps: ordered.map((s) => ({ position: s.position, step_type: s.step_type, config: s.config })),
  };
}

/** Deterministic stringify (recursively key-sorted) so key ordering never spoofs a diff. */
function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sort((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Serialize a workflow for the API. The SERVER is the single source of truth for
 * "needs setup" badges (`issues`) and the "unpublished changes" pill.
 */
function toApiWorkflow(workflow: WorkflowRow, steps: StepRow[], publishedVersion: VersionRow | null) {
  const { steps: _drop, ...rest } = workflow as WorkflowRow & { steps?: StepRow[] };
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const def = buildDefinition(workflow, ordered);
  const issues = validateWorkflowDefinition(def);
  const has_unpublished_changes =
    workflow.status === 'PUBLISHED' &&
    publishedVersion != null &&
    stableStringify(def) !== stableStringify(publishedVersion.definition);
  return {
    ...rest,
    steps: ordered.map((s) => ({ id: s.id, position: s.position, step_type: s.step_type, config: s.config })),
    issues,
    has_unpublished_changes,
    published_version: publishedVersion
      ? { version: publishedVersion.version, published_at: publishedVersion.published_at }
      : null,
  };
}

/** Load the immutable published snapshot for the has-changes flag (tenant-scoped). */
async function loadPublishedVersion(req: Request, publishedVersionId: string | null): Promise<VersionRow | null> {
  if (!publishedVersionId) return null;
  return prisma.workflowVersion.findFirst({
    where: { id: publishedVersionId, ...tenantWhere(req) },
  }) as Promise<VersionRow | null>;
}

/** SRVW-113 — trigger_config.sub_status_id must resolve inside the caller's org (no cross-org probes). */
async function subStatusInOrg(req: Request, subStatusId: string | undefined): Promise<boolean> {
  if (!subStatusId) return true;
  const subStatus = await prisma.jobSubStatus.findFirst({
    where: { id: subStatusId, ...tenantWhere(req) },
    select: { id: true },
  });
  return Boolean(subStatus);
}

/** specific_user must exist + be active in the caller's org (no cross-org probes). */
async function specificUserInOrg(req: Request, userId: string | undefined): Promise<boolean> {
  if (!userId) return true;
  const user = await prisma.user.findFirst({
    where: { id: userId, ...tenantWhere(req), is_active: true },
    select: { id: true },
  });
  return Boolean(user);
}

// ── handlers ──────────────────────────────────────────────────────────────────

/**
 * The "Send text" step unlocks per-org, not via a global launch flag (SERV10X-70):
 * true only when the org has actually connected CTM, cleared A2P, left its own
 * kill switch on, and is entitled to `phone` — the same real gates runGates()
 * enforces at the point of effect. A missing org row fails closed.
 */
async function smsAvailable(orgId: string): Promise<boolean> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      ctm_account_id: true,
      ctm_sms_ready: true,
      sms_sending_enabled: true,
      plan: true,
      trial_ends_at: true,
      feature_overrides: true,
    },
  });
  if (!org?.ctm_account_id || !org.ctm_sms_ready || !org.sms_sending_enabled) return false;
  return hasFeature(
    { plan: org.plan, trial_ends_at: org.trial_ends_at, feature_overrides: org.feature_overrides as Record<string, unknown> | null },
    'phone',
  );
}

export async function getWorkflowCatalog(req: Request, res: Response) {
  res.json({
    triggers: TRIGGERS,
    actions: ACTIONS,
    audiences: AUDIENCES,
    anchors: ANCHOR_OPTIONS,
    merge_field_labels: MERGE_FIELD_LABELS,
    sample_context: SAMPLE_CONTEXT,
    default_fallbacks: DEFAULT_MERGE_FIELD_FALLBACKS,
    templates: TEMPLATES,
    stop_if: { conditions: STOP_IF_CONDITIONS, labels: STOP_IF_LABELS },
    capabilities: { sms_available: await smsAvailable(req.user!.organization_id) },
  });
}

export async function listWorkflows(req: Request, res: Response) {
  try {
    const workflows = await prisma.workflow.findMany({
      where: { ...tenantWhere(req) },
      orderBy: { created_at: 'desc' },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    const publishedIds = workflows
      .map((w: any) => w.published_version_id)
      .filter((id: string | null): id is string => Boolean(id));
    const versions = publishedIds.length
      ? await prisma.workflowVersion.findMany({ where: { id: { in: publishedIds }, ...tenantWhere(req) } })
      : [];
    const versionById = new Map<string, VersionRow>(versions.map((v: any) => [v.id, v]));
    res.json(
      workflows.map((w: any) =>
        toApiWorkflow(w, w.steps, w.published_version_id ? versionById.get(w.published_version_id) ?? null : null),
      ),
    );
  } catch (err) {
    logger.error('Failed to list workflows:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createWorkflow(req: Request, res: Response) {
  try {
    const body = req.body as z.infer<typeof createWorkflowSchema>;
    const orgId = req.user!.organization_id;
    const created = await prisma.$transaction(async (tx: any) => {
      const workflow = await tx.workflow.create({
        data: {
          name: body.name,
          status: 'DRAFT',
          is_enabled: false,
          trigger_type: body.trigger_type,
          trigger_config: body.trigger_config ?? undefined,
          send_window: body.send_window ?? 'ANYTIME',
          template_key: body.template_key ?? null,
          created_by_id: req.user!.id,
          ...tenantWhere(req),
        },
      });
      const steps = body.steps ?? [];
      if (steps.length) {
        await tx.workflowStep.createMany({
          data: steps.map((s, i) => ({
            workflow_id: workflow.id,
            position: i,
            step_type: s.step_type,
            config: s.config,
            organization_id: orgId,
          })),
        });
      }
      return workflow;
    });
    void logAudit({
      req,
      action: 'automation.workflow_created',
      resourceType: 'Workflow',
      resourceId: created.id,
      metadata: { name: created.name, trigger_type: created.trigger_type },
    });
    const full = await prisma.workflow.findFirst({
      where: { id: created.id, ...tenantWhere(req) },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    res.status(201).json(toApiWorkflow(full as any, (full as any).steps, null));
  } catch (err) {
    logger.error('Failed to create workflow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getWorkflow(req: Request, res: Response) {
  try {
    const workflow = await prisma.workflow.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (!workflow) {
      res.status(404).json({ error: 'Automation not found' });
      return;
    }
    const publishedVersion = await loadPublishedVersion(req, (workflow as any).published_version_id);
    res.json(toApiWorkflow(workflow as any, (workflow as any).steps, publishedVersion));
  } catch (err) {
    logger.error('Failed to get workflow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function patchWorkflow(req: Request, res: Response) {
  try {
    const existing = await prisma.workflow.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Automation not found' });
      return;
    }
    const body = req.body as z.infer<typeof patchWorkflowSchema>;
    const orgId = req.user!.organization_id;
    await prisma.$transaction(async (tx: any) => {
      await tx.workflow.update({
        where: { id: existing.id },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.trigger_type !== undefined && { trigger_type: body.trigger_type }),
          // Prisma ignores `undefined`, which would strand a stale offset when a timed
          // trigger becomes an event trigger — write SQL NULL instead.
          ...(body.trigger_type !== undefined && { trigger_config: body.trigger_config ?? Prisma.DbNull }),
          ...(body.send_window !== undefined && { send_window: body.send_window }),
          ...(body.template_key !== undefined && { template_key: body.template_key }),
        },
      });
      if (body.steps !== undefined) {
        await tx.workflowStep.deleteMany({ where: { workflow_id: existing.id, ...tenantWhere(req) } });
        if (body.steps.length) {
          await tx.workflowStep.createMany({
            data: body.steps.map((s, i) => ({
              workflow_id: existing.id,
              position: i,
              step_type: s.step_type,
              config: s.config,
              organization_id: orgId,
            })),
          });
        }
      }
    });
    void logAudit({
      req,
      action: 'automation.workflow_updated',
      resourceType: 'Workflow',
      resourceId: existing.id,
    });
    const full = await prisma.workflow.findFirst({
      where: { id: existing.id, ...tenantWhere(req) },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    const publishedVersion = await loadPublishedVersion(req, (full as any).published_version_id);
    res.json(toApiWorkflow(full as any, (full as any).steps, publishedVersion));
  } catch (err) {
    logger.error('Failed to update workflow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function publishWorkflow(req: Request, res: Response) {
  try {
    const existing = await prisma.workflow.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Automation not found' });
      return;
    }
    const steps = (existing as any).steps as StepRow[];
    const definition = buildDefinition(existing as any, steps);

    // PUBLISH tier: the whole definition must be clean.
    const issues = validateWorkflowDefinition(definition);
    if (issues.length) {
      res.status(400).json({ error: "This automation isn't ready to publish", issues });
      return;
    }

    // SRVW-113 — a JOB_SUB_STATUS_ENTERED trigger's sub_status_id must resolve in-org.
    if (definition.trigger_type === 'JOB_SUB_STATUS_ENTERED') {
      const cfg = definition.trigger_config as { sub_status_id?: string } | null;
      if (!(await subStatusInOrg(req, cfg?.sub_status_id))) {
        res.status(400).json({ error: 'Selected sub-status not found' });
        return;
      }
    }

    // Every step naming ONE specific person must name someone in THIS org.
    // Keyed off the recipient rather than off a step type: this check used to
    // name the in-app step, which is retired and can no longer reach publish,
    // while the specific-person audience it guarded is offered by the email
    // step too. Structural legality is already settled by
    // validateWorkflowDefinition above; "does this id belong to this org" is a
    // DB lookup and lives here, alongside the sub-status check.
    for (const step of steps) {
      const cfg = step.config as { recipient?: string; user_id?: string };
      if (cfg.recipient === 'specific_user' && !(await specificUserInOrg(req, cfg.user_id))) {
        res.status(400).json({ error: 'Selected user not found' });
        return;
      }
    }

    const body = req.body as z.infer<typeof publishWorkflowSchema>;
    const orgId = req.user!.organization_id;
    const now = new Date();
    const result = await prisma.$transaction(async (tx: any) => {
      const last = await tx.workflowVersion.findFirst({
        where: { workflow_id: existing.id, ...tenantWhere(req) },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const nextVersion = (last?.version ?? 0) + 1;
      const version = await tx.workflowVersion.create({
        data: {
          workflow_id: existing.id,
          version: nextVersion,
          definition: definition as unknown as Prisma.InputJsonValue,
          published_by_id: req.user!.id,
          organization_id: orgId,
        },
      });
      const workflow = await tx.workflow.update({
        where: { id: existing.id },
        data: {
          status: 'PUBLISHED',
          published_version_id: version.id,
          published_at: now,
          is_enabled: body.enable ?? true, // publish = go live by default; the Switch pauses
        },
        include: { steps: { orderBy: { position: 'asc' } } },
      });
      return { workflow, version };
    });
    void logAudit({
      req,
      action: 'automation.workflow_published',
      resourceType: 'Workflow',
      resourceId: existing.id,
      metadata: { version: result.version.version },
    });
    res.json(toApiWorkflow(result.workflow, result.workflow.steps, result.version));
  } catch (err) {
    logger.error('Failed to publish workflow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function toggleWorkflow(req: Request, res: Response) {
  try {
    const existing = await prisma.workflow.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, status: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Automation not found' });
      return;
    }
    if (existing.status !== 'PUBLISHED') {
      res.status(400).json({ error: 'Publish this automation before turning it on' });
      return;
    }
    const { is_enabled } = req.body as z.infer<typeof toggleWorkflowSchema>;
    const workflow = await prisma.workflow.update({
      where: { id: existing.id },
      data: { is_enabled },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    void logAudit({
      req,
      action: 'automation.workflow_toggled',
      resourceType: 'Workflow',
      resourceId: existing.id,
      metadata: { is_enabled },
    });
    const publishedVersion = await loadPublishedVersion(req, (workflow as any).published_version_id);
    res.json(toApiWorkflow(workflow as any, (workflow as any).steps, publishedVersion));
  } catch (err) {
    logger.error('Failed to toggle workflow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteWorkflow(req: Request, res: Response) {
  try {
    const existing = await prisma.workflow.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, name: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Automation not found' });
      return;
    }
    // Delete in dependency order so the handler is correct even under RESTRICT:
    // step_runs → enrollments → versions → steps → workflow. (WorkflowEnrollment
    // → WorkflowVersion has no onDelete cascade, so enrollments MUST precede
    // versions.)
    await prisma.$transaction(async (tx: any) => {
      const enrollments = await tx.workflowEnrollment.findMany({
        where: { workflow_id: existing.id, ...tenantWhere(req) },
        select: { id: true },
      });
      const enrollmentIds = enrollments.map((e: { id: string }) => e.id);
      if (enrollmentIds.length) {
        await tx.workflowStepRun.deleteMany({ where: { enrollment_id: { in: enrollmentIds }, ...tenantWhere(req) } });
      }
      await tx.workflowEnrollment.deleteMany({ where: { workflow_id: existing.id, ...tenantWhere(req) } });
      await tx.workflowVersion.deleteMany({ where: { workflow_id: existing.id, ...tenantWhere(req) } });
      await tx.workflowStep.deleteMany({ where: { workflow_id: existing.id, ...tenantWhere(req) } });
      await tx.workflow.delete({ where: { id: existing.id } });
    });
    void logAudit({
      req,
      action: 'automation.workflow_deleted',
      resourceType: 'Workflow',
      resourceId: existing.id,
      metadata: { name: existing.name },
    });
    res.status(204).send();
  } catch (err) {
    logger.error('Failed to delete workflow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Dry-run: walk the DRAFT steps against the catalog's sample context and report a
 * per-step outcome. NEVER writes enrollments / step-runs / Communication rows.
 * With send_to_me, each VALID send step is previewed to the CALLING user only
 * (email) plus one in-app notification.
 */
export async function testWorkflow(req: Request, res: Response) {
  try {
    const workflow = await prisma.workflow.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (!workflow) {
      res.status(404).json({ error: 'Automation not found' });
      return;
    }
    const body = req.body as z.infer<typeof testWorkflowSchema>;
    const steps = (workflow as any).steps as StepRow[];
    const def = buildDefinition(workflow as any, steps);
    const entity = TRIGGERS[def.trigger_type].entity;
    // Sample data by default; with empty_fields every field the trigger advertises resolves to
    // '', so what shows is the step's own fallbacks and nothing else. Nothing is appended to
    // that list any more: nothing outside it is legal in a body (see `BASE` in catalog.ts).
    const previewContext: Record<string, string> = body.empty_fields
      ? Object.fromEntries(TRIGGERS[def.trigger_type].mergeFields.map((f) => [f, '']))
      : SAMPLE_CONTEXT;

    // The server's per-step "needs setup" verdict — same authority as the badge.
    const issuesByStep = new Map<number, string>();
    for (const issue of validateWorkflowDefinition(def)) {
      if (issue.step_index >= 0 && !issuesByStep.has(issue.step_index)) {
        issuesByStep.set(issue.step_index, issue.message);
      }
    }

    type SendPreview = { subject?: string; body: string };
    const outcomes: Array<{
      step_index: number;
      step_type: WorkflowStepType;
      outcome: string;
      detail: string;
      rendered?: SendPreview;
    }> = [];
    const validSends: SendPreview[] = [];

    def.steps.forEach((step, index) => {
      // A step type this build no longer configures never previews as a send.
      // Checked BEFORE the validation verdict below so the preview does not
      // depend on the validator having flagged it: the fall-through at the foot
      // of this loop reads cfg.body off a config nothing can parse and would
      // then offer to email it under send_to_me.
      if (!isSupportedStepType(step.step_type)) {
        outcomes.push({
          step_index: index,
          step_type: step.step_type,
          outcome: 'needs_setup',
          // The retired in-app step gets the same sentence here as it does at
          // publish and in the config drawer. It is the one member of this
          // family the product decided about, and this is the third surface an
          // admin meets it on - three different explanations of one retirement
          // read as three faults. Same split as the run path's
          // RETIRED_IN_APP_STEP_DETAIL / UNRUNNABLE_STEP_DETAIL.
          detail:
            step.step_type === 'NOTIFY_TEAM' ? retiredInAppStepMessage(index) : UNSUPPORTED_STEP_MESSAGE,
        });
        return;
      }
      const firstIssue = issuesByStep.get(index);
      if (firstIssue) {
        outcomes.push({ step_index: index, step_type: step.step_type, outcome: 'needs_setup', detail: firstIssue });
        return;
      }
      if (step.step_type === 'WAIT') {
        // Anchored waits (v2.1) carry offset_minutes/anchor/direction, not
        // duration_minutes — branch before falling into the legacy relative
        // read below, else duration_minutes is undefined and the preview
        // reads "undefined minutes" (the real engine already branches the
        // same way; see enrollment.ts's isAnchoredWait check).
        if (isAnchoredWait(step.config)) {
          outcomes.push({
            step_index: index,
            step_type: 'WAIT',
            outcome: 'would_wait',
            detail: `until ${describeAnchoredWait(step.config)}`,
          });
          return;
        }
        const minutes = (step.config as { duration_minutes: number }).duration_minutes;
        outcomes.push({ step_index: index, step_type: 'WAIT', outcome: 'would_wait', detail: humanizeDuration(minutes) });
        return;
      }
      if (step.step_type === 'STOP_IF') {
        const condition = (step.config as { condition: string }).condition;
        outcomes.push({
          step_index: index,
          step_type: 'STOP_IF',
          outcome: 'would_check',
          detail: `Keeps going unless ${STOP_IF_LABELS[condition]}`,
        });
        return;
      }
      const cfg = step.config as { recipient?: string; recipients?: string[]; subject?: string; body: string };
      // The same renderer and the same per-step fallback map a real send uses (executors.ts), so
      // the empty-state preview IS what a customer with nothing on file would receive.
      const renderOpts = { html: false, fallbacks: fallbacksFor(step.config) };
      const rendered: SendPreview = {
        ...(cfg.subject ? { subject: renderMergeFields(cfg.subject, previewContext, renderOpts) } : {}),
        body: renderMergeFields(cfg.body, previewContext, renderOpts),
      };
      outcomes.push({
        step_index: index,
        step_type: step.step_type,
        outcome: 'would_send',
        detail: `Would send to ${recipientPreviewLabel(cfg, entity)}`,
        rendered,
      });
      validSends.push(rendered);
    });

    const delivered: string[] = [];
    if (body.send_to_me) {
      const caller = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { id: true, email: true },
      });
      if (caller?.email) {
        for (const send of validSends) {
          // Escape the WHOLE rendered body (staff literals + merge values), then add
          // only our own <br> line breaks — see executors.ts toHtmlFragment.
          const htmlBody = `<p style="margin:0 0 16px;">${esc(send.body).replace(/\n/g, '<br>')}</p>`;
          await sendAutomationEmail({
            organizationId: req.user!.organization_id,
            to: caller.email,
            subject: `[Test] ${send.subject ?? (workflow as any).name}`,
            text: send.body,
            html: htmlBody,
            // no `record` — test sends never appear in the Communication inbox
          });
          delivered.push('email');
        }
      }
      // Object type MUST be non-row-scoped ('AUTOMATION' passes straight through
      // filterRecipientsByAccess): a scoped type like 'JOB' would look up a Job
      // row by the WORKFLOW's id, find nothing, and fail-closed drop the recipient.
      await emit({
        verb: 'automation.message',
        organizationId: req.user!.organization_id,
        actorId: null,
        object: { type: 'AUTOMATION', id: (workflow as any).id, label: '[Test]' },
        entity: { recipient_ids: [req.user!.id] },
        data: {
          title: `[Test] ${(workflow as any).name}`,
          body: `This is a test run of your "${(workflow as any).name}" automation.`,
          object_type: 'AUTOMATION',
        },
      });
      delivered.push('in_app');
    }

    res.json({ steps: outcomes, delivered });
  } catch (err) {
    logger.error('Failed to test workflow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getWorkflowActivity(req: Request, res: Response) {
  try {
    const workflow = await prisma.workflow.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, legacy_rule_id: true },
    });
    if (!workflow) {
      res.status(404).json({ error: 'Automation not found' });
      return;
    }
    const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;

    type ActivityRow = {
      id: string;
      source: 'workflow' | 'legacy';
      when: Date;
      step_index: number;
      step_type: string;
      status: string;
      recipient_summary: string | null;
      detail: string | null;
      /** One entry per resolved audience of a send step; [] on legacy rows and pre-column runs. */
      audience_outcomes: unknown[];
      entity_label: string | null;
    };

    const stepRuns = await prisma.workflowStepRun.findMany({
      where: { ...tenantWhere(req), enrollment: { workflow_id: workflow.id } },
      orderBy: { created_at: 'desc' },
      take: limit,
      include: { enrollment: { select: { entity_type: true, entity_id: true, entity_label: true } } },
    });
    const newRows: ActivityRow[] = stepRuns.map((r: any) => ({
      id: r.id,
      source: 'workflow' as const,
      when: r.created_at,
      step_index: r.step_index,
      step_type: r.step_type,
      status: r.status,
      recipient_summary: r.recipient_summary ?? null,
      detail: r.detail ?? null,
      audience_outcomes: Array.isArray(r.audience_outcomes) ? r.audience_outcomes : [],
      entity_label: r.enrollment?.entity_label ?? null,
    }));

    let legacyRows: ActivityRow[] = [];
    if ((workflow as any).legacy_rule_id) {
      const runs = await prisma.automationRun.findMany({
        where: { rule_id: (workflow as any).legacy_rule_id, ...tenantWhere(req) },
        orderBy: { created_at: 'desc' },
        take: limit,
        include: { rule: { select: { action_type: true } } },
      });
      legacyRows = runs.map((r: any) => ({
        id: r.id,
        source: 'legacy' as const,
        when: r.executed_at ?? r.created_at,
        step_index: 0,
        step_type: r.rule.action_type === 'SEND_SMS' ? 'SEND_TEXT' : r.rule.action_type,
        status: r.status,
        recipient_summary: r.recipient_summary ?? null,
        detail: r.detail ?? null,
        // The legacy engine never resolved audiences, so there is nothing to show per audience.
        audience_outcomes: [],
        entity_label: r.entity_label ?? null,
      }));
    }

    const rows = [...newRows, ...legacyRows]
      .sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime())
      .slice(0, limit);
    res.json({ rows });
  } catch (err) {
    logger.error('Failed to load workflow activity:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
