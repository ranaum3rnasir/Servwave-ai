/**
 * dispatch.ts — the ONE call controllers make to feed the Automation Center.
 *
 * dispatchAutomationEvent is fire-and-forget and NEVER throws or blocks the
 * caller's response: the enrollment work (enrollOnEvent in enrollment.ts — the
 * multi-step workflow engine) is deferred to the next tick, mirroring the
 * notification service's post-commit contract (#271 rule — the caller must
 * invoke this AFTER its transaction commits, never inside it).
 */

import { AutomationTriggerType } from '@prisma/client';
import { logger } from '../../lib/logger';
import type { AutomationEntity } from './automationEntity';
import { enrollOnEvent } from './enrollment';
import type { EventPayload } from './context';
import type { DispatchLane } from './dispatchLane';

/** Event-shaped triggers (time-based ones are owned by the poller). */
export type EventTriggerType = Exclude<
  AutomationTriggerType,
  'BEFORE_JOB_START' | 'AFTER_JOB_COMPLETED' | 'INVOICE_OVERDUE' | 'ESTIMATE_FOLLOW_UP'
>;

export interface AutomationEvent {
  type: EventTriggerType;
  organizationId: string;
  /** Typed by the ONE named entity union (automationEntity.ts), never a hand-written copy. */
  entity: { type: AutomationEntity; id: string; label?: string | null };
  /**
   * Occurrence discriminator for occurrence-scoped triggers:
   * JOB_RESCHEDULED → new scheduled_start ISO; TECH_ASSIGNED → user id.
   */
  occurrenceKey?: string;
  /**
   * Multi-visit D18: the visit this occurrence is about. It joins the DEDUPE key
   * (dedupe.ts), never the occurrence key, so two visits on one job enrol twice
   * instead of visit 2 being swallowed as a duplicate of visit 1.
   *
   * Since the per-visit-enrollment spec (2026-09-14) it is ALSO persisted on the
   * enrollment as `visit_id`, and that is what makes the run RENDER this trip:
   * loadEntityBundle resolves the named visit rather than re-deriving one from the
   * parent. The ENTITY still stays the parent job/lead (that spec's D5) - a visit
   * is a qualifier on an entity, not an entity, and AutomationEntity gains no
   * member.
   */
  visitId?: string;
  /**
   * Rule 0 (never tell someone about their own action): the user whose request
   * caused this event. enrollOnEvent folds it into the enrollment's event_payload,
   * from which recipients.ts drops them out of every resolved audience - so it must
   * be a real user id on the staff doors, and null on the doors that have no acting
   * user at all (the Stripe webhook, the public estimate/invoice pages), where the
   * exclusion is correctly a no-op.
   */
  actorId?: string | null;
  /** Whatever this event captured that the live entity won't have later (a removed
   *  recipient, request-time text) — see context.ts's EventPayload. */
  eventPayload?: EventPayload;
}

function enrollSwallowingFailure(ev: AutomationEvent): Promise<void> {
  return enrollOnEvent(ev).catch((err) => {
    logger.warn('[automations] dispatch failed — swallowing to protect caller', {
      type: ev.type,
      entityId: ev.entity.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * `lane`: one request dispatching a burst (a bulk task delete) passes a bounded lane
 * (dispatchLane.ts) so its enrolments run a few at a time instead of all on the next tick.
 */
export function dispatchAutomationEvent(ev: AutomationEvent, opts: { lane?: DispatchLane } = {}): void {
  if (opts.lane) {
    opts.lane.run(() => enrollSwallowingFailure(ev));
    return;
  }
  setImmediate(() => {
    void enrollSwallowingFailure(ev);
  });
}
