import type { Grant } from './defineAbility';
import { substituteConditions } from './substituteConditions';
import { isSuperUser } from './effectiveRole';

export const MATCH_NOTHING = { id: { in: [] as string[] } } as const;

type ScopeUser = {
  id: string;
  role: string;
  // SRVW-138: set when the user holds an org-defined custom role. Only consulted to
  // decide whether the ADMIN short-circuit applies (isSuperUser) - the grants
  // themselves arrive already resolved in the `grants` argument.
  custom_role_id?: string | null;
  department_id?: string | null;
  location_id?: string | null;
};
// #2041 — 'Customer' added so SALES's now-conditioned read/update grants can carry a row scope.
// Nothing else in this file changes: the ADMIN short-circuit, the unconditional-read widening and
// the fail-closed union all apply to Customer exactly as they do to every other resource here.
export type ScopeResource = 'Lead' | 'Job' | 'Estimate' | 'Invoice' | 'LogisticOrder' | 'PurchaseOrder' | 'Customer';

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⚠️  LogisticOrder — READ THIS BEFORE WRITING ANY LogisticOrder CONTROLLER (LO-2 and later)
//
//     canAccessRow(req, 'LogisticOrder', …) IS NOT A TENANCY GATE. It can return true for an id
//     belonging to ANOTHER ORGANIZATION.
//
// Why: every non-ADMIN role that reaches LOs holds an UNCONDITIONAL `read LogisticOrder`
// (SALES and DISPATCHER, per defaultGrants.ts — LO row scope is org-wide in v1). An
// unconditional read makes `scopeWhereFor` return {} (line ~49). canAccessRow then hits its
// "empty fragment ⇒ no restriction" fast path (enforce.ts ~172-173) and returns true WITHOUT
// EVER RUNNING the tenant-scoped findFirst on the next line. ADMIN short-circuits even earlier.
// So for LogisticOrder there is currently no caller for whom that probe executes at all.
//
// This differs from Estimate/Invoice, where SALES holds a CONDITIONAL read — the findFirst does
// run there, and its `...tenantWhere(req)` incidentally blocks a cross-org id. LogisticOrder
// gets no such incidental protection. Do not copy the Invoice controller's pattern and assume
// you inherit it.
//
// THEREFORE, in every LogisticOrder controller, spread `tenantWhere(req)` into YOUR OWN where
// clause on every read AND every write — findFirst/findMany/update/updateMany/delete alike:
//
//     const lo = await prisma.logisticOrder.findFirst({ where: { id, ...tenantWhere(req) } });
//     if (!lo) { res.status(404)…; return; }
//     await prisma.logisticOrder.update({ where: { id: lo.id }, data: … });
//
// The anti-pattern to avoid — `canAccessRow` followed by a bare-id write — passes a cross-org
// UUID straight through:
//
//     if (!(await canAccessRow(req, 'LogisticOrder', prisma.logisticOrder, id))) { …403… }
//     await prisma.logisticOrder.update({ where: { id }, data: … });   // ← CROSS-ORG WRITE
//
// Nothing in LO-1 is exploitable (no LO routes exist yet); this is a precedent hazard for the
// controllers LO-2+ will add. Fixing enforce.ts instead is deliberately out of scope — that
// helper is shared by every subject and changing its fast path is its own reviewed change.
// ══════════════════════════════════════════════════════════════════════════════════════════════

// Does a (possibly nested) condition object reference the given token (e.g. {{teamId}})?
function referencesRequiredToken(o: unknown, token: string): boolean {
  if (typeof o === 'string') return o === token;
  if (Array.isArray(o)) return o.some((v) => referencesRequiredToken(v, token));
  if (o && typeof o === 'object') {
    return Object.values(o as Record<string, unknown>).some((v) =>
      referencesRequiredToken(v, token),
    );
  }
  return false;
}

/**
 * The Prisma `where` fragment for a user's row-scope on a resource, derived by UNIONing ALL
 * `read` grants for the resource (role grants PLUS the own-scoped reads synthesized from a user's
 * per-user ALLOW overrides — appended by `scopeWhereForReq`) so the SQL scope agrees with the CASL
 * ability (which materializes the same paired own-scoped read for an allow override). Pure — grants
 * are injected. Resolved through substituteConditions.
 *   ADMIN / ANY unconditional read → {} (no restriction)
 *   no read grant                  → MATCH_NOTHING
 *   one conditional read           → that substituted condition
 *   multiple conditional reads     → { OR: [...] } of each substituted condition
 * FAIL-CLOSED: a Team/Location condition whose token resolves to null contributes MATCH_NOTHING
 * (never the fail-open `*_id: null` match) — i.e. that one grant is dropped from the union; if it
 * was the only read, the result is MATCH_NOTHING.
 *
 * `action` defaults to 'read' - the visibility question, and the only thing this answered before
 * the technician-ownership spec (Part C). Pass another action to get the AUTHORITY fragment for
 * that verb instead: once a role holds `delete Job` under a NARROWER condition than its `read Job`
 * (TECHNICIAN's creator-scoped delete vs its assigned-or-created read), a read-derived fragment
 * says yes to rows the delete grant refuses. `canActOnRow` is the intended caller - it intersects
 * the two rather than substituting one for the other.
 */
export function scopeWhereFor(
  user: ScopeUser,
  resource: ScopeResource,
  grants: Grant[],
  action: string = 'read',
): Record<string, unknown> {
  // SRVW-138: an ADMIN-DERIVED custom role must fall through to its grants, or every
  // permission it subtracts would be silently ignored. Only an unrestricted ADMIN is unscoped.
  if (isSuperUser(user)) return {};
  const readGrants = grants.filter((g) => g.action === action && g.subject === resource);
  if (readGrants.length === 0) return { ...MATCH_NOTHING };
  // ANY unconditional read grant widens to org-wide (no restriction).
  if (readGrants.some((g) => !g.conditions)) return {};

  const ctx = {
    userId: user.id,
    teamId: user.department_id ?? null,
    locationId: user.location_id ?? null,
  };
  const resolved: Record<string, unknown>[] = [];
  for (const g of readGrants) {
    const conds = g.conditions as Record<string, unknown>;
    // Fail-closed: a Team/Location condition whose token is null is dropped (its MATCH_NOTHING
    // contributes nothing to an OR union) rather than fail-open matching `*_id: null`.
    if (referencesRequiredToken(conds, '{{teamId}}') && (user.department_id ?? null) === null) {
      continue;
    }
    if (referencesRequiredToken(conds, '{{locationId}}') && (user.location_id ?? null) === null) {
      continue;
    }
    const sub = substituteConditions(conds, ctx) ?? {};
    // De-dupe structurally identical conditions so two equal grants don't yield a redundant OR.
    const key = JSON.stringify(sub);
    if (!resolved.some((r) => JSON.stringify(r) === key)) {
      resolved.push(sub as Record<string, unknown>);
    }
  }

  if (resolved.length === 0) return { ...MATCH_NOTHING }; // every conditional read fail-closed
  if (resolved.length === 1) return resolved[0];
  return { OR: resolved };
}
