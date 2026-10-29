import { Request, Response, NextFunction } from 'express';
import type { Action, Subject } from '../lib/permissions/catalog';

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
