/**
 * M3 (ticket 29): THE TWO SHAPES OF A PERSON ON A PEOPLE LIST.
 *
 * Only an Admin (the `is_admin` flag, read the way every Admin-only route reads it) gets a colleague's full record:
 * email, phone, the Admin flag, role, sign-in state, mailbox. Everyone else gets the names-only row below, so the
 * people list is never a ready target list of every colleague's login address and of who the Admins are.
 *
 * Every lane that LISTS people answers through here: the people list (`GET /api/users`), a person's details
 * (`GET /api/users/:id`) and the communication team list (`GET /api/communication/team-members`). The source guard
 * `permission-people-names-only-guard.test.ts` fails when a new response reads a person's contact fields without
 * going through this module or being named, with its reason, on that guard's allow-list.
 *
 * NOT here, by ruling (Q2, Q4, logged for Ran): people already ON a record (a job's crew, dispatcher and salesperson,
 * a lead's walkthrough crew, owner and dispatcher, a purchase order's orderer, a phone agent's person) keep their
 * fields, because the call and email actions on those records use them. The assignee picker
 * (`GET /api/users/assignable`) keeps its own picker row.
 */
import type { Request } from 'express';
import { prisma } from '../prisma';
import { isSuperUser } from '../permissions/effectiveRole';

/** Does this requester get colleagues' full records? Only an Admin. */
export function seesFullPeopleRecords(req: Request): boolean {
  return Boolean(req.user && isSuperUser(req.user));
}

/** What the database is asked for when the answer is names-only: nothing more is ever read. */
export const namesOnlySelect = {
  id: true,
  first_name: true,
  last_name: true,
  avatar_path: true,
  is_active: true,
} as const;

/** A person as a non-Admin sees them on a people list (ruling Q1): id, name, avatar and whether they are active. */
export type NamesOnlyPerson = {
  id: string;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  is_active: boolean;
};

/** The names-only row, built field by field so nothing else on the input can ride along. */
export function namesOnly(row: NamesOnlyPerson): NamesOnlyPerson {
  return { id: row.id, first_name: row.first_name, last_name: row.last_name, avatar_url: row.avatar_url, is_active: row.is_active };
}

/** A member of the communication team list as a non-Admin sees them (ruling Q1): id, name, online. */
export type NamesOnlyTeamMember = { id: string; name: string; online: boolean };

export function namesOnlyTeamMember(row: { id: string; first_name: string; last_name: string; is_active: boolean }): NamesOnlyTeamMember {
  return { id: row.id, name: `${row.first_name} ${row.last_name}`.trim(), online: row.is_active };
}

/**
 * Re-audit N6: a record's history (an estimate's History tab, a purchase order's Activity) names who did each thing. An Admin
 * gets the row as it is stored; anyone else gets the person's name and never their login address, nor the address and browser
 * they called from (the parked L2). Names are read inside the caller's company, by the actor's id; a person since deleted,
 * or a system action, has no name.
 */
export async function actorNamesById(req: Request, ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string'))];
  if (wanted.length === 0 || !req.user) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: wanted }, organization_id: req.user.organization_id },
    select: { id: true, first_name: true, last_name: true },
  });
  return new Map((rows ?? []).map((r) => [r.id, `${r.first_name} ${r.last_name}`.trim()]));
}

/** One history row as a non-Admin sees it: what happened, when, and who by name. No address, browser, or internal ids. */
export type HistoryRowForNonAdmin = { id: string; action: string; metadata: unknown; created_at: Date; actor_name: string | null };

export function historyRowForNonAdmin(
  row: { id: string; action: string; metadata: unknown; created_at: Date; actor_id: string | null },
  names: Map<string, string>,
): HistoryRowForNonAdmin {
  return { id: row.id, action: row.action, metadata: row.metadata, created_at: row.created_at, actor_name: row.actor_id ? names.get(row.actor_id) ?? null : null };
}
