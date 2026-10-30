import type { Request } from 'express';
import { prisma } from '../prisma';
import { canActOnRow } from './enforce';

/**
 * What a person may do to one logistic order right now (Roles & Permissions, PRD 7, S07.10).
 *
 * The order's own answer carries this list, so the screen never tests a switch against an order's status by itself:
 * this is the one place where "this status allows Approve" meets "this person holds Approve" and the reach the order
 * is read through. It mirrors, action for action, what the order's routes accept, so no control is offered that the
 * routes would refuse (the routes stay the authority; this only names what they would let through).
 *
 *   submit    Create logistic orders (there is no separate submit switch), on a draft
 *   approve   Approve logistic orders, on a submitted order
 *   process   Process logistic orders, on an approved order; on a draft or submitted one only for a person who also
 *             holds Approve logistic orders (it carries the order straight through)
 *   cancel    Cancel logistic orders, on an order that is not yet processed
 *   edit      Edit logistic orders, on an order that is not cancelled or returned; a processed order's edit moves stock,
 *             so it also needs Process; an approved order's lines have been reviewed, so it also needs Approve or Process
 *   delete    Delete logistic orders; a processed order's delete returns its stock, so it also needs Process
 *   pick_up   Pick up staged items, on a processed order not yet taken (the pickup mark moves no stock and needs none of
 *             the write switches above, only View logistic orders and the order's reach)
 *   record_pickup  Record pickup for someone else, on the same orders
 *
 * On an order whose job is cancelled nothing moves the order forward (submit, approve, process, cancel), as the routes
 * answer. The completed-job lock does not reach orders: its routes never ask it, and this does not either.
 *
 * Every probe is the route's own `canActOnRow` (the person's read reach intersected with the verb's own), which
 * answers without a query for an unconditional grant, so this adds no query per order that the routes do not make.
 */
export type LogisticOrderAction = 'submit' | 'approve' | 'process' | 'cancel' | 'edit' | 'delete' | 'pick_up' | 'record_pickup';

/** The order the answer lists them in. */
export const LOGISTIC_ORDER_ACTIONS: readonly LogisticOrderAction[] = ['submit', 'approve', 'process', 'cancel', 'edit', 'delete', 'pick_up', 'record_pickup'];

/** The verb each action's switch grants on the order. */
const VERB: Record<LogisticOrderAction, string> = {
  submit: 'submit',
  approve: 'approve',
  process: 'process',
  cancel: 'cancel',
  edit: 'update',
  delete: 'delete',
  // The pickup needs the order's read reach and nothing else of the order's own; its switch is checked on the ability.
  pick_up: 'read',
  record_pickup: 'read',
};

const OPEN = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

export interface OrderForActions {
  id: string;
  status: string;
  taken_at?: Date | null;
  job?: { status: string } | null;
}

export async function logisticOrderActionsFor(req: Request, order: OrderForActions): Promise<LogisticOrderAction[]> {
  const { id, status } = order;
  const jobCancelled = order.job?.status === 'CANCELLED';
  const holdsApprove = req.ability?.can('approve', 'LogisticOrder') ?? false;
  const may = (verb: string) => canActOnRow(req, 'LogisticOrder', prisma.logisticOrder, id, verb);

  const listed: LogisticOrderAction[] = [];
  for (const action of LOGISTIC_ORDER_ACTIONS) {
    if (!statusAllows(action, status, jobCancelled, holdsApprove)) continue;
    if (action === 'pick_up' && !(req.ability?.can('pick_up_staged', 'Inventory') ?? false)) continue;
    if (action === 'record_pickup' && !(req.ability?.can('record_pickup_for_other', 'Inventory') ?? false)) continue;
    if ((action === 'pick_up' || action === 'record_pickup') && order.taken_at) continue;
    if (!(await may(VERB[action]))) continue;
    // The extra authority a stock-moving or reviewed order asks of an edit or a delete.
    if (action === 'edit' && status === 'PROCESSED' && !(await may('process'))) continue;
    if (action === 'delete' && status === 'PROCESSED' && !(await may('process'))) continue;
    if (action === 'edit' && status === 'APPROVED' && !((await may('approve')) || (await may('process')))) continue;
    listed.push(action);
  }
  return listed;
}

function statusAllows(action: LogisticOrderAction, status: string, jobCancelled: boolean, holdsApprove: boolean): boolean {
  switch (action) {
    case 'submit':
      return status === 'DRAFT' && !jobCancelled;
    case 'approve':
      return status === 'PENDING_APPROVAL' && !jobCancelled;
    case 'process':
      if (jobCancelled) return false;
      return holdsApprove ? OPEN.includes(status) : status === 'APPROVED';
    case 'cancel':
      return OPEN.includes(status) && !jobCancelled;
    case 'edit':
      // A cancelled or returned order takes no edit; a processed edit on a cancelled job is refused.
      return status !== 'CANCELLED' && status !== 'RETURNED' && !(status === 'PROCESSED' && jobCancelled);
    case 'delete':
      return true;
    case 'pick_up':
    case 'record_pickup':
      // Not a move of the order, so the job's state does not matter: a processed order whose job is cancelled is unwound.
      return status === 'PROCESSED';
  }
}
