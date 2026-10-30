import { Request, Response } from 'express';
import { z } from 'zod';
import { Prisma, Role } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { logger } from '../lib/logger';
import { logAudit, recordAuditInTx } from '../lib/audit';
import { ROLE_ADMIN_FLAG, SYSTEM_ROLE_NAMES, slugifyRoleKey } from '../lib/permissions/effectiveRole';
import { BUILT_IN_ROLE_LABELS, nameTakenMessage, roleNameRefusal } from '../lib/permissions/roleName';
import { isBuiltInRole, type BuiltInRole } from '../lib/permissions/switches/catalog';
import type { ResolvedSwitches } from '../lib/permissions/switches/cache';
import {
  InvalidSwitchSetError,
  UnknownSwitchError,
  allViewsOff,
  countPeopleByRole,
  editRoleSwitchValues,
  presetValues,
  readChangeLogPage,
  resetRoleSwitchValues,
  resolveRoleSwitchValues,
  setRoleSwitchValues,
} from '../lib/permissions/switches/store';
import { putPersonSwitchesSchema } from './user-permission.controller';

const SYSTEM_ROLES = SYSTEM_ROLE_NAMES;
const ROLE_META: Record<string, { label: string; fullAccess: boolean; editable: boolean }> = {
  // fullAccess is the role's Admin flag: the one the user changes read when someone is moved onto the role.
  ADMIN: { label: BUILT_IN_ROLE_LABELS.ADMIN, fullAccess: ROLE_ADMIN_FLAG.ADMIN, editable: false },
  SALES: { label: BUILT_IN_ROLE_LABELS.SALES, fullAccess: ROLE_ADMIN_FLAG.SALES, editable: true },
  DISPATCHER: { label: BUILT_IN_ROLE_LABELS.DISPATCHER, fullAccess: ROLE_ADMIN_FLAG.DISPATCHER, editable: true },
  TECHNICIAN: { label: BUILT_IN_ROLE_LABELS.TECHNICIAN, fullAccess: ROLE_ADMIN_FLAG.TECHNICIAN, editable: true },
};

type CustomRoleRow = {
  id: string;
  organization_id: string;
  key: string;
  label: string;
  description: string;
  base_role: Role;
  made_from_blank: boolean;
  made_from_role_key: string | null;
  archived_at: Date | null;
};

// Resolve `:role`/`:key` to an org's custom_roles row, or null if it names a system role,
// an unknown key, or an archived one. Archived roles 404 like they never existed - phase one
// has no unarchive endpoint, so there is nothing a caller could legitimately do with one.
async function resolveCustomRole(req: Request, key: string): Promise<CustomRoleRow | null> {
  const row = await prisma.customRole.findFirst({ where: { ...tenantWhere(req), key, archived_at: null } });
  return row as CustomRoleRow | null;
}

/** Maps a refused switch write to its answer; false when the error is not one of them. */
function answerRefusal(err: unknown, res: Response): boolean {
  if (err instanceof InvalidSwitchSetError) {
    res.status(400).json({ error: err.message, violations: err.violations });
    return true;
  }
  if (err instanceof UnknownSwitchError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  return false;
}

export const listRoles = async (req: Request, res: Response) => {
  try {
    // People are counted once, under the role they are based on (the role the users list names them under).
    // users.role holds the BASE role of a person on a custom role, so grouping by it would count them twice.
    const countByRole = await countPeopleByRole(req.user!.organization_id);
    const systemEntries = SYSTEM_ROLES.map((role) => ({
      role,
      ...ROLE_META[role],
      userCount: countByRole.get(role) ?? 0,
      type: 'system' as const,
    }));

    const customRows = await prisma.customRole.findMany({
      where: { ...tenantWhere(req), archived_at: null },
      select: {
        id: true, key: true, label: true, description: true, base_role: true, made_from_blank: true, made_from_role_key: true,
      },
      orderBy: { created_at: 'asc' },
    });
    const customEntries = customRows.map((r: any) => ({
      // The row's real UUID - users.custom_role_id is a FK to custom_roles.id, not the key, so a
      // user-role picker built off this list needs it to actually assign the role.
      id: r.id,
      role: r.key,
      label: r.label,
      description: r.description,
      base_role: r.base_role,
      made_from_role_key: r.made_from_role_key,
      made_from_blank: r.made_from_blank,
      fullAccess: false,
      editable: true,
      userCount: countByRole.get(r.key) ?? 0,
      type: 'custom' as const,
    }));

    res.json([...systemEntries, ...customEntries]);
  } catch (err) {
    logger.error('listRoles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// A role to copy the starting switch values from: a system role (the Admin role included, whose values are the
// built-in Admin preset), or a live custom role of the org. Null when it names neither.
async function resolveCloneSource(
  req: Request,
  key: string,
): Promise<{ baseRole: Role; madeFromBlank: boolean } | null> {
  if ((SYSTEM_ROLE_NAMES as readonly string[]).includes(key)) return { baseRole: key as Role, madeFromBlank: false };
  const custom = await resolveCustomRole(req, key);
  return custom ? { baseRole: custom.base_role, madeFromBlank: custom.made_from_blank } : null;
}

// A role made from blank has no built-in role to take its base from; the narrowest one stands in for the base-role
// column, which a blank role's switch values never read.
const BLANK_ROLE_BASE: Role = 'TECHNICIAN';

export const createRoleSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    base_role: z.nativeEnum(Role).optional(),
    description: z.string().max(500).optional(),
    // A system role name or another org role's key to copy the initial switch values from.
    clone_grants_from: z.string().min(1).optional(),
    // Start with every switch off.
    blank: z.literal(true).optional(),
  })
  .refine((v) => !(v.blank && v.clone_grants_from), { message: 'Copy a role or start from blank, not both' })
  .refine((v) => v.blank || v.clone_grants_from || v.base_role, { message: 'Choose a role to start from, or start from blank' });

export const createRole = async (req: Request, res: Response) => {
  try {
    const { label, base_role, description, clone_grants_from, blank } = req.body as z.infer<typeof createRoleSchema>;

    const refusal = await roleNameRefusal({ organizationId: req.user!.organization_id, label });
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.error });
      return;
    }
    const key = slugifyRoleKey(label);

    const source = clone_grants_from ? await resolveCloneSource(req, clone_grants_from) : null;
    if (clone_grants_from && !source) {
      res.status(400).json({ error: 'Unknown role to clone permissions from' });
      return;
    }

    const orgId = req.user!.organization_id;
    // A role made from another role carries that role's base built-in role and, when the source was itself made from
    // blank, the blank start; one made from blank has no built-in role to fall back on; one made from only a base role
    // starts from that base's preset.
    const baseRole = base_role ?? source?.baseRole ?? BLANK_ROLE_BASE;
    const roleData = {
      organization_id: orgId, key, label, description: description ?? '', base_role: baseRole,
      made_from_blank: blank === true || source?.madeFromBlank === true,
      made_from_role_key: blank ? null : (clone_grants_from ?? base_role ?? null),
    };
    // The role, its starting switches and its record are one step (N23): with the audit row failing, no role is made. The values
    // a copy starts from are read before the write opens.
    let created!: Awaited<ReturnType<typeof prisma.customRole.create>>;
    const makeRole = async (tx: Prisma.TransactionClient) => {
      created = await tx.customRole.create({ data: roleData });
      await recordAuditInTx(tx, req, { action: 'role.created', resourceType: 'Role', resourceId: created.id, metadata: { key, base_role: baseRole } });
    };
    // Copying another role (or starting from blank) means storing the starting values on the new role, so editing the
    // source afterwards never touches it. A role made from a base role alone holds its preset without storing it.
    let values = presetValues(blank ? null : baseRole);
    if (source || blank) {
      values = blank ? presetValues(null) : await resolveRoleSwitchValues(orgId, clone_grants_from!, source!.baseRole);
      await setRoleSwitchValues({
        organizationId: orgId,
        roleKey: key,
        values,
        actorId: req.user!.id,
        reason: 'manual',
        userBaseRole: baseRole,
        copiedFromHolder: true,
        newRole: true,
        inSameStep: makeRole,
      });
    } else {
      await prisma.$transaction(makeRole);
    }

    // The answer is built from `values`, read before the write; nothing is read after it commits (hosted pool of one).
    res.status(201).json({
      id: created.id,
      role: created.key,
      label: created.label,
      description: created.description,
      base_role: created.base_role,
      made_from_role_key: created.made_from_role_key,
      made_from_blank: created.made_from_blank,
      all_views_off: allViewsOff(values),
      fullAccess: false,
      editable: true,
      userCount: 0,
      type: 'custom',
    });
  } catch (err) {
    if (answerRefusal(err, res)) return;
    const prismaErr = err as { code?: string };
    if (prismaErr.code === 'P2002') {
      // Two requests for one name at once: the other one got there between the check and the write.
      res.status(409).json({ error: nameTakenMessage(req.body.label) });
      return;
    }
    logger.error('createRole error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const patchRoleSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
  })
  .refine((v) => v.label !== undefined || v.description !== undefined, { message: 'Nothing to update' });

// Rename/re-describe only. The key (what the role's switch values are keyed on) and base_role
// (what code-level behaviour the role inherits) are both immutable in phase one.
export const patchRole = async (req: Request, res: Response) => {
  try {
    const key = req.params.role as string;
    if (isBuiltInRole(key)) {
      res.status(400).json({ error: 'Built-in roles cannot be renamed.' });
      return;
    }
    const custom = await resolveCustomRole(req, key);
    if (!custom) {
      res.status(404).json({ error: 'Unknown role' });
      return;
    }

    const { label, description } = req.body as z.infer<typeof patchRoleSchema>;
    if (label !== undefined) {
      const refusal = await roleNameRefusal({ organizationId: req.user!.organization_id, label, renaming: custom.id });
      if (refusal) {
        res.status(refusal.status).json({ error: refusal.error });
        return;
      }
    }
    const data: Prisma.CustomRoleUpdateInput = {};
    if (label !== undefined) data.label = label;
    if (description !== undefined) data.description = description;

    // The rename and its record are one step (N23); the record keeps the name before and after.
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.customRole.update({ where: { id: custom.id }, data });
      await recordAuditInTx(tx, req, {
        action: 'role.updated', resourceType: 'Role', resourceId: custom.id,
        metadata: {
          fields: Object.keys(data),
          ...(label !== undefined ? { label: { from: custom.label, to: row.label } } : {}),
        },
      });
      return row;
    });
    res.json({
      id: updated.id,
      role: updated.key,
      label: updated.label,
      description: updated.description,
      base_role: updated.base_role,
    });
  } catch (err) {
    logger.error('patchRole error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const archiveRole = async (req: Request, res: Response) => {
  try {
    const key = req.params.role as string;
    if (isBuiltInRole(key)) {
      res.status(400).json({ error: 'Built-in roles cannot be deleted.' });
      return;
    }
    const custom = await resolveCustomRole(req, key);
    if (!custom) {
      res.status(404).json({ error: 'Unknown role' });
      return;
    }

    // The same count the Roles list shows beside the role: everyone based on it, active or not, counted once.
    const people = (await countPeopleByRole(req.user!.organization_id)).get(custom.key) ?? 0;
    if (people > 0) {
      res.status(409).json({
        error: `Cannot archive: ${people} ${people === 1 ? 'person is' : 'people are'} still on this role. Move them to another role first.`,
      });
      return;
    }

    // The archive and its record are one step (N23).
    await prisma.$transaction(async (tx) => {
      await tx.customRole.update({ where: { id: custom.id }, data: { archived_at: new Date() } });
      await recordAuditInTx(tx, req, { action: 'role.archived', resourceType: 'Role', resourceId: custom.id, metadata: { key: custom.key } });
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error('archiveRole error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/** A role the Roles API can name: a built-in role, or a live custom role of the company. */
interface NamedRole {
  key: string;
  label: string;
  type: 'system' | 'custom';
  editable: boolean;
  baseRole: Role;
  madeFromBlank: boolean;
  madeFromRoleKey: string | null;
}

async function resolveNamedRole(req: Request, key: string): Promise<NamedRole | null> {
  if (isBuiltInRole(key)) {
    return { key, label: ROLE_META[key]!.label, type: 'system', editable: ROLE_META[key]!.editable, baseRole: key, madeFromBlank: false, madeFromRoleKey: null };
  }
  const custom = await resolveCustomRole(req, key);
  if (!custom) return null;
  return {
    key: custom.key, label: custom.label, type: 'custom', editable: true, baseRole: custom.base_role,
    madeFromBlank: custom.made_from_blank, madeFromRoleKey: custom.made_from_role_key,
  };
}

/** The built-in preset a role starts from: its own for a built-in role, its base for a custom one, none if made from blank. */
const startsFrom = (role: NamedRole): BuiltInRole | null => (role.madeFromBlank ? null : role.baseRole);

/** The role's set as the Permissions page reads it; a save passes the values it holds, so nothing is read after it commits. */
function roleSetBody(role: NamedRole, values: ResolvedSwitches, effect?: { reaches: number; keepOwn: number }) {
  return {
    // A save tells the Admin what it did: how many people follow the change and how many keep their own value.
    ...(effect ? { reaches: effect.reaches, keep_own: effect.keepOwn } : {}),
    role: role.key,
    label: role.label,
    type: role.type,
    editable: role.editable,
    base_role: role.baseRole,
    made_from_role_key: role.madeFromRoleKey,
    made_from_blank: role.madeFromBlank,
    values,
    all_views_off: allViewsOff(values),
  };
}

const ADMIN_ROLE_FIXED = 'The Administrator role is full-access and cannot be edited';

export const getRoleSwitches = async (req: Request, res: Response) => {
  try {
    const role = await resolveNamedRole(req, req.params.role as string);
    if (!role) {
      res.status(404).json({ error: 'Unknown role' });
      return;
    }
    res.json(roleSetBody(role, await resolveRoleSwitchValues(req.user!.organization_id, role.key, role.baseRole)));
  } catch (err) {
    logger.error('getRoleSwitches error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const putRoleSwitchesSchema = putPersonSwitchesSchema;

export const putRoleSwitches = async (req: Request, res: Response) => {
  try {
    const role = await resolveNamedRole(req, req.params.role as string);
    if (!role) {
      res.status(404).json({ error: 'Unknown role' });
      return;
    }
    if (!role.editable) {
      res.status(400).json({ error: ADMIN_ROLE_FIXED });
      return;
    }
    const { values } = req.body as z.infer<typeof putRoleSwitchesSchema>;
    const saved = await editRoleSwitchValues({
      organizationId: req.user!.organization_id, roleKey: role.key, values, actorId: req.user!.id, userBaseRole: role.baseRole,
    });
    void logAudit({ req, action: 'role.permissions_updated', resourceType: 'Role', resourceId: role.key, metadata: { switches: Object.keys(values) } });
    res.json(roleSetBody(role, saved.values, saved));
  } catch (err) {
    if (answerRefusal(err, res)) return;
    logger.error('putRoleSwitches error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const resetRole = async (req: Request, res: Response) => {
  try {
    const role = await resolveNamedRole(req, req.params.role as string);
    if (!role) {
      res.status(404).json({ error: 'Unknown role' });
      return;
    }
    if (!role.editable) {
      res.status(400).json({ error: ADMIN_ROLE_FIXED });
      return;
    }
    const saved = await resetRoleSwitchValues({
      organizationId: req.user!.organization_id, roleKey: role.key, startsFrom: startsFrom(role), actorId: req.user!.id, userBaseRole: role.baseRole,
    });
    void logAudit({ req, action: 'role.reset', resourceType: 'Role', resourceId: role.key });
    res.json(roleSetBody(role, saved.values, saved));
  } catch (err) {
    if (answerRefusal(err, res)) return;
    logger.error('resetRole error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getRoleChangeLog = async (req: Request, res: Response) => {
  try {
    const role = await resolveNamedRole(req, req.params.role as string);
    if (!role) {
      res.status(404).json({ error: 'Unknown role' });
      return;
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    res.json(await readChangeLogPage({ organizationId: req.user!.organization_id, targetType: 'ROLE', targetId: role.key, limit, offset }));
  } catch (err) {
    logger.error('getRoleChangeLog error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
