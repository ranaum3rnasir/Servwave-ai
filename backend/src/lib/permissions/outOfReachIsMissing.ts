import type { NextFunction, Request, Response, Router } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { logger } from '../logger';
import { canAccessRow } from './enforce';
import { moduleReachFor, reachWhere } from './moduleReach';
import { noteRowRefusal } from './refusalNote';
import { canAccessTask, seesAllTasks } from '../tasks/visibility';
import { seesAllCalendarEntries, withCalendarEntryRule } from '../calendar-entries/visibility';
import { unscopedRequest } from '../../middleware/unscopedRequest';
import { isPermissionGate } from '../../middleware/canGuard';
import { markRouteCheck, routeCheckOf } from '../../middleware/routeCheck';
import { CANONICAL_ID, isOtherSpellingOfId, markCanonicalIdGuard } from '../ids/canonicalId';

/**
 * "Not found" means not found (spec stories 47 and 50, ticket 33). A record a person can't reach answers exactly like a
 * record that does not exist, on every route that takes its id, so the answer never confirms that the id is real.
 *
 * One rule per router instead of a check per handler: `answerOutOfReachAsMissing` is called once at the bottom of a
 * route file, after every route is registered, and puts the reach check into every route of that router whose path
 * names the record's id. It runs right after the route's permission gates (`canDo`, `canDoAny`), so a person whose
 * switch is off is still refused at the gate with a 403 that says nothing about the record, and before everything else
 * (body validation, uploads, the handler), so an out-of-reach id never reaches a step whose answer depends on the record.
 * A route added later on the same router is covered the day it lands.
 *
 * The check is the person's READ reach for the record (the reach layer: Data Scope, Tasks scope, Events scope...). A
 * verb's own narrower reach (`canActOnRow`) stays with the handler and may still answer 403: by then the person can open
 * the record, so a 403 tells them nothing new. Routes for a customer's own link (no signed-in person) are left alone.
 *
 * Reach that covers every row (an Admin, or a scope of All) skips the probe: the handler's own tenant lookup answers a
 * missing id as it always has.
 */

/** Whether the record with this id exists in the person's company and they reach it. */
export type ReachProbe = (req: Request, id: string) => Promise<boolean>;

type RouteLayer = { handle: (req: Request, res: Response, next: NextFunction) => unknown };
type RouterLayer = { route?: { path: string; stack: RouteLayer[] } };

export interface OutOfReachRule {
  /** The route parameter that carries the record's id (`id` for `/:id`). */
  param: string;
  /** The body a missing record of this kind answers with. */
  notFound: string;
  reaches: ReachProbe;
}

/** Put the reach check into every route of `router` that names `:param`. Call it after the last route is registered. */
export function answerOutOfReachAsMissing(router: Router, rule: OutOfReachRule): void {
  const named = new RegExp(`/:${rule.param}(?=/|$|\\()`);
  for (const layer of router.stack as unknown as RouterLayer[]) {
    const route = layer.route;
    if (!route || !named.test(route.path)) continue;
    if (route.stack.some((l) => l.handle === unscopedRequest)) continue; // a customer's own link: no signed-in person
    // The first step after the route's permission gates; an error handler (four arguments) is never the one wrapped.
    let at = 0;
    route.stack.forEach((l, i) => { if (isPermissionGate(l.handle)) at = i + 1; });
    while (at < route.stack.length && route.stack[at]!.handle.length > 3) at += 1;
    const step = route.stack[at];
    if (!step) continue;
    const next = step.handle;
    step.handle = async (req: Request, res: Response, carryOn: NextFunction) => {
      // The step runs as Express would have run it: a synchronous throw goes to the error handler.
      const proceed = () => {
        try {
          return next(req, res, carryOn);
        } catch (err) {
          return carryOn(err);
        }
      };
      const raw = req.params[rule.param];
      const id = typeof raw === 'string' ? raw : undefined;
      // Fail closed: a uuid in any spelling but the canonical one names no record, whoever asks (security review SR-1). The
      // lookup behind would still find the record by an upper-case, dash-less, braced or `urn:uuid:` spelling, so stepping
      // aside here would let the handler act on a record out of reach.
      if (id !== undefined && isOtherSpellingOfId(id)) {
        res.status(404).json({ error: rule.notFound });
        return;
      }
      // A value that is no uuid in any spelling names no record in any reader, so the route's own answer for it is the same
      // for everyone.
      if (!id || !CANONICAL_ID.test(id)) return proceed();
      let reached: boolean;
      try {
        reached = await rule.reaches(req, id);
      } catch (err) {
        logger.error('Reach check error:', err);
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
      if (!reached) {
        res.status(404).json({ error: rule.notFound });
        return;
      }
      return proceed();
    };
    // The step keeps the mark it had (a parked route's 'closed', an Admin check's 'permission'), so the route test still reads it.
    const kind = routeCheckOf(next);
    if (kind) markRouteCheck(kind, step.handle);
    markCanonicalIdGuard([rule.param], step.handle);
  }
}

// ─── The probes, one per kind of record with reach ─────────────────────────────────────────────────────

type Delegate = Parameters<typeof canAccessRow>[2];

/**
 * A record whose reach is a Data Scope `where` (jobs, leads, estimates, invoices): it exists here and the scope matches.
 * `canAccessRow` answers true without a query for reach over every row, and notes a hidden row for the refusal log.
 */
export function scopedRecord(resource: 'Job' | 'Lead' | 'Estimate' | 'Invoice'): ReachProbe {
  // The delegate is looked up per request, not when the route file loads.
  const delegate = (): Delegate => ({ Job: prisma.job, Lead: prisma.lead, Estimate: prisma.estimate, Invoice: prisma.invoice })[resource] as unknown as Delegate;
  return (req, id) => canAccessRow(req, resource, delegate(), id);
}

/** Does the record exist in the person's company at all? Asked only to tell a hidden row from a missing one in the log. */
const existsHere = (delegate: Delegate, req: Request, id: string) => async () =>
  !!(await delegate.findFirst({ where: { id, ...tenantWhere(req) }, select: { id: true } }));

/** A task: Tasks scope (assignee or watcher), or the record it is linked to (the same rule the task page uses). */
export const reachableTask: ReachProbe = async (req, id) => {
  if (await seesAllTasks(req)) return true;
  const task = await prisma.task.findFirst({
    where: { id, ...tenantWhere(req) },
    select: { id: true, assignee_ids: true, watcher_ids: true, linked_entity_type: true, linked_entity_id: true },
  });
  if (!task) return false;
  if (await canAccessTask(req, task)) return true;
  noteRowRefusal(req, 'Task', id, null, async () => true);
  return false;
};

/** A calendar entry: Events scope (an entry the person, or their team, takes part in). */
export const reachableCalendarEntry: ReachProbe = async (req, id) => {
  if (await seesAllCalendarEntries(req)) return true;
  const where = await withCalendarEntryRule(req, { id, ...tenantWhere(req) });
  if (await prisma.calendarEntry.findFirst({ where, select: { id: true } })) return true;
  noteRowRefusal(req, 'CalendarEntry', id, null, existsHere(prisma.calendarEntry as unknown as Delegate, req, id));
  return false;
};

/** An asset: Assets scope (an asset held by the person, or by their team). */
export const reachableAsset: ReachProbe = async (req, id) => {
  const reach = await moduleReachFor(req, 'Asset');
  if (reach.kind === 'all') return true;
  if (await prisma.asset.findFirst({ where: { id, ...tenantWhere(req), ...reachWhere('Asset', reach) }, select: { id: true } })) return true;
  noteRowRefusal(req, 'Asset', id, null, existsHere(prisma.asset as unknown as Delegate, req, id));
  return false;
};
