import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';

// Admin management of the many-to-many User<->PhoneNumber mapping (comm caller-ID
// overhaul slice 3). These endpoints populate what resolveOutboundNumber (slice 2)
// reads: which users may send from which numbers, each user's default, and the
// org default. Every handler is admin-gated (canDo('update','Organization')) and
// tenant-scoped — a number/user outside the caller's org is a 404.
//
// ASSIGNMENT DOES NOT TOUCH ROUTING (2026-08-12). It used to: assigning a number
// created a voicemail menu, pointed the number's dial route at it, and
// overwrote `route_to` - so buying a number made it ring, and then assigning it
// to a user made it stop ringing and go to voicemail. That was an attempt to
// automate a ring group, but only the voicemail half is API-drivable, and the
// other half was a manual step in a vendor dashboard no customer has an account
// for. Under the model this now implements, routing belongs to the NUMBER (the
// forward destination set at purchase, editable on PATCH /numbers/:id) and an
// assignment is a statement of responsibility: it says who is accountable for
// the calls that number takes, which is what attribution reads at ingest.

function userName(u: { first_name: string | null; last_name: string | null }): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || 'User';
}

// resolveOutboundNumber only ever presents an ACTIVE number, so a default on a
// paused or released number would be skipped silently on every call and text.
// Refuse it here rather than trusting the page to have hidden it. Clearing a
// default is always allowed. The message reaches the UI, so it names no vendor.
function notDefaultableReason(status: string | null | undefined): string | null {
  if (status === 'active') return null;
  if (status === 'paused') return "A paused number can't be a default caller ID.";
  if (status === 'released') return "A released number can't be a default caller ID.";
  return "This number can't be a default caller ID right now.";
}

// ─── GET /number-assignments ─────────────────────────────────────────────────
// Feeds Settings > Caller ID. A released number is gone from the phone system
// and can never present as caller ID again, so it is left out entirely, and so
// is a `failed` row (a purchase that never completed - not a number the org
// has). A pending purchase stays listed but is not active, so the page refuses
// it as a default. A paused number stays in the list (it can come back) and its `status` lets the
// page refuse it as a default. `sms_enabled` drives the calls-only warning: the
// outbound resolver skips a default that cannot text when sending a text.
export async function listNumberAssignments(req: Request, res: Response) {
  try {
    const [numbers, users] = await Promise.all([
      prisma.phoneNumber.findMany({
        where: { ...tenantWhere(req), status: { notIn: ['released', 'failed'] } },
        orderBy: { created_at: 'asc' },
        select: {
          id: true,
          e164: true,
          label: true,
          is_org_default: true,
          sms_enabled: true,
          status: true,
          type: true,
          user_links: {
            select: {
              user_id: true,
              is_default: true,
              user: { select: { id: true, first_name: true, last_name: true } },
            },
          },
        },
      }),
      prisma.user.findMany({
        where: { ...tenantWhere(req), is_active: true },
        orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }],
        select: { id: true, first_name: true, last_name: true },
      }),
    ]);

    res.json({
      numbers: numbers.map((n) => ({
        id: n.id,
        e164: n.e164,
        label: n.label,
        is_org_default: n.is_org_default,
        sms_enabled: n.sms_enabled,
        status: n.status,
        type: n.type,
        assignments: n.user_links.map((l) => ({
          user_id: l.user_id,
          user_name: userName(l.user),
          is_default: l.is_default,
        })),
      })),
      users: users.map((u) => ({ id: u.id, name: userName(u) })),
    });
  } catch (err) {
    logger.error('Failed to list number assignments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PUT /numbers/:id/assignments ────────────────────────────────────────────
export const setAssignmentsSchema = z.object({
  user_ids: z.array(z.string().uuid()).max(200),
});

export async function setNumberAssignments(req: Request, res: Response) {
  try {
    const numberId = req.params.id as string;
    const number = await prisma.phoneNumber.findFirst({
      where: { id: numberId, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!number) {
      res.status(404).json({ error: 'Phone number not found' });
      return;
    }

    // Dedupe first: user_ids is a SET (the assignment set). Comparing a raw
    // count of distinct in-org rows against a list length would falsely 400 on a
    // repeated id, so collapse repeats before the membership check.
    const userIds: string[] = [...new Set<string>(req.body.user_ids)];
    if (userIds.length > 0) {
      // Tenant safety: every user assigned to an org number must be in the org.
      const inOrg = await prisma.user.count({ where: { id: { in: userIds }, ...tenantWhere(req) } });
      if (inOrg !== userIds.length) {
        res.status(400).json({ error: 'One or more users are not in your organization' });
        return;
      }
    }

    await prisma.$transaction(async (tx) => {
      // Drop links that are no longer wanted (a removed link that held is_default
      // just disappears → that user falls back to the org default). Retained links
      // are preserved via createMany skipDuplicates, keeping their is_default flag.
      await tx.userPhoneNumber.deleteMany({
        where: { phone_number_id: numberId, ...(userIds.length ? { user_id: { notIn: userIds } } : {}) },
      });
      if (userIds.length) {
        await tx.userPhoneNumber.createMany({
          data: userIds.map((uid) => ({ user_id: uid, phone_number_id: numberId })),
          skipDuplicates: true,
        });
      }
    });

    void logAudit({
      req,
      action: 'phone_number.assignments_updated',
      resourceType: 'PhoneNumber',
      resourceId: numberId,
      metadata: { user_ids: userIds },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to set number assignments:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PUT /users/:userId/default-number ───────────────────────────────────────
// Picks which of a user's already-assigned numbers is their outbound default.
// Affects resolveOutboundNumber's caller-ID choice and nothing else.
export const setUserDefaultSchema = z.object({
  phone_number_id: z.string().uuid().nullable(),
});

export async function setUserDefaultNumber(req: Request, res: Response) {
  try {
    const userId = req.params.userId as string;
    const user = await prisma.user.findFirst({
      where: { id: userId, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const phoneNumberId: string | null = req.body.phone_number_id;
    if (phoneNumberId) {
      // The default must be a number the user is actually assigned to.
      const link = await prisma.userPhoneNumber.findUnique({
        where: { user_id_phone_number_id: { user_id: userId, phone_number_id: phoneNumberId } },
        select: { user_id: true, phone_number: { select: { status: true } } },
      });
      if (!link) {
        res.status(400).json({ error: 'That number is not assigned to this user' });
        return;
      }
      const refused = notDefaultableReason(link.phone_number.status);
      if (refused) {
        res.status(400).json({ error: refused });
        return;
      }
    }

    await prisma.$transaction(async (tx) => {
      // At most one default per user: clear the prior default, then set the new one.
      await tx.userPhoneNumber.updateMany({
        where: { user_id: userId, is_default: true },
        data: { is_default: false },
      });
      if (phoneNumberId) {
        await tx.userPhoneNumber.update({
          where: { user_id_phone_number_id: { user_id: userId, phone_number_id: phoneNumberId } },
          data: { is_default: true },
        });
      }
    });

    void logAudit({
      req,
      action: 'phone_number.user_default_set',
      resourceType: 'User',
      resourceId: userId,
      metadata: { phone_number_id: phoneNumberId },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to set user default number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PUT /numbers/:id/org-default ────────────────────────────────────────────
export const setOrgDefaultSchema = z.object({
  is_org_default: z.boolean().optional(),
});

export async function setOrgDefaultNumber(req: Request, res: Response) {
  try {
    const numberId = req.params.id as string;
    const number = await prisma.phoneNumber.findFirst({
      where: { id: numberId, ...tenantWhere(req) },
      select: { id: true, status: true },
    });
    if (!number) {
      res.status(404).json({ error: 'Phone number not found' });
      return;
    }

    const setDefault = req.body.is_org_default !== false; // default = set as org default
    const refused = setDefault ? notDefaultableReason(number.status) : null;
    if (refused) {
      res.status(400).json({ error: refused });
      return;
    }

    await prisma.$transaction(async (tx) => {
      if (setDefault) {
        // At most one org default: clear the prior, then set this one.
        await tx.phoneNumber.updateMany({
          where: { ...tenantWhere(req), is_org_default: true },
          data: { is_org_default: false },
        });
        await tx.phoneNumber.update({ where: { id: numberId }, data: { is_org_default: true } });
      } else {
        await tx.phoneNumber.update({ where: { id: numberId }, data: { is_org_default: false } });
      }
    });

    void logAudit({
      req,
      action: 'phone_number.org_default_set',
      resourceType: 'PhoneNumber',
      resourceId: numberId,
      metadata: { is_org_default: setDefault },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Failed to set org default number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
