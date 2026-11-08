import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { runWithOrg } from '../lib/tenant-context';
import { authenticate } from './authenticate';
import { requireDemoOrg } from './requireDemoOrg';

/**
 * Authentication and organization isolation middleware specifically for Bee Agent webhooks.
 *
 * Supports two modes:
 * 1. Authenticated user/app requests with a Bearer JWT (delegates to standard authenticate + requireDemoOrg).
 * 2. Inbound telephony webhooks & manual Postman testing:
 *    - Resolves organization from x-organization-id header, body.organization_id, or active demo/Bee-enabled org.
 *    - Strictly checks Bee feature entitlement (rejects non-entitled orgs with 404 FEATURE_DISABLED).
 *    - Sets req.user and establishes tenant context via runWithOrg to guarantee database isolation.
 */
export async function beeWebhookAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  // 1. If Bearer token is provided, verify user session & feature entitlement
  if (authHeader?.startsWith('Bearer ') && authHeader.trim().length > 7) {
    authenticate(req, res, (err) => {
      if (err) return next(err);
      requireDemoOrg('bee')(req, res, next);
    });
    return;
  }

  // 2. Webhook invocation without user JWT (Postman testing or telephony webhook)
  try {
    const targetOrgId =
      (req.headers['x-organization-id'] as string) ||
      (req.headers['x-org-id'] as string) ||
      req.body?.organization_id ||
      req.body?.orgId ||
      req.body?.metadata?.organizationId ||
      req.body?.call?.metadata?.organizationId ||
      req.body?.call?.metadata?.servwaveOrgId ||
      req.body?.message?.call?.metadata?.organizationId ||
      req.body?.message?.call?.metadata?.servwaveOrgId ||
      req.body?.message?.metadata?.organizationId ||
      (req.query?.orgId as string);

    let org = null;
    if (targetOrgId) {
      org = await prisma.organization.findUnique({
        where: { id: targetOrgId },
      });
      if (!org) {
        res.status(404).json({ error: 'Organization not found' });
        return;
      }
    } else {
      // Find organization with Bee enabled or demo org
      const allOrgs = await prisma.organization.findMany({
        take: 10,
        orderBy: { created_at: 'asc' },
      });

      org = allOrgs.find((o) => {
        const fo = o.feature_overrides as Record<string, any> | null;
        return o.is_demo === true || fo?.bee === true;
      });

      if (!org && allOrgs.length > 0) {
        org = allOrgs[0];
      }
    }

    if (!org) {
      res.status(404).json({ error: 'No organization found' });
      return;
    }

    const fo = org.feature_overrides as Record<string, any> | null;
    const isAllowed =
      org.is_demo === true ||
      fo?.bee === true ||
      Boolean(process.env.BEE_ALLOWED_ORG_IDS?.toLowerCase().includes(org.id.toLowerCase()));

    if (!isAllowed) {
      res.status(404).json({ error: 'FEATURE_DISABLED', feature: 'bee' });
      return;
    }

    req.user = {
      id: '00000000-0000-0000-0000-000000000000',
      email: 'bee-webhook@servwave.local',
      first_name: 'Bee',
      last_name: 'Webhook',
      role: 'ADMIN' as any,
      has_login: false,
      organization_id: org.id,
      org_is_demo: org.is_demo,
      org_plan: org.plan,
      org_features: ['bee'],
    };

    runWithOrg(org.id, () => next());
  } catch (err) {
    logger.error('[beeWebhookAuth] Error authenticating webhook request:', err);
    res.status(500).json({ error: 'Failed to authenticate webhook request' });
  }
}
