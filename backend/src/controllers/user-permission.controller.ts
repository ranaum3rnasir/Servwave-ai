import { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';
import { clearTokenCache } from '../middleware/authenticate';
import {
  InvalidSwitchSetError,
  PersonSetError,
  UnknownSwitchError,
  readChangeLogPage,
  assertPersonInOrganization,
  readPersonSet,
  resetPersonSwitches,
  saveSwitchesAsRole,
  setPersonSwitchValues,
  type PersonSetRead,
} from '../lib/permissions/switches/store';

/**
 * A person's switches (Roles & Permissions M2). Every route here needs Manage roles and permissions (the route
 * guard), and nobody writes their own set (checked here, whether or not they hold the switch).
 */

const switchValue = z.union([z.boolean(), z.string(), z.array(z.string())]);

export const putPersonSwitchesSchema = z.object({
  values: z.record(z.string(), switchValue).refine((v) => Object.keys(v).length > 0, { message: 'Send at least one switch value' }),
});

export const resetPersonSwitchesSchema = z
  .object({ switch_keys: z.array(z.string()).min(1).optional(), all: z.literal(true).optional() })
  .refine((v) => (v.switch_keys === undefined) !== (v.all === undefined), { message: 'Name the switches to reset, or send all' });

export const saveAsRoleSchema = z.object({
  label: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
});

const SELF_WRITE_REFUSED = 'You cannot change your own permissions.';

function shape(set: PersonSetRead, requesterId: string) {
  return {
    user_id: set.userId,
    admin_box: set.adminBox,
    editable: !set.adminBox && set.userId.toLowerCase() !== requesterId.toLowerCase(),
    based_on: set.basedOn,
    values: set.values,
    differences: set.differences,
    difference_count: set.differences.length,
  };
}

/** Maps a store refusal to its answer; false when the error is not one of them. */
function answerRefusal(err: unknown, res: Response): boolean {
  if (err instanceof PersonSetError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'name_taken' ? 409 : 400;
    res.status(status).json({ error: err.message });
    return true;
  }
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The person the route names, in the one spelling ids are stored and compared in. The id column is a uuid, which the
 * database accepts in any case, so a string compare on the raw param would let a person write their own set under an
 * upper-case spelling of their own id. Something that is not an id names nobody.
 */
function idOf(req: Request): string {
  const id = String(req.params.id).toLowerCase();
  if (!UUID_PATTERN.test(id)) throw new PersonSetError('User not found', 'not_found');
  return id;
}

const isSelf = (req: Request) => idOf(req) === req.user!.id.toLowerCase();

export async function getPersonSwitches(req: Request, res: Response) {
  try {
    res.json(shape(await readPersonSet(req.user!.organization_id, idOf(req)), req.user!.id));
  } catch (err) {
    if (answerRefusal(err, res)) return;
    logger.error('getPersonSwitches error:', err);
    res.status(500).json({ error: 'Failed to load permissions' });
  }
}

export async function putPersonSwitches(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    if (isSelf(req)) {
      res.status(403).json({ error: SELF_WRITE_REFUSED });
      return;
    }
    const { values } = req.body as z.infer<typeof putPersonSwitchesSchema>;
    const saved = await setPersonSwitchValues({ organizationId: orgId, userId: idOf(req), values, actorId: req.user!.id });
    void logAudit({ req, action: 'user.permissions_updated', resourceType: 'User', resourceId: idOf(req), metadata: { switches: Object.keys(values) } });
    res.json(shape(saved, req.user!.id));
  } catch (err) {
    if (answerRefusal(err, res)) return;
    logger.error('putPersonSwitches error:', err);
    res.status(500).json({ error: 'Failed to update permissions' });
  }
}

export async function resetPersonSwitchValues(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    if (isSelf(req)) {
      res.status(403).json({ error: SELF_WRITE_REFUSED });
      return;
    }
    const body = req.body as z.infer<typeof resetPersonSwitchesSchema>;
    const saved = await resetPersonSwitches({ organizationId: orgId, userId: idOf(req), switchKeys: body.all ? 'all' : body.switch_keys!, actorId: req.user!.id });
    void logAudit({ req, action: 'user.permissions_reset', resourceType: 'User', resourceId: idOf(req), metadata: { switches: body.all ? 'all' : body.switch_keys } });
    res.json(shape(saved, req.user!.id));
  } catch (err) {
    if (answerRefusal(err, res)) return;
    logger.error('resetPersonSwitchValues error:', err);
    res.status(500).json({ error: 'Failed to reset permissions' });
  }
}

export async function saveSwitchesAsNewRole(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    if (isSelf(req)) {
      res.status(403).json({ error: SELF_WRITE_REFUSED });
      return;
    }
    const { label, description } = req.body as z.infer<typeof saveAsRoleSchema>;
    const { role, set } = await saveSwitchesAsRole({ organizationId: orgId, userId: idOf(req), label, description, actorId: req.user!.id });
    // The person's role moved: drop the cached sign-in so the next request sees it.
    clearTokenCache(idOf(req));
    void logAudit({ req, action: 'role.created', resourceType: 'Role', resourceId: role.id, metadata: { key: role.key, base_role: role.base_role, from: 'person' } });
    res.status(201).json({
      role: {
        id: role.id,
        role: role.key,
        label: role.label,
        description: role.description,
        base_role: role.base_role,
        made_from_role_key: role.made_from_role_key,
        fullAccess: false,
        editable: true,
        type: 'custom',
      },
      ...shape(set, req.user!.id),
    });
  } catch (err) {
    if (answerRefusal(err, res)) return;
    logger.error('saveSwitchesAsNewRole error:', err);
    res.status(500).json({ error: 'Failed to save the role' });
  }
}

export async function getPersonChangeLog(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    // The person must be of this company; the answer for one who is not is the same as for one who does not exist.
    await assertPersonInOrganization(orgId, idOf(req));
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
    res.json(await readChangeLogPage({ organizationId: orgId, targetType: 'USER', targetId: idOf(req), limit, offset }));
  } catch (err) {
    if (answerRefusal(err, res)) return;
    logger.error('getPersonChangeLog error:', err);
    res.status(500).json({ error: 'Failed to load the change log' });
  }
}
