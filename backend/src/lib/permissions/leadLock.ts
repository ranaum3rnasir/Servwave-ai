import type { NextFunction, Request, Response } from 'express';
import type { LeadStatus } from '@prisma/client';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { logger } from '../logger';
import { canAccessRow } from './enforce';
import { TERMINAL_LEAD_STATUSES } from '../../services/lead-stage.service';

/**
 * The closed-lead lock (Roles & Permissions, PRD 5, S05.14): one answer to "is this lead closed for writes to its own
 * contact entries".
 *
 * A lead is closed while it is Won or Lost: the statuses the lead pipeline
 * already calls terminal, so the lock follows that list and needs no copy of it. Writing a closed lead's own phones,
 * emails, name or company is refused for everyone. No switch lifts it, and Change locked jobs, which is about jobs,
 * never applies. The way back is to reopen the lead. The status is read on every call and never cached, so a reopen
 * lifts the lock on the next request.
 *
 * It covers only the lead's own entries. The customer's own phones and emails, on the customer record, never lock.
 */

/** The one refusal, on the server and in the line under a closed lead's contact details. */
export const LEAD_CLOSED_MESSAGE = 'This lead is closed. Reopen it to change it.';
/** The machine-readable code a refusal carries next to the message. */
export const LEAD_CLOSED_CODE = 'LEAD_CLOSED';

export function isClosedLeadStatus(status: LeadStatus): boolean {
  return TERMINAL_LEAD_STATUSES.includes(status);
}

/**
 * Is this lead closed for the person asking? True only when the lead's status is a closed one and the person can open
 * the lead at all: a lead they cannot open answers with its ordinary refusal (forbidden, or not found in another
 * company), so the lock never tells anyone the status of a lead they cannot see. `status` is passed when the caller
 * already has it.
 */
export async function leadClosedFor(req: Request, leadId: string, status?: LeadStatus): Promise<boolean> {
  const current = status ?? (await prisma.lead.findFirst({ where: { id: leadId, ...tenantWhere(req) }, select: { status: true } }))?.status;
  if (!current || !isClosedLeadStatus(current)) return false;
  return canAccessRow(req, 'Lead', prisma.lead, leadId);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Route guard for a write to a lead's own contact entries: refuses with the closed-lead message when the lead in `:id`
 * is closed. It sits after the route's own switch guard, so a person without the switch still gets that refusal first.
 * A malformed id or a lead that is not there falls through to the handler, which answers as it always has.
 */
export function refuseWhenLeadClosed() {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = String(req.params.id ?? '');
      if (!UUID.test(id)) {
        next();
        return;
      }
      if (await leadClosedFor(req, id)) {
        res.status(403).json({ error: LEAD_CLOSED_MESSAGE, code: LEAD_CLOSED_CODE });
        return;
      }
      next();
    } catch (err) {
      logger.error('Lead closed check error:', err);
      res.status(500).json({ error: 'Failed to check the lead' });
    }
  };
}
