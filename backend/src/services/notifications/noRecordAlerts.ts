/**
 * noRecordAlerts.ts - the one place the alerts that have no record are sent from (Roles & Permissions, PRD 6, S06.29).
 *
 * The payments-account alerts (payments active, payouts enabled, more information needed, payments paused, payments disconnected,
 * connect your bank), Invite accepted, Low stock, Item on backorder, Purchase order partly received, Staging has no area and a stock
 * approval request are about the company, not about a job, a lead or an invoice. They go through M6's two lanes from the second
 * step (alertChain.ts, record null): the active holders of the alert's switch, else the company's Admins, with the
 * why line naming what nobody could do. There are no record people, no Dispatcher step and no copies: nobody comes from a role name,
 * and the person who did it is never told. A person who holds the switch with the Admin box ticked off is not told.
 *
 *   billing.payments_*, billing.payouts_*   the Admins (setting up the company is the Admin flag's alone since 36b)
 *   team.invite_accepted                    the Admins (inviting people is the Admin flag's alone since AL-18)
 *   inventory.low_stock, backorder, po_partial   Create purchase orders
 *   inventory.staging_no_area, stock_approval_requested   Edit stock
 *
 * The two kinds of caller. A request (an invite accepted, a stock movement, a purchase order received) only QUEUES the alert
 * (queueNoRecordAlert) and it is sent once the response has gone out with a success status, never inside the request's
 * transaction. A webhook, reconciler or sweep with no request of its own sends it directly (alertSwitchHolders) after its own
 * commit, on the global client; both log a failure and never throw. An event that is reported twice keeps its dedup key on the first
 * alert and suffixes the second (the one carrying the why line), so a retried event produces neither again.
 *
 * Cost of one alert, the same however large the company: one read to see whether it was sent already, the step's holders (one read
 * of the company's people and the batched switch reads), the manager fallback's holders when nobody holds the step, and one write pair
 * per alert sent. A caller that raises many of them at once (a stock movement over many items) hands in `holdersOf`, a reader that
 * remembers its answers, so the company's holders are read once for the whole run: see memoisedHolders.
 */

import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { ADMINS, activeSwitchHolders } from '../../lib/permissions/switchHolders';
import { sendByWhyLine, twoLaneRecipients, WHY_KEY, type TwoLaneInput } from './alertChain';
import { emit } from './notificationService';
import { queueAlertAfterResponse, requestMemo } from './reviewAttentionQueue';

/** The switch whose holders must act on each alert, the words for "nobody can ..." and the name a log line gives the alert. */
const NO_RECORD_ALERTS = {
  'billing.payments_activated': { step: ADMINS, stepWords: 'change company settings', alert: 'payments active alert' },
  'billing.payouts_activated': { step: ADMINS, stepWords: 'change company settings', alert: 'payouts enabled alert' },
  'billing.payments_action_needed': { step: ADMINS, stepWords: 'change company settings', alert: 'payments need more information alert' },
  'billing.payments_paused': { step: ADMINS, stepWords: 'change company settings', alert: 'payments paused alert' },
  'billing.payments_disconnected': { step: ADMINS, stepWords: 'change company settings', alert: 'payments disconnected alert' },
  'billing.payouts_pending_first_payment': { step: ADMINS, stepWords: 'change company settings', alert: 'connect your bank alert' },
  'team.invite_accepted': { step: ADMINS, stepWords: 'invite users', alert: 'invite accepted alert' },
  'inventory.low_stock': { step: 'create_purchase_orders', stepWords: 'create purchase orders', alert: 'low stock alert' },
  'inventory.backorder': { step: 'create_purchase_orders', stepWords: 'create purchase orders', alert: 'item on backorder alert' },
  'inventory.po_partial': { step: 'create_purchase_orders', stepWords: 'create purchase orders', alert: 'purchase order partly received alert' },
  'inventory.staging_no_area': { step: 'edit_stock', stepWords: 'edit stock', alert: 'staging has no area alert' },
  // Neither PRD 6's table nor PRD 7 has a row for it; it is told like its nearest sibling (the stock alerts), by Edit stock.
  'inventory.stock_approval_requested': { step: 'edit_stock', stepWords: 'edit stock', alert: 'stock approval requested alert' },
} as const;

export type NoRecordAlertVerb = keyof typeof NO_RECORD_ALERTS;

export const NO_RECORD_ALERT_VERBS = Object.keys(NO_RECORD_ALERTS) as NoRecordAlertVerb[];

export const isNoRecordAlertVerb = (verb: string): verb is NoRecordAlertVerb => verb in NO_RECORD_ALERTS;

export interface NoRecordAlertArgs {
  verb: NoRecordAlertVerb;
  organizationId: string;
  /** The person who did it (the person who accepted an invite, who moved stock); null for a processor's report or a sweep. */
  actorId: string | null;
  object: { type: string; id: string; label?: string };
  /** Display data kept on the alert. */
  data?: Record<string, unknown>;
  /** Doors that report one event share a key, so the alert goes out once. */
  dedupKey?: string;
  /** A caller that raises many alerts at once hands in a reader that remembers its answers (memoisedHolders). */
  holdersOf?: TwoLaneInput['holdersOf'];
}

/** A switch-holder reader that remembers its answers: the company's holders of a switch are read once for as long as it is kept. */
export function memoisedHolders(): NonNullable<TwoLaneInput['holdersOf']> {
  const answers = new Map<string, Promise<string[]>>();
  return (organizationId, switchKey) => {
    const key = `${organizationId}:${switchKey}`;
    let answer = answers.get(key);
    if (!answer) {
      answer = activeSwitchHolders(organizationId, switchKey);
      answers.set(key, answer);
    }
    return answer;
  };
}

/**
 * Send one alert that has no record. Returns the people it reached (every alert it went out as), [] when nobody was told, the event
 * was already sent, or it could not be sent: it never throws.
 */
export async function alertSwitchHolders(args: NoRecordAlertArgs): Promise<string[]> {
  try {
    const { organizationId, verb } = args;
    if (args.dedupKey) {
      const sent = await prisma.notification.findFirst({
        where: { organization_id: organizationId, dedup_key: { in: [args.dedupKey, args.dedupKey + WHY_KEY] } },
        select: { id: true },
      });
      if (sent) return [];
    }

    const row = NO_RECORD_ALERTS[verb];
    const answer = await twoLaneRecipients({
      organizationId,
      record: null,
      actorId: args.actorId,
      recordPeople: [],
      dispatcherId: null,
      stepSwitch: row.step,
      copySwitch: [],
      holdersOf: args.holdersOf,
      words: { record: 'company', step: row.stepWords, alert: row.alert },
    });

    const told: string[] = [];
    await sendByWhyLine(answer, async (entity, whyLine) => {
      told.push(...await emit({
        verb,
        organizationId,
        actorId: args.actorId,
        object: args.object,
        entity,
        data: { ...(args.data ?? {}), object_label: args.object.label, fallback_reason: whyLine ?? '' },
        ...(args.dedupKey ? { dedupKey: whyLine ? args.dedupKey + WHY_KEY : args.dedupKey } : {}),
      }));
    });
    return told;
  } catch (err) {
    logger.warn('[noRecordAlerts] could not send an alert', {
      verb: args.verb, organizationId: args.organizationId, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Leave an alert for after the response. A request's alert is sent once its response has gone out with a success status; where there
 * is no request to wait for it is sent at once without holding the caller. The switch holders are shared by every alert the request
 * queues, so a request raising many of them (a stock movement over many items) reads the company's holders once.
 */
export function queueNoRecordAlert(args: NoRecordAlertArgs): void {
  const holdersOf = args.holdersOf ?? requestMemo('noRecordAlerts.holders', memoisedHolders);
  args = { ...args, holdersOf };
  queueAlertAfterResponse({
    orgId: args.organizationId,
    actorId: args.actorId,
    send: async () => {
      await alertSwitchHolders(args);
    },
  });
}
