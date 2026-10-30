import type { Request } from 'express';
import { prisma } from '../prisma';
import { MATCH_NOTHING } from './scopeWhereFor';
import { resolveSwitches, type SwitchSubject } from './switches/store';

/**
 * The reach of a module that is not a record anchor (Roles & Permissions P6, A8a): Tasks, Events (calendar entries),
 * Stock's assets and Time tracking's timesheets each have ONE scope switch with the standard choices, and this is the
 * single place that turns the person's value into the rows it reaches.
 *
 *   Attached  the rows the person is one of the people on (P7: attached, not "created"):
 *               Task            assignee or watcher;
 *               CalendarEntry   a USER participant (the creator is deliberately not one);
 *               Asset           the person holding it (its assigned user);
 *               Timesheet       the person whose time it is (a time entry or an overtime review).
 *   Team      the same, for any person in the signed-in person's department. A person with no department matches nothing
 *             (P3, fail closed), exactly as the record anchors do.
 *   All       every row.
 *   anything else reaches nothing.
 *
 * The answer is the set of people whose rows count, or "every row", read from the person's switches on every call (the
 * switch cache is cleared on any change, so a change shows on the next request). Both the SQL fragment a list is built
 * from and the in-memory test a single loaded row is judged by come from it, so the two cannot disagree.
 */
export type ReachSubject = 'Task' | 'CalendarEntry' | 'Asset' | 'Timesheet';

export const REACH_SCOPE_KEY: Record<ReachSubject, string> = {
  Task: 'tasks_scope',
  CalendarEntry: 'events_scope',
  Asset: 'assets_scope',
  Timesheet: 'timesheets_scope',
};

/**
 * Every row, or only the rows these people are on. An empty list reaches nothing. `scope` says which choice the people
 * came from ('none' for a value the resolver does not know), for the one caller that must tell Attached from Team.
 */
export type ModuleReach =
  | { kind: 'all' }
  | { kind: 'people'; scope: 'attached' | 'team' | 'none'; ids: readonly string[] };

export type ReachUser = SwitchSubject & { department_id?: string | null };

/** The people of a department, as ids; everyone in it, deactivated people included (their rows are still the team's). */
export async function departmentMemberIds(organizationId: string, departmentId: string | null | undefined): Promise<string[]> {
  if (!departmentId) return [];
  const rows = await prisma.user.findMany({ where: { organization_id: organizationId, department_id: departmentId }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** What a scope value reaches for this person; the value comes from their resolved switches. */
export async function reachForScope(user: ReachUser, scope: unknown): Promise<ModuleReach> {
  if (scope === 'all') return { kind: 'all' };
  if (scope === 'attached') return { kind: 'people', scope: 'attached', ids: [user.id] };
  if (scope === 'team') return { kind: 'people', scope: 'team', ids: await departmentMemberIds(user.organization_id, user.department_id) };
  return { kind: 'people', scope: 'none', ids: [] };
}

export async function moduleReachOf(user: ReachUser, subject: ReachSubject): Promise<ModuleReach> {
  const values = await resolveSwitches(user);
  return reachForScope(user, values[REACH_SCOPE_KEY[subject]]);
}

const perRequest = new WeakMap<Request, Map<ReachSubject, Promise<ModuleReach>>>();

/** The signed-in person's reach, asked once per request however many readers of the module ask. */
export function moduleReachFor(req: Request, subject: ReachSubject): Promise<ModuleReach> {
  let asked = perRequest.get(req);
  if (!asked) perRequest.set(req, (asked = new Map()));
  let answer = asked.get(subject);
  if (!answer) asked.set(subject, (answer = req.user ? moduleReachOf(req.user, subject) : Promise.resolve({ kind: 'people', scope: 'none', ids: [] } as ModuleReach)));
  return answer;
}

/** Does the reach cover a row whose people are these? "All" covers every row, even one with nobody on it. */
export function reachCovers(reach: ModuleReach, rowPeople: readonly string[]): boolean {
  if (reach.kind === 'all') return true;
  return rowPeople.some((id) => reach.ids.includes(id));
}

type Where = Record<string, unknown>;

/** The Prisma `where` fragment for the rows a reach covers: `{}` for every row, a match-nothing fragment for nobody. */
export function reachWhere(subject: ReachSubject, reach: ModuleReach): Where {
  if (reach.kind === 'all') return {};
  if (reach.ids.length === 0) return { ...MATCH_NOTHING };
  const ids = [...reach.ids];
  switch (subject) {
    case 'Task':
      return { OR: [{ assignee_ids: { hasSome: ids } }, { watcher_ids: { hasSome: ids } }] };
    case 'CalendarEntry':
      return { participants: { some: { kind: 'USER', user_id: { in: ids } } } };
    case 'Asset':
      return { assigned_user_id: { in: ids } };
    case 'Timesheet':
      return { user_id: { in: ids } };
  }
}
