import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { Prisma, Role } from '@prisma/client';
import { supabaseAdmin, createIsolatedAuthClient } from '../lib/supabase';
import { mapPasswordUpdateError, isSessionMissingError, needsFreshSignInError, SAME_PASSWORD_MESSAGE } from '../lib/auth-provider-errors';
import { updatePasswordAsOwnSession } from '../lib/auth-own-session';
import { userHasPassword } from '../lib/password-presence';
import { prisma } from '../lib/prisma';
import { canonicalUserId, sameUserId } from '../lib/users/sameUserId';
import { logger } from '../lib/logger';
import { clearTokenCache } from '../middleware/authenticate';
import { tenantWhere } from '../lib/tenant';
import { eligibleUserIds, isSlot, type Slot } from '../lib/permissions/slotEligibility';
import { resolveAssigneePoolForRequest, type AssigneePool, type AssigneePurpose } from '../lib/permissions/assigneePool';
import { resolveWatcherPoolForRequest, watcherPoolWhere } from '../lib/permissions/watcherPool';
import { sendInviteLink } from '../lib/invite-link';
import { emailSchema } from '../lib/email-schema';
import { userPhoneField } from '../lib/user-phone';
import { assertEmailAvailable, EmailAlreadyRegisteredError, EMAIL_ALREADY_REGISTERED_MSG } from '../lib/user-email-guard';
import { writeSettingsAudit, logAudit } from '../lib/audit';
import { assignRoleToPerson, clearSwitchCacheForUser, resolveSwitches, summarizePeopleRoles } from '../lib/permissions/switches/store';
import { isSuperUser, roleMakesAdmin } from '../lib/permissions/effectiveRole';
import { emit } from '../services/notifications/notificationService';
import { alertAddressNeeded } from '../services/notifications/addressNeededAlert';
import { issueUserMailbox, userAddressSuffix, userMailboxesFor } from '../lib/mailbox/register';
import { emailPageClosedFor } from '../lib/mailbox/email-page-access';
import { hasFeature } from '../middleware/requireFeature';
import { runUnscoped } from '../lib/tenant-context';
import { summarizeOpenRecords, reassignOpenRecords, REASSIGN_MODULES } from '../lib/users/openRecords';
import { reactivateMailbox, type ReactivationOutcome } from '../lib/mailbox/reactivation';
import { handOverMailbox, handoverToField, mailboxHandoverStates, resolveHandoverTarget, settleMailboxesBeforeDelete, HANDOVER_TARGET_REFUSED, type HandoverOutcome } from '../lib/mailbox/handover';
import { signAvatarPaths, resolveAvatarUrl, removeAvatarObject } from '../lib/avatar';
import {
  refuseOwnerRemoval, refuseUnlessOwnerFor, ownerOnlyRefuses, answerOwnerOnly, isCompanyOwner, lockCompanyForAdminChange, activeAdminCount,
  OwnerOnlyRefusal, LastAdminRefusal,
} from '../lib/users/owner';
import { actorOf, recordAccessChange, type AccessAction, type AccessActor, type AccessHeld } from '../lib/users/access-audit';
import { alertOwnerOfAdminChange } from '../lib/users/admin-change-alert';
import { NOT_AN_OWNER_CANDIDATE, ownerCandidates, requestOwnerHandover } from '../lib/users/owner-handover';
import { ProviderLoginRemovalError, removeProviderLogin, removeProviderLoginQuietly } from '../lib/auth-provider-login';
import { namesOnly, namesOnlySelect, seesFullPeopleRecords } from '../lib/users/peopleRow';

const userSelect = {
  id: true,
  email: true,
  first_name: true,
  last_name: true,
  role: true,
  custom_role_id: true,
  is_admin: true,
  custom_role: { select: { key: true, label: true } },
  is_active: true,
  erased_at: true,
  has_login: true,
  phone: true,
  phone_ext: true,
  avatar_path: true,
  department_id: true,
  department: { select: { id: true, name: true } },
  enforce_clock_in_location: true,
  can_approve_clock_overrides: true,
  created_at: true,
  updated_at: true,
};

/** Swap the private `avatar_path` column for a signed, response-safe `avatar_url` — batch-signed
 *  in ONE call regardless of how many rows are passed (2026-08-04 plan, decision 7). */
async function withAvatarUrls<T extends { avatar_path: string | null }>(
  rows: T[],
): Promise<Array<Omit<T, 'avatar_path'> & { avatar_url: string | null }>> {
  const signed = await signAvatarPaths(rows.map((r) => r.avatar_path));
  return rows.map(({ avatar_path, ...rest }) => ({
    ...rest,
    avatar_url: resolveAvatarUrl(avatar_path, signed),
  }));
}

/** Singular convenience over withAvatarUrls, for the many handlers below that resolve exactly
 *  one row. Still one signing call per response — batching only matters at N>1. */
async function withAvatarUrl<T extends { avatar_path: string | null }>(
  row: T,
): Promise<Omit<T, 'avatar_path'> & { avatar_url: string | null }> {
  return (await withAvatarUrls([row]))[0]!;
}

export const createUserSchema = z.object({
  email: emailSchema,
  password: z.string().min(8),
  phone: userPhoneField,
  phone_ext: z.string().max(50).nullable().optional(),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  role: z.nativeEnum(Role),
  // SRVW-138/139: an org custom role, layered on the required base `role` above. Validated
  // server-side (resolveCustomRoleAssignment) against the org and against base_role agreement -
  // never trusted from the client past shape.
  custom_role_id: z.string().uuid().nullable().optional(),
  // Roles & Permissions P15: whether the person is an Admin. Left out, it follows the role picked: Administrator is an
  // Admin, any other role is not.
  is_admin: z.boolean().optional(),
  department_id: z.string().uuid().nullable().optional(),
});

export const inviteUserSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  email: emailSchema,
  role: z.nativeEnum(Role),
  custom_role_id: z.string().uuid().nullable().optional(),
  is_admin: z.boolean().optional(),
  phone: userPhoneField,
  phone_ext: z.string().max(50).nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
});

export const updateUserSchema = z.object({
  first_name: z.string().min(1).max(100).optional(),
  last_name: z.string().min(1).max(100).optional(),
  role: z.nativeEnum(Role).optional(),
  custom_role_id: z.string().uuid().nullable().optional(),
  // Roles & Permissions P15: grant or take away Admin. Left out, a change of role carries the flag with it
  // (Administrator is an Admin, any other role is not); a request that does not change the role leaves it alone.
  is_admin: z.boolean().optional(),
  is_active: z.boolean().optional(),
  phone: userPhoneField,
  phone_ext: z.string().max(50).nullable().optional(),
  department_id: z.string().uuid().nullable().optional(),
  // Only read when this update sets the user inactive: who gets their email (see lib/mailbox/handover.ts).
  handover_to: handoverToField,
});

/** The body of the deactivate action: who gets the person's email, "main" (the default) or an active person's id. */
export const deactivateUserSchema = z.object({ handover_to: handoverToField });

// Self-service profile edit — whitelisted fields ONLY (.strict rejects privileged keys like role/is_active).
export const meUpdateSchema = z
  .object({
    first_name: z.string().min(1).max(100).optional(),
    last_name: z.string().min(1).max(100).optional(),
    phone: userPhoneField,
    phone_ext: z.string().max(50).nullable().optional(),
  })
  .strict();

export { SAME_PASSWORD_MESSAGE };

export const changePasswordSchema = z
  .object({
    // SECURITY (review #4): require the current password so a stolen short-lived session can't be
    // turned into permanent account takeover by silently resetting the password.
    current_password: z.string().min(1).max(256),
    password: z.string().min(8, 'Password must be at least 8 characters.').max(256),
  })
  // Checked before the provider is asked anything: re-using the current password is never a change.
  .refine((b) => b.password !== b.current_password, { message: SAME_PASSWORD_MESSAGE, path: ['password'] });

/**
 * GET /api/users — the STAFF DIRECTORY, for the settings and staff-admin screens.
 *
 * Gated on `read User` and returns the whole of `userSelect`: email, phone, phone_ext, login
 * state, clock-in flags, timestamps. That is the right shape for the Users & Teams admin table
 * and the wrong shape for a picker, which is why the assignee roster now lives on its own route
 * (`listAssignable` below) rather than as an `?assignable=true` branch in here.
 *
 * WHY THE BRANCH IS GONE RATHER THAN LEFT AS A SECOND WAY IN. Two implementations of "who may I
 * put on this work" drift, and the one behind `read User` is the one that silently keeps the old
 * behaviour: a SALES user 403s here, so a picker still pointed at this route comes back EMPTY and
 * reads as "no members" instead of as an error. Deleting the branch makes that a build-visible
 * change rather than a runtime one. NOTE that `include_referenced_in` used to trigger the branch
 * ON ITS OWN, so both parameters had to go together.
 */
export async function list(req: Request, res: Response) {
  try {
    // M3 (ticket 29): a non-Admin gets names only, and nothing else is read for them. The role filter is not applied
    // for them either: `?role=ADMIN` would otherwise single out who the Admins are by name.
    if (!seesFullPeopleRecords(req)) {
      const people = await prisma.user.findMany({ where: tenantWhere(req), select: namesOnlySelect, orderBy: { created_at: 'desc' } });
      res.json({ users: (await withAvatarUrls(people)).map(namesOnly) });
      return;
    }

    const roleFilter = req.query.role as Role | undefined;

    const where: Record<string, unknown> = { ...tenantWhere(req) };
    if (roleFilter) {
      where.role = roleFilter;
    }

    const users = await prisma.user.findMany({
      where,
      // The invite-mark column is read only to say whether a revoke is unfinished (revoke_pending); it never leaves the server.
      select: { ...userSelect, based_on_role_key: true, password_hash: true },
      orderBy: { created_at: 'desc' },
    });

    // The role column reads "<role> · N changes": the role's name and the switches that differ from it.
    const orgId = tenantWhere(req).organization_id;
    const summaries = await summarizePeopleRoles(orgId, users);
    // The Email column (PRD 10, S10.25): each person's mailbox and whether their own switches close the Email page,
    // each in a constant number of reads for the whole list. Only while the company has the Email plan feature.
    const withEmail = hasFeature(req, 'email');
    const mailboxes = withEmail ? await userMailboxesFor(prisma, users.map((u) => u.id)) : new Map();
    // Where a deactivated person's mailbox went (S10.22), for the "Move mailbox" control.
    const handovers = withEmail ? await mailboxHandoverStates(prisma, users.filter((u) => !u.is_active).map((u) => u.id)) : new Map();
    const addressSuffix = withEmail ? await userAddressSuffix(prisma, orgId) : null;
    const emailClosed = withEmail
      ? await emailPageClosedFor(users.map((u) => ({ id: u.id, organization_id: orgId, role: u.role, is_admin: u.is_admin, custom_role_id: u.custom_role_id, custom_role: u.custom_role })))
      : new Set<string>();
    // Make Owner (ticket 27): which rows the Owner may hand the company to. Worked out for the Owner only; false for everyone
    // else, so whether a person has ever signed in is told to no one who can't act on it.
    const viewerIsOwner = await isCompanyOwner(orgId, req.user!.id);
    const candidates = viewerIsOwner
      ? await ownerCandidates(prisma, orgId, users.filter((u) => u.is_admin && u.is_active && u.id !== req.user!.id).map((u) => u.id))
      : new Set<string>();
    const rows = users.map(({ based_on_role_key: _basedOn, password_hash, ...user }) => ({
      ...user,
      owner_eligible: candidates.has(user.id),
      // A revoke that could not finish (H2, ticket 22): the screen still offers Revoke so the Admin can try again.
      revoke_pending: revokePending({ has_login: user.has_login, password_hash }),
      role_label: summaries.get(user.id)!.role_label,
      change_count: summaries.get(user.id)!.change_count,
      mailbox: mailboxes.has(user.id)
        ? { status: mailboxes.get(user.id)!.status, address: mailboxes.get(user.id)!.address, address_suffix: addressSuffix }
        : null,
      mailbox_handover: handovers.get(user.id) ?? null,
      email_page_closed: emailClosed.has(user.id),
      // The Admin box (full access, no switches to set) is the person's `is_admin` flag (P15), whatever role they sit on;
      // a role copied from Admin is not in it. The screen follows this answer rather than guessing from role names.
      admin_box: isSuperUser(user),
    }));

    res.json({ users: await withAvatarUrls(rows) });
  } catch (err) {
    logger.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
}

/**
 * THE POOL-GOVERNED PURPOSES — the query-string spelling of `AssigneePurpose`.
 *
 * Each one names a WRITE the assignee pool actually governs, so scoping the list by
 * `resolveAssigneePoolForRequest` keeps the picker and the validator answering the same question.
 * `jobCrew` is job.controller's crew door, `walkthroughPerformer` is walkthrough.service's
 * performer door — the only two call sites of `isAssigneeSetPermitted` — and `task` is the task
 * assignee field, whose own validator has always read `assign Task`.
 */
const POOL_PURPOSES = ['jobCrew', 'walkthroughPerformer', 'task'] as const satisfies readonly AssigneePurpose[];

/**
 * THE DIRECTORY PURPOSE — a people list that NO pool rule governs, gated on `read User`.
 *
 * WHY A SECOND FAMILY EXISTS AT ALL. `purpose` was doing two jobs at once: naming the grant that
 * gates the list, and naming the picker that is asking. Those came apart the moment `assign User`
 * started narrowing anything. Six live surfaces pass a purpose for a write the pool does NOT
 * govern — the lead OWNER picker, the job DISPATCHER picker, calendar-entry PARTICIPANTS (which
 * `eventPeople.ts` documents as explicitly not crew), the automation RECIPIENT pickers and the
 * assignee FILTER dropdowns on Jobs and Leads. Scoping those by `assign User` hides people the API
 * would happily accept: an org with a custom role holding `read User` + `create Lead` but not
 * `assign User` — realistic, since `assign User` is brand new and was backfilled onto DISPATCHER
 * and TECHNICIAN only — watched its New Lead "Assign to" dropdown collapse to one row while
 * `POST /api/leads` still accepted anybody.
 *
 * WHY IT IS GATED ON `read User`. That is precisely what `origin/staging` did for these surfaces:
 * they read `GET /api/users?assignable=true` behind `canDo('read', 'User')`. A holder saw the org
 * list; a non-holder 403'd into an empty one. Answering the org list to a holder and self-only to
 * a non-holder reproduces that exactly, so this slice takes nothing away from anybody and gives
 * nobody anything new — it only stops the pool grant from governing lists it does not govern.
 *
 * WHY THE NAME IS `directory`. It says what the list IS (the people directory, narrowed to a
 * picker's field set) rather than which of six pickers is asking, and it names the grant the
 * reader will go looking for: this is the same `read User` that gates `GET /api/users`. Naming it
 * after a surface (`recipients`, `filter`) would have re-created the exact confusion this fixes —
 * a purpose per picker, drifting away from the grant — and the seventh surface would have needed
 * a seventh value. There is no `AssigneePurpose` member for it ON PURPOSE: `assigneePool.ts`
 * answers "whose names may I put on a piece of work", and a directory read is not that question.
 */
const DIRECTORY_PURPOSE = 'directory';

/**
 * THE WATCHER PURPOSE — a third family of exactly one, gated by NO grant (#1956).
 *
 * WHY IT IS NOT AN `AssigneePurpose`. `PURPOSE_GRANT` in `assigneePool.ts` answers "which grant
 * widens this list past self". No grant widens this one, because no grant governs the watcher
 * WRITE: `task.controller` has only ever checked that a watcher id names an active member of the
 * caller's org. Giving it a map entry would send the next reader hunting for a grant that does
 * not exist, and `Record<AssigneePurpose, …>` would have forced a fake one to be invented.
 *
 * WHY IT IS NOT `directory` EITHER. `directory` gates on `read User`, which SALES does not hold —
 * the Watchers field would go from one row straight to a 403, and the reported symptom (#1956,
 * tracker row 016) would return unchanged.
 *
 * WHY IT IS NOT `task`. That purpose reads `assign Task`, which sits in no default role, so the
 * field offered exactly one name: the rep themselves. A self-only watcher list watches nothing.
 * The assignee half keeps `task` and is deliberately untouched here — whether DISPATCHER should
 * hold `assign Task` is issue #1950's question, not this one's.
 *
 * It is therefore governed by `watcherPool.ts`, which is asked for the query fragment here and
 * for the matching predicate in `task.controller` — one rule, both directions.
 */
const WATCHER_PURPOSE = 'taskWatcher';

/** Everything `?purpose=` accepts. Pool-governed first, then the directory read, then watchers. */
const ROSTER_PURPOSES = [...POOL_PURPOSES, DIRECTORY_PURPOSE, WATCHER_PURPOSE] as const;

type RosterPurpose = (typeof ROSTER_PURPOSES)[number];

/** The one `eligible_for` value that is not a slot: the task owner and watcher pool is every active user. */
const TASK_ELIGIBILITY = 'task';

/**
 * A PICKER's row, and deliberately nothing more: the id to submit, the name to render, the role
 * and department the dropdown groups and labels by, and the avatar. No email, no phone, no
 * phone_ext, no login state, no clock-in flags, no timestamps.
 *
 * `avatar_path` is the private storage key and never reaches the client — `withAvatarUrls` swaps
 * it for a signed `avatar_url` on the way out.
 */
const assignableSelect = {
  id: true,
  first_name: true,
  last_name: true,
  role: true,
  department: { select: { id: true, name: true } },
  avatar_path: true,
} as const;

/**
 * GET /api/users/assignable — WHOSE NAMES MAY THIS REQUESTER PUT ON A PIECE OF WORK?
 *
 * Scoped assignee pool, slice 3 (plan: md_files/plans/permissions/2026-08-31-assignee-pool/).
 * Modelled directly on `GET /api/communication/manual-log/performers`, which argued this same
 * case first: a picker's roster is not a staff directory, and gating it on `read User` breaks the
 * exact users the capability was granted to.
 *
 * ── WHY IT IS NOT A BRANCH OF `GET /api/users` ───────────────────────────────────────────────
 *
 * `read User` appears in DEFAULT_GRANTS exactly twice — DISPATCHER and TECHNICIAN. There is no
 * SALES row and SHARED_BASELINE does not carry one. So a salesperson opening their OWN lead's
 * walkthrough got a 403 from `?assignable=true`, an empty array from the hook's error path, and a
 * picker that read "No more members" with a disabled trigger and a dead Schedule button. The
 * capability they hold — scheduling a walkthrough on a lead they own — did not work.
 *
 * ── THE GATE, AND WHY IT IS NOT A `canDo` ────────────────────────────────────────────────────
 *
 * `authenticate` + `attachAbility`, then the HANDLER's own scoping. Not `read User`: this route
 * exists precisely to be reachable without it. Not a fixed `canDo` either, and that is a fact
 * about the roster rather than a shortcut:
 *
 *   THE CAPABILITY THIS FEEDS DEPENDS ON THE PURPOSE. A route guard is evaluated before the
 *   handler and cannot read `?purpose=`. The four purposes are fed by three different grants
 *   (`assign User` for crew and performers, `assign Task` for tasks, `read User` for the
 *   directory read), and the manual-log precedent's rule — gate on the capability the roster
 *   FEEDS — therefore has to be applied inside the handler. For the pool-governed purposes
 *   `resolveAssigneePoolForRequest` is that application, and it is the SAME module the write-side
 *   validators (`validatePerformers`, `validateCrew`) ask, so the list a user is offered and the
 *   set the API will accept from them cannot disagree.
 *
 *   AND WHERE NO POOL RULE APPLIES, NEITHER DOES THE POOL. `directory` is the second family (see
 *   `DIRECTORY_PURPOSE` above): a lead-owner picker, a job-dispatcher picker, a calendar-entry
 *   participants field, an automation recipient list, a filter dropdown. None of those writes
 *   consults `isAssigneeSetPermitted`, so scoping them by `assign User` would hide people the API
 *   accepts. They are gated on `read User` — what `origin/staging` gated them on — and nothing
 *   else changes hands.
 *
 *   AND A NON-HOLDER LEARNS NOTHING. Without the grant the pool is `{scope:'self'}` and the
 *   response is exactly one row: the requester's own id, name, role, department and avatar — six
 *   facts about themselves that every authenticated session already carries. There is no
 *   enumeration to guard, so an additional capability gate would only ever lock somebody out of
 *   their own name, which is the bug above wearing a different hat.
 *
 * Ran's ruling, in full: ONE switch controls both seeing the team and assigning them, and without
 * it a walkthrough auto-assigns the rep as its sole performer. But the rep still SEES who is on
 * their record, by name — those names travel on the LEAD read (lead.controller.ts already selects
 * `visits.assignees.user`), not on this roster. This route answers "who may I ADD", which is the
 * half that is gated. Do not widen it to cover the display of people already assigned.
 *
 * ── EVERYTHING ELSE IS THE OLD BRANCH, MOVED VERBATIM ────────────────────────────────────────
 *
 * Tenant scope, `is_active`, the `eligible_for` role sets, `department_id`, the
 * `include_referenced_in` union and the department/name ordering all behave exactly as they did
 * on `?assignable=true`. Only the gate, the select and the response envelope changed.
 */
export async function listAssignable(req: Request, res: Response) {
  try {
    // REQUIRED, and checked against the closed set rather than cast. A missing or misspelled
    // purpose must not fall through to a default, because the purpose IS the grant that widens
    // the pool: defaulting to `task` would answer a crew picker out of `assign Task`, and
    // defaulting to `jobCrew` would answer a task picker out of `assign User`. Either way the
    // roster stops matching the write the caller is about to make, and a typo in a query string
    // becomes an authorization decision.
    const rawPurpose = req.query.purpose;
    if (typeof rawPurpose !== 'string' || !(ROSTER_PURPOSES as readonly string[]).includes(rawPurpose)) {
      res.status(400).json({ error: `purpose must be one of: ${ROSTER_PURPOSES.join(', ')}` });
      return;
    }
    const purposeParam = rawPurpose as RosterPurpose;

    // `read User` — the grant that gates `GET /api/users` — read once and used twice below: it is
    // the whole gate for the `directory` family, and it is the condition on the `task` hold.
    const maySeeTheDirectory = req.ability?.can('read', 'User') ?? false;

    // THREE FAMILIES, THREE GATES. A pool-governed purpose asks the shared assignee resolver,
    // which is the same module the write validators ask. `directory` names a list no pool rule
    // governs, so it asks `read User` instead and reproduces exactly what `origin/staging`
    // answered for those surfaces. `taskWatcher` asks `watcherPool` — the same module
    // `task.controller` asks before persisting — and is the one family that narrows by a
    // FRAGMENT rather than by a single id, because its pool is a COHORT (self + every admin +
    // own department) and not a scope. The self-only branch is built here rather than
    // short-circuited into a bare `res.json([req.user])` for the same reason the pool's is —
    // see THE SCOPE below.
    const pool: AssigneePool | null =
      purposeParam === WATCHER_PURPOSE
        ? null
        : purposeParam === DIRECTORY_PURPOSE
          ? (maySeeTheDirectory ? { scope: 'org' } : { scope: 'self', userId: req.user?.id ?? '' })
          : resolveAssigneePoolForRequest(req, purposeParam);
    const watcherPool = purposeParam === WATCHER_PURPOSE ? resolveWatcherPoolForRequest(req) : null;

    const departmentId = req.query.department_id as string | undefined;
    // `eligible_for` names the SLOT the picker fills (or `task`, which is not a slot). Checked against the
    // closed set for the same reason `purpose` is: a typo must not quietly become "everyone".
    const rawEligibleFor = req.query.eligible_for;
    if (rawEligibleFor !== undefined && rawEligibleFor !== TASK_ELIGIBILITY && !isSlot(rawEligibleFor)) {
      res.status(400).json({ error: `eligible_for must be one of: owner, dispatcher, crew, ${TASK_ELIGIBILITY}` });
      return;
    }
    const eligibleFor = rawEligibleFor as Slot | typeof TASK_ELIGIBILITY | undefined;
    const referenced = req.query.include_referenced_in as 'jobs' | 'leads' | undefined;

    const where: Prisma.UserWhereInput = { ...tenantWhere(req) };

    // THE SCOPE. `self` narrows by id and keeps every other filter — the tenant scope above and
    // the eligibility rules below both still apply, so a self-only requester is answered about
    // themselves under exactly the rules everyone else is answered under, and never about anyone
    // else. It is an intersection, deliberately: short-circuiting to "just return req.user" would
    // hand back a row the org-scope query would have excluded (an inactive account, a role the
    // `eligible_for` set does not admit) and put a name in the picker the write side would refuse.
    //
    // `task` IS DELIBERATELY HELD ORG-WIDE FOR A HOLDER OF `read User`, and this is a product
    // hold, not an oversight. `assign Task` is in the catalog but sits in NO DEFAULT_GRANTS row -
    // not even DISPATCHER - so scoping this purpose by the pool alone would collapse the task
    // assignee field to self for everyone but ADMIN, and with it the NON-ASSIGNMENT consumers
    // that share the roster and are not what #1950 is about: the AUTOMATION RECIPIENT pickers
    // (`RecipientMultiSelect`, on both the v1 and v2 workflow builders) and the TASK FILTER BARS
    // (`taskFilterBar`, `dashboardView`, `useFilteredTasks`) - ALL of which have since moved to
    // `directory`, and they moved there precisely so this hold does not have to carry them, which
    // is why deleting it now touches the task ASSIGNEE pickers and nothing else. The
    // task WRITE side has always refused a non-holder naming anyone else, so the picker has been
    // offering people the save rejects; narrowing it here would merely make that long-standing
    // mismatch visible, on a module this PRD is not about. Ran's call (2026-09-01): leave Tasks
    // untouched in this slice and decide the real question - whether DISPATCHER should hold
    // `assign Task` at all - separately, in issue #1950. Delete this whole `taskHeldOpen` clause
    // when that lands; the pool resolver already answers correctly.
    //
    // CONDITIONED ON `read User`, and that condition is the hold's ENTIRE point. Unconditional,
    // it held the purpose open for EVERYONE, so a SALES rep calling
    // `/api/users/assignable?purpose=task&eligible_for=task` got the whole org roster - a list
    // `origin/staging` answered them with a 403, because SALES holds no `read User`. A hold that
    // is supposed to change nothing must therefore reproduce staging's own answer, which is what
    // `read User` is: DISPATCHER, TECHNICIAN and ADMIN keep the full task pool they have today,
    // and SALES stays exactly where staging left them. Widening a roster is not a way to leave a
    // module untouched.
    const taskHeldOpen = purposeParam === 'task' && maySeeTheDirectory;
    if (pool?.scope === 'self' && !taskHeldOpen) where.id = pool.userId;

    // THE WATCHER COHORT narrows by a disjunction, not by an id, so it merges as a fragment.
    // `watcherPoolWhere` nests itself under `AND` deliberately: the `include_referenced_in`
    // branch below assigns `where.OR`, and a bare `OR` here would be clobbered by it — the
    // roster would silently widen back to the whole org. An org-scoped (admin) pool returns
    // `{}` and merges to nothing, which is why this needs no `if` on the scope. Every other
    // filter still applies: this is an intersection with the tenant scope, `is_active` and the
    // `eligible_for` rules, never a short-circuit around them.
    if (watcherPool) Object.assign(where, watcherPoolWhere(watcherPool));

    // A slot is answered by M5 (`slotEligibility.ts`): the active users whose switch for it is on, never a
    // role name. Tasks can be owned/watched by ANY active user (issue #434), so `task` is not a slot and
    // adds no filter; neither does a roster asked for no slot at all (the schedule's people lists).
    const assignableWhere: Prisma.UserWhereInput = { is_active: true };
    if (isSlot(eligibleFor)) {
      // Under `AND`, never as `id`: the self-only scope above already holds `where.id`, and an id list
      // there would replace it and hand a self-only requester the whole slot roster.
      assignableWhere.AND = [{ id: { in: await eligibleUserIds(req.user!.organization_id, eligibleFor) } }];
    }
    if (departmentId) assignableWhere.department_id = departmentId;   // board-column dept scope; omit → org-wide borrow pool

    if (referenced) {
      // Union so a referenced user (inactive, or a role outside the assignable pool) is
      // never dropped from the roster just because they're no longer eligible for NEW
      // assignments — fixes filters missing genuinely-assigned non-technician users.
      // Typed as Prisma.UserWhereInput[] rather than Record<string, unknown>[] on purpose:
      // the untyped shape is what let `job_crew_memberships` survive the S8 teardown as a
      // 500 (the relation was dropped with job_assignees). tsc now rejects a dead relation.
      const referencedClauses: Prisma.UserWhereInput[] =
        // Since multi-visit S8 there is no job_assignees table — "the job's crew" is the
        // derived union over its visits, so a user is referenced-in-jobs when they hold a
        // visit assignment whose visit hangs off a Job. `job_id: { not: null }` is the same
        // set as `purpose: 'WORK'` (the visits_exactly_one_parent CHECK guarantees it) and
        // rides the @@index([job_id]).
        referenced === 'jobs' ? [{ visit_assignments: { some: { visit: { job_id: { not: null } } } } }]
        // Leads keep their direct joins (lead_assignees and the commission owner both still
        // exist), but S1 moved the WALKTHROUGH performer onto visits, so those two alone miss
        // anyone whose only tie to a lead is a walkthrough assignment. Unlike the jobs arm this
        // was never a 500, just a silent gap: the assignable arm still returns such a user while
        // they stay active, and drops them the moment they go inactive. `lead_id: { not: null }`
        // mirrors the jobs clause and rides @@index([lead_id]).
        : referenced === 'leads' ? [
          { lead_crew_memberships: { some: {} } },
          { commission_owned_leads: { some: {} } },
          { visit_assignments: { some: { visit: { lead_id: { not: null } } } } },
        ]
        : [];
      where.OR = [assignableWhere, ...referencedClauses];
    } else {
      // `AND` is merged rather than assigned: the watcher cohort above may already hold one.
      const { AND: slotClauses, ...rest } = assignableWhere;
      Object.assign(where, rest);
      if (slotClauses) where.AND = [...[where.AND ?? []].flat(), ...[slotClauses].flat()];
    }

    const users = await prisma.user.findMany({
      where,
      select: assignableSelect,
      orderBy: [
        { department: { name: 'asc' } },
        { last_name: 'asc' },
        { first_name: 'asc' },
      ],
    });

    // A BARE ARRAY, not `{ users }`. This is a roster and nothing else will ever hang off it —
    // no pagination cursor, no total — so the envelope would carry no information.
    res.json(await withAvatarUrls(users));
  } catch (err) {
    logger.error('List assignable users error:', err);
    res.status(500).json({ error: 'Failed to list assignable users' });
  }
}

// SRVW-138/139: a custom_role_id must belong to the same org, not be archived, and its
// base_role must agree with the base `role` the user is (or remains) holding - `users.role`
// is the base role every existing controller branch reads directly (effectiveRole.ts), so
// letting it drift from the custom role's base_role would silently change what a ~24-site
// `req.user.role === X` check sees versus what the custom role's grants imply.
async function resolveCustomRoleAssignment(
  req: Request,
  customRoleId: string,
  baseRole: string,
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const row = await prisma.customRole.findFirst({
    where: { id: customRoleId, ...tenantWhere(req), archived_at: null },
  });
  if (!row) return { ok: false, error: 'Custom role not found' };
  if (row.base_role !== baseRole) {
    return { ok: false, error: `Custom role's base role is ${row.base_role}, not ${baseRole}` };
  }
  return { ok: true, key: row.key };
}

/**
 * Whether a new person is an Admin (P15). The request may say so; left out, it follows the role picked: a role whose Admin flag
 * is set (the Administrator entry in the role picker, `roleMakesAdmin`) is shorthand for "make this person an Admin". What is
 * stored, and what every later check reads, is the flag on the person.
 */
function adminFlagForNewPerson(body: { role?: string; custom_role_id?: string | null; is_admin?: boolean }): boolean {
  return body.is_admin ?? roleMakesAdmin(body.role ?? '', body.custom_role_id);
}

/** True when the request names a role whose Admin flag is set and also asks for the person's flag off: they contradict. */
function contradictsAdministrator(body: { role?: string; custom_role_id?: string | null; is_admin?: boolean }): boolean {
  return body.is_admin === false && roleMakesAdmin(body.role ?? '', body.custom_role_id);
}

/**
 * Only the Owner changes Admins (ticket 26). Every write that changes an Admin's account, or makes an Admin, takes this step
 * first inside its own transaction: lock the company, read the person again under the lock, and make the Owner check against
 * that row (never the sign-in cache). The row it returns is the person as the change finds them: the access record's "before",
 * and what the last-Admin check (same lock) counts from.
 */
const lockedPersonSelect = { id: true, role: true, custom_role_id: true, is_admin: true, is_active: true } as const;
type LockedPerson = Prisma.UserGetPayload<{ select: typeof lockedPersonSelect }>;

/** The person was removed while the change waited for the lock. */
class PersonGone extends Error {}

/** A change refused from inside its transaction, already answered. */
const REFUSED = Symbol('refused');

async function lockPersonForChange(
  tx: Prisma.TransactionClient,
  req: Request,
  id: string,
  makesAdmin: (row: LockedPerson) => boolean = () => false,
): Promise<LockedPerson> {
  const organizationId = req.user!.organization_id;
  const ownerId = await lockCompanyForAdminChange(tx, organizationId);
  const row = await tx.user.findFirst({ where: { id, organization_id: organizationId }, select: lockedPersonSelect });
  if (!row) throw new PersonGone();
  if (ownerOnlyRefuses({ actorId: req.user!.id, ownerId, target: row, makesAdmin: makesAdmin(row) })) throw new OwnerOnlyRefusal(row.id);
  return row;
}

/** Under the same lock: refuse a change that takes away the company's last active Admin. */
async function refuseLastAdminUnderLock(tx: Prisma.TransactionClient, row: LockedPerson, organizationId: string, removes: boolean): Promise<void> {
  if (removes && isSuperUser(row) && row.is_active && (await activeAdminCount(tx, organizationId)) <= 1) throw new LastAdminRefusal();
}

/** Answer a refusal thrown from inside a change (the transaction has rolled back). True when it answered. */
function answerChangeRefusal(req: Request, res: Response, err: unknown, lastAdminMessage: string): boolean {
  if (err instanceof OwnerOnlyRefusal) {
    answerOwnerOnly(req, res, err.targetId);
    return true;
  }
  if (err instanceof LastAdminRefusal) {
    res.status(409).json({ error: lastAdminMessage });
    return true;
  }
  if (err instanceof PersonGone) {
    res.status(404).json({ error: 'User not found' });
    return true;
  }
  return false;
}

/** What a person holds, as the access record shows it (ticket 25). */
const heldBy = (u: { role: string; custom_role_id: string | null; is_admin: boolean }): AccessHeld => ({
  role: u.role, custom_role_id: u.custom_role_id, is_admin: u.is_admin,
});

/**
 * Create the person and, in the SAME transaction, their mailbox and first.last.company address (PRD 10, S10.3): if
 * either fails neither exists. The register spans every company, hence the unscoped run (the person's own
 * organization is written explicitly). Every query inside goes through `tx`: the hosted pool holds one connection.
 * A mailbox that came out without an address rings the new user and the holders of Edit users once the create has
 * committed.
 *
 * The access record (ticket 25: the role they start on, and whether they are an Admin) is written in the same transaction,
 * so a person whose record can't be written is not created. The Owner is told after the commit when they start as an Admin.
 * A new Admin is the Owner's to make (ticket 26): a caller who is not the Owner gets OwnerOnlyRefusal and nothing is created.
 */
async function createUserWithMailbox(data: Prisma.UserUncheckedCreateInput, actor: AccessActor) {
  const { user, mailbox, access } = await runUnscoped(() =>
    prisma.$transaction(async (tx) => {
      // Making an Admin is the Owner's alone (ticket 26): checked again here, under the company lock, before the person exists.
      if (data.is_admin) {
        const ownerId = await lockCompanyForAdminChange(tx, data.organization_id);
        if (ownerOnlyRefuses({ actorId: actor.id ?? '', ownerId, target: null, makesAdmin: true })) throw new OwnerOnlyRefusal(null);
      }
      const created = await tx.user.create({ data, select: userSelect });
      const issued = await issueUserMailbox(tx, {
        id: created.id,
        organization_id: data.organization_id,
        first_name: data.first_name,
        last_name: data.last_name,
      });
      const recorded = await recordAccessChange(tx, {
        organizationId: data.organization_id, actor, targetId: created.id, before: null, after: heldBy(created),
      });
      return { user: created, mailbox: issued, access: recorded };
    }),
  );
  void alertOwnerOfAdminChange({ organizationId: data.organization_id, action: access, targetId: user.id, actorId: actor.id });
  if (mailbox.status === 'address_needed') {
    void alertAddressNeeded({
      organizationId: data.organization_id,
      userId: user.id,
      userName: `${data.first_name} ${data.last_name}`.trim(),
      mailboxId: mailbox.mailboxId,
    });
  }
  return user;
}

export async function create(req: Request, res: Response) {
  const { email, password, first_name, last_name, role, custom_role_id, department_id, phone, phone_ext } = req.body;
  const is_admin = adminFlagForNewPerson(req.body);
  if (contradictsAdministrator(req.body)) {
    res.status(400).json({ error: 'The Administrator role is an Admin. Choose another role for someone without admin access.' });
    return;
  }
  // Only the Owner makes an Admin (ticket 26). Read from the database before anything is made; the write checks again.
  if (await refuseUnlessOwnerFor(req, res, null, { makesAdmin: is_admin })) return;

  try {
    if (custom_role_id) {
      const check = await resolveCustomRoleAssignment(req, custom_role_id, role);
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
    }

    if (department_id) {
      const dept = await prisma.department.findFirst({
        where: { id: department_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!dept) {
        res.status(400).json({ error: 'Department not found' });
        return;
      }
    }

    await assertEmailAvailable(email);

    // Create in Supabase Auth first
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError || !authData.user) {
      const code = (authError as { code?: string } | null)?.code;
      const message = authError?.message ?? '';
      if (code === 'email_exists' || /already.*(registered|exists)/i.test(message)) {
        res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
        return;
      }
      res.status(400).json({ error: message || 'Failed to create auth user' });
      return;
    }

    // Create matching Prisma user with same ID (in requesting org)
    try {
      const user = await createUserWithMailbox({
        id: authData.user.id,
        email,
        first_name,
        last_name,
        role,
        custom_role_id: custom_role_id ?? null,
        is_admin,
        phone: phone ?? null,
        phone_ext: phone_ext ?? null,
        department_id: department_id ?? null,
        organization_id: req.user!.organization_id,
      }, actorOf(req));

      void logAudit({ req, action: 'user.created', resourceType: 'User', resourceId: user.id, metadata: { email: user.email, role: user.role } });
      res.status(201).json({ user: await withAvatarUrl(user) });
    } catch (prismaError) {
      // Rollback: delete the Supabase Auth user if Prisma creation fails
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      if (prismaError instanceof OwnerOnlyRefusal) {
        answerOwnerOnly(req, res, null);
        return;
      }
      logger.error('Create user Prisma error (rolled back Supabase):', prismaError);
      res.status(500).json({ error: 'Failed to create user' });
    }
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
      return;
    }
    logger.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
}

// Make the person's one live invite and mail it (lib/invite-link.ts). Returns whether it sent.
const dispatchInvite = sendInviteLink;

/** What the Admin is told when an invite could not clear a sign-in left behind for the address: nothing was made. */
export const INVITE_LOGIN_CHECK_FAILED_MESSAGE = 'Could not finish setting up this invite. Nothing was sent. Please try again.';

export async function inviteUser(req: Request, res: Response) {
  const { email, first_name, last_name, role, custom_role_id, department_id, phone, phone_ext } = req.body;
  const is_admin = adminFlagForNewPerson(req.body);
  if (contradictsAdministrator(req.body)) {
    res.status(400).json({ error: 'The Administrator role is an Admin. Choose another role for someone without admin access.' });
    return;
  }
  // Only the Owner makes an Admin (ticket 26). Read from the database before anything is made; the write checks again.
  if (await refuseUnlessOwnerFor(req, res, null, { makesAdmin: is_admin })) return;

  try {
    if (custom_role_id) {
      const check = await resolveCustomRoleAssignment(req, custom_role_id, role);
      if (!check.ok) {
        res.status(400).json({ error: check.error });
        return;
      }
    }

    if (department_id) {
      const dept = await prisma.department.findFirst({
        where: { id: department_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!dept) {
        res.status(400).json({ error: 'Department not found' });
        return;
      }
    }

    await assertEmailAvailable(email);

    // No one is invited onto a sign-in left behind (security review SR-5). Nobody holds this address (checked just above), so a
    // login the provider still has for it belongs to no one: a leftover of a delete or an erase whose removal failed. Left in
    // place it would open the new account with the old password (sign-in falls back to the confirmed address). It is removed
    // first, and the invite waits until it is: a failure makes nothing and says so, and a retry looks again.
    try {
      await removeProviderLogin(email);
    } catch (removeErr) {
      logger.error('Invite: a leftover identity provider login for this address could not be removed; nothing was made', {
        step: removeErr instanceof ProviderLoginRemovalError ? removeErr.step : 'unknown',
      });
      res.status(502).json({ error: INVITE_LOGIN_CHECK_FAILED_MESSAGE });
      return;
    }

    const user = await createUserWithMailbox({
      email,
      first_name,
      last_name,
      role,
      custom_role_id: custom_role_id ?? null,
      is_admin,
      phone: phone ?? null,
      phone_ext: phone_ext ?? null,
      has_login: true,
      password_hash: '',
      department_id: department_id ?? null,
      organization_id: req.user!.organization_id,
    }, actorOf(req));

    const { inviteUrl, emailSent } = await dispatchInvite({
      id: user.id, email: user.email, first_name: user.first_name, organization_id: req.user!.organization_id,
    });

    void logAudit({ req, action: 'user.invited', resourceType: 'User', resourceId: user.id, metadata: { email: user.email, role: user.role } });
    res.status(201).json({ user: await withAvatarUrl(user), email_sent: emailSent, invite_url: inviteUrl });
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
      return;
    }
    const prismaErr = err as { code?: string; meta?: { target?: string[] } };
    if (prismaErr.code === 'P2002' && prismaErr.meta?.target?.includes('email')) {
      res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
      return;
    }
    if (err instanceof OwnerOnlyRefusal) {
      answerOwnerOnly(req, res, null);
      return;
    }
    logger.error('Invite user error:', err);
    res.status(500).json({ error: 'Failed to invite user' });
  }
}

/** Said when an invite is asked for a deactivated person (N21). */
export const INACTIVE_INVITE_REFUSAL = 'This person is deactivated. Reactivate them to send an invite.';

/**
 * Resend invite. On an Admin it is the Owner's alone (ticket 26, H4): an Admin with no password yet could otherwise be taken
 * over by whoever holds the link. And the link itself is handed back to the Owner only: anyone else gets the email sent and an
 * answer with no link field at all, so they can help a colleague in without being able to sign in as them.
 */
export async function invite(req: Request, res: Response) {
  try {
    const existing = await prisma.user.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, email: true, first_name: true, is_active: true, organization_id: true, erased_at: true, is_admin: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (existing.erased_at) {
      res.status(409).json({ error: ERASED_REFUSAL });
      return;
    }
    if (await refuseUnlessOwnerFor(req, res, existing)) return;
    // A deactivated person gets no invite (re-audit N21): it would turn their sign-in back on and arm a link that opens the
    // moment they are reactivated. Reactivating them is the way back, and the Users page offers Send invite only to an active person.
    if (!existing.is_active) {
      res.status(409).json({ error: INACTIVE_INVITE_REFUSAL });
      return;
    }

    const { inviteUrl, emailSent } = await dispatchInvite(existing);
    // Read from the database, not the sign-in cache: someone who stopped being the Owner a moment ago gets no link.
    const toOwner = await isCompanyOwner(existing.organization_id, req.user!.id);

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { has_login: true },
      select: userSelect,
    });

    void logAudit({ req, action: 'user.invite_resent', resourceType: 'User', resourceId: existing.id });
    res.json(toOwner ? { user, email_sent: emailSent, invite_url: inviteUrl } : { user, email_sent: emailSent });
  } catch (err) {
    logger.error('Resend invite error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
}

function param(req: Request, name: string): string {
  // A person's id in the address is read in its stored form, so every lookup, every Owner check and every "is this you" check
  // in this file sees the same id however the request spelled it (capitals, no hyphens, braces; CR-4).
  return canonicalUserId(req.params[name] as string);
}

export async function getById(req: Request, res: Response) {
  try {
    // M3 (ticket 29): the full record is an Admin's; everyone else gets the names-only row, and only that is read.
    if (!seesFullPeopleRecords(req)) {
      const person = await prisma.user.findFirst({ where: { id: param(req, 'id'), ...tenantWhere(req) }, select: namesOnlySelect });
      if (!person) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json({ user: namesOnly(await withAvatarUrl(person)) });
      return;
    }

    const user = await prisma.user.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: userSelect,
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user: await withAvatarUrl(user) });
  } catch (err) {
    logger.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
}

/** What the audit row for a mailbox handover says: to the main mailbox or to which person. Ids only. */
function handoverAudit(handover: Exclude<HandoverOutcome, { handed: 'none' }>): Record<string, unknown> {
  return handover.handed === 'person'
    ? { handed_to: 'person', person_id: handover.userId, mailbox_ids: handover.mailboxIds }
    : { handed_to: 'main', mailbox_ids: handover.mailboxIds };
}

/**
 * What deactivating a person does to their sign-in, shared by both ways to deactivate (the Users page's Deactivate and the user
 * update that sets is_active false) so they cannot drift apart. The row stops claiming a login in the same write that flips
 * is_active (the caller merges these fields in); then, AFTER that write, the login at the identity provider is removed
 * (removeLoginAfterDeactivation). That order is what lets an invite acceptance racing the deactivation see it and undo the login
 * it made (H2).
 */
const LOGIN_OFF = { has_login: false, password_hash: '' } as const;

/**
 * After the deactivation is written: remove the login at the identity provider. Best effort: the person is already refused at
 * every door (signInRefusal reads is_active), so a provider failure is logged and the deactivation stands.
 */
async function removeLoginAfterDeactivation(existing: { has_login: boolean; email: string | null }): Promise<void> {
  // Whatever the row said: an off row is no proof the provider is clear (a revoke that could not finish leaves one behind).
  if (existing.email) await removeProviderLoginQuietly(existing.email, 'deactivation');
}

/**
 * The Admin flag a person holds once an update lands (P15). Stated in the request, else carried by a change of role, else left
 * as it is. A role carries it by its own Admin flag (`roleMakesAdmin`, the Administrator role's alone), never by its name:
 * moving onto a role whose flag is set makes the person an Admin, and moving off one onto a role without it takes that away.
 * Any other change of role leaves the person's flag where it was.
 */
function nextAdminFlag(
  existing: { role: string; custom_role_id: string | null; is_admin: boolean },
  body: { role?: string; custom_role_id?: string | null; is_admin?: boolean },
): { nextIsAdmin: boolean; toAdministrator: boolean; roleStated: boolean } {
  const nextRole: string = body.role ?? existing.role;
  const nextCustomRoleId = body.custom_role_id !== undefined ? body.custom_role_id : existing.custom_role_id;
  const toAdministrator = roleMakesAdmin(nextRole, nextCustomRoleId);
  const fromAdministrator = roleMakesAdmin(existing.role, existing.custom_role_id);
  // The role moves the flag only when the request names a role: a name or phone edit leaves it exactly as it is.
  const roleStated = body.role !== undefined || body.custom_role_id !== undefined;
  const nextIsAdmin: boolean = body.is_admin ?? (roleStated ? (toAdministrator ? true : fromAdministrator ? false : existing.is_admin) : existing.is_admin);
  return { nextIsAdmin, toAdministrator, roleStated };
}

export async function update(req: Request, res: Response) {
  try {
    const existing = await prisma.user.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      include: { custom_role: { select: { key: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    // A person whose personal data was erased is a name-less record kept for history: nothing about them is edited and they
    // are not brought back (P19).
    if (existing.erased_at) {
      res.status(409).json({ error: ERASED_REFUSAL });
      return;
    }

    // No one, the Owner included, removes the Owner (AL-16): not by taking Admin away (the switch, or a move off the
    // Administrator role), not by setting them inactive.
    const { nextIsAdmin, toAdministrator, roleStated } = nextAdminFlag(existing, req.body);
    const removing = req.body.is_active === false || (existing.is_admin && !nextIsAdmin);
    if (removing && (await refuseOwnerRemoval(req, res, existing.id))) return;
    // Only the Owner makes an Admin or changes an Admin's account (ticket 26): read from the database here, before anything else
    // is looked at, and again inside the write, under the company lock, against the person as they are then.
    if (await refuseUnlessOwnerFor(req, res, existing, { makesAdmin: nextIsAdmin && !existing.is_admin })) return;

    // Nobody changes their own role: neither the base role nor the custom-role link (an admin demoting themselves
    // locks the company out; anyone else would be raising their own access). Editing other fields on your own
    // account is fine, and sending back the role you already hold is not a change (mirrors the self-deactivate
    // guard in deactivate()).
    if (sameUserId(req.user?.id, existing.id)) {
      const changesBaseRole = req.body.role !== undefined && req.body.role !== existing.role;
      const changesCustomRole = req.body.custom_role_id !== undefined && req.body.custom_role_id !== existing.custom_role_id;
      // The Admin flag is part of the role: nobody grants or takes away their own.
      const changesAdminFlag = req.body.is_admin !== undefined && req.body.is_admin !== existing.is_admin;
      if (changesBaseRole || changesCustomRole || changesAdminFlag) {
        res.status(400).json({ error: 'Cannot change your own role' });
        return;
      }
    }

    if (req.body.department_id) {
      const dept = await prisma.department.findFirst({
        where: { id: req.body.department_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!dept) {
        res.status(400).json({ error: 'Department not found' });
        return;
      }
    }

    // Someone in the Administrator role is an Admin: to take it away, give them another role.
    if (nextIsAdmin === false && toAdministrator && (roleStated || existing.is_admin)) {
      res.status(400).json({ error: 'Give this person another role to take away their admin access.' });
      return;
    }

    if (await wouldRemoveLastAdmin(req, existing)) {
      // Leaving the Admin box: the flag goes off.
      const demoting = !nextIsAdmin;
      const deactivating = req.body.is_active === false;
      if (demoting || deactivating) {
        res.status(409).json({ error: 'Cannot remove the last active admin. Assign another admin first.' });
        return;
      }
    }

    // Setting a user inactive hands their mailbox on (PRD 10): a target that is not an active person is refused before anything is written.
    const handoverTarget = req.body.is_active === false
      ? await resolveHandoverTarget(prisma, { organizationId: req.user!.organization_id, leaverId: existing.id, raw: req.body.handover_to })
      : null;
    if (req.body.is_active === false && !handoverTarget) {
      res.status(400).json({ error: HANDOVER_TARGET_REFUSED });
      return;
    }
    let handover = null as HandoverOutcome | null;
    // Setting a person active again returns their mailbox (PRD 10, S10.23), in the same write as the flip.
    const reactivating = req.body.is_active === true && !existing.is_active;
    // The register spans every company, so the write that returns a mailbox runs unscoped (the person's own organization is explicit).
    const scoped = <T>(run: () => Promise<T>): Promise<T> => (reactivating ? runUnscoped(run) : run());
    let returned = null as ReactivationOutcome | null;

    // SRVW-138/139: re-validate base_role/custom_role_id agreement whenever EITHER is touched -
    // changing only `role` while a custom_role_id is already set (or vice versa) can just as
    // easily strand the pair as setting both at once, and existing.custom_role_id is not
    // re-checked unless something here actually moves.
    // The key of the role the person holds once this update lands: a custom role's key, else the
    // built-in role's name. Roles & Permissions M2: giving a person a role fills their switches.
    let newRoleKey: string = req.body.role !== undefined ? req.body.role : existing.role;
    if (req.body.role !== undefined || req.body.custom_role_id !== undefined) {
      const effectiveRole = req.body.role !== undefined ? req.body.role : existing.role;
      const effectiveCustomRoleId = req.body.custom_role_id !== undefined ? req.body.custom_role_id : existing.custom_role_id;
      if (effectiveCustomRoleId) {
        const check = await resolveCustomRoleAssignment(req, effectiveCustomRoleId, effectiveRole);
        if (!check.ok) {
          res.status(400).json({ error: check.error });
          return;
        }
        newRoleKey = check.key;
      }
    } else if (existing.custom_role?.key) {
      newRoleKey = existing.custom_role.key;
    }

    // Explicit field allowlist (NOT `data: req.body`): the controller self-defends
    // regardless of schema drift (a future .passthrough(), a new privileged column,
    // or a removed validate) so an injected organization_id/email/has_login/id can
    // never be mass-assigned to escalate or move another user (authz-4). Mirrors
    // updateUserSchema; undefined keys are dropped so a partial PATCH never nulls.
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (body.first_name !== undefined) data.first_name = body.first_name;
    if (body.last_name !== undefined) data.last_name = body.last_name;
    if (body.role !== undefined) data.role = body.role;
    if (body.custom_role_id !== undefined) data.custom_role_id = body.custom_role_id;
    if (nextIsAdmin !== existing.is_admin) data.is_admin = nextIsAdmin;
    if (body.is_active !== undefined) data.is_active = body.is_active;
    // Setting a person inactive removes their login, exactly as the Users page's Deactivate does (the provider's, after the write).
    if (body.is_active === false) Object.assign(data, LOGIN_OFF);
    if (body.department_id !== undefined) data.department_id = body.department_id;
    // Personnel staff-mgmt (PR #218): admin Edit-details dialog PATCHes phone/ext.
    if (body.phone !== undefined) data.phone = body.phone;
    if (body.phone_ext !== undefined) data.phone_ext = body.phone_ext;

    // Giving the person a role (or a different one) links them to it and clears their overrides; sending
    // back the role they already hold leaves their overrides alone. Compared with the role they were last
    // linked to, so a link that failed is retried by sending the same update again.
    const filledFrom = existing.based_on_role_key ?? existing.custom_role?.key ?? existing.role;
    const fillSwitches = (body.role !== undefined || body.custom_role_id !== undefined) && newRoleKey !== filledFrom;

    if (fillSwitches) data.based_on_role_key = newRoleKey;

    // Ticket 25 (M6): a change of Admin or role is recorded in the same transaction as the write, so it can't happen unrecorded.
    // Ticket 26: the write opens with the company lock and the person read again under it. The Owner check and the last-Admin
    // check are made against that row, the flag written follows it, and it is the record's "before".
    const actor = actorOf(req);
    let access = null as AccessAction | null;
    const lastAdminRemoved = 'Cannot remove the last active admin. Assign another admin first.';
    const underLock = async (tx: Prisma.TransactionClient) => {
      const locked = await lockPersonForChange(tx, req, existing.id, (row) => nextAdminFlag(row, req.body).nextIsAdmin && !row.is_admin);
      const lockedNext = nextAdminFlag(locked, req.body).nextIsAdmin;
      await refuseLastAdminUnderLock(tx, locked, existing.organization_id, !lockedNext || req.body.is_active === false);
      if (lockedNext !== locked.is_admin) data.is_admin = lockedNext;
      else delete data.is_admin;
      return heldBy(locked);
    };

    const user = await (async () => {
      // What the person resolved to before the new role, for the change log's "from".
      const previous = fillSwitches ? await resolveSwitches(existing) : null;
      // The handover (or the return of the mailbox) is part of the same write as the flip, so a person is never left inactive with a
      // mailbox nobody holds, nor active with a mailbox that is not theirs. A change of access carries its record the same way.
      return scoped(() => prisma.$transaction(async (tx) => {
        const before = await underLock(tx);
        const updated = await tx.user.update({ where: { id: param(req, 'id') }, data, select: userSelect });
        if (previous) {
          await assignRoleToPerson(tx, {
            organizationId: existing.organization_id,
            userId: existing.id,
            roleKey: newRoleKey,
            userBaseRole: updated.role,
            previous,
            actorId: req.user!.id,
          });
        }
        access = await recordAccessChange(tx, { organizationId: existing.organization_id, actor, targetId: existing.id, before, after: heldBy(updated) });
        if (handoverTarget) handover = await handOverMailbox(tx, { organizationId: existing.organization_id, userId: existing.id, target: handoverTarget, actorId: req.user!.id });
        if (reactivating) returned = await reactivateMailbox(tx, { id: existing.id, organization_id: existing.organization_id, first_name: updated.first_name, last_name: updated.last_name });
        return updated;
      }));
    })().catch((err: unknown): typeof REFUSED => {
      if (answerChangeRefusal(req, res, err, lastAdminRemoved)) return REFUSED;
      throw err;
    });
    if (user === REFUSED) return;

    // Only now that the change has committed: a rolled-back change leaves both caches as they were (ticket 37).
    clearTokenCache(param(req, 'id'));
    clearSwitchCacheForUser(existing.id);
    if (body.is_active === false) await removeLoginAfterDeactivation(existing);
    void logAudit({ req, action: 'user.updated', resourceType: 'User', resourceId: param(req, 'id'), metadata: { fields: Object.keys(data) } });
    if (returned && returned.returned !== 'none') {
      void logAudit({ req, action: 'user.mailbox_returned', resourceType: 'User', resourceId: param(req, 'id'), metadata: { ...returned } });
    }
    if (returned?.returned === 'issued' && returned.addressNeeded) {
      void alertAddressNeeded({
        organizationId: existing.organization_id, userId: existing.id, userName: `${user.first_name} ${user.last_name}`.trim(), mailboxId: returned.mailboxId,
      });
    }
    if (handover && handover.handed !== 'none') void logAudit({ req, action: 'user.mailbox_handed_over', resourceType: 'User', resourceId: param(req, 'id'), metadata: handoverAudit(handover) });
    void alertOwnerOfAdminChange({ organizationId: existing.organization_id, action: access, targetId: existing.id, actorId: actor.id });
    res.json({ user: await withAvatarUrl(user) });
  } catch (err) {
    logger.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
}

/**
 * What deactivating this person would leave open: the number of open records per module that name them (P19). Counts only.
 * Deactivating changes no record, so this is a heads-up and the way to the optional reassign below, not a precondition.
 */
export async function deactivationSummary(req: Request, res: Response) {
  try {
    const person = await prisma.user.findFirst({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: { id: true, first_name: true, last_name: true, is_active: true },
    });
    if (!person) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const summary = await summarizeOpenRecords(req.user!.organization_id, person.id);
    res.json({ person: { id: person.id, first_name: person.first_name, last_name: person.last_name, is_active: person.is_active }, ...summary });
  } catch (err) {
    logger.error('Deactivation summary error:', err);
    res.status(500).json({ error: 'Failed to read the open records' });
  }
}

export const reassignOpenSchema = z.object({
  to_user_id: z.string().uuid(),
  modules: z.array(z.enum(REASSIGN_MODULES)).min(1),
});

/**
 * Replace this person with another on their open records, module by module (P19's optional bulk reassign). It moves the
 * people fields of open records only; closed records keep the person as history. An Admin's action: it writes across the
 * company's tasks, leads and jobs, whatever the caller's own reach over them.
 */
export async function reassignOpen(req: Request, res: Response) {
  try {
    if (!isSuperUser(req.user!)) {
      res.status(403).json({ error: 'Only an Admin can reassign a person\'s open records.' });
      return;
    }
    const fromId = param(req, 'id');
    const { to_user_id: toId, modules } = req.body as z.infer<typeof reassignOpenSchema>;
    if (sameUserId(toId, fromId)) {
      res.status(400).json({ error: 'Choose someone other than this person.' });
      return;
    }
    const orgId = req.user!.organization_id;
    const [from, to] = await Promise.all([
      prisma.user.findFirst({ where: { id: fromId, ...tenantWhere(req) }, select: { id: true } }),
      prisma.user.findFirst({ where: { id: toId, ...tenantWhere(req), is_active: true }, select: { id: true } }),
    ]);
    if (!from) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!to) {
      res.status(400).json({ error: 'Choose an active person to take over.' });
      return;
    }
    const result = await reassignOpenRecords({ orgId, actorId: req.user!.id, fromUserId: fromId, toUserId: toId, modules });
    void logAudit({
      req, action: 'user.open_records_reassigned', resourceType: 'User', resourceId: fromId,
      metadata: { to_user_id: toId, modules, moved: result.moved, skipped: result.skipped },
    });
    res.json(result);
  } catch (err) {
    logger.error('Reassign open records error:', err);
    res.status(500).json({ error: 'Failed to reassign the open records' });
  }
}

/** The erase could not remove the person's sign-in, so nothing was erased (CR-10). ServWave's own words, no provider's. */
export const ERASE_LOGIN_FAILED_MESSAGE = "Could not remove this person's sign-in, so nothing was erased. Please try again.";

/** The refusal for any change to a person whose personal data was erased. */
const ERASED_REFUSAL = 'This person\'s personal data was erased. They stay on their records as a former user and cannot be edited or brought back.';

/** What an erased person is called everywhere a record names them. */
export const FORMER_USER_FIRST_NAME = 'Former';
export const FORMER_USER_LAST_NAME = 'user';

/**
 * Erase a deactivated person's personal data (P19, A5; GDPR Art. 17 with its 17(3) exceptions, 11 CCR 7022(b)(1)): the name
 * becomes "Former user", the email, phone and photo are removed, the credentials are deleted, and the erasure is logged. The
 * row and every record that names the person stay, so history keeps its shape; the mailbox address stays reserved. An erased
 * person cannot sign in and cannot be reactivated. An Admin's action, only on a person already deactivated, only once.
 */
export async function erasePersonalData(req: Request, res: Response) {
  try {
    // No one, the Owner included, erases the Owner (AL-16).
    if (await refuseOwnerRemoval(req, res, param(req, 'id'))) return;
    if (!isSuperUser(req.user!)) {
      res.status(403).json({ error: 'Only an Admin can erase a person\'s personal data.' });
      return;
    }
    const id = param(req, 'id');
    if (sameUserId(req.user?.id, id)) {
      res.status(400).json({ error: 'Cannot erase your own account' });
      return;
    }
    const existing = await prisma.user.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true, organization_id: true, email: true, is_active: true, erased_at: true, avatar_path: true, is_admin: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    // Erasing an Admin is the Owner's alone (ticket 26); checked again inside the write, under the company lock.
    if (await refuseUnlessOwnerFor(req, res, existing)) return;
    if (existing.is_active) {
      res.status(409).json({ error: 'Deactivate this person before erasing their personal data.' });
      return;
    }
    if (existing.erased_at) {
      res.status(409).json({ error: 'This person\'s personal data was already erased.' });
      return;
    }

    // The sign-in first: a login that outlived the erase would be the worst result. If it cannot be removed, nothing is erased and
    // the answer says so (a status never claims success for a failure, CR-10): the real address is the only way to find that
    // login again, so it stays for a retry. (The person is already deactivated, so every door refuses them meanwhile.)
    if (!(await removeProviderLoginQuietly(existing.email, 'erase'))) {
      res.status(502).json({ error: ERASE_LOGIN_FAILED_MESSAGE });
      return;
    }
    const claimed = await prisma.$transaction(async (tx) => {
      await lockPersonForChange(tx, req, id);
      // Only a person still deactivated and not yet erased is erased: a reactivation, or a second erase, between the read above
      // and this write finds no row to change.
      const { count } = await tx.user.updateMany({
        where: { id, ...tenantWhere(req), is_active: false, erased_at: null },
        data: {
          first_name: FORMER_USER_FIRST_NAME,
          last_name: FORMER_USER_LAST_NAME,
          // The email column is required and unique, so it holds an address that belongs to nobody (the reserved .invalid
          // domain never resolves) and carries nothing of the person; the real address is free to be used again.
          email: `erased-${id}@erased.invalid`,
          phone: null,
          phone_ext: null,
          avatar_path: null,
          has_login: false,
          password_hash: '',
          mfa_email_enrolled: false,
          erased_at: new Date(),
        },
      });
      if (count === 0) return false;
      await tx.mfaEmailChallenge.deleteMany({ where: { user_id: id } });
      // The permission change log is the person's own history on the Permissions page: the erasure is one event row on it.
      await tx.permissionChangeLog.create({
        data: {
          organization_id: existing.organization_id, target_type: 'USER', target_id: id, switch_key: null,
          from_value: Prisma.DbNull, to_value: Prisma.DbNull, actor_id: req.user!.id, reason: 'erased', role_label: null,
        },
      });
      return true;
    });
    if (!claimed) {
      res.status(409).json({ error: 'This person can no longer be erased: they were reactivated or already erased.' });
      return;
    }
    if (existing.avatar_path) await removeAvatarObject(existing.avatar_path);
    clearTokenCache(id);
    void logAudit({ req, action: 'user.personal_data_erased', resourceType: 'User', resourceId: id });
    res.json({ message: 'Personal data erased' });
  } catch (err) {
    if (answerChangeRefusal(req, res, err, '')) return;
    logger.error('Erase personal data error:', err);
    res.status(500).json({ error: 'Failed to erase personal data' });
  }
}

const LAST_ADMIN_DEACTIVATE = 'Cannot deactivate the last active admin. Assign another admin first.';

export async function deactivate(req: Request, res: Response) {
  try {
    // No one, the Owner included, deactivates the Owner (AL-16).
    if (await refuseOwnerRemoval(req, res, param(req, 'id'))) return;
    if (sameUserId(req.user?.id, param(req, 'id'))) {
      res.status(400).json({ error: 'Cannot deactivate your own account' });
      return;
    }

    const existing = await prisma.user.findFirst({ where: { id: param(req, 'id'), ...tenantWhere(req) } });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Deactivating an Admin is the Owner's alone (ticket 26); checked again inside the write, under the company lock.
    if (await refuseUnlessOwnerFor(req, res, existing)) return;

    if (await wouldRemoveLastAdmin(req, existing)) {
      res.status(409).json({ error: LAST_ADMIN_DEACTIVATE });
      return;
    }

    // Who gets their email (PRD 10): the main mailbox unless the request names an active person. Refused before anything changes.
    const handoverTarget = await resolveHandoverTarget(prisma, { organizationId: existing.organization_id, leaverId: existing.id, raw: req.body?.handover_to });
    if (!handoverTarget) {
      res.status(400).json({ error: HANDOVER_TARGET_REFUSED });
      return;
    }

    // Deactivation force-revokes login so has_login never lies (and the seat can't sign in): the row first, then the provider.
    // The flip and the mailbox handover are one write, so a person is never left inactive with a mailbox nobody holds.
    const handover = await prisma.$transaction(async (tx) => {
      const locked = await lockPersonForChange(tx, req, existing.id);
      await refuseLastAdminUnderLock(tx, locked, existing.organization_id, true);
      await tx.user.update({
        where: { id: param(req, 'id') },
        data: { is_active: false, ...LOGIN_OFF },
        select: { id: true },
      });
      return handOverMailbox(tx, { organizationId: existing.organization_id, userId: existing.id, target: handoverTarget, actorId: req.user!.id });
    });

    clearTokenCache(param(req, 'id'));
    await removeLoginAfterDeactivation(existing);
    void logAudit({ req, action: 'user.deactivated', resourceType: 'User', resourceId: param(req, 'id') });
    if (handover.handed !== 'none') void logAudit({ req, action: 'user.mailbox_handed_over', resourceType: 'User', resourceId: param(req, 'id'), metadata: handoverAudit(handover) });
    res.json({ message: 'User deactivated' });
  } catch (err) {
    if (answerChangeRefusal(req, res, err, LAST_ADMIN_DEACTIVATE)) return;
    logger.error('Deactivate user error:', err);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
}

// A person with history is never deleted (P19); a person with none (a mistyped invite) can be. History is every record that
// still names them: what they made, what they were paid or paid out, what they were assigned, crewed, owned, dispatched or
// sold, and the audit trail. Deactivating keeps all of it and marks the name "Deactivated"; only a person nothing points at
// can go. (Crew rows and a Dispatcher slot used to count as transient. They are people fields, and a record's people
// fields are history.) Relations that only hold the person's own settings (table preferences, switch values) are
// omitted: they are not history.
export const DELETE_BLOCKING_RELATIONS = {
  created_estimates: true,
  created_notes: true,
  uploaded_attachments: true,
  created_attachments: true,
  time_entries: true,
  timeclock_ot_reviews: true,
  issued_refunds: true,
  created_credits: true,
  collected_payments: true,
  created_payments: true,
  voided_payments: true,
  refunded_invoices: true,
  created_invoices: true,
  created_customers: true,
  created_leads: true,
  created_jobs: true,
  jobs_closed: true,
  commission_owned_leads: true,
  lead_crew_memberships: true,
  dispatched_leads: true,
  dispatched_jobs: true,
  jobs_as_salesperson: true,
  visit_assignments: true,
  service_plans_sold: true,
  // Issue 04 widened what this one blocks: a task's timeline now OUTLIVES the task, so a user
  // whose whole history was creating and deleting one task still holds events here. That is the
  // point - `created_by` on those rows is the only surviving record of who did it, and the
  // relation is SetNull, so a hard delete would blank the trail the issue exists to keep. Do not
  // relax this entry to unblock a deletion.
  timeline_events: true,
  cancelled_visits: true,
  // A record's people fields are history (P19): each of these relations is SetNull, so a hard delete would blank the person from
  // the record without a word, which is exactly what deactivation promises not to do.
  stock_movements_performed: true,
  asset_events: true,
  asset_events_acted: true,
  purchase_orders_ordered: true,
  job_reviews_finished: true,
  logistic_orders_created: true,
  logistic_orders_submitted: true,
  logistic_orders_approved: true,
  logistic_orders_processed: true,
  automation_rules_created: true,
  leads_contact_set: true,
  headed_departments: true,
  managed_locations: true,
  visit_milestone_events: true,
  payment_resolutions: true,
  disputes_submitted: true,
} as const;

export const DELETE_RELATION_LABELS: Record<string, string> = {
  created_estimates: 'estimates',
  created_notes: 'notes',
  uploaded_attachments: 'attachments',
  created_attachments: 'attachments created',
  time_entries: 'time entries',
  timeclock_ot_reviews: 'overtime reviews',
  issued_refunds: 'refunds',
  created_credits: 'credits',
  collected_payments: 'payments collected',
  created_payments: 'payments recorded',
  voided_payments: 'payments voided',
  refunded_invoices: 'invoices refunded',
  created_invoices: 'invoices',
  created_customers: 'customers',
  created_leads: 'leads created',
  created_jobs: 'jobs created',
  jobs_closed: 'jobs closed',
  commission_owned_leads: 'leads owned',
  lead_crew_memberships: 'leads assigned',
  dispatched_leads: 'leads dispatched',
  dispatched_jobs: 'jobs dispatched',
  jobs_as_salesperson: 'jobs sold',
  visit_assignments: 'visits on a crew',
  service_plans_sold: 'service plans sold',
  timeline_events: 'timeline events',
  cancelled_visits: 'walkthrough cancellations',
  stock_movements_performed: 'stock movements',
  asset_events: 'asset events',
  asset_events_acted: 'asset events made',
  purchase_orders_ordered: 'purchase orders placed',
  job_reviews_finished: 'job reviews finished',
  logistic_orders_created: 'logistic orders created',
  logistic_orders_submitted: 'logistic orders submitted',
  logistic_orders_approved: 'logistic orders approved',
  logistic_orders_processed: 'logistic orders processed',
  automation_rules_created: 'automations created',
  leads_contact_set: 'leads marked contacted',
  headed_departments: 'departments headed',
  managed_locations: 'locations managed',
  visit_milestone_events: 'visit milestones',
  payment_resolutions: 'payment problems resolved',
  disputes_submitted: 'disputes answered',
  tasks: 'tasks',
};

// Admin "Reset 2FA": clear the target user's email-OTP enrollment and purge any
// pending challenges so they can re-enroll cleanly. Admin-only + tenant-scoped,
// mirroring permanentDelete (findFirst + tenantWhere; findFirst — NOT findUnique —
// avoids colliding with the auth-middleware's findUnique mock in tests).
export async function resetMfa(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.user.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    await prisma.user.updateMany({
      where: { id, ...tenantWhere(req) },
      data: { mfa_email_enrolled: false },
    });
    await prisma.mfaEmailChallenge.deleteMany({ where: { user_id: id } });

    void logAudit({ req, action: 'user.mfa_reset', resourceType: 'User', resourceId: id });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Reset 2FA error:', err);
    res.status(500).json({ error: 'Failed to reset 2FA' });
  }
}

/** What the Admin is told when a delete could not remove the person's sign-in: nothing was deleted, and a retry is safe. */
export const DELETE_LOGIN_FAILED_MESSAGE = "Could not remove this person's sign-in, so nothing was deleted. Please try again.";

export async function permanentDelete(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    // No one, the Owner included, deletes the Owner (AL-16). The database refuses it too.
    if (await refuseOwnerRemoval(req, res, id)) return;
    if (sameUserId(req.user?.id, id)) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    const existing = await prisma.user.findFirst({
      where: { id, ...tenantWhere(req) },
      select: { id: true, organization_id: true, email: true, is_active: true, avatar_path: true, is_admin: true, _count: { select: DELETE_BLOCKING_RELATIONS } },
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    // Deleting an Admin is the Owner's alone (ticket 26); checked again inside the write, under the company lock.
    if (await refuseUnlessOwnerFor(req, res, existing)) return;

    if (existing.is_active) {
      res.status(409).json({ error: 'Deactivate this user before deleting them.' });
      return;
    }

    const counts = existing._count as unknown as Record<string, number>;
    // Task people lists are uuid[] columns with no foreign key, so the count above cannot see them; a task that names the
    // person (assignee, watcher or creator) is history too.
    counts.tasks = await prisma.task.count({
      where: { organization_id: existing.organization_id, OR: [{ assignee_ids: { has: id } }, { watcher_ids: { has: id } }, { created_by: id }] },
    });
    const history = Object.entries(counts).filter(([, n]) => n > 0);
    if (history.length > 0) {
      const detail = history.map(([k, n]) => `${n} ${DELETE_RELATION_LABELS[k] ?? k}`).join(', ');
      res.status(409).json({
        error: `This user has history (${detail}) and can't be permanently deleted. Keep them deactivated instead.`,
      });
      return;
    }

    // The sign-in goes first, and it must go (security review SR-5). Once the row is deleted nothing holds the address the login
    // is found by, and a login left at the provider would open the next account invited with that address, on the old password.
    // So a failure deletes nothing and says so: the row keeps the address, and the Admin's retry finds the login again. (The
    // person is already deactivated, so every door refuses them meanwhile.)
    try {
      await removeProviderLogin(existing.email);
    } catch (removeErr) {
      logger.error('Permanent delete: the identity provider login could not be removed; nothing was deleted', {
        userId: id, step: removeErr instanceof ProviderLoginRemovalError ? removeErr.step : 'unknown',
      });
      res.status(502).json({ error: DELETE_LOGIN_FAILED_MESSAGE });
      return;
    }

    // Mailbox rows and address rows are never history and no foreign key from them blocks this (the links to the user are
    // SET NULL). A mailbox the delete would leave with nobody to read it is merged into the main mailbox in the same write,
    // so a refused delete (below) rolls that back too. The address rows stay as reservations (PRD 10, S10.24).
    let settled: HandoverOutcome;
    try {
      settled = await prisma.$transaction(async (tx) => {
        await lockPersonForChange(tx, req, id);
        const outcome = await settleMailboxesBeforeDelete(tx, { organizationId: existing.organization_id, userId: id });
        await tx.user.delete({ where: { id } });
        return outcome;
      });
    } catch (delErr) {
      if ((delErr as { code?: string }).code === 'P2003') {
        res.status(409).json({
          error: "This user is still referenced by other records and can't be deleted. Keep them deactivated instead.",
        });
        return;
      }
      throw delErr;
    }

    if (existing.avatar_path) await removeAvatarObject(existing.avatar_path);

    clearTokenCache(id);
    void logAudit({ req, action: 'user.permanently_deleted', resourceType: 'User', resourceId: id, metadata: { email: existing.email } });
    if (settled.handed !== 'none') void logAudit({ req, action: 'user.mailbox_handed_over', resourceType: 'User', resourceId: id, metadata: handoverAudit(settled) });
    res.json({ message: 'User deleted' });
  } catch (err) {
    if (answerChangeRefusal(req, res, err, '')) return;
    logger.error('Permanent delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
}

// Returns true if `target` is the org's last active admin (so demoting / deactivating /
// revoking-login it would lock the org out of admin access). An admin is a person with the Admin flag (P15); a role
// copied from Admin with the flag off keeps the company reachable no more than any other role (see isSuperUser).
async function wouldRemoveLastAdmin(req: Request, target: { role: string; custom_role_id?: string | null; is_admin: boolean; is_active: boolean }): Promise<boolean> {
  if (!isSuperUser(target) || !target.is_active) return false;
  const activeAdmins = await prisma.user.count({
    where: { is_admin: true, is_active: true, ...tenantWhere(req) },
  });
  return activeAdmins <= 1;
}

/** What the Admin is told when the login could not be removed and the person holds sign-in: they can still sign in. */
export const REVOKE_LOGIN_FAILED_MESSAGE = "Could not revoke this person's login. They can still sign in. Please try again.";
/** The person's sign-in is off, but their login was not confirmed gone at the provider. The screen still offers Revoke. */
export const REVOKE_LOGIN_UNFINISHED_MESSAGE = "Could not finish revoking this person's login. Please try again.";
/** The same, for a person deactivated meanwhile: Revoke is not offered for them, so nothing is asked of the Admin. */
export const REVOKE_LOGIN_UNFINISHED_INACTIVE_MESSAGE = "Could not finish revoking this person's login.";

/**
 * Revoke's marks in the row's invite-mark column (password_hash, lib/invite-link.ts). None is an invite mark, so while any of them
 * is there every invite link for the person is expired, and lib/invite-link only ever clears invite marks.
 *  - `revoking:<uuid>`: a revoke waiting on the provider. Only the revoke holding it may put the person back if the provider fails.
 *  - `revoking:pending`: a revoke that could not finish (sign-in off, the provider not seen clear). The list says so and the screen
 *    still offers Revoke.
 *  - `revoked:confirmed`: a revoke saw the provider hold no login for the person, written only over the exact mark it saw before
 *    its call. A revoke whose own call also succeeded may lean on it; a revoke whose call failed never does. An empty column proves
 *    nothing (deactivation, an erase and a finished invite all leave one).
 */
const REVOKING_PREFIX = 'revoking:';
const REVOKE_PENDING_MARK = `${REVOKING_PREFIX}pending`;
const REVOKE_CONFIRMED_MARK = 'revoked:confirmed';

/** Whether a row's invite-mark column says a revoke is unfinished or still running: the list's `revoke_pending`. */
export function revokePending(row: { has_login: boolean; password_hash: string | null }): boolean {
  return !row.has_login && Boolean(row.password_hash?.startsWith(REVOKING_PREFIX));
}

type RevokeOutcome = 'done' | 'can_sign_in' | 'unfinished' | 'inactive' | 'gone';

/**
 * Where a revoke stands, read from the row after this request's provider call. "Done" needs this request's OWN proof: its provider
 * call removed the login (or found none) AND the row was still exactly as it saw it before that call, so its confirmation was
 * written (`confirmedByMe`); or its call succeeded and a confirmation is already on the row. A revoke whose own provider call failed
 * is never done, whatever another revoke found. Anything short of proof leaves the pending mark, so "try again" can be done from
 * the screen.
 */
async function revokeOutcome(req: Request, id: string, mine: { seenClear: boolean; confirmedByMe: boolean }): Promise<RevokeOutcome> {
  const read = () => prisma.user.findFirst({
    where: { id, ...tenantWhere(req) }, select: { has_login: true, is_active: true, password_hash: true },
  });
  const classify = (row: Awaited<ReturnType<typeof read>>): RevokeOutcome | null => {
    if (!row) return 'gone';
    // Holding sign-in again (put back, or an Admin re-invited them: an invite mark is a re-invite on its way).
    const mark = row.password_hash ?? '';
    if ((row.has_login || mark.startsWith('invite:')) && row.is_active) return 'can_sign_in';
    if (!row.has_login && (mine.confirmedByMe || (mine.seenClear && mark === REVOKE_CONFIRMED_MARK))) return 'done';
    if (!row.is_active) return 'inactive';
    return null;
  };
  const first = classify(await read());
  if (first) return first;
  // Off, active, and not proven clear by this request: unfinished. Say so on the row (a running revoke's own mark already does),
  // even over a confirmation another revoke wrote, so the retry this answer asks for is on screen.
  await prisma.user.updateMany({
    where: { id, ...tenantWhere(req), has_login: false, is_active: true, password_hash: { in: ['', REVOKE_CONFIRMED_MARK] } },
    data: { password_hash: REVOKE_PENDING_MARK },
  });
  return classify(await read()) ?? 'unfinished';
}

/**
 * This request's provider call found no login for the person. Record it, in one conditional write, only if the row still holds
 * exactly the mark this request saw before that call: a newer revoke, a re-invite or a new sign-in since then means the answer is
 * stale, and nothing is written. Returns whether it was.
 */
async function recordRevokeConfirmed(req: Request, id: string, seenMark: string): Promise<boolean> {
  const { count } = await prisma.user.updateMany({
    where: { id, ...tenantWhere(req), has_login: false, password_hash: seenMark },
    data: { password_hash: REVOKE_CONFIRMED_MARK },
  });
  return count === 1;
}

/** Answer what is true for each outcome. */
async function answerRevoke(req: Request, res: Response, id: string, outcome: RevokeOutcome): Promise<void> {
  switch (outcome) {
    case 'done': {
      const row = await prisma.user.findFirst({ where: { id, ...tenantWhere(req) }, select: userSelect });
      if (!row) { res.status(404).json({ error: 'User not found' }); return; }
      void logAudit({ req, action: 'user.login_revoked', resourceType: 'User', resourceId: id });
      res.json({ user: await withAvatarUrl(row) });
      return;
    }
    case 'gone': res.status(404).json({ error: 'User not found' }); return; // deleted while the revoke ran
    case 'can_sign_in': res.status(502).json({ error: REVOKE_LOGIN_FAILED_MESSAGE }); return;
    case 'inactive': res.status(502).json({ error: REVOKE_LOGIN_UNFINISHED_INACTIVE_MESSAGE }); return;
    case 'unfinished': res.status(502).json({ error: REVOKE_LOGIN_UNFINISHED_MESSAGE }); return;
  }
}

// POST /api/users/:id/revoke-login — turn login OFF (idempotent). Removes the login at the identity provider + blanks the
// credential; refuses to lock out the last active admin. Security finding H2, build item 10. The row is turned off FIRST (from
// that moment every door refuses the person, and an invite acceptance racing this sees it and undoes the login it made), then the
// login is removed at the provider. "Done" only on this request's own proof the provider is clear (revokeOutcome); a failure puts
// the person back if nothing else changed them, and otherwise says the revoke is unfinished, with Revoke still on screen.
const LAST_ADMIN_REVOKE = 'Cannot remove login from the last active admin. Assign another admin first.';

export async function revokeLogin(req: Request, res: Response) {
  try {
    const existing = await prisma.user.findUnique({
      where: { id: param(req, 'id'), ...tenantWhere(req) },
      select: userSelect,
    });
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    // No one, the Owner included, revokes the Owner's sign-in (AL-16).
    if (await refuseOwnerRemoval(req, res, existing.id)) return;
    // Revoking an Admin's sign-in is the Owner's alone (ticket 26); checked again inside the write, under the company lock.
    if (await refuseUnlessOwnerFor(req, res, existing)) return;
    const readMark = () => prisma.user.findFirst({ where: { id: existing.id, ...tenantWhere(req) }, select: { has_login: true, password_hash: true } });

    let turnedOff = false;
    let mine = '';
    let held = '';
    if (existing.has_login) {
      if (await wouldRemoveLastAdmin(req, existing)) {
        res.status(409).json({ error: LAST_ADMIN_REVOKE });
        return;
      }
      // The turn-off opens with the company lock and the person read again under it: the Owner check and the last-Admin check
      // hold until it commits (ticket 26).
      await prisma.$transaction(async (tx) => {
        const locked = await lockPersonForChange(tx, req, existing.id);
        await refuseLastAdminUnderLock(tx, locked, req.user!.organization_id, true);
        // Turn the row off as a compare-and-swap on what it held, so what is put back on a failure is exactly what was replaced:
        // a resend landing between the read and the write makes the write miss, and it is read again.
        for (let attempt = 0; attempt < 3 && !turnedOff; attempt++) {
          const now = await tx.user.findFirst({ where: { id: existing.id, ...tenantWhere(req) }, select: { has_login: true, password_hash: true } });
          if (!now?.has_login) break;
          held = now.password_hash ?? '';
          mine = `${REVOKING_PREFIX}${randomUUID()}`;
          turnedOff = (await tx.user.updateMany({
            where: { id: existing.id, ...tenantWhere(req), has_login: true, password_hash: held },
            data: { has_login: false, password_hash: mine },
          })).count === 1;
        }
      });
      clearTokenCache(existing.id);
    }
    // What this request sees before its provider call. Already off (an earlier revoke, one still running, or one that could not
    // finish): idempotent, but an off row is no proof the provider is clear, so the provider is asked every time.
    const seen = await readMark();
    if (!seen) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (seen.has_login) {
      // Holding sign-in (given back, or changing too fast to turn off): their login is not touched, and they are told so.
      res.status(502).json({ error: REVOKE_LOGIN_FAILED_MESSAGE });
      return;
    }

    let seenClear = false;
    try {
      await removeProviderLogin(existing.email);
      seenClear = true;
    } catch (removeErr) {
      logger.error('Revoke login: the identity provider login could not be removed', { userId: existing.id, removeErr });
    }

    let confirmedByMe = false;
    if (seenClear) {
      confirmedByMe = await recordRevokeConfirmed(req, existing.id, seen.password_hash ?? '');
    } else if (turnedOff) {
      // Put the person back, only if nothing changed them since: a deactivation, a re-invite, an erase or another revoke has
      // rewritten this revoke's own mark.
      const restored = await prisma.user.updateMany({
        where: { id: existing.id, ...tenantWhere(req), has_login: false, is_active: true, password_hash: mine },
        data: { has_login: true, password_hash: held },
      });
      if (restored.count === 1) clearTokenCache(existing.id);
    }
    await answerRevoke(req, res, existing.id, await revokeOutcome(req, existing.id, { seenClear, confirmedByMe }));
  } catch (err) {
    if (answerChangeRefusal(req, res, err, LAST_ADMIN_REVOKE)) return;
    logger.error('Revoke login error:', err);
    res.status(500).json({ error: 'Failed to revoke login' });
  }
}

// PATCH /api/users/me — self-service profile edit (whitelisted fields only).
export async function updateMe(req: Request, res: Response) {
  try {
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: req.body,
      select: userSelect,
    });
    clearTokenCache(req.user!.id);
    void logAudit({ req, action: 'user.profile_updated', resourceType: 'User', resourceId: req.user!.id, metadata: { fields: Object.keys(req.body) } });
    res.json({ user: await withAvatarUrl(user) });
  } catch (err) {
    logger.error('Update me error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
}

/** The change form needs a current password; a Google-only user has none (spec §4.1, slice 06). */
export const NO_PASSWORD_MESSAGE =
  "You sign in with Google and don't have a password yet. Use Set a password by email on Login & Security.";

/**
 * GET /api/users/me/password-status — `{ has_password }` for the Login & Security card, decided on
 * the server from the verified token's account (lib/password-presence.ts). Nothing else: no auth
 * id, no sign-in method list.
 */
export async function getMyPasswordStatus(req: Request, res: Response) {
  try {
    res.json({ has_password: await userHasPassword(req.user!) });
  } catch (err) {
    logger.error('Password status error', { name: err instanceof Error ? err.name : typeof err });
    res.status(500).json({ error: 'Could not load your sign-in details' });
  }
}

/**
 * Runs before POST /me/password's validation, so a user with no password gets this message, not a
 * "current password required" error or a re-check against an empty password.
 */
export async function refuseWithoutPassword(req: Request, res: Response, next: () => void) {
  try {
    if (!(await userHasPassword(req.user!))) {
      res.status(400).json({ error: NO_PASSWORD_MESSAGE, code: 'no_password' });
      return;
    }
  } catch (err) {
    // userHasPassword does not throw; if it ever does, the change path's own checks still apply.
    logger.warn('Password presence check threw', { name: err instanceof Error ? err.name : typeof err });
  }
  next();
}

// POST /api/users/me/password — self-service password change for login-enabled users
// (password reset spec §4.2). Every outcome the browser sees is ServWave copy: the provider's
// own messages are mapped by lib/auth-provider-errors.ts and only logged.
export async function changeMyPassword(req: Request, res: Response) {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { has_login: true, email: true },
    });
    // The auth id comes from the VERIFIED token (authenticate), never from input or an email search.
    const authId = req.user!.auth_id;
    if (!me || !me.has_login || !authId) {
      res.status(400).json({ error: 'Login is not enabled for your account' });
      return;
    }
    // SECURITY (review #4): re-authenticate with the CURRENT password before changing it, so a
    // momentarily-stolen session can't be turned into a permanent takeover. It runs on a fresh,
    // non-persisting client made for this request alone: a signInWithPassword writes a session
    // into the client that ran it, and neither supabaseAdmin (Storage RLS) nor the shared
    // supabaseAuth (other requests) may hold one — see lib/supabase.ts.
    const { error: reauthError } = await createIsolatedAuthClient().auth.signInWithPassword({
      email: me.email,
      password: req.body.current_password,
    });
    if (reauthError) {
      res.status(400).json({ error: 'Current password is incorrect.', code: 'current_password_incorrect' });
      return;
    }

    // Decision §9.2: every OTHER session is signed out, this device stays signed in. The password is
    // set AS this device's session (lib/auth-own-session.ts): the provider then ends every other
    // session, the re-check's above included, in the same step, and keeps this one. The admin update
    // ends this device's session too (#2866 staging check), so it is only the fallback for a provider
    // that wants a fresher sign-in first, and then the answer says this device was signed out.
    const jwt = bearerToken(req);
    let updateError: unknown;
    let usedAdminUpdate = false;
    try {
      if (jwt) {
        ({ error: updateError } = await updatePasswordAsOwnSession(jwt, {
          password: req.body.password,
          currentPassword: req.body.current_password,
        }));
      }
      if (!jwt || needsFreshSignInError(updateError)) {
        usedAdminUpdate = true;
        ({ error: updateError } = await supabaseAdmin.auth.admin.updateUserById(authId, { password: req.body.password }));
      }
    } catch (err) {
      updateError = err;
    }
    if (updateError) {
      const mapped = mapPasswordUpdateError(updateError, 'change-password', { userId: req.user!.id });
      res.status(mapped.status).json(mapped.body);
      return;
    }

    // Confirm with the provider, then drop the 60 s identity cache so a revoked token can't keep
    // working from it.
    const { othersSignedOut, thisDeviceSignedOut } = await signOutOtherSessions(req, jwt);
    clearTokenCache(req.user!.id);
    if (usedAdminUpdate) {
      logger.info('Password changed with the admin update; every session was ended', { userId: req.user!.id });
    }

    void logAudit({
      req,
      action: 'user.password_changed',
      resourceType: 'User',
      resourceId: req.user!.id,
      metadata: { other_sessions_signed_out: othersSignedOut, this_device_signed_out: thisDeviceSignedOut },
    });
    // Still 200: the password DID change. The flags let the page tell the truth: about the other
    // devices, instead of promising a sign-out that did not happen, and about this one, so a device
    // whose session ended is sent to sign in rather than bounced there on its next page.
    res.json({
      message: 'Password updated',
      other_sessions_signed_out: othersSignedOut,
      this_device_signed_out: thisDeviceSignedOut,
    });
    emit({
      verb: 'security.password_changed',
      organizationId: req.user!.organization_id,
      actorId: null,
      object: { type: 'USER', id: req.user!.id },
      entity: { user_id: req.user!.id },
      data: { object_label: req.user!.first_name || req.user!.email },
    }).catch((err) => logger.warn('notification emit failed', err));
  } catch (err) {
    logger.error('Change my password error:', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
}

function errorShape(err: unknown): { name: string; status: number | undefined } {
  return {
    name: err instanceof Error ? err.name : typeof err,
    status: (err as { status?: number } | null)?.status,
  };
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.substring(7) : undefined;
}

/**
 * After the password changed: end every session of the caller except the one whose JWT made this
 * request, and report what is true afterwards. The password is already changed when this runs, so
 * a failure (after one retry) is logged and reported, never turned into an error the user would
 * read as "your password did not change".
 *
 * - The sign-out works: the other sessions are gone (normally the provider already ended them in
 *   the password update itself) and this one is alive.
 * - The provider says this request's own session no longer exists: in this request only the
 *   provider's admin password update ends it, and that ends every session of the user. So every
 *   session, this one included, is gone.
 * - Anything else: unconfirmed, so the page must not claim the others were signed out.
 */
async function signOutOtherSessions(
  req: Request,
  jwt: string | undefined,
): Promise<{ othersSignedOut: boolean; thisDeviceSignedOut: boolean }> {
  const unconfirmed = { othersSignedOut: false, thisDeviceSignedOut: false };
  if (!jwt) return unconfirmed;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await supabaseAdmin.auth.admin.signOut(jwt, 'others');
      if (!result?.error) return { othersSignedOut: true, thisDeviceSignedOut: false };
      if (isSessionMissingError(result.error)) return { othersSignedOut: true, thisDeviceSignedOut: true };
      // Name and status only: a provider error's message or a thrown error may quote the token back.
      logger.error('Sign out of other sessions failed after a password change', {
        userId: req.user!.id, attempt, ...errorShape(result.error),
      });
    } catch (err) {
      logger.error('Sign out of other sessions threw after a password change', {
        userId: req.user!.id, attempt, ...errorShape(err),
      });
    }
  }
  return unconfirmed;
}

/**
 * POST /api/users/:id/make-owner (ticket 27, D1): the Owner asks to hand the company to this person. Nothing changes: the
 * CURRENT Owner is emailed a one-time approval link (lib/users/owner-handover.ts), and the link is never in this answer.
 * `requireOwner` has already refused anyone else; the request repeats that check under the company lock.
 */
export async function requestMakeOwner(req: Request, res: Response) {
  try {
    const outcome = await requestOwnerHandover({ organizationId: req.user!.organization_id, actorId: req.user!.id, targetId: String(req.params.id ?? '') });
    switch (outcome.kind) {
      case 'not_owner':
        answerOwnerOnly(req, res, null);
        return;
      case 'not_found':
        res.status(404).json({ error: 'User not found' });
        return;
      case 'not_a_candidate':
        res.status(409).json({ error: NOT_AN_OWNER_CANDIDATE });
        return;
      case 'sent':
        if (!outcome.emailSent) {
          res.status(502).json({ error: "We couldn't send the approval email. Try again." });
          return;
        }
        res.json({ email_sent: true });
    }
  } catch (err) {
    logger.error('Make Owner request failed', { name: err instanceof Error ? err.name : typeof err });
    res.status(500).json({ error: "We couldn't start the hand-over. Try again." });
  }
}
