/**
 * #2041 — the Customer row-scope engine.
 *
 * `Customer` became a `ScopeResource` (scopeWhereFor.ts) once SALES's `read`/`update Customer`
 * grants gained `OWN_CUSTOMER` (defaultGrants.ts). Every surface that reads or writes a single
 * customer by id needs an in-memory verdict for a row it already loaded (never a fresh
 * `req.ability.can('read','Customer', row)` — `enforce.ts:246-256` records that @casl/prisma
 * THROWS on a nested to-one -> to-many condition, and `OWN_CUSTOMER` is exactly that shape on two
 * of its three OR-arms). This module is that verdict engine, plus the per-request memoisation
 * that keeps `lib/permissions/customerContact.ts`'s presenters synchronous (spec R3's "smaller
 * alternative", preferred over converting the ~60 `present(Estimate|Invoice)Detail` call sites to
 * async).
 */
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { logger } from '../logger';
import { scopeWhereForReq } from './enforce';
import { scopeWhereFor, MATCH_NOTHING } from './scopeWhereFor';
import { resolveSwitches } from './switches/store';
import { SCOPE_SWITCH_KEY } from './switches/catalog';
import { customerThroughRecordsReach } from './recordPeople';

type Where = Record<string, unknown>;

// ─── Per-request scope memoisation ──────────────────────────────────────────────────────────
//
// `attachCustomerScope` (mounted right after `attachAbility` on every router that reads/writes a
// Customer) resolves `scopeWhereForReq(req, 'Customer')` ONCE and stamps it on `req.customerScope`
// (types/express.d.ts). A person's resolved switches are already cached (short TTL) by the time
// `attachAbility` finishes building `req.ability`, so this second call is a cache hit in the common case, not a
// second DB round trip.

/**
 * The customers that come with a lead or job the person can open (Roles & Permissions S01.5): the customer's
 * name, phone and address on that record are part of the record, not the Customers module, so this reach
 * holds whatever Customers View says. It is the through-records half of the Customer reach alone (no
 * customers the person only created), which View customers would add on top.
 */
async function resolveCustomerRecordScope(req: Request): Promise<Where> {
  const user = req.user;
  if (!user) return { ...MATCH_NOTHING };
  const values = await resolveSwitches(user);
  const arms = customerThroughRecordsReach(values[SCOPE_SWITCH_KEY.Lead], values[SCOPE_SWITCH_KEY.Job]);
  if (!arms) return { ...MATCH_NOTHING };
  return scopeWhereFor(user, 'Customer', arms.map((conditions) => ({ action: 'read', subject: 'Customer', conditions })));
}

/** Resolve + memoise the Customer scope (and the customers-with-an-openable-record scope) on `req`. Idempotent — a second call is a no-op read. */
export async function resolveCustomerScope(req: Request): Promise<Where> {
  if (req.customerScope === undefined) {
    req.customerScope = await scopeWhereForReq(req, 'Customer');
  }
  if (req.customerRecordScope === undefined) {
    req.customerRecordScope = await resolveCustomerRecordScope(req);
  }
  return req.customerScope;
}

/**
 * Synchronous accessor for a scope `resolveCustomerScope` (via `attachCustomerScope`) already
 * resolved. Throws — deliberately, never a silent `{}` fail-open — if a handler reaches this
 * before the middleware ran, so a missing mount is a loud test failure, not a quiet over-grant.
 */
export function getCustomerScope(req: Request): Where {
  if (req.customerScope === undefined) {
    throw new Error(
      'customerScope not resolved on this request — mount attachCustomerScope (after attachAbility) on this router before this handler',
    );
  }
  return req.customerScope;
}

/** Express middleware: resolve + attach `req.customerScope`. Same error shape as `attachAbility`. */
export async function attachCustomerScope(req: Request, res: Response, next: NextFunction) {
  try {
    await resolveCustomerScope(req);
    next();
  } catch (err) {
    logger.error('attachCustomerScope error:', err);
    res.status(500).json({ error: 'Failed to load permissions' });
  }
}

// ─── matchesFragment — the in-memory verdict ────────────────────────────────────────────────
//
// Production twin of `__tests__/helpers.ts`'s `matchesScopeWhere` (kept in exact semantic sync
// deliberately — a test asserting behaviour this function does not implement is worthless).
// R12: an ABSENT relation/scalar key on `row` is a NON-MATCH, never a throw (a `getById` on a
// row that simply lacks the proof relation must read as "doesn't satisfy the condition", not
// crash into a 500) — throwing is reserved for a condition shape this function does not
// recognise at all (an operator object with an unhandled key), which is a real "this needs a new
// case" bug, not a legitimate absence.

function isPlainConditionObject(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).every((k) => /^[a-z_]+$/.test(k));
}

export function matchesFragment(where: Where, row: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'AND') return (value as Where[]).every((f) => matchesFragment(f, row));
    if (key === 'OR') return (value as Where[]).some((f) => matchesFragment(f, row));
    if (key === 'NOT') return !matchesFragment(value as Where, row);

    const actual = row[key];

    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      // MATCH_NOTHING is `{ id: { in: [] } }` — an absent read grant, so nothing matches.
      if ('in' in obj) return (obj.in as unknown[]).includes(actual);
      // To-many relation: `{ some: {...} }`. An absent/non-array `actual` is a non-match, never
      // a throw — this is R12's exact case (a row loaded without the proof relation).
      if ('some' in obj) {
        return (
          Array.isArray(actual) &&
          actual.some((r) => matchesFragment(obj.some as Where, r as Record<string, unknown>))
        );
      }
      // To-one relation: recurse. A missing relation on the row is a non-match, never a match.
      if (isPlainConditionObject(obj)) {
        return !!actual && matchesFragment(obj, actual as Record<string, unknown>);
      }
      throw new Error(`matchesFragment: unhandled operator object on "${key}": ${JSON.stringify(obj)}`);
    }

    return actual === value;
  });
}

// ─── proofSelectFor — the generic proof-select builder (decision 3) ────────────────────────
//
// Walks a (already-substituted, i.e. `{{userId}}` resolved to a real id) scope fragment and
// derives the MINIMAL Prisma `select` that would let `matchesFragment` judge a row against it:
// a scalar condition key selects itself; `{ rel: { some: inner } }` becomes
// `{ rel: { where: inner, select: <proofSelectFor(inner)>, take: 1 } }` (never hardcodes
// SALES's specific shape, so a hand-edited org condition still resolves correctly); `AND`/`OR`/
// `NOT` merge their arms' selects together (different arms target different top-level relation
// keys, so merging cannot collide). `{ id: { in: [] } }` (MATCH_NOTHING) selects the bare scalar
// so `matchesFragment`'s own `'in' in obj` branch can judge it — never nests a `select` under a
// scalar column.
export function proofSelectFor(where: Where, userId: string): Record<string, unknown> {
  const select: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' || key === 'OR') {
      for (const frag of value as Where[]) mergeProofSelects(select, proofSelectFor(frag, userId));
      continue;
    }
    if (key === 'NOT') {
      mergeProofSelects(select, proofSelectFor(value as Where, userId));
      continue;
    }
    if (value !== null && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if ('in' in obj) {
        select[key] = true;
        continue;
      }
      if ('some' in obj) {
        // `some: {}` is "has any such row" (a scope that reaches every lead or job): a select must name
        // a field, so the row's id stands as the proof that one exists.
        const inner = obj.some as Where;
        select[key] = {
          where: inner,
          select: Object.keys(inner).length ? proofSelectFor(inner, userId) : { id: true },
          take: 1,
        };
        continue;
      }
      if (isPlainConditionObject(obj)) {
        select[key] = { select: proofSelectFor(obj, userId) };
        continue;
      }
      throw new Error(`proofSelectFor: unhandled operator object on "${key}": ${JSON.stringify(obj)}`);
    }
    select[key] = true;
  }
  return select;
}

/**
 * Fold one arm's proof select into the others'. Two arms of a union may reach through the same relation
 * (a customer's leads, by two different paths), and one select can name a relation only once, so the
 * relation is read once for both: a to-many relation returns a row satisfying either arm's condition, and
 * what is read off it is the union of what the two arms need. One row that satisfies one arm is all the
 * union needs, so the single row `take: 1` returns is enough.
 */
function mergeProofSelects(into: Record<string, unknown>, from: Record<string, unknown>): void {
  for (const [key, next] of Object.entries(from)) {
    const current = into[key];
    if (current === undefined || current === true) {
      into[key] = next;
      continue;
    }
    if (next === true) continue;
    const a = current as { where?: Where; select: Record<string, unknown>; take?: number };
    const b = next as { where?: Where; select: Record<string, unknown>; take?: number };
    const select = { ...a.select };
    mergeProofSelects(select, b.select);
    into[key] = a.where && b.where ? { where: { OR: [a.where, b.where] }, select, take: 1 } : { select };
  }
}

// ─── canReadCustomerById — decision 3's dedicated probe ─────────────────────────────────────
//
// A separate `findUnique` selecting ONLY the proof of association, judged in memory. This is the
// shape that is correct in production AND green on the frozen test (`repro-2041.test.ts`):
// `canAccessRow`'s `findFirst` and a re-fetch-with-spread-scope both fail the frozen test's mock,
// which answers on `where.id` alone (spec decision 3). Tenancy stays in the `findUnique` `where`
// (enforce.ts's caveat — an empty scope short-circuits with NO query at all, so a cross-org id is
// never even checked there; every OTHER caller of this function must not rely on it for tenancy).
//
// Memoised per (request, id): a request that asks about the same id twice (e.g. a `can()`-style
// gate followed by a write decision) pays for exactly one query.
const requestProbeCache = new WeakMap<Request, Map<string, Promise<boolean>>>();

export async function canReadCustomerById(req: Request, id: string): Promise<boolean> {
  if (!req.user) return false;
  let cache = requestProbeCache.get(req);
  if (!cache) {
    cache = new Map();
    requestProbeCache.set(req, cache);
  }
  const cached = cache.get(id);
  if (cached) return cached;

  const probe = (async () => {
    const scope = await resolveCustomerScope(req);
    if (Object.keys(scope).length === 0) return true; // ADMIN / unconditional read
    const row = await prisma.customer.findUnique({
      where: { id, ...tenantWhere(req) },
      select: proofSelectFor(scope, req.user!.id),
    });
    return !!row && matchesFragment(scope, row as Record<string, unknown>);
  })();
  cache.set(id, probe);
  return probe;
}

// ─── isCustomerReadableRow — the sync verdict for an ALREADY-LOADED, proof-carrying row ─────
//
// Used by `customerContact.ts`'s presenters and `customer-duplicate.ts` (#1996), both of which
// must stay synchronous (spec R3). Requires the row to have been selected with `CUSTOMER_PROOF_SELECT`
// (or an equivalent) merged in — an absent proof key reads as a non-match (R12), never a throw,
// so a row loaded WITHOUT the proof fields simply over-redacts rather than 500ing.
//
// FAIL-CLOSED, same contract as `can()` (enforce.ts) and `canAccessRow`: a request with no
// resolved `customerScope` (un-hydrated / `attachCustomerScope` never ran, e.g. an unauthenticated
// caller) answers `false`, never throws — a 500 on a security branch is a worse failure mode than
// an over-redaction. `getCustomerScope`'s throw stays reserved for a caller that explicitly wants
// the resolved fragment itself.
export function isCustomerReadableRow(req: Request, row: Record<string, unknown> | null | undefined): boolean {
  if (!row || !row.id) return false;
  if (req.customerScope === undefined) return false;
  return matchesFragment(req.customerScope, row);
}

// ─── isCustomerOnOpenRecord — the sync verdict for "this customer comes with a record the person can open" ───
//
// The same in-memory judgement as `isCustomerReadableRow`, against the through-records scope instead of the
// Customer one: true for a customer who has a lead or job the person can open or is attached to. FAIL-CLOSED
// the same way: a request that never resolved the scope (the public estimate and invoice pages, which carry
// no signed-in person) answers `false`.
export function isCustomerOnOpenRecord(req: Request, row: Record<string, unknown> | null | undefined): boolean {
  if (!row || !row.id) return false;
  if (req.customerRecordScope === undefined) return false;
  return matchesFragment(req.customerRecordScope, row);
}

// ─── Static proof projection for the enumerated detail selects (decision 5) ─────────────────
//
// UNFILTERED (no `where`, no `take`) on purpose: `estimateDetailSelect` / `invoiceDetailSelect`
// are static, module-scope constants shared by dozens of call sites — they cannot be parameterised
// per-request the way `proofSelectFor`'s filtered shape is. Selecting the full (small — a
// customer's own leads/jobs) relation set and letting `matchesFragment` judge it in memory is the
// trade decision 5 makes explicitly; `stripCustomerProofKeys` removes these keys again before any
// response goes out, on EVERY branch (readable or not) — they were never part of the wire shape.
// S01.5: Attached, Team and Location scope all ask who is on a lead or job (crew, owner, sold by, dispatcher),
// and Team and Location ask which department / location each of them is in, so the proof carries those people.
const PERSON = { select: { department_id: true, location_id: true } } as const;
const CREW = { select: { user_id: true, user: PERSON } } as const;

export const CUSTOMER_PROOF_SELECT = {
  created_by_id: true,
  leads: {
    select: {
      lead_assignees: CREW,
      commission_owner_id: true,
      commission_owner: PERSON,
      dispatcher_id: true,
      dispatcher: PERSON,
      visits: { select: { assignees: CREW } },
    },
  },
  jobs: {
    select: {
      visits: { select: { assignees: CREW } },
      salesperson_id: true,
      salesperson: PERSON,
      dispatcher_id: true,
      dispatcher: PERSON,
      estimate: {
        select: { lead: { select: { lead_assignees: CREW } } },
      },
    },
  },
} as const;

export const CUSTOMER_PROOF_KEYS = ['created_by_id', 'leads', 'jobs'] as const;

export function stripCustomerProofKeys<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const key of CUSTOMER_PROOF_KEYS) delete out[key];
  return out as T;
}
