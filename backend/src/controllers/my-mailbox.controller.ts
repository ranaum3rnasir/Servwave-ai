import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { ownMailboxOf } from '../lib/mailbox/register';

/**
 * GET /api/communication/my-mailbox - the signed-in person's own mailbox: its status ("active" with an address, or
 * "address_needed" with none) and the address in full. It is the person's own address and nobody else's and it reads no
 * mail; the route puts it behind the company's Email plan feature and the Communication section gate. `mailbox` is
 * null for a person who has none.
 */
export async function getMyMailbox(req: Request, res: Response) {
  try {
    const mailbox = await ownMailboxOf(prisma, req.user!.id);
    res.json({ mailbox: mailbox ? { status: mailbox.status, address: mailbox.address } : null });
  } catch (err) {
    logger.error('Failed to read the own mailbox:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
