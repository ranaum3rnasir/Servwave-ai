/**
 * logisticOrderAlerts.ts - the one place the logistic order submitted alert is sent from (Roles & Permissions, PRD 7, S07.9).
 *
 * "Who must approve this order" is the whole question, so the alert is not a two-lane alert: it has no record people, no Dispatcher
 * step and no copies (the order's people and the job's are never told by it). It starts at the holders of Approve logistic orders
 * (alertChain.ts, record null) and, when none is someone, goes on to the holders of Manage roles and permissions with the line
 * "Nobody can approve this order". "Someone" is the alert test of every chain: active, not the person who submitted it, and here
 * also able to reach the order, by the order's own read rule (lib/permissions/logisticOrderApprovers). A chain that ends with
 * nobody is logged by the chain and nothing is sent. Nobody comes from a role name: a person on a role called Admin with Approve
 * switched off is not told. Bell only.
 *
 * Sent AFTER the submit committed and the response went out, off the request queue (reviewAttentionQueue), never inside the
 * request: the company's holders are read once, their reach is asked in one batch per distinct filter, and the submit itself gains
 * no query. A failure is logged and never reaches the submit that already landed.
 */

import { logger } from '../../lib/logger';
import { peopleWhoCanReachOrder } from '../../lib/permissions/logisticOrderApprovers';
import { activeSwitchHolders } from '../../lib/permissions/switchHolders';
import { sendByWhyLine, twoLaneRecipients, WHY_KEY } from './alertChain';
import { emit } from './notificationService';
import { queueAlertAfterResponse } from './reviewAttentionQueue';

export interface LogisticOrderSubmittedArgs {
  organizationId: string;
  /** The person who submitted it; never someone for the alert. */
  actorId: string;
  actorName: string;
  order: { id: string; number: string };
  /** One key per submit, so a later submit of the same order is told again; the why-line alert carries it with WHY_KEY. */
  dedupKey: string;
}

/** Send the alert; returns the people it reached and never throws. */
export async function alertLogisticOrderSubmitted(args: LogisticOrderSubmittedArgs): Promise<string[]> {
  try {
    const { organizationId, order } = args;
    const answer = await twoLaneRecipients({
      organizationId,
      record: null,
      actorId: args.actorId,
      recordPeople: [],
      dispatcherId: null,
      stepSwitch: 'approve_logistic_orders',
      copySwitch: [],
      // A holder is someone only if they can reach the order too, for the manager fallback as much as for the approvers.
      holdersOf: async (org, switchKey) => peopleWhoCanReachOrder(
        org, order.id, (await activeSwitchHolders(org, switchKey)).filter((id) => id !== args.actorId),
      ),
      words: { record: 'order', step: 'approve this order', alert: 'logistic order submitted alert' },
    });

    const told: string[] = [];
    await sendByWhyLine(answer, async (entity, whyLine) => {
      told.push(...await emit({
        verb: 'lo.submitted',
        organizationId,
        actorId: args.actorId,
        object: { type: 'LOGISTIC_ORDER', id: order.id, label: order.number },
        entity,
        data: {
          logistic_order_id: order.id,
          object_label: order.number,
          actor_name: args.actorName,
          fallback_reason: whyLine ?? '',
        },
        dedupKey: whyLine ? args.dedupKey + WHY_KEY : args.dedupKey,
      }));
    });
    return told;
  } catch (err) {
    logger.warn('[logisticOrderAlerts] could not send the order submitted alert', {
      orderId: args.order.id, organizationId: args.organizationId, error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** Leave the alert for after the response: the submit route only queues it. */
export function queueLogisticOrderSubmitted(args: LogisticOrderSubmittedArgs): void {
  queueAlertAfterResponse({
    orgId: args.organizationId,
    actorId: args.actorId,
    send: async () => {
      await alertLogisticOrderSubmitted(args);
    },
  });
}
