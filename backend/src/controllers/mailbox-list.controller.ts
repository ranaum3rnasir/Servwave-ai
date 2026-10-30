import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { mailboxListForReq } from '../lib/communication/mailboxList';

const intParam = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/**
 * GET /api/communication/mailboxes - the Email page's mailbox list (PRD 10, S10.7): "My mailbox", the mailboxes handed to
 * the person, and under Communication scope All the main mailbox and a paged, searchable list of every person's mailbox,
 * each with its unread count. `selected` is the mailbox the page asks to show; the answer says which one it shows (a
 * mailbox the person may not open reads "mine"). The route puts it behind the Email plan feature and Access Communication.
 */
export async function listMailboxes(req: Request, res: Response) {
  try {
    res.json(await mailboxListForReq(req, {
      selected: req.query.selected,
      search: typeof req.query.search === 'string' ? req.query.search : undefined,
      offset: intParam(req.query.offset),
      limit: intParam(req.query.limit),
    }));
  } catch (err) {
    logger.error('Failed to list the mailboxes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
