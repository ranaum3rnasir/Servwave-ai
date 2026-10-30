import { Request, Response, NextFunction } from 'express';
import type { Action, Subject } from '../lib/permissions/catalog';
import { creatorCanOpen, creatorRuleOpens, isCreatorStillAttached, type CreatorSubject } from '../lib/permissions/creatorRule';

export function canDo(action: Action, subject: Subject) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ability) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!req.ability.can(action, subject)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

/**
 * The role fields of a user write (S01.12). A body that names a base role or a custom-role link passes only for a
 * requester who holds Manage roles and permissions, on top of whatever the route itself needs (Edit users on an
 * update, Invite users on an invite, Create users on a direct create). A body that names neither passes, so an update
 * of a name or a phone number needs only Edit users. Without this, anyone who could edit, invite or create users could
 * make a colleague, or a new user, an admin.
 */
export function canSetRoleFields() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ability) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const setsARole = body.role !== undefined || body.custom_role_id !== undefined;
    if (setsARole && !req.ability.can('manage_roles', 'Role')) {
      res.status(403).json({ error: 'Setting a user\'s role needs permission to manage roles and permissions.' });
      return;
    }
    next();
  };
}

/**
 * Passes when the requester holds ANY of the given (action, subject) pairs — same 401/403
 * bodies as `canDo`. Introduced for the #2041 org-wide customer picker: the SAME picker
 * component backs the lead, job, estimate and standalone-invoice create forms, so the guard
 * has to be "may create at least one of these", not any single subject.
 */
export function canDoAny(pairs: [Action, Subject][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ability) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!pairs.some(([action, subject]) => req.ability!.can(action, subject))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

// The bulk routes accept at most 100 ids (their schemas); a longer list is not looked up one id at a time.
const CREATOR_RULE_MAX_IDS = 100;

/**
 * `canDo` for an estimate or invoice, with the creator rule: the person passes when they hold the grant,
 * or when the action is one the creator rule opens and every record the request names is one they made and
 * can still see. The records are the route's `:id` unless `idsOf` says otherwise (a bulk route names them
 * in its body). A holder still gets the per-record scope check inside the handler, exactly as before.
 * Anything else answers 403, whether the record exists or not.
 */
export function canDoOrCreator(
  action: Action,
  subject: CreatorSubject,
  idsOf: (req: Request) => unknown = (req) => [req.params.id],
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.ability || !req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (req.ability.can(action, subject)) {
      next();
      return;
    }
    try {
      const ids = idsOf(req);
      if (
        creatorRuleOpens(subject, action) &&
        Array.isArray(ids) && ids.length > 0 && ids.length <= CREATOR_RULE_MAX_IDS && ids.every((id) => typeof id === 'string') &&
        (await Promise.all(ids.map((id: string) => creatorCanOpen(req.user!, subject, id)))).every(Boolean)
      ) {
        next();
        return;
      }
    } catch (err) {
      next(err);
      return;
    }
    res.status(403).json({ error: 'Insufficient permissions' });
  };
}

/**
 * `canDo('update', 'Lead')` with the lead creator path (PRD 4): the person passes with Edit leads, or when they made the
 * lead and are still on it. The handler behind it tells the two apart and limits the creator's fields. Anything else
 * answers 403, whether the lead exists or not.
 */
export function canDoOrLeadCreator() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.ability || !req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (req.ability.can('update', 'Lead')) {
      next();
      return;
    }
    try {
      if (await isCreatorStillAttached(req.user, 'Lead', String(req.params.id))) {
        next();
        return;
      }
    } catch (err) {
      next(err);
      return;
    }
    res.status(403).json({ error: 'Insufficient permissions' });
  };
}

/**
 * `canDoAny` with the lead creator path: the person passes with any one of the grants, or when they made the lead and
 * are still on it (the same M3 answer `canDoOrLeadCreator` asks). A lead's own phones and emails take Edit job and lead
 * contact details or Edit leads, and Edit leads is the switch the creator path stands in for. Anything else answers
 * 403, whether the lead exists or not.
 */
export function canDoAnyOrLeadCreator(pairs: [Action, Subject][]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.ability || !req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (pairs.some(([action, subject]) => req.ability!.can(action, subject))) {
      next();
      return;
    }
    try {
      if (await isCreatorStillAttached(req.user, 'Lead', String(req.params.id))) {
        next();
        return;
      }
    } catch (err) {
      next(err);
      return;
    }
    res.status(403).json({ error: 'Insufficient permissions' });
  };
}
