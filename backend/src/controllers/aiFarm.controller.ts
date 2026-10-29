import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { sendAiFarmBookingEmails } from '../lib/email';
import { logger } from '../lib/logger';

export const bookCallSchema = z
  .object({
    agentName: z.string().min(1).max(120),
    agentRole: z.string().min(1).max(160),
    day: z.string().min(1).max(60),
    slot: z.string().min(1).max(40),
  })
  .strict();

export async function bookCall(req: Request, res: Response) {
  const { agentName, agentRole, day, slot } = req.body;
  const user = req.user!;

  try {
    const org = await prisma.organization.findUnique({
      where: { id: user.organization_id },
      select: { name: true },
    });

    await sendAiFarmBookingEmails({
      requesterName: `${user.first_name} ${user.last_name}`.trim(),
      requesterEmail: user.email,
      orgName: org?.name ?? 'their business',
      agentName,
      agentRole,
      day,
      slot,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error('AI Agentic Farm booking failed:', err);
    res.status(502).json({ error: 'Could not send the booking request. Please try again.' });
  }
}
