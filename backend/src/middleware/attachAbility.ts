import { Request, Response, NextFunction } from 'express';
import { abilityForUser } from '../lib/permissions/enforce';
import { logger } from '../lib/logger';

export async function attachAbility(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    // The build itself lives in `abilityForUser` so the batched permission helpers can reuse it
    // for a reader who is NOT the requester. It keeps every rule this middleware used to spell
    // out: an unrestricted ADMIN short-circuits with no DB read, an ADMIN-DERIVED custom role
    // resolves through its grants instead, grants are looked up (and cached) under the CUSTOM
    // role's key, and per-user overrides layer on top from their own cache. grantRoleKey throws
    // if custom_role_id is set but the relation was not loaded - the catch below turns that into
    // a 500, which denies access rather than silently falling back to the wider base role.
    req.ability = await abilityForUser(req.user);
    next();
  } catch (err) {
    logger.error('attachAbility error:', err);
    res.status(500).json({ error: 'Failed to load permissions' });
  }
}
