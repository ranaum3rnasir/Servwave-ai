/**
 * seedDefaultAutomations.ts — writes each DEFAULT_AUTOMATIONS entry as a real,
 * published Workflow for one org, in the exact shape workflow.controller.ts's
 * own publishWorkflow() writes (Workflow + WorkflowStep + WorkflowVersion,
 * published_version_id set) — so a seeded automation is indistinguishable
 * from a hand-built one the moment it lands: editable, versionable, deletable.
 *
 * Idempotent per (organization_id, builtin_key) — the unique index is the
 * backstop, but this checks first so a re-run is a clean no-op rather than a
 * caught constraint violation. That skip is also why `is_enabled` is read from
 * the registry rather than hardcoded off: an existing row is never touched, so
 * a workflow seeded disabled could never be enabled by re-running the seeder.
 * The no-double-send rule is held in the registry instead — an entry only
 * carries `seed_enabled: true` in the same change that deletes the hard-coded
 * sender it replaces (see DefaultAutomation.seed_enabled).
 *
 * Entitlement-gated (#1069): seeding is a one-way door - the idempotent-by-SKIP
 * design above means a row created for an org that isn't entitled to
 * `automations` can never be corrected by re-running this. The rows must never
 * exist in the first place, so the whole org is checked before touching any row.
 */
import { Prisma, WorkflowStepType, AutomationSendWindow } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { hasFeature } from '../../lib/entitlements/resolve';
import { DEFAULT_AUTOMATIONS, type DefaultAutomation } from './defaultAutomations';
import { DEFAULT_MERGE_FIELD_FALLBACKS } from './mergeFieldFallbacks';

export interface SeedResult {
  created: string[];
  skipped: string[];
  /** false when the org isn't entitled to `automations` - every definition is
   *  reported skipped without a single existence check or write. */
  entitled: boolean;
}

/**
 * Spec B slice 7: `trigger_config` comes from the registry entry, not from a hardcoded null.
 *
 * All thirteen original defaults are event triggers, whose config is legitimately null - the
 * validator refuses a config on one outright. The fourteenth kind is date-anchored, and its
 * timing IS its config. Left hardcoded, a seeded date-anchored workflow publishes, enables,
 * validates and reads back correctly in the builder, and then cron.ts's dateAnchorConfigOf
 * returns null on every tick, logs "invalid trigger_config - skipping", and the reminder never
 * fires for any org, ever, with nothing red anywhere.
 *
 * EXPORTED, too, so the assembled-path test can run the five task defaults through the real
 * engine in exactly the shape this seeder freezes rather than against a hand-written copy. A
 * copy would drift, and every failure mode this spec has - a wrong audience key, a merge field
 * that renders empty, a null trigger_config - is invisible until the definition is executed.
 */
export function buildDefinition(def: DefaultAutomation) {
  return {
    trigger_type: def.trigger_type,
    trigger_config: def.trigger_config ?? null,
    send_window: 'ANYTIME' satisfies AutomationSendWindow,
    steps: [
      {
        position: 0,
        step_type: 'SEND_EMAIL' satisfies WorkflowStepType,
        // "If empty, fill with" seeded explicitly (mergeFieldFallbacks.ts): the popover on a fresh
        // org shows the words its copy renders, and the read-side default covers steps older than it.
        config: { recipients: def.recipients, subject: def.subject, body: def.body, fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS } },
      },
    ],
  };
}

/** Seed every DEFAULT_AUTOMATIONS entry the org doesn't already have. Never throws per-entry — one bad insert is logged into the result rather than aborting the rest (mirrors enrollOnEvent's per-item isolation). */
export async function seedDefaultAutomationsForOrg(
  organizationId: string,
  /** Defaults to the real registry; overridable so a test can prove the seed_enabled contract on a definition that isn't in it. */
  definitions: readonly DefaultAutomation[] = DEFAULT_AUTOMATIONS,
): Promise<SeedResult> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { plan: true, trial_ends_at: true, feature_overrides: true },
  });
  // feature_overrides is JSONB (Prisma.JsonValue); hasFeature only ever reads
  // it as a plain object map, matching every other entitlement call site.
  const entitlementSource = org && { ...org, feature_overrides: org.feature_overrides as Record<string, unknown> | null };
  if (!entitlementSource || !hasFeature(entitlementSource, 'automations')) {
    return { created: [], skipped: definitions.map((d) => d.builtin_key), entitled: false };
  }

  const result: SeedResult = { created: [], skipped: [], entitled: true };

  for (const def of definitions) {
    const existing = await prisma.workflow.findFirst({
      where: { organization_id: organizationId, builtin_key: def.builtin_key },
      select: { id: true },
    });
    if (existing) {
      result.skipped.push(def.builtin_key);
      continue;
    }

    const definition = buildDefinition(def);
    await prisma.$transaction(async (tx) => {
      const workflow = await tx.workflow.create({
        data: {
          name: def.name,
          status: 'PUBLISHED',
          is_enabled: def.seed_enabled,
          trigger_type: def.trigger_type,
          // The ROW's copy, which is the one the poller reads (cron.ts's scanDateAnchorTriggers
          // selects on `trigger_type` and parses `workflow.trigger_config` - it never opens the
          // frozen version). DbNull, not JsonNull, for the event triggers: the column is
          // nullable and an absent config must be a SQL NULL, not the JSON value `null`.
          trigger_config: def.trigger_config
            ? (def.trigger_config as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
          send_window: 'ANYTIME',
          builtin_key: def.builtin_key,
          organization_id: organizationId,
          published_at: new Date(),
        },
      });
      await tx.workflowStep.create({
        data: {
          workflow_id: workflow.id,
          position: 0,
          step_type: 'SEND_EMAIL',
          config: definition.steps[0].config as unknown as Prisma.InputJsonValue,
          organization_id: organizationId,
        },
      });
      const version = await tx.workflowVersion.create({
        data: {
          workflow_id: workflow.id,
          version: 1,
          definition: definition as unknown as Prisma.InputJsonValue,
          organization_id: organizationId,
        },
      });
      await tx.workflow.update({
        where: { id: workflow.id },
        data: { published_version_id: version.id },
      });
    });
    result.created.push(def.builtin_key);
  }

  return result;
}
