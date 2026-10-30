import type { Request, Response } from 'express';
import { getClientIp } from '../lib/client-ip';
import { logger } from '../lib/logger';
import {
  OWNER_CANDIDATE_GONE,
  OWNER_LINK_EXPIRED_BODY,
  approveOwnerHandover,
  previewOwnerHandover,
} from '../lib/users/owner-handover';

/**
 * The Make Owner approval link (ticket 27, D1), opened from the email sent to the company's Owner. Public: the emailed link is
 * the proof, as an invite link is. The token travels in the POST body only (never the address), so it stays out of request
 * logs. Every dead link (expired, used, replaced, tampered, unknown) gets the same answer, naming no person and no company.
 */

/** POST /api/auth/owner-approval { token }: what the page shows before the Owner approves. Changes nothing. */
export async function previewOwnerApproval(req: Request, res: Response) {
  try {
    const shown = await previewOwnerHandover(req.body?.token);
    if (!shown) {
      res.status(400).json(OWNER_LINK_EXPIRED_BODY);
      return;
    }
    res.json(shown);
  } catch (err) {
    logger.error('Owner approval preview failed', { name: err instanceof Error ? err.name : typeof err });
    res.status(500).json({ error: "We couldn't open this approval link. Try again." });
  }
}

/** POST /api/auth/owner-approval/approve { token }: the Owner approves; ownership moves once. */
export async function approveOwner(req: Request, res: Response) {
  try {
    const outcome = await approveOwnerHandover(req.body?.token, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    if (outcome.kind === 'expired') {
      res.status(400).json(OWNER_LINK_EXPIRED_BODY);
      return;
    }
    if (outcome.kind === 'not_a_candidate') {
      res.status(409).json({ error: OWNER_CANDIDATE_GONE, code: 'owner_candidate_gone' });
      return;
    }
    res.json({ company_name: outcome.company_name, new_owner_name: outcome.new_owner_name });
  } catch (err) {
    logger.error('Owner approval failed', { name: err instanceof Error ? err.name : typeof err });
    res.status(500).json({ error: "We couldn't complete the hand-over. Nothing was changed. Try again." });
  }
}
