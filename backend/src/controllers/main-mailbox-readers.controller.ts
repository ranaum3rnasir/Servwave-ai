import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';
import { linkReader, linkedReaders, readerCandidates, unlinkReader } from '../lib/communication/mainMailboxReaders';

const intParam = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

const pageQuery = (req: Request) => ({
  search: typeof req.query.search === 'string' ? req.query.search : undefined,
  offset: intParam(req.query.offset),
  limit: intParam(req.query.limit),
});

/**
 * The Sender Address page's "People who read the main mailbox" (PRD 10, S10.8). Every route is Company settings behind
 * the Email plan feature, like the page; who actually reads the main mailbox is M11's rule (communicationScope.ts).
 */

/** GET /api/organization/email-sender/readers - the active people linked to the main mailbox, paged. */
export async function listReaders(req: Request, res: Response) {
  try {
    res.json(await linkedReaders(req, pageQuery(req)));
  } catch (err) {
    logger.error('Failed to list the main mailbox readers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** GET /api/organization/email-sender/readers/candidates - the active people not linked yet: the picker, searched and paged. */
export async function listReaderCandidates(req: Request, res: Response) {
  try {
    res.json(await readerCandidates(req, pageQuery(req)));
  } catch (err) {
    logger.error('Failed to list the main mailbox reader candidates:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** PUT /api/organization/email-sender/readers/:userId - link one active person. Linking twice is one link. */
export async function addReader(req: Request, res: Response) {
  try {
    const userId = String(req.params.userId);
    const result = await linkReader(req, userId);
    if (!result.ok) {
      if (result.reason === 'inactive') res.status(400).json({ error: 'Only active people can read the main mailbox.' });
      else if (result.reason === 'no_main_mailbox') res.status(409).json({ error: 'Your company has no main mailbox yet.' });
      else res.status(404).json({ error: 'Person not found' });
      return;
    }
    if (result.changed) {
      await logAudit({
        req, action: 'mailbox.reader_linked', resourceType: 'Mailbox', resourceId: result.mailboxId, metadata: { user_id: userId },
      });
    }
    res.json({ id: userId });
  } catch (err) {
    logger.error('Failed to link a main mailbox reader:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** DELETE /api/organization/email-sender/readers/:userId - unlink one person; it takes effect on their next request. */
export async function removeReader(req: Request, res: Response) {
  try {
    const userId = String(req.params.userId);
    const result = await unlinkReader(req, userId);
    if (result.changed) {
      await logAudit({
        req, action: 'mailbox.reader_unlinked', resourceType: 'Mailbox', resourceId: result.mailboxId, metadata: { user_id: userId },
      });
    }
    res.json({ id: userId });
  } catch (err) {
    logger.error('Failed to unlink a main mailbox reader:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
