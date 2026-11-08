/**
 * recipients.ts — the audience resolver: the single source of truth for
 * "who does each recipient audience mean, for THIS record."
 *
 * The v2.1 recipient model is a multi-select over named audiences (customer,
 * assigned crew/performers, dispatcher, salesperson, creator, roles, a specific
 * person, a custom email). This module answers three questions and nothing else:
 *   • audiencesForEntity(entity) → which audiences are even offered here
 *   • audienceLabel(key, entity) → the plain-English name we show for one
 *   • resolveAudience(key, ctx)  → the concrete users/emails for one, per record
 *
 * CORRECTNESS CONTRACT: resolveAudience NEVER throws and NEVER silently sends to
 * nobody. Every empty path returns a plain-English `skipReason` (product copy —
 * it renders in the Activity tab), never an exception. Legacy stored configs may
 * still carry the old `'assigned_techs'` key; it is accepted as an exact alias of
 * `'assigned_team'`.
 *
 * RULE 0: never tell someone about their own action. `ctx.actorId` is dropped from
 * every resolved audience, once, around the whole switch (dropActingUser below) -
 * not per case, so the next key added is guarded the day it is written. Unlike the
 * bell there is no named-exception vocabulary here, and that is deliberate: audience
 * keys are admin configuration rather than developer classification, so an exception
 * string would have nowhere to live and no one to review it. The product's one
 * deliberate notify-yourself path (the Test dialog's send_to_me receipt in
 * workflow.controller.ts) never reaches this resolver.
 *
 * Task 18 populates the ctx people from the ExecutionBundle; Task 19 wires this
 * into executeAction; Task 20 renders the multi-select from audiencesForEntity.
 */

import { prisma } from '../../lib/prisma';
import type { AutomationEntity } from './automationEntity';
import type { RecipientUser } from './executors';

export type RecipientKey =
  | 'customer'
  | 'assigned_team'
  | 'dispatcher'
  | 'salesperson'
  | 'creator'
  | 'all_admins'
  | 'all_dispatchers'
  | 'specific_user'
  | 'custom'
  /**
   * The person the triggering event removed — not derivable from the live
   * entity (they're off the crew/team by the time the automation runs), so
   * this resolves from ctx.eventRecipient rather than a DB lookup. Legal only
   * for the two REMOVED triggers (TECH_UNASSIGNED, WALKTHROUGH_PERFORMER_REMOVED) —
   * added there directly in catalog.ts's audiencesFor, not via audiencesForEntity,
   * since it's a trigger-specific offering, not an entity-wide one.
   */
  | 'removed_user'
  /**
   * The mirror of removed_user: the person the triggering event just added.
   * TECH_ASSIGNED / WALKTHROUGH_PERFORMER_ASSIGNED dispatch once PER newly-added
   * person, but `assigned_team` resolves to the live FULL crew/team — using it
   * here would re-notify everyone already on the job/walkthrough every time one
   * more person joins. Resolves from the same ctx.eventRecipient field as
   * removed_user (the field is generic; its meaning comes from which event
   * populated it). Legal only for the two ASSIGNED triggers (TECH_ASSIGNED,
   * WALKTHROUGH_PERFORMER_ASSIGNED) — see catalog.ts's audiencesFor.
   */
  | 'assigned_user'
  /**
   * Spec B: the people DOING a task, and the people FOLLOWING one.
   *
   * Not folded into `assigned_team`. That key already means the crew on a job or the
   * walkthrough team on a lead, and its label is written per entity - reusing it for tasks
   * would force one of the two plain-English phrasings to be wrong. A task's two people
   * lists are also genuinely two audiences an admin picks between, which `assigned_team`
   * has no way to express.
   *
   * Both resolve from the live task (loaded in context.ts), not from the event, so an
   * automation that waits a day addresses whoever is on the task when it finally sends.
   */
  | 'assignees'
  | 'watchers';

/** Old stored/folded configs may still carry this — accepted as an alias of assigned_team. */
type LegacyRecipientKey = 'assigned_techs';

/**
 * The entity an audience is being resolved for. Aliased to the ONE named entity type
 * (automationEntity.ts) rather than kept as a second hand-written union: the two copies
 * had already been allowed to mean the same thing, and only one of them was ever going to
 * be widened by hand. Kept as a name because every call site reads better for it.
 */
export type AudienceEntity = AutomationEntity;

/** Everything resolveAudience needs, built from the ExecutionBundle by Task 19. */
export interface AudienceContext {
  organizationId: string;
  entity: AudienceEntity;
  /**
   * `extra_emails` is the customer's secondary addresses ALREADY narrowed to the
   * opted-in ones (`receives_emails: true`) by the context.ts query. Filtering there
   * rather than here means an opted-out address cannot reach an executor even if some
   * future caller assembles this ctx by hand. Shape mirrors the Prisma row so
   * context.ts stays a pass-through.
   */
  customer?: { id: string; email: string | null; extra_emails?: { email: string }[] | null } | null;
  assignees: RecipientUser[]; // job crew, walkthrough performers, OR the task's assignees
  /**
   * The task's watchers. Structurally empty for the other four entities, which have no
   * concept of following a record. Required rather than optional so the resolver arm below
   * cannot be written against a field some builder of this context forgot to fill - the
   * same trap `extra_emails` and `actorId` are commented for in executors.ts.
   */
  watchers: RecipientUser[];
  dispatcher?: RecipientUser | null;
  salesperson?: RecipientUser | null;
  creator?: RecipientUser | null;
  /** For 'removed_user' — sourced from the enrollment's event_payload (context.ts), not a live lookup. */
  eventRecipient?: RecipientUser | null;
  userId?: string; // for 'specific_user'
  customEmails?: string[]; // for 'custom'
  /**
   * Rule 0: never tell someone about their own action. The person whose request
   * caused this run, carried from the dispatching controller through the
   * enrollment's event_payload (so it survives a WAIT of any length) and dropped
   * from every resolved audience below. Null/absent for the paths that have no
   * actor at all - the cron sweeps, the Stripe webhook, the public doors - and
   * there the filter is a no-op.
   */
  actorId?: string | null;
}

export interface ResolvedAudience {
  users: RecipientUser[];
  emails: string[];
  skipReason?: string;
}

// ── which audiences each entity offers (per Ran's decisions) ────────────────
// `custom` is intentionally absent — it's added only for SEND_EMAIL, at
// validation time in Task 19, not here.
const AUDIENCES: Record<AudienceEntity, RecipientKey[]> = {
  job: ['customer', 'assigned_team', 'dispatcher', 'salesperson', 'all_admins', 'all_dispatchers', 'specific_user'],
  lead: ['customer', 'assigned_team', 'salesperson', 'all_admins', 'all_dispatchers', 'specific_user'],
  estimate: ['customer', 'creator', 'salesperson', 'all_admins', 'all_dispatchers', 'specific_user'],
  invoice: ['customer', 'all_admins', 'all_dispatchers', 'specific_user'],
  // No `customer`: a task has no customer, and the entity that carries one (through
  // linked_entity_type) is the JOB or LEAD the task hangs off, not the task itself.
  // Emailing that customer about internal to-do work is not something to offer by accident.
  //
  // `creator` is a DIVERGENCE from the bell, recorded here because it is invisible from
  // either side alone: no task bell verb routes to the creator (the TASK block in
  // services/notifications/resolveRecipients.ts reaches assignees and watchers only), while
  // an admin CAN address a task automation to them. A creator who is neither assigned nor
  // watching therefore gets automation email about a comment and never a bell for it. It is
  // defensible - the bell is for the people the task NAMES, this list is the admin's choice -
  // and the same note sits on `task.commented` in services/notifications/templates.ts.
  task: ['assignees', 'watchers', 'creator', 'all_admins', 'all_dispatchers', 'specific_user'],
};

export function audiencesForEntity(entity: AudienceEntity): RecipientKey[] {
  // Fresh copy so callers can't mutate the shared source of truth.
  return [...AUDIENCES[entity]];
}

// ── plain-English label for one audience (differs per entity where it matters) ─
export function audienceLabel(key: RecipientKey, entity: AudienceEntity): string {
  switch (key) {
    case 'customer':
      return 'the customer';
    case 'assigned_team':
      return entity === 'lead' ? 'the walkthrough team' : 'the assigned crew';
    case 'dispatcher':
      return 'the dispatcher';
    case 'salesperson':
      return 'the salesperson';
    case 'creator':
      return 'the creator';
    case 'all_admins':
      return 'all admins';
    case 'all_dispatchers':
      return 'all dispatchers';
    case 'specific_user':
      return 'a specific person';
    case 'custom':
      return 'a custom email';
    case 'removed_user':
      return entity === 'lead' ? 'the removed performer' : 'the removed technician';
    case 'assigned_user':
      // Spec B: a task assignee holds no trade and performs no walkthrough, so neither
      // existing phrasing survives the third entity. Written as the person, not the role.
      if (entity === 'task') return 'the person just assigned';
      return entity === 'lead' ? 'the assigned performer' : 'the assigned technician';
    case 'assignees':
      return 'the assignees';
    case 'watchers':
      return 'the watchers';
  }
}

// ── resolve one audience to concrete users/emails for THIS record ───────────

/**
 * Rule 0, applied ONCE around the whole switch rather than inside each case.
 * Nine of the eleven keys resolve to user rows and every one of them must drop
 * the acting user; `customer` and `custom` resolve to raw addresses with a
 * structurally empty `users`, so the same filter is a no-op for them and needs
 * no special case. Filtering here rather than per-case is the point of this
 * seam: the twelfth key added below is guarded the day it is written.
 *
 * The never-throw/never-silently-empty contract holds through the drop - when
 * removing the actor is what emptied an audience, this supplies the plain-English
 * reason. When the audience was ALREADY empty for its own reason, that reason
 * wins: an unassigned job still says nobody is assigned.
 *
 * That reason has to read correctly for EVERY trigger shape, because this function
 * sees only (resolved, actorId) and never the trigger - deliberately, so a new
 * trigger cannot arrive with an unguarded audience. So it says "triggered this",
 * not "made this change": on a CREATION trigger nothing was changed, and the
 * change wording misread on LEAD_CREATED in the Activity tab. Keep any future
 * rewording trigger-neutral rather than plumbing the trigger down here.
 */
function dropActingUser(resolved: ResolvedAudience, actorId: string | null | undefined): ResolvedAudience {
  if (!actorId) return resolved;
  const users = resolved.users.filter((u) => u.id !== actorId);
  if (users.length === resolved.users.length) return resolved;
  if (users.length > 0 || resolved.emails.length > 0) return { ...resolved, users };
  return {
    ...resolved,
    users,
    skipReason: resolved.skipReason ?? 'The only person to notify is the one who triggered this',
  };
}

export async function resolveAudience(
  key: RecipientKey | LegacyRecipientKey,
  ctx: AudienceContext,
): Promise<ResolvedAudience> {
  return dropActingUser(await resolveAudienceKey(key, ctx), ctx.actorId);
}

async function resolveAudienceKey(
  key: RecipientKey | LegacyRecipientKey,
  ctx: AudienceContext,
): Promise<ResolvedAudience> {
  // Fold the legacy alias so everything downstream sees the canonical key.
  const k: RecipientKey = key === 'assigned_techs' ? 'assigned_team' : key;

  switch (k) {
    case 'customer': {
      // Primary first, then each opted-in secondary address. Deduped on a trimmed,
      // lower-cased key (the same address can legitimately be typed into both the
      // primary field and an extra row) while the ORIGINAL casing is what we send to.
      const seen = new Set<string>();
      const emails: string[] = [];
      for (const raw of [ctx.customer?.email, ...(ctx.customer?.extra_emails ?? []).map((e) => e.email)]) {
        const value = raw?.trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        emails.push(value);
      }
      return emails.length > 0
        ? { users: [], emails }
        : { users: [], emails: [], skipReason: 'The customer has no email address on file' };
    }

    case 'assigned_team': {
      if (ctx.assignees.length > 0) return { users: ctx.assignees, emails: [] };
      return {
        users: [],
        emails: [],
        skipReason:
          ctx.entity === 'lead' ? 'No walkthrough team is assigned yet' : 'No one is assigned to this job yet',
      };
    }

    case 'dispatcher':
      return ctx.dispatcher
        ? { users: [ctx.dispatcher], emails: [] }
        : { users: [], emails: [], skipReason: 'No dispatcher is assigned to this job' };

    case 'salesperson':
      return ctx.salesperson
        ? { users: [ctx.salesperson], emails: [] }
        : { users: [], emails: [], skipReason: 'No salesperson is assigned' };

    case 'creator':
      return ctx.creator
        ? { users: [ctx.creator], emails: [] }
        : { users: [], emails: [], skipReason: 'This record has no creator on file' };

    case 'all_admins':
    case 'all_dispatchers': {
      const role = k === 'all_admins' ? 'ADMIN' : 'DISPATCHER';
      const users = await prisma.user.findMany({
        where: { organization_id: ctx.organizationId, role, is_active: true },
        select: { id: true, email: true, first_name: true, last_name: true, phone: true },
      });
      if (users.length === 0) {
        return {
          users: [],
          emails: [],
          skipReason: `No active ${role === 'ADMIN' ? 'admins' : 'dispatchers'} to notify`,
        };
      }
      return { users, emails: [] };
    }

    case 'specific_user': {
      if (!ctx.userId) return { users: [], emails: [], skipReason: 'No team member was chosen' };
      const user = await prisma.user.findFirst({
        where: { id: ctx.userId, organization_id: ctx.organizationId, is_active: true },
        select: { id: true, email: true, first_name: true, last_name: true, phone: true },
      });
      return user
        ? { users: [user], emails: [] }
        : { users: [], emails: [], skipReason: 'That team member is no longer available' };
    }

    case 'custom': {
      const emails = ctx.customEmails ?? [];
      return emails.length > 0
        ? { users: [], emails }
        : { users: [], emails: [], skipReason: 'No email address was configured' };
    }

    case 'removed_user':
      return ctx.eventRecipient
        ? { users: [ctx.eventRecipient], emails: [] }
        : { users: [], emails: [], skipReason: 'No removed team member was captured for this run' };

    case 'assigned_user':
      return ctx.eventRecipient
        ? { users: [ctx.eventRecipient], emails: [] }
        : { users: [], emails: [], skipReason: 'No assigned team member was captured for this run' };

    case 'assignees':
      // The task API refuses to leave a live task with nobody on it, so this skip is
      // reachable mainly through Rule 0 emptying the list - dropActingUser supplies the
      // better reason in that case, and this one covers the rows a sweep left behind.
      return ctx.assignees.length > 0
        ? { users: ctx.assignees, emails: [] }
        : { users: [], emails: [], skipReason: 'No one is assigned to this task' };

    case 'watchers':
      return ctx.watchers.length > 0
        ? { users: ctx.watchers, emails: [] }
        : { users: [], emails: [], skipReason: 'No one is watching this task' };
  }
}
