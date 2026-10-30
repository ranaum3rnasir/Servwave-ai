import { Prisma, type CustomRole } from '@prisma/client';
import { prisma } from '../../prisma';
import { grantRoleKey, isSuperUser, slugifyRoleKey, type RoleBearer } from '../effectiveRole';
import { nameTakenMessage, roleNameRefusal } from '../roleName';
import type { Grant } from '../defineAbility';
import {
  SCOPE_SWITCH_KEY,
  SWITCH_CATALOG,
  findSwitch,
  isBuiltInRole,
  sameSwitchValue,
  type BuiltInRole,
  type GrantSpec,
  type SwitchEntry,
  type SwitchValue,
} from './catalog';
import { FIXED_GRANTS } from '../fixedGrants';
import { customerReach, logisticOrderReach, orderOnJobReach, scopeReach } from '../recordPeople';
import { validateSwitchSet, type SwitchSetViolation } from './validate';
import {
  clearSwitchCacheForOrg,
  clearSwitchCacheForUser,
  getCachedSwitches,
  setCachedSwitches,
  type ResolvedSwitches,
} from './cache';

/**
 * M2 - the per-person switch store (Roles & Permissions, PRD 1).
 *
 * A role holds a stored value for each switch it was given, a person holds their own, and each
 * person remembers the role they were last given (`users.based_on_role_key`). Resolution, per switch:
 *
 *   1. the person's own stored value;
 *   2. else the value of the role they are based on (its stored value);
 *   3. else the preset of that role's built-in base - a built-in role is its own base, a custom role
 *      uses the base role it records, and a role made from blank has none, so the switch is off.
 *
 * Giving a person a role copies that role's current values into their set once; editing the role
 * afterwards never touches them. The built-in Admin role (no custom role) is one box with every
 * switch on and no stored set.
 */

/** The slice of a person the store needs; `req.user` satisfies it. */
export interface SwitchSubject extends RoleBearer {
  id: string;
  organization_id: string;
}

/** Why a value changed; the last column of the change log. */
export type ChangeReason = 'manual' | 'role assigned' | 'reset' | 'save as role' | 'migration';

/** Raised when a write names a switch the catalog does not hold. */
export class UnknownSwitchError extends Error {
  constructor(key: string) {
    super(`Unknown permission switch: ${key}`);
    this.name = 'UnknownSwitchError';
  }
}

/** Raised when a write would store a set that breaks the row rule or a switch's Requires, or holds a bad value. */
export class InvalidSwitchSetError extends Error {
  constructor(readonly violations: SwitchSetViolation[]) {
    super(violations.map((v) => v.message).join(' '));
    this.name = 'InvalidSwitchSetError';
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

/** Every switch's value for a built-in role's preset, or for no role at all (the blank set: everything off or narrowest). */
export function presetValues(role: BuiltInRole | null): ResolvedSwitches {
  const out: ResolvedSwitches = {};
  // A role with no built-in base takes the narrowest value of every switch: off for an on/off switch,
  // the first (narrowest) choice for a choice switch, no members for a list switch.
  for (const s of SWITCH_CATALOG) {
    out[s.key] = role ? s.presets[role] : s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false;
  }
  return out;
}

/**
 * The built-in preset a role falls back to, given the custom role row it is stored as (if any): itself if built-in,
 * else the base it records, or none if made from blank. A key with no row falls back to the person's own base role.
 * The one rule for it: the single-role read below and the many-people read share it, so they cannot drift.
 */
function presetRoleOf(
  roleKey: string,
  custom: { base_role: string; made_from_blank: boolean } | null | undefined,
  userBaseRole: string,
): BuiltInRole | null {
  if (isBuiltInRole(roleKey)) return roleKey;
  if (!custom) return isBuiltInRole(userBaseRole) ? userBaseRole : null;
  return custom.made_from_blank ? null : isBuiltInRole(custom.base_role) ? custom.base_role : null;
}

/** The built-in preset a role falls back to: itself if built-in, else its recorded base, or none if made from blank. */
async function presetRoleFor(
  db: Db,
  organizationId: string,
  roleKey: string,
  userBaseRole: string,
): Promise<BuiltInRole | null> {
  if (isBuiltInRole(roleKey)) return roleKey;
  const custom = await db.customRole.findFirst({
    where: { organization_id: organizationId, key: roleKey },
    select: { base_role: true, made_from_blank: true },
  });
  return presetRoleOf(roleKey, custom, userBaseRole);
}

const asValue = (v: Prisma.JsonValue): SwitchValue | undefined => {
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  return Array.isArray(v) && v.every((m) => typeof m === 'string') ? (v as string[]) : undefined;
};

/** Lays stored rows over a set of values, in place; a row for a switch the catalog no longer holds, or a bad value, is ignored. */
function overlayStored(values: ResolvedSwitches, rows: { switch_key: string; value: Prisma.JsonValue }[]): ResolvedSwitches {
  for (const r of rows) {
    const v = asValue(r.value);
    if (v !== undefined && r.switch_key in values) values[r.switch_key] = v;
  }
  return values;
}

/** A role's effective value for every switch: its stored value, else its preset. */
async function roleValues(
  db: Db,
  organizationId: string,
  roleKey: string,
  userBaseRole: string,
): Promise<ResolvedSwitches> {
  const [rows, base] = await Promise.all([
    db.permissionRoleSwitch.findMany({
      where: { organization_id: organizationId, role_key: roleKey },
      select: { switch_key: true, value: true },
    }),
    presetRoleFor(db, organizationId, roleKey, userBaseRole),
  ]);
  return overlayStored(presetValues(base), rows);
}

/**
 * A role's current value for every switch (its stored value, else the preset of its built-in base). The role is
 * only read, so a caller that copies it (a new role made from it) never ties the copy to the source.
 */
export async function resolveRoleSwitchValues(organizationId: string, roleKey: string, userBaseRole: string): Promise<ResolvedSwitches> {
  return roleValues(prisma, organizationId, roleKey, userBaseRole);
}

/**
 * The person's resolved value for every switch in the catalog (see the resolution order above).
 *
 * The subject names WHO is asked about; which role they sit on is read from the stored person, never
 * from the subject. A caller may hold a partial user row (selected without the custom role), and a
 * role read from it would be the base role: the base preset would then sit in the cache under that
 * person's id and be handed to their own next request. The cache therefore only ever holds values
 * resolved from the stored person; a subject with no stored person is answered but never cached.
 */
export async function resolveSwitches(user: SwitchSubject): Promise<ResolvedSwitches> {
  // The Admin box is full access with no stored set. An admin-derived custom role is not the box.
  if (isSuperUser(user)) return presetValues('ADMIN');
  const cached = getCachedSwitches(user.id);
  if (cached) return cached;

  const [person, own] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { role: true, based_on_role_key: true, custom_role_id: true, custom_role: { select: { key: true } } },
    }),
    prisma.permissionUserSwitch.findMany({ where: { user_id: user.id }, select: { switch_key: true, value: true } }),
  ]);
  const stored: RoleBearer = person ?? user;
  const basedOn = person?.based_on_role_key ?? grantRoleKey(stored);
  const values = overlayStored(await roleValues(prisma, user.organization_id, basedOn, stored.role), own);
  if (person) setCachedSwitches(user.id, user.organization_id, values);
  return values;
}

/**
 * The built-in preset a person starts from: the preset behind the role they are based on (itself if built-in, else the
 * base a custom role records, none if it was made from blank). A role records its base when it is made, copied from
 * the role it was made from, so this already follows a chain of roles back to a preset: a role whose source was
 * archived or deleted keeps the base it recorded, and no chain is walked that could loop. The built-in Admin box is
 * the Admin preset. Used for the default dashboard layout.
 */
export async function presetRoleOfPerson(user: SwitchSubject): Promise<BuiltInRole | null> {
  if (isSuperUser(user)) return 'ADMIN';
  const person = await prisma.user.findUnique({
    where: { id: user.id },
    select: { role: true, based_on_role_key: true, custom_role_id: true, custom_role: { select: { key: true } } },
  });
  const stored: RoleBearer = person ?? user;
  return presetRoleFor(prisma, user.organization_id, person?.based_on_role_key ?? grantRoleKey(stored), stored.role);
}

/** One role a person is read against: the key it is stored under, and the base role the person carries. */
interface RoleRead {
  roleKey: string;
  userBaseRole: string;
}

const roleReadKey = (r: RoleRead) => `${r.roleKey}\u0000${r.userBaseRole}`;

/**
 * Many roles' effective values in two reads however many roles there are: the stored rows of every role asked about,
 * and the custom roles they name. Each role's values come out by the same rule `roleValues` applies to one
 * (`presetRoleOf`, then `overlayStored`), keyed by `roleReadKey`. `keys` narrows the stored rows read to those switches.
 */
async function roleValuesForMany(
  organizationId: string,
  reads: RoleRead[],
  keys?: readonly string[],
): Promise<{ values: Map<string, ResolvedSwitches>; customLabels: Map<string, string> }> {
  const roleKeys = [...new Set(reads.map((r) => r.roleKey))];
  const customKeys = roleKeys.filter((k) => !isBuiltInRole(k));
  const [rows, customRoles] = await Promise.all([
    prisma.permissionRoleSwitch.findMany({
      where: { organization_id: organizationId, role_key: { in: roleKeys }, ...(keys ? { switch_key: { in: [...keys] } } : {}) },
      select: { role_key: true, switch_key: true, value: true },
    }),
    customKeys.length
      ? prisma.customRole.findMany({
          where: { organization_id: organizationId, key: { in: customKeys } },
          select: { key: true, label: true, base_role: true, made_from_blank: true },
        })
      : Promise.resolve([]),
  ]);
  const rowsByRole = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!rowsByRole.has(r.role_key)) rowsByRole.set(r.role_key, []);
    rowsByRole.get(r.role_key)!.push(r);
  }
  const customByKey = new Map(customRoles.map((c) => [c.key, c]));
  const values = new Map<string, ResolvedSwitches>();
  for (const read of reads) {
    const readKey = roleReadKey(read);
    if (values.has(readKey)) continue;
    const base = presetRoleOf(read.roleKey, customByKey.get(read.roleKey), read.userBaseRole);
    values.set(readKey, overlayStored(presetValues(base), rowsByRole.get(read.roleKey) ?? []));
  }
  return { values, customLabels: new Map(customRoles.map((c) => [c.key, c.label])) };
}

/**
 * Many people's resolved switches at once, for people of any number of companies, in a constant number of reads per
 * company (the people, their own rows, their roles' rows, the custom roles they name) however many people there are.
 * The answer for each person is the one `resolveSwitches` gives them: the Admin box holds every switch on, else the
 * person's own stored value, else the value of the role they are based on, else that role's preset. The role is read
 * from the stored person, never from the subject, so a partial row (selected without its custom role's key) cannot
 * answer with the wrong role.
 *
 * `keys` asks about named switches only: the answer is then read fresh from the database and holds just those
 * switches (the roster and alert lookups, which are always current). Without `keys` the answer is every switch, and
 * the per-person cache is used exactly as `resolveSwitches` uses it: a cached person is answered from it, and a
 * stored person read here is cached for the same 60 seconds, so a change to a person or a role shows no later than it
 * does for a single request.
 */
export async function resolveSwitchesForPeople(
  people: SwitchSubject[],
  keys?: readonly string[],
): Promise<Map<string, ResolvedSwitches>> {
  keys?.forEach(entryFor);
  const pick = (values: ResolvedSwitches): ResolvedSwitches =>
    keys ? Object.fromEntries(keys.map((k) => [k, values[k]!])) : values;
  const out = new Map<string, ResolvedSwitches>();
  const toRead = new Map<string, SwitchSubject>();
  for (const person of people) {
    if (out.has(person.id) || toRead.has(person.id)) continue;
    if (isSuperUser(person)) {
      out.set(person.id, pick(presetValues('ADMIN')));
      continue;
    }
    const cached = keys ? null : getCachedSwitches(person.id);
    if (cached) out.set(person.id, cached);
    else toRead.set(person.id, person);
  }
  const byOrganization = new Map<string, SwitchSubject[]>();
  for (const person of toRead.values()) {
    if (!byOrganization.has(person.organization_id)) byOrganization.set(person.organization_id, []);
    byOrganization.get(person.organization_id)!.push(person);
  }
  for (const [organizationId, group] of byOrganization) {
    const ids = group.map((p) => p.id);
    const [storedRows, own] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, role: true, based_on_role_key: true, custom_role_id: true, custom_role: { select: { key: true } } },
      }),
      prisma.permissionUserSwitch.findMany({
        where: { user_id: { in: ids }, ...(keys ? { switch_key: { in: [...keys] } } : {}) },
        select: { user_id: true, switch_key: true, value: true },
      }),
    ]);
    const storedById = new Map(storedRows.map((r) => [r.id, r]));
    const ownByUser = new Map<string, typeof own>();
    for (const r of own) {
      if (!ownByUser.has(r.user_id)) ownByUser.set(r.user_id, []);
      ownByUser.get(r.user_id)!.push(r);
    }
    const readOf = (person: SwitchSubject): RoleRead => {
      const stored: RoleBearer = storedById.get(person.id) ?? person;
      return { roleKey: storedById.get(person.id)?.based_on_role_key ?? grantRoleKey(stored), userBaseRole: stored.role };
    };
    const { values: roleSets } = await roleValuesForMany(organizationId, group.map(readOf), keys);
    for (const person of group) {
      const values = overlayStored({ ...roleSets.get(roleReadKey(readOf(person)))! }, ownByUser.get(person.id) ?? []);
      // A person with no stored row is answered but never cached (see `resolveSwitches`).
      if (!keys && storedById.has(person.id)) setCachedSwitches(person.id, organizationId, values);
      out.set(person.id, pick(values));
    }
  }
  return out;
}

/** The reach a grant's `scoped` kind gives a person, from their resolved values; `null` reaches nothing. */
function reachOf(scoped: NonNullable<GrantSpec['scoped']>, values: ResolvedSwitches): ({ conditions?: Record<string, unknown> } | null)[] | null {
  const jobsScope = values[SCOPE_SWITCH_KEY.Job];
  const leadsScope = values[SCOPE_SWITCH_KEY.Lead];
  switch (scoped) {
    case 'Customer':
      return customerReach(leadsScope, jobsScope);
    case 'PurchaseOrder':
    case 'LogisticOrderOnJob':
      return orderOnJobReach(values.view_jobs, jobsScope);
    case 'LogisticOrder':
      return logisticOrderReach({ jobs: values.view_jobs, leads: values.view_leads }, { jobs: jobsScope, leads: leadsScope });
    default:
      return [scopeReach(scoped, values[SCOPE_SWITCH_KEY[scoped]])];
  }
}

/**
 * The ability-layer grants a person's resolved values compile into, through the catalog. A grant
 * that acts on records is narrowed to the records the person's Data Scope for that subject reaches
 * (a customer, which has no scope of its own, to the customers of the leads and jobs they reach);
 * a Data Scope value the resolver does not know reaches nothing, so its grants are left out.
 */
export function compileSwitchGrants(values: ResolvedSwitches): Grant[] {
  const grants: Grant[] = [];
  for (const s of SWITCH_CATALOG) {
    if (values[s.key] !== true) continue;
    for (const g of s.grants) {
      if (!g.scoped) {
        grants.push({ action: g.action, subject: g.subject });
        continue;
      }
      const reaches = reachOf(g.scoped, values);
      for (const reach of reaches ?? []) {
        if (!reach) continue;
        grants.push(reach.conditions ? { action: g.action, subject: g.subject, conditions: reach.conditions } : { action: g.action, subject: g.subject });
      }
    }
  }
  return grants;
}

/** The grants a person's switches compile into; empty for the Admin box, which holds `manage all`. */
export async function switchGrantsForUser(user: SwitchSubject): Promise<Grant[]> {
  if (isSuperUser(user)) return [];
  return compileSwitchGrants(await resolveSwitches(user));
}

/**
 * A person's grants, from one source: what their switches compile into, plus the fixed reads every signed-in
 * person holds. The role-permission and per-person override tables are no longer read, so the ability, the row
 * scopes and the client's rules cannot disagree. Empty for the Admin box, which holds `manage all`.
 */
export async function grantsForPerson(user: SwitchSubject): Promise<Grant[]> {
  if (isSuperUser(user)) return [];
  return [...FIXED_GRANTS, ...(await switchGrantsForUser(user))];
}

function entryFor(key: string): SwitchEntry {
  const entry = findSwitch(key);
  if (!entry) throw new UnknownSwitchError(key);
  return entry;
}

type LogRow = Prisma.PermissionChangeLogCreateManyInput;

function logRow(
  base: Pick<LogRow, 'organization_id' | 'target_type' | 'target_id' | 'actor_id' | 'reason' | 'role_label'>,
  switchKey: string,
  from: SwitchValue,
  to: SwitchValue,
): LogRow {
  return { ...base, switch_key: switchKey, from_value: from, to_value: to };
}

/**
 * Store values on a role. Only values that change what the role holds are logged (one entry per
 * changed switch). A role's people are never touched; their cached values are dropped so the change
 * shows on the next request for anyone who falls back to the role.
 *
 * Returns the value the role holds for every switch once this is stored, built from what the write already read: a
 * route answers with it and reads nothing after the commit (see `personSetAfter`).
 */
export async function setRoleSwitchValues(args: {
  organizationId: string;
  roleKey: string;
  values: Record<string, SwitchValue>;
  actorId: string | null;
  reason: ChangeReason;
  /** The role's base built-in role as users.role records it, for a custom role that no longer resolves. */
  userBaseRole?: string;
  /**
   * The whole set is copied from a role or person that holds it (a new role made from a role, Save as role).
   * The only write that may store a kept scope value the target does not hold yet.
   */
  copiedFromHolder?: boolean;
  /**
   * Edit or reset of a role that has people on it: a person who holds no value of their own for a switch that changes
   * keeps the value they had, so the edit never reaches them. Left off for a role that has just been made.
   */
  pinPeople?: boolean;
}): Promise<ResolvedSwitches> {
  const keys = Object.keys(args.values);
  keys.forEach(entryFor);
  const before = await roleValues(prisma, args.organizationId, args.roleKey, args.userBaseRole ?? '');
  // The set the role would hold after this write must pass the catalog validator; nothing is stored if not.
  // A kept scope value is accepted only where the role already holds it, unless the set is a copy of a holder's.
  const violations = validateSwitchSet({ ...before, ...args.values }, args.copiedFromHolder ? {} : { held: before });
  if (violations.length) throw new InvalidSwitchSetError(violations);
  const base = {
    organization_id: args.organizationId, target_type: 'ROLE', target_id: args.roleKey,
    actor_id: args.actorId, reason: args.reason,
  };
  await prisma.$transaction(async (tx) => {
    for (const key of keys) {
      const value = args.values[key]!;
      await tx.permissionRoleSwitch.upsert({
        where: { organization_id_role_key_switch_key: { organization_id: args.organizationId, role_key: args.roleKey, switch_key: key } },
        create: { organization_id: args.organizationId, role_key: args.roleKey, switch_key: key, value },
        update: { value },
      });
    }
    const changed = keys.filter((k) => !sameSwitchValue(before[k], args.values[k]));
    if (changed.length) {
      await tx.permissionChangeLog.createMany({ data: changed.map((k) => logRow(base, k, before[k]!, args.values[k]!)) });
      if (args.pinPeople) await pinPeopleOnRole(tx, args.organizationId, args.roleKey, changed, before);
    }
  });
  clearSwitchCacheForOrg(args.organizationId);
  return { ...before, ...args.values };
}

/** Who is on a role: those based on it, and those who have never been given a based-on role and sit on it by their role. */
function peopleOnRole(organizationId: string, roleKey: string): Prisma.UserWhereInput {
  return {
    organization_id: organizationId,
    OR: [
      { based_on_role_key: roleKey },
      { based_on_role_key: null, custom_role: { key: roleKey } },
      ...(isBuiltInRole(roleKey) ? [{ based_on_role_key: null, custom_role_id: null, role: roleKey }] : []),
    ],
  };
}

/**
 * Give each person on the role their own copy of the value the role held for these switches, where they hold none. A
 * person with no stored value for a switch falls back to their role, so without this a change to the role would
 * reach them; with it, only the role changes.
 */
async function pinPeopleOnRole(
  tx: Prisma.TransactionClient,
  organizationId: string,
  roleKey: string,
  switchKeys: string[],
  roleBefore: ResolvedSwitches,
): Promise<void> {
  const people = await tx.user.findMany({ where: peopleOnRole(organizationId, roleKey), select: { id: true } });
  if (!people.length) return;
  const held = await tx.permissionUserSwitch.findMany({
    where: { user_id: { in: people.map((p) => p.id) }, switch_key: { in: switchKeys } },
    select: { user_id: true, switch_key: true },
  });
  const heldPairs = new Set(held.map((r) => `${r.user_id}\u0000${r.switch_key}`));
  const data = people.flatMap((p) =>
    switchKeys
      .filter((k) => !heldPairs.has(`${p.id}\u0000${k}`))
      .map((k) => ({ organization_id: organizationId, user_id: p.id, switch_key: k, value: roleBefore[k]! })),
  );
  if (data.length) await tx.permissionUserSwitch.createMany({ data, skipDuplicates: true });
}

/** Edit a role's switches. The people on it are not touched (see `pinPeople`). Returns the values the role now holds. */
export async function editRoleSwitchValues(args: {
  organizationId: string;
  roleKey: string;
  values: Record<string, SwitchValue>;
  actorId: string | null;
  userBaseRole: string;
}): Promise<ResolvedSwitches> {
  return setRoleSwitchValues({ ...args, reason: 'manual', pinPeople: true });
}

/**
 * Reset a role to its starting point: `startsFrom` is the built-in preset (a built-in role's own, a custom role's
 * base), or null for a role made from blank, which starts with everything off. Every switch is stored at that value
 * and each one that changed is logged "reset". The people on the role are not touched. The starting point is the
 * preset itself, so a kept value it holds (Sales' Through own leads) is accepted here. Returns the values the role now holds.
 */
export async function resetRoleSwitchValues(args: {
  organizationId: string;
  roleKey: string;
  startsFrom: BuiltInRole | null;
  actorId: string | null;
  userBaseRole: string;
}): Promise<ResolvedSwitches> {
  return setRoleSwitchValues({
    organizationId: args.organizationId,
    roleKey: args.roleKey,
    values: presetValues(args.startsFrom),
    actorId: args.actorId,
    reason: 'reset',
    userBaseRole: args.userBaseRole,
    copiedFromHolder: true,
    pinPeople: true,
  });
}

/** True when View is off on every module: the role could open nothing, which is almost never what was meant. */
export function allViewsOff(values: ResolvedSwitches): boolean {
  return SWITCH_CATALOG.filter((s) => s.key.startsWith('view_')).every((s) => values[s.key] !== true);
}

/**
 * Give a person a role: copy the role's current value for every switch into the person's set and log
 * each switch whose value changed for them. Runs inside the caller's transaction so the person's role
 * and their set move together; the caller records the role as the person's based-on role
 * (`users.based_on_role_key`) in that same update. The role is only read here, so editing it later
 * never touches the person.
 *
 * `previous` is what the person resolved to before the new role, read by the caller before it changed
 * the person's role.
 */
export async function assignRoleToPerson(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    userId: string;
    roleKey: string;
    userBaseRole: string;
    previous: ResolvedSwitches;
    actorId: string | null;
  },
): Promise<void> {
  const values = await roleValues(tx, args.organizationId, args.roleKey, args.userBaseRole);
  // The log names the role by the name it has now: a later rename never rewrites it.
  const given = await basedOnRole(tx, args.organizationId, args.roleKey);
  await tx.permissionUserSwitch.deleteMany({ where: { user_id: args.userId } });
  await tx.permissionUserSwitch.createMany({
    data: SWITCH_CATALOG.map((s) => ({
      organization_id: args.organizationId, user_id: args.userId, switch_key: s.key, value: values[s.key]!,
    })),
  });
  const base = {
    organization_id: args.organizationId, target_type: 'USER', target_id: args.userId,
    actor_id: args.actorId, reason: 'role assigned' as ChangeReason, role_label: given.label,
  };
  const changed = SWITCH_CATALOG.filter((s) => !sameSwitchValue(args.previous[s.key], values[s.key]));
  if (changed.length) {
    await tx.permissionChangeLog.createMany({
      data: changed.map((s) => logRow(base, s.key, args.previous[s.key]!, values[s.key]!)),
    });
  }
  clearSwitchCacheForUser(args.userId);
}

/** Why a person-set operation cannot run, apart from a bad value (that is an InvalidSwitchSetError). */
export class PersonSetError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'admin_box' | 'bad_name' | 'name_taken',
  ) {
    super(message);
    this.name = 'PersonSetError';
  }
}

const BUILT_IN_ROLE_LABEL: Record<BuiltInRole, string> = { ADMIN: 'Admin', SALES: 'Sales', DISPATCHER: 'Dispatcher', TECHNICIAN: 'Technician' };

/** The role a person's set is compared with. */
export interface BasedOnRole {
  key: string;
  label: string;
  type: 'built_in' | 'custom';
}

/** A switch whose value for a person differs from the role they are based on. */
export interface SwitchDifference {
  switch_key: string;
  value: SwitchValue;
  role_value: SwitchValue;
}

/** Refuses (as not found) a person who is not of this company, with one light read: the change log needs no more of them. */
export async function assertPersonInOrganization(organizationId: string, userId: string): Promise<void> {
  const person = await prisma.user.findFirst({ where: { id: userId, organization_id: organizationId }, select: { id: true } });
  if (!person) throw new PersonSetError('User not found', 'not_found');
}

/** A person's set as the Permissions page reads it. */
export interface PersonSetRead {
  userId: string;
  /** The built-in Admin role: one box, full access, no stored set and no differences. */
  adminBox: boolean;
  basedOn: BasedOnRole | null;
  values: ResolvedSwitches;
  differences: SwitchDifference[];
}

const personSelect = {
  id: true,
  organization_id: true,
  role: true,
  based_on_role_key: true,
  custom_role_id: true,
  custom_role: { select: { key: true } },
} satisfies Prisma.UserSelect;

type StoredPerson = Prisma.UserGetPayload<{ select: typeof personSelect }>;

async function loadPerson(db: Db, organizationId: string, userId: string): Promise<StoredPerson> {
  const person = await db.user.findFirst({ where: { id: userId, organization_id: organizationId }, select: personSelect });
  if (!person) throw new PersonSetError('User not found', 'not_found');
  return person;
}

interface PersonState {
  adminBox: boolean;
  basedOnKey: string | null;
  /** The based-on role's current value for every switch. */
  roleVals: ResolvedSwitches;
  /** The person's value for every switch: their own stored value, else the role's. Read fresh, never from the cache. */
  values: ResolvedSwitches;
}

async function personState(db: Db, person: StoredPerson): Promise<PersonState> {
  if (isSuperUser(person)) {
    return { adminBox: true, basedOnKey: null, roleVals: presetValues('ADMIN'), values: presetValues('ADMIN') };
  }
  const basedOnKey = person.based_on_role_key ?? grantRoleKey(person);
  const [roleVals, own] = await Promise.all([
    roleValues(db, person.organization_id, basedOnKey, person.role),
    db.permissionUserSwitch.findMany({ where: { user_id: person.id }, select: { switch_key: true, value: true } }),
  ]);
  const values = overlayStored({ ...roleVals }, own);
  return { adminBox: false, basedOnKey, roleVals, values };
}

async function basedOnRole(db: Db, organizationId: string, key: string): Promise<BasedOnRole> {
  if (isBuiltInRole(key)) return { key, label: BUILT_IN_ROLE_LABEL[key], type: 'built_in' };
  const custom = await db.customRole.findFirst({ where: { organization_id: organizationId, key }, select: { label: true } });
  return { key, label: custom?.label ?? key, type: 'custom' };
}

function differencesOf(state: PersonState): SwitchDifference[] {
  return SWITCH_CATALOG.filter((s) => !sameSwitchValue(state.values[s.key], state.roleVals[s.key])).map((s) => ({
    switch_key: s.key,
    value: state.values[s.key]!,
    role_value: state.roleVals[s.key]!,
  }));
}

/** What the users list shows in a person's role column: the role's name, and how many switches differ from it. */
export interface PersonRoleSummary {
  role_label: string;
  change_count: number;
}

/** A stored person as the users list selects them: enough to find the role they are based on. */
export interface RoleSummaryPerson extends RoleBearer {
  id: string;
  based_on_role_key: string | null;
}

/**
 * The key of the role a person is based on: the role their set was last filled from, else the role they hold. The
 * Admin box has no set and is based on the built-in Admin role. The users list and the Roles list both read it.
 */
function basedOnKeyOf(p: RoleSummaryPerson): string {
  return isSuperUser(p) ? 'ADMIN' : (p.based_on_role_key ?? grantRoleKey(p));
}

/**
 * How many people are based on each role of one company, keyed by role key (a built-in role's name or a custom role's
 * key). Everyone counts once, in the role the users list names them under, active or not (the users list shows both,
 * and archiving a role is refused for either): the Admin role counts only the Admin box, and a person on a custom role
 * counts under it and not under its base role.
 */
export async function countPeopleByRole(organizationId: string): Promise<Map<string, number>> {
  const people = await prisma.user.findMany({
    where: { organization_id: organizationId },
    select: { id: true, role: true, custom_role_id: true, based_on_role_key: true, custom_role: { select: { key: true } } },
  });
  const counts = new Map<string, number>();
  for (const p of people) {
    const key = basedOnKeyOf(p);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The role name and the number of changes for many people of one company, in a constant number of reads. The name is
 * the role the person's set was last filled from (the same role `readPersonSet` compares with), the count the switches
 * the person holds differently from it, so the two always agree with that person's Permissions page. The Admin box has
 * no set: "Admin" and no changes.
 */
export async function summarizePeopleRoles(
  organizationId: string,
  people: RoleSummaryPerson[],
): Promise<Map<string, PersonRoleSummary>> {
  const out = new Map<string, PersonRoleSummary>();
  const stored = people.filter((p) => !isSuperUser(p));
  for (const p of people) if (isSuperUser(p)) out.set(p.id, { role_label: BUILT_IN_ROLE_LABEL.ADMIN, change_count: 0 });
  if (stored.length === 0) return out;

  const basedOnOf = basedOnKeyOf;
  const [rows, roles] = await Promise.all([
    prisma.permissionUserSwitch.findMany({
      where: { organization_id: organizationId, user_id: { in: stored.map((p) => p.id) } },
      select: { user_id: true, switch_key: true, value: true },
    }),
    roleValuesForMany(organizationId, stored.map((p) => ({ roleKey: basedOnOf(p), userBaseRole: p.role }))),
  ]);
  const ownByUser = new Map<string, Map<string, SwitchValue>>();
  for (const r of rows) {
    const v = asValue(r.value);
    if (v === undefined || !findSwitch(r.switch_key)) continue;
    if (!ownByUser.has(r.user_id)) ownByUser.set(r.user_id, new Map());
    ownByUser.get(r.user_id)!.set(r.switch_key, v);
  }
  for (const p of stored) {
    const basedOn = basedOnOf(p);
    const roleVals = roles.values.get(roleReadKey({ roleKey: basedOn, userBaseRole: p.role }))!;
    const own = ownByUser.get(p.id);
    const changes = own ? [...own].filter(([key, value]) => !sameSwitchValue(value, roleVals[key])).length : 0;
    out.set(p.id, {
      role_label: isBuiltInRole(basedOn) ? BUILT_IN_ROLE_LABEL[basedOn] : (roles.customLabels.get(basedOn) ?? basedOn),
      change_count: changes,
    });
  }
  return out;
}

/** A person's set: their values, the role they are based on, and the switches that differ from it. */
export async function readPersonSet(organizationId: string, userId: string): Promise<PersonSetRead> {
  const person = await loadPerson(prisma, organizationId, userId);
  const state = await personState(prisma, person);
  if (state.adminBox) return { userId, adminBox: true, basedOn: null, values: state.values, differences: [] };
  return {
    userId,
    adminBox: false,
    basedOn: await basedOnRole(prisma, organizationId, state.basedOnKey!),
    values: state.values,
    differences: differencesOf(state),
  };
}

/**
 * The set a person holds once `values` are stored on them, built from what the save already read. A save answers with
 * this and reads nothing after it commits: on the hosted database's one-connection pool every read waits behind the
 * other requests, and a read that timed out after the commit answered a failure for a write that had been saved.
 */
function personSetAfter(userId: string, state: PersonState, basedOn: BasedOnRole, values: Record<string, SwitchValue>): PersonSetRead {
  const after: PersonState = { ...state, values: { ...state.values, ...values } };
  return { userId, adminBox: false, basedOn, values: after.values, differences: differencesOf(after) };
}

/** Store a person's own values for these switches. */
async function storePersonValues(
  tx: Prisma.TransactionClient,
  person: StoredPerson,
  state: PersonState,
  values: Record<string, SwitchValue>,
  actorId: string | null,
  reason: ChangeReason,
): Promise<void> {
  const keys = Object.keys(values);
  for (const key of keys) {
    await tx.permissionUserSwitch.upsert({
      where: { user_id_switch_key: { user_id: person.id, switch_key: key } },
      create: { organization_id: person.organization_id, user_id: person.id, switch_key: key, value: values[key]! },
      update: { value: values[key]! },
    });
  }
  const changed = keys.filter((k) => !sameSwitchValue(state.values[k], values[k]));
  if (changed.length) {
    const base = { organization_id: person.organization_id, target_type: 'USER', target_id: person.id, actor_id: actorId, reason };
    await tx.permissionChangeLog.createMany({ data: changed.map((k) => logRow(base, k, state.values[k]!, values[k]!)) });
  }
}

function refuseAdminBox(state: PersonState): void {
  if (state.adminBox) throw new PersonSetError('The Admin role has full access and no switches to set.', 'admin_box');
}

/**
 * Write some of a person's values. The set the person would hold afterwards must pass the catalog validator (the row
 * rule and each switch's Requires); nothing is stored if not. Only values that change what the person holds are logged,
 * one entry each. The Admin box has no set to write.
 */
export async function setPersonSwitchValues(args: {
  organizationId: string;
  userId: string;
  values: Record<string, SwitchValue>;
  actorId: string | null;
}): Promise<PersonSetRead> {
  Object.keys(args.values).forEach(entryFor);
  const person = await loadPerson(prisma, args.organizationId, args.userId);
  const state = await personState(prisma, person);
  refuseAdminBox(state);
  const violations = validateSwitchSet({ ...state.values, ...args.values }, { held: state.values });
  if (violations.length) throw new InvalidSwitchSetError(violations);
  const basedOn = await basedOnRole(prisma, args.organizationId, state.basedOnKey!);
  await prisma.$transaction((tx) => storePersonValues(tx, person, state, args.values, args.actorId, 'manual'));
  clearSwitchCacheForUser(args.userId);
  return personSetAfter(args.userId, state, basedOn, args.values);
}

/**
 * Put some of a person's switches (`all` for every one) back to the based-on role's current value. The value is stored
 * on the person, not dropped, so a later edit to the role still never reaches them.
 */
export async function resetPersonSwitches(args: {
  organizationId: string;
  userId: string;
  switchKeys: string[] | 'all';
  actorId: string | null;
}): Promise<PersonSetRead> {
  if (args.switchKeys !== 'all') args.switchKeys.forEach(entryFor);
  const person = await loadPerson(prisma, args.organizationId, args.userId);
  const state = await personState(prisma, person);
  refuseAdminBox(state);
  const keys = args.switchKeys === 'all' ? SWITCH_CATALOG.map((s) => s.key) : args.switchKeys;
  const values = Object.fromEntries(keys.map((k) => [k, state.roleVals[k]!]));
  // The role's own value is held by the role, so a kept value it holds is not refused here.
  const violations = validateSwitchSet({ ...state.values, ...values }, { held: { ...state.values, ...values } });
  if (violations.length) throw new InvalidSwitchSetError(violations);
  const basedOn = await basedOnRole(prisma, args.organizationId, state.basedOnKey!);
  await prisma.$transaction((tx) => storePersonValues(tx, person, state, values, args.actorId, 'reset'));
  clearSwitchCacheForUser(args.userId);
  return personSetAfter(args.userId, state, basedOn, values);
}

/**
 * Save as role: a new custom role holding the person's current values for every switch, which records the role the
 * person was based on and carries that role's built-in base, and moves the person onto it. They keep every value, so
 * they have no differences from it. The role's change log records its values against that base's preset.
 *
 * Returns the new role and the person's set as it now stands, built from what the save already read, so the route
 * reads nothing after the commit (see `personSetAfter`).
 */
export async function saveSwitchesAsRole(args: {
  organizationId: string;
  userId: string;
  label: string;
  description?: string;
  actorId: string | null;
}): Promise<{ role: CustomRole; set: PersonSetRead }> {
  const person = await loadPerson(prisma, args.organizationId, args.userId);
  const state = await personState(prisma, person);
  refuseAdminBox(state);
  const refusal = await roleNameRefusal({ organizationId: args.organizationId, label: args.label });
  if (refusal) throw new PersonSetError(refusal.error, refusal.status === 409 ? 'name_taken' : 'bad_name');
  const key = slugifyRoleKey(args.label);
  const violations = validateSwitchSet(state.values);
  if (violations.length) throw new InvalidSwitchSetError(violations);

  const source = state.basedOnKey!;
  const sourceRow = isBuiltInRole(source)
    ? null
    : await prisma.customRole.findFirst({ where: { organization_id: args.organizationId, key: source }, select: { base_role: true, made_from_blank: true } });
  const baseRole = isBuiltInRole(source) ? source : (sourceRow?.base_role ?? person.role);
  const madeFromBlank = sourceRow?.made_from_blank ?? false;
  const startValues = presetValues(madeFromBlank ? null : (baseRole as BuiltInRole));

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const role = await tx.customRole.create({
        data: {
          organization_id: args.organizationId, key, label: args.label, description: args.description ?? '',
          base_role: baseRole, made_from_blank: madeFromBlank, made_from_role_key: source,
        },
      });
      await tx.permissionRoleSwitch.createMany({
        data: SWITCH_CATALOG.map((s) => ({ organization_id: args.organizationId, role_key: key, switch_key: s.key, value: state.values[s.key]! })),
      });
      // Both logs open with one row for the event itself, with no switch: a role saved at its starting values, or a person
      // who kept every value, would otherwise leave nothing to show. The role's rows are the switches that differ from the
      // starting point the role resets to.
      const changed = SWITCH_CATALOG.filter((s) => !sameSwitchValue(startValues[s.key], state.values[s.key]));
      const saveRow = { actor_id: args.actorId, reason: 'save as role' as ChangeReason, switch_key: null, from_value: Prisma.DbNull, to_value: Prisma.DbNull };
      const roleBase = { organization_id: args.organizationId, target_type: 'ROLE', target_id: key, actor_id: args.actorId, reason: 'save as role' as ChangeReason, role_label: null };
      await tx.permissionChangeLog.createMany({
        data: [
          { ...saveRow, organization_id: args.organizationId, target_type: 'ROLE', target_id: key, role_label: null },
          ...changed.map((s) => logRow(roleBase, s.key, startValues[s.key]!, state.values[s.key]!)),
          { ...saveRow, organization_id: args.organizationId, target_type: 'USER', target_id: person.id, role_label: args.label },
        ],
      });
      // The person keeps every value they hold; the new role holds the same, so nothing differs.
      await tx.permissionUserSwitch.deleteMany({ where: { user_id: person.id } });
      await tx.permissionUserSwitch.createMany({
        data: SWITCH_CATALOG.map((s) => ({ organization_id: args.organizationId, user_id: person.id, switch_key: s.key, value: state.values[s.key]! })),
      });
      await tx.user.update({ where: { id: person.id }, data: { custom_role_id: role.id, role: baseRole, based_on_role_key: key } });
      return role;
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new PersonSetError(nameTakenMessage(args.label), 'name_taken');
    throw err;
  }
  clearSwitchCacheForOrg(args.organizationId);
  // The person now sits on the new role, which holds exactly their values: no differences.
  const set: PersonSetRead = {
    userId: args.userId,
    adminBox: false,
    basedOn: { key, label: created.label, type: 'custom' },
    values: state.values,
    differences: [],
  };
  return { role: created, set };
}

/** The change log of a role (`targetType` 'ROLE', the role key) or a person ('USER', the user id), oldest first. */
export async function readChangeLog(args: { organizationId: string; targetType: 'ROLE' | 'USER'; targetId: string }) {
  return prisma.permissionChangeLog.findMany({
    where: { organization_id: args.organizationId, target_type: args.targetType, target_id: args.targetId },
    orderBy: { created_at: 'asc' },
  });
}

/** One entry of a change log as a screen shows it. */
export interface ChangeLogEntry {
  id: string;
  /** Null on the one row a Save as role writes for the event itself. */
  switch_key: string | null;
  /** The catalog's label for the switch; null when the row has no switch or the catalog no longer holds it. */
  switch_label: string | null;
  from: SwitchValue | null;
  to: SwitchValue | null;
  reason: string;
  /** The role a "role assigned" or "save as role" row is about, by the name it had when the row was written. */
  role_label: string | null;
  created_at: Date;
  actor: { id: string; name: string } | null;
}

/**
 * A page of a role's or person's change log, newest first. The order is total: rows written in one statement share a
 * timestamp (a role assignment writes one per switch), so ties break on the event row first, then the switch key, then
 * the id, and a page never repeats or skips a row. `has_more` says older rows remain. The first page also carries the
 * number of entries the log holds (`total`); later pages leave it null, so a page costs the rows, plus one read for the
 * names of the people who made them: the hosted pool runs queries one after another.
 */
export async function readChangeLogPage(args: {
  organizationId: string;
  targetType: 'ROLE' | 'USER';
  targetId: string;
  limit: number;
  offset: number;
}): Promise<{ total: number | null; has_more: boolean; entries: ChangeLogEntry[] }> {
  const where = { organization_id: args.organizationId, target_type: args.targetType, target_id: args.targetId };
  const found = await prisma.permissionChangeLog.findMany({
    where,
    orderBy: [{ created_at: 'desc' }, { switch_key: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    take: args.limit + 1,
    skip: args.offset,
  });
  const rows = found.slice(0, args.limit);
  const total = args.offset === 0 ? await prisma.permissionChangeLog.count({ where }) : null;
  const actorIds = [...new Set(rows.map((r) => r.actor_id).filter((id): id is string => !!id))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds }, organization_id: args.organizationId }, select: { id: true, first_name: true, last_name: true } })
    : [];
  const actorById = new Map(actors.map((a) => [a.id, { id: a.id, name: `${a.first_name} ${a.last_name}`.trim() }]));
  return {
    total,
    has_more: found.length > args.limit,
    entries: rows.map((r) => ({
      id: r.id,
      switch_key: r.switch_key,
      switch_label: r.switch_key ? (findSwitch(r.switch_key)?.label ?? null) : null,
      from: r.from_value === null ? null : (asValue(r.from_value) ?? null),
      to: r.to_value === null ? null : (asValue(r.to_value) ?? null),
      reason: r.reason,
      role_label: r.role_label,
      created_at: r.created_at,
      actor: r.actor_id ? (actorById.get(r.actor_id) ?? null) : null,
    })),
  };
}

export { clearSwitchCacheForUser, clearSwitchCacheForOrg };
