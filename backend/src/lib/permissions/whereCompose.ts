/**
 * Clobber-safe composition of a disjunctive (OR) filter group into a Prisma `where`.
 *
 * Why this exists: list controllers spread the grant-driven row-scope fragment from
 * `scopeWhereForReq` into their `where`. For a MULTI-READ user (≥2 distinct conditional
 * read grants — e.g. a tech whose role read is `OWN_WALKTHROUGH` AND whose per-user
 * `update Lead` override implies an `OWN_LEAD` read; or a SALES user whose role read is
 * `OWN_INVOICE_VIA_LEAD` AND whose `create Invoice` override implies `OWN_INVOICE_VIA_JOB`)
 * that fragment is `{ OR: [...] }`. If the same handler then assigns its own search OR with
 * `where.OR = [...]`, the two `OR` keys collide and the scope `OR` is SILENTLY DROPPED —
 * a row-scope LEAK. Use this helper instead of `where.OR = clauses`.
 *
 * Semantics:
 *   - No `OR` present  → set `where.OR = clauses` (unchanged cheap shape).
 *   - An `OR` already present (the spread-in scope) → demote BOTH disjunctions under `AND`
 *     as peers (`AND: [..., { OR: <existing> }, { OR: clauses }]`) so each remains REQUIRED.
 *     This is the anti-leak invariant: the scope OR is never lost, and the search OR is ANDed
 *     on top (a search narrows the already-scoped set — the correct precedence).
 *   - An existing `AND` is appended to, never replaced.
 *
 * Safe to call unconditionally (it does the right thing whether or not a scope OR is present),
 * so callers don't have to know whether the requester is a multi-read user.
 */
export function addOrFilter(
  where: Record<string, unknown>,
  clauses: Record<string, unknown>[],
): void {
  if (where.OR === undefined) {
    where.OR = clauses;
    return;
  }
  const existingAnd = Array.isArray(where.AND)
    ? (where.AND as unknown[])
    : where.AND !== undefined
      ? [where.AND]
      : [];
  where.AND = [...existingAnd, { OR: where.OR }, { OR: clauses }];
  delete where.OR;
}

/**
 * Append ONE required clause to a Prisma `where` under `AND`, keeping whatever `AND` is already
 * there (a scope OR demoted by `addOrFilter`, another facet's clause). The clobber-safe way to add
 * a constraint on a key the row-scope may already own - `visits`, `lead_assignees`, `status` -
 * without writing that key: under AND the scope clause and the new one are separate, both
 * required, and neither can overwrite the other.
 */
export function addAndClause(where: Record<string, unknown>, clause: Record<string, unknown>): void {
  const existingAnd = Array.isArray(where.AND)
    ? (where.AND as unknown[])
    : where.AND !== undefined
      ? [where.AND]
      : [];
  where.AND = [...existingAnd, clause];
}
