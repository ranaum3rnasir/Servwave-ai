import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';
import { runUnscoped } from '../lib/tenant-context';
import { tenantWhere } from '../lib/tenant';
import { setUserNamePart, type UserAddressSet } from '../lib/mailbox/register';
import { HANDOVER_TARGET_REFUSED, moveMailbox, resolveHandoverTarget } from '../lib/mailbox/handover';

export const setMailboxAddressSchema = z.object({ name_part: z.string().max(200) });

/** What the person is told for each way a set or a change can be refused. Plain words, no provider named. */
const REFUSALS: Record<Exclude<UserAddressSet, { ok: true }>['reason'], { status: number; error: string }> = {
  invalid: {
    status: 400,
    error: 'Use only letters, numbers and single dots between them. The whole address can be up to 64 characters before the @.',
  },
  reserved: { status: 400, error: 'This address is reserved.' },
  taken: { status: 409, error: 'This address is already in use. Choose a different one.' },
  user_not_found: { status: 404, error: 'User not found' },
  no_mailbox: { status: 409, error: "This person doesn't have a mailbox yet." },
  no_company_part: { status: 409, error: "Email addresses aren't set up for this company yet." },
  no_domain: { status: 409, error: "Email addresses aren't set up for this company yet." },
};

/**
 * PUT /api/users/:id/mailbox-address - set or change the NAME PART of a user's mailbox address (PRD 10, S10.25). The
 * route puts it behind the company's Email plan feature and Edit users. The admin types only the name part: the server
 * builds the address from it, the company's frozen company part and the environment's mailbox domain, through the
 * register, which holds its lock and refuses a taken, malformed or reserved name part. A change leaves the old address
 * in the register, still delivering to the same mailbox; a set on a mailbox in "address needed" activates it. The
 * sign-in email is never touched. Written to the audit trail: nobody's address changes silently.
 */
export async function setMailboxAddress(req: Request, res: Response) {
  try {
    const userId = String(req.params.id);
    // The register spans every company, hence the unscoped run; the person's own company is passed explicitly.
    const result = await runUnscoped(() =>
      setUserNamePart(prisma, {
        organizationId: req.user!.organization_id,
        userId,
        namePart: (req.body as z.infer<typeof setMailboxAddressSchema>).name_part,
      }),
    );
    if (!result.ok) {
      const refusal = REFUSALS[result.reason];
      res.status(refusal.status).json({ error: refusal.error });
      return;
    }
    void logAudit({
      req,
      action: 'user.mailbox_address_changed',
      resourceType: 'User',
      resourceId: userId,
      metadata: { from: result.previousAddress, to: result.address, activated: result.activated },
    });
    res.json({ mailbox: { status: 'active', address: result.address } });
  } catch (err) {
    logger.error('Failed to set the mailbox address:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/** The body of the later move: "main" or the id of the active person who takes the mailbox. There is no default here. */
export const moveMailboxSchema = z.object({ handover_to: z.string().min(1).max(100) });

/**
 * PUT /api/users/:id/mailbox-handover - hand a LEAVER's mailbox to another person or to the main mailbox, later (PRD 10,
 * S10.22). The route puts it behind the company's Email plan feature and Edit users. The person in the path is the mailbox's
 * owner; they must already be deactivated (a mailbox in use is not moved from under its owner). Conversations and addresses
 * go with it, the previous holder loses it on their next request, and the mail is kept. Written to the audit trail.
 */
export async function moveUserMailbox(req: Request, res: Response) {
  try {
    const ownerId = String(req.params.id);
    const owner = await prisma.user.findFirst({ where: { id: ownerId, ...tenantWhere(req) }, select: { id: true, is_active: true } });
    if (!owner) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (owner.is_active) {
      res.status(409).json({ error: "Only a deactivated person's mailbox can be handed on." });
      return;
    }
    const target = await resolveHandoverTarget(prisma, {
      organizationId: req.user!.organization_id,
      leaverId: owner.id,
      raw: (req.body as z.infer<typeof moveMailboxSchema>).handover_to,
    });
    if (!target) {
      res.status(400).json({ error: HANDOVER_TARGET_REFUSED });
      return;
    }
    const outcome = await prisma.$transaction((tx) => moveMailbox(tx, { organizationId: req.user!.organization_id, ownerId: owner.id, target }));
    if (!outcome.moved) {
      res.status(409).json({ error: "This person doesn't have a mailbox to hand on." });
      return;
    }
    if (outcome.changed) {
      void logAudit({
        req,
        action: 'user.mailbox_moved',
        resourceType: 'User',
        resourceId: owner.id,
        metadata: outcome.target.kind === 'person'
          ? { handed_to: 'person', person_id: outcome.target.userId, mailbox_ids: outcome.mailboxIds }
          : { handed_to: 'main', mailbox_ids: outcome.mailboxIds },
      });
    }
    res.json({ moved: outcome.changed });
  } catch (err) {
    logger.error('Failed to move the mailbox:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
