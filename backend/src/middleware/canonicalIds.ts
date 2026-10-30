import type { Application, NextFunction, Request, Response } from 'express';
import { canonicalIdParamsOf, isOtherSpellingOfId, markCanonicalIdGuard } from '../lib/ids/canonicalId';
import { isPermissionGate } from './canGuard';
import { routeCheckOf } from './routeCheck';
import { authenticate } from './authenticate';
import { attachAbility } from './attachAbility';
import { unscopedRequest } from './unscopedRequest';

// Express 4 ships no types for its route layer; a route keeps its steps as these.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Layer = require('express/lib/router/layer') as (path: string, options: object, fn: Handler) => RouteLayer;

/**
 * A record id in any spelling but the canonical one names nothing (security review SR-1, SR-2, SR-7 and the older lock
 * checks; lib/ids/canonicalId.ts says why).
 *
 * `refuseNonCanonicalIds(app)` runs once, after every router is mounted. It walks every route the app serves and puts one
 * step into each, right after the route's sign-in and permission gates and before anything else (body validation, uploads,
 * the reach wrapper's probe, a lock check, the handler). The step answers 404 "Not found" when a uuid is spelled any way but
 * the canonical lower-case hyphenated one (no dashes, braces, `urn:uuid:`, upper or mixed case, odd dashes) in:
 *  - a route parameter that names a record (`:id`, or `:<thing>Id`); or
 *  - a request field that names a record (`id`, `ids`, `<thing>_id`, `<thing>_ids`, `<thing>Id`, `<thing>Ids`, in the body
 *    or the query string, at any depth).
 * A value that is no uuid in any spelling (a slug, a placeholder, an outside service's id) names no record in any reader and
 * keeps the answer its route always gave.
 * The answer is the same whether the record exists or not, so it tells the caller nothing. It sits after the gates, so a
 * person whose switch is off is still refused at the gate with the 403 that says nothing about the record.
 *
 * Because it is put in from the app's own route table, a route added later on any router is covered the day it lands
 * (permission-canonical-ids-guard.test.ts fails for a route that has no guard in front).
 */

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
type RouteLayer = { handle: Handler; method?: string };
type Route = { path: string | string[]; stack: RouteLayer[] };
type StackLayer = { name: string; handle: unknown; route?: Route };

/**
 * Route parameters whose name ends in `Id` that do not name a record, and why. A scope's id names a block inside an
 * estimate's own scope list: it is matched in code against that list, never looked up in the database.
 */
const NOT_A_RECORD_PARAM: Readonly<Record<string, string>> = {
  scopeId: "names a scope block inside the estimate's own list, matched in code, never looked up in the database",
};

export const isRecordIdParam = (name: string): boolean =>
  (name === 'id' || /^[a-z][A-Za-z]*Id$/.test(name)) && !(name in NOT_A_RECORD_PARAM);

/** The record id params of a route path, as `:name` (an optional `:name?` too). */
export function recordIdParamsOf(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_]+)\??/g)].map((m) => m[1]!).filter(isRecordIdParam);
}

/** A request field that names a record by id. */
const RECORD_ID_FIELD = /^(id|ids)$|(_id|_ids|Id|Ids)$/;
const MAX_DEPTH = 8;

/** Does the body or query hold a record id spelled another way, under a field that names a record? */
export function holdsOtherSpellingOfId(value: unknown, field: string | null = null, depth = 0): boolean {
  if (depth > MAX_DEPTH || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    // `ids=a,b` in a query string is one string.
    return field !== null && RECORD_ID_FIELD.test(field) && value.split(',').some((v) => isOtherSpellingOfId(v));
  }
  if (Array.isArray(value)) return value.some((v) => holdsOtherSpellingOfId(v, field, depth + 1));
  if (typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => holdsOtherSpellingOfId(v, k, depth + 1));
  }
  return false;
}

const NOT_FOUND = { error: 'Not found' };

/** The step put into a route: `params` are the record id params it checks (the ones no earlier step already refuses). */
export function refuseOtherSpellings(params: readonly string[]): Handler {
  const step: Handler = (req, res, next) => {
    for (const p of params) {
      const v = req.params[p];
      if (typeof v === 'string' && isOtherSpellingOfId(v)) {
        res.status(404).json(NOT_FOUND);
        return;
      }
    }
    if (holdsOtherSpellingOfId(req.body) || holdsOtherSpellingOfId(req.query)) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    next();
  };
  guardSteps.add(step);
  return markCanonicalIdGuard(params, step);
}

const guardSteps = new WeakSet<object>();
/** Is this route step the guard `refuseNonCanonicalIds` puts in? */
export const isCanonicalIdsStep = (handle: unknown): boolean => typeof handle === 'function' && guardSteps.has(handle);

/** A step the guard goes after: signing in, the permission gates, and the marker of a customer's own link. None reads a record. */
export const isLeadingStep = (handle: unknown): boolean =>
  handle === authenticate || handle === attachAbility || handle === unscopedRequest || isPermissionGate(handle) || routeCheckOf(handle) === 'permission';

function guardRoute(route: Route): void {
  // A parked route answers the same to everyone and touches nothing.
  if (route.stack.some((l) => routeCheckOf(l.handle) === 'closed')) return;
  if (route.stack.some((l) => isCanonicalIdsStep(l.handle))) return; // already guarded
  let at = 0;
  route.stack.forEach((l, i) => { if (isLeadingStep(l.handle)) at = i + 1; });
  const paths = Array.isArray(route.path) ? route.path : [route.path];
  // A param an earlier step (up to and including the one the guard goes in front of) already refuses keeps that step's words.
  const covered = new Set(route.stack.slice(0, at + 1).flatMap((l) => canonicalIdParamsOf(l.handle)));
  const params = [...new Set(paths.flatMap(recordIdParamsOf))].filter((p) => !covered.has(p));
  const layer = Layer('/', {}, refuseOtherSpellings(params));
  layer.method = (route.stack[at] ?? route.stack[at - 1])?.method;
  route.stack.splice(at, 0, layer);
}

function walk(stack: StackLayer[], skip: ReadonlySet<unknown>): void {
  for (const layer of stack) {
    if (layer.route) guardRoute(layer.route);
    else if (layer.name === 'router' && !skip.has(layer.handle)) walk((layer.handle as { stack: StackLayer[] }).stack, skip);
  }
}

/**
 * Put the guard into every route of the app. Call it once, after the last router is mounted. `skip` names routers left out,
 * each for a reason given where it is called.
 */
export function refuseNonCanonicalIds(app: Application, skip: unknown[] = []): void {
  walk((app as unknown as { _router: { stack: StackLayer[] } })._router.stack, new Set(skip));
}
