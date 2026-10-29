import type { Request } from 'express';
import { scopeWhereForReq } from './enforce';

/**
 * Anchor-inherited visibility for Communication rows (email slice 8a).
 *
 * THE RULE (product decision, all four channels - calls, SMS, email, WhatsApp):
 * a communication row is visible to whoever can see the entity it hangs off.
 * Attached to a job -> whoever can see that job. Attached to a lead -> whoever
 * can see that lead. Attached only to a customer or a vendor, or to nothing at
 * all -> visible ORG-WIDE. Customers and vendors are deliberately NOT
 * row-restricted; there is no per-customer scope in this product.
 *
 * ANCHOR PRECEDENCE IS job > lead > customer/vendor. A row carrying a job_id is
 * governed by the job regardless of what else is stamped on it. This is not a
 * nicety: `persistTransactionalEmail` (lib/comm-persist.ts) stamps customer_id,
 * lead_id AND job_id onto the SAME row, so nearly every job-anchored email is
 * also customer-anchored. Reading those as an OR of independent anchors would
 * make the customer branch rescue every job-anchored row and the scope would be
 * theatre.
 *
 * WHY IT IS SHAPED THIS WAY. `Communication` is not a member of the closed
 * `ScopeResource` union (scopeWhereFor.ts: Lead | Job | Estimate | Invoice |
 * LogisticOrder), so there is no grant that scopes comm rows directly and none
 * is being added - decision 3 says Communication gets no permission surface of
 * its own, because the roll-ups are unified and hiding an email while showing
 * the SMS and the call recording from the same job protects nothing. The scope
 * therefore has to RIDE the anchor subjects, nested under their relation keys.
 *
 * ADMIN and DISPATCHER fall out for free and are not special-cased: both hold
 * unconditional `read Job` and `read Lead` (defaultGrants.ts), so both anchor
 * scopes resolve to {} and `anchorInheritedWhere` returns {} - no restriction.
 *
 * Access does NOT expire when the job closes (Workiz and Housecall Pro both
 * revoke; we deliberately do not). Nothing here is time-bounded.
 */

function isOpenScope(scope: Record<string, unknown>): boolean {
  return Object.keys(scope).length === 0;
}

/**
 * Nest a grant-derived row-scope under a to-one relation key - THE one place
 * this rule is allowed to live.
 *
 * The subtlety, and why estimate.controller.ts and invoice.controller.ts
 * disagreed about it before this helper existed: an EMPTY scope fragment means
 * "no restriction" at the top level, but `{ job: {} }` on a NULLABLE to-one
 * relation does not mean that at all - it asserts that a related row exists, so
 * it silently drops every row whose relation is null. An unconditional read
 * grant produces exactly that empty fragment, so nesting it unguarded turns
 * "this user may read every job" into "this user may only read job-anchored
 * rows". Collapse it to no filter instead.
 *
 * MATCH_NOTHING (`{ id: { in: [] } }`) is passed through unchanged and that is
 * correct HERE: nested under a relation it reads "has a related job whose id is
 * in []", i.e. no anchored row matches - which is what a user with no read
 * grant on that anchor should see. It is only wrong in the UNANCHORED branch,
 * where the same shape would also exclude null-relation rows; that branch below
 * carries no relation filter at all, so the shape never reaches it.
 */
export function relationScopeFilter(
  relation: string,
  scope: Record<string, unknown>,
): Record<string, unknown> {
  if (isOpenScope(scope)) return {};
  return { [relation]: scope };
}

/**
 * The row-level `where` fragment for anchor-inherited visibility, given the
 * requester's already-resolved Job and Lead row-scopes. Pure - the scopes are
 * injected so this is unit-testable without a request.
 *
 * Emits three MUTUALLY EXCLUSIVE branches (each pins job_id/lead_id nullness, so
 * exactly one can ever match a given row - that is what encodes the precedence):
 *   1. job-anchored   -> job_id NOT NULL, job within the Job scope
 *   2. lead-anchored  -> job_id NULL, lead_id NOT NULL, lead within the Lead scope
 *   3. unanchored     -> job_id NULL and lead_id NULL (customer-only, vendor-only
 *                        or nothing) -> org-wide, no scope applied
 *
 * Branch 3 is unconditional, so the OR is never empty and can never collapse to
 * "match nothing" for a user who simply lacks both anchor grants.
 *
 * Returns {} (no restriction) when BOTH anchor scopes are org-wide, so an
 * unrestricted requester's query is left byte-identical.
 */
export function anchorInheritedWhere(
  jobScope: Record<string, unknown>,
  leadScope: Record<string, unknown>,
): Record<string, unknown> {
  if (isOpenScope(jobScope) && isOpenScope(leadScope)) return {};
  return {
    OR: [
      { job_id: { not: null }, ...relationScopeFilter('job', jobScope) },
      { job_id: null, lead_id: { not: null }, ...relationScopeFilter('lead', leadScope) },
      { job_id: null, lead_id: null },
    ],
  };
}

/**
 * The same rule lifted to a PARENT row (MessageThread / WhatsAppChat) via its
 * to-many child relation: keep the parent when at least one child row is
 * visible.
 *
 * Why parents need their own shape: Message and WhatsAppMessage have NO
 * top-level read path - they are only ever reached as a nested `messages`
 * include on their parent. The anchor lives on the CHILD (Message.job_id /
 * Message.lead_id), not on the thread, so a thread can legitimately hold job A
 * and job B messages at once. The list/detail handlers therefore do two things:
 * filter the nested include with `anchorInheritedWhere` (so the payload carries
 * only visible messages - still SQL, not response-level hiding), and filter the
 * parent with this (so a thread with nothing visible in it does not surface at
 * all and leak its existence plus its customer linkage).
 *
 * `some` is a to-MANY filter, where an empty fragment genuinely means "has at
 * least one child" - the opposite hazard from the to-one case above - so the
 * org-wide fast path here is a plain {} return rather than a collapse.
 */
export function anchorInheritedParentWhere(
  childRelation: string,
  jobScope: Record<string, unknown>,
  leadScope: Record<string, unknown>,
): Record<string, unknown> {
  const rowWhere = anchorInheritedWhere(jobScope, leadScope);
  if (isOpenScope(rowWhere)) return {};
  return { [childRelation]: { some: rowWhere } };
}

/** Both anchor row-scopes for the requester, resolved once. */
async function anchorScopes(
  req: Request,
): Promise<{ jobScope: Record<string, unknown>; leadScope: Record<string, unknown> }> {
  const [jobScope, leadScope] = await Promise.all([
    scopeWhereForReq(req, 'Job'),
    scopeWhereForReq(req, 'Lead'),
  ]);
  return { jobScope, leadScope };
}

/**
 * Controller-facing row filter. Spread it into the `where` of EVERY comm read -
 * list, detail, recording, transcript, and any mutation that takes a row id -
 * alongside `tenantWhere(req)`:
 *
 *   const where = { id, ...tenantWhere(req), ...(await commVisibilityWhere(req)) };
 *
 * Returns {} for an unrestricted requester. A non-empty return is `{ OR: [...] }`,
 * so a handler that also builds its own search/filter OR must merge with
 * `addOrFilter` (lib/permissions/whereCompose) rather than assigning `where.OR`.
 */
export async function commVisibilityWhere(req: Request): Promise<Record<string, unknown>> {
  const { jobScope, leadScope } = await anchorScopes(req);
  return anchorInheritedWhere(jobScope, leadScope);
}

/**
 * Controller-facing PARENT filter for the two channels whose rows hang off a
 * conversation (MessageThread.messages, WhatsAppChat.messages). Pair it with
 * `commVisibilityWhere` on the nested include.
 */
export async function commParentVisibilityWhere(
  req: Request,
  childRelation: string,
): Promise<Record<string, unknown>> {
  const { jobScope, leadScope } = await anchorScopes(req);
  return anchorInheritedParentWhere(childRelation, jobScope, leadScope);
}
