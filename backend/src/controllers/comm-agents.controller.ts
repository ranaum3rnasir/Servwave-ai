import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { blockedNumberKey, findBlockedNumber } from '../lib/communication/blockedNumbers';

// ─── Zod Schemas ───────────────────────────────────────

export const blockNumberSchema = z.object({
  // Only a number that normalises to E.164 may be stored: the stored value IS
  // the key ingest compares against, so anything else would be an inert row.
  number: z
    .string()
    .min(1, 'Number is required')
    .max(40)
    .refine((v) => blockedNumberKey(v) !== null, 'Enter a 10-digit US or Canadian phone number'),
  name: z.string().max(200).nullable().optional(),
  reason: z.enum(['spam', 'not_spam', 'customer', 'other']),
  note: z.string().max(1000).nullable().optional(),
});

export const unblockNumberSchema = z.object({
  id: z.string().uuid(),
});

// ─── Mappers (snake_case Prisma row → camelCase mock shape) ──

// PhoneAgent mock shape: { id, kind, name, role, calls, answerRatePct,
//   bookingRatePct, ahtSec, sentimentPct, revenue, scriptAdherencePct, containmentPct? }
function toPhoneAgent(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    role: row.role,
    calls: row.calls,
    answerRatePct: row.answer_rate_pct,
    bookingRatePct: row.booking_rate_pct,
    ahtSec: row.aht_sec,
    sentimentPct: row.sentiment_pct,
    revenue: row.revenue == null ? 0 : Number(row.revenue),
    scriptAdherencePct: row.script_adherence_pct,
    ...(row.containment_pct == null ? {} : { containmentPct: row.containment_pct }),
    ...(row.user != null && {
      userId: row.user.id,
      linkedUser: { id: row.user.id, name: `${row.user.first_name} ${row.user.last_name}`.trim(), email: row.user.email },
    }),
  };
}

// BlockedNumber mock shape: { id, number, name?, reason, note?, blockedAt, blockedBy }
function toBlockedNumber(row: any) {
  return {
    id: row.id,
    number: row.number,
    ...(row.name == null ? {} : { name: row.name }),
    reason: row.reason,
    ...(row.note == null ? {} : { note: row.note }),
    blockedAt: row.blocked_at.toISOString(),
    blockedBy: row.blocked_by,
  };
}

// ForwardRule mock shape: { id, from, toGroupId?, toMemberId?, enabled }
function toForwardRule(row: any) {
  return {
    id: row.id,
    from: row.from,
    ...(row.to_group_id == null ? {} : { toGroupId: row.to_group_id }),
    ...(row.to_member_id == null ? {} : { toMemberId: row.to_member_id }),
    enabled: row.enabled,
  };
}

// TeamMember mock shape: { id, name, email, role, online? }
function toTeamMember(row: any) {
  return {
    id: row.id,
    name: `${row.first_name} ${row.last_name}`.trim(),
    email: row.email,
    role: row.role,
    online: row.is_active,
  };
}

// ─── Phone Agent Handlers ──────────────────────────────

export async function listPhoneAgents(req: Request, res: Response) {
  try {
    const agents = await prisma.phoneAgent.findMany({
      where: tenantWhere(req),
      orderBy: { name: 'asc' },
      include: {
        user: { select: { id: true, first_name: true, last_name: true, email: true } },
      },
    });

    res.json({ agents: agents.map(toPhoneAgent) });
  } catch (err) {
    logger.error('Failed to list phone agents:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getPhoneAgent(req: Request, res: Response) {
  try {
    const agent = await prisma.phoneAgent.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      include: {
        user: { select: { id: true, first_name: true, last_name: true, email: true } },
      },
    });

    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    res.json({ agent: toPhoneAgent(agent) });
  } catch (err) {
    logger.error('Failed to get phone agent:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Blocked Number Handlers ───────────────────────────

export async function listBlockedNumbers(req: Request, res: Response) {
  try {
    const blocked = await prisma.blockedNumber.findMany({
      where: tenantWhere(req),
      orderBy: { blocked_at: 'desc' },
    });

    res.json({ blocked: blocked.map(toBlockedNumber) });
  } catch (err) {
    logger.error('Failed to list blocked numbers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getBlockedNumber(req: Request, res: Response) {
  try {
    const blocked = await prisma.blockedNumber.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    if (!blocked) {
      res.status(404).json({ error: 'Blocked number not found' });
      return;
    }

    res.json({ blocked: toBlockedNumber(blocked) });
  } catch (err) {
    logger.error('Failed to get blocked number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Block a number — POST /api/communication/blocked
export async function blockNumber(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const blockedBy = `${req.user!.first_name} ${req.user!.last_name}`.trim();

    // Unreachable in practice - blockNumberSchema's refine runs in validate()
    // before this handler - but it is what narrows `key` to a string.
    const key = blockedNumberKey(req.body.number);
    if (!key) {
      res.status(400).json({ error: 'Enter a 10-digit US or Canadian phone number' });
      return;
    }

    // Server-side duplicate check, scoped to this org so one org's list can
    // never reject another's. Replaces the old client-side check, which could
    // not see a row a second browser had just written.
    const dup = await findBlockedNumber(prisma, orgId, req.body.number);
    if (dup) {
      res.status(409).json({ error: 'That number is already blocked', code: 'ALREADY_BLOCKED' });
      return;
    }

    const blocked = await prisma.blockedNumber.create({
      data: {
        number: key,
        name: req.body.name ?? null,
        reason: req.body.reason,
        note: req.body.note ?? null,
        blocked_at: new Date(),
        blocked_by: blockedBy || req.user!.email,
        blocked_by_id: req.user!.id,
        organization_id: orgId,
      },
    });

    res.status(201).json({ blocked: toBlockedNumber(blocked) });
  } catch (err) {
    logger.error('Failed to block number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// Unblock a number — POST /api/communication/blocked/unblock { id }
export async function unblockNumber(req: Request, res: Response) {
  try {
    // deleteMany with id+org filter is atomic — only removes rows in the org.
    const result = await prisma.blockedNumber.deleteMany({
      where: { id: req.body.id as string, ...tenantWhere(req) },
    });

    if (result.count === 0) {
      res.status(404).json({ error: 'Blocked number not found' });
      return;
    }

    res.json({ message: 'Number unblocked' });
  } catch (err) {
    logger.error('Failed to unblock number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Forward Rule Handlers ─────────────────────────────

export async function listForwardRules(req: Request, res: Response) {
  try {
    const rules = await prisma.emailForwardRule.findMany({
      where: tenantWhere(req),
      orderBy: { created_at: 'asc' },
    });

    res.json({ rules: rules.map(toForwardRule) });
  } catch (err) {
    logger.error('Failed to list forward rules:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Team Member Handlers ──────────────────────────────

// Maps active Users to the TeamMember mock shape.
export async function listTeamMembers(req: Request, res: Response) {
  try {
    const users = await prisma.user.findMany({
      where: { ...tenantWhere(req), is_active: true },
      orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }],
    });

    res.json({ members: users.map(toTeamMember) });
  } catch (err) {
    logger.error('Failed to list team members:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
