import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { resolveOutboundNumber } from '../lib/communication/resolveOutboundNumber';

/**
 * "My outbound number" resolver (master plan Task B1) — the /phone tab's
 * caller-ID source. A thin wrapper over `resolveOutboundNumber` for the
 * CURRENT user only (no explicit pick here; that's the from-number picker,
 * Task B3). Tenant-scoped because every candidate query inside the resolver
 * is filtered on req.user's organization_id — this org can never resolve to
 * another org's number.
 */
export async function getMyOutboundNumber(req: Request, res: Response) {
  try {
    const resolved = await resolveOutboundNumber(prisma, {
      orgId: req.user!.organization_id,
      userId: req.user!.id,
    });

    if (!resolved) {
      res.json({ none: true });
      return;
    }

    const row = await prisma.phoneNumber.findUnique({
      where: { id: resolved.phone_number_id },
      select: { formatted: true, e164: true },
    });

    res.json({
      provider_number_id: resolved.ctm_number_id,
      // TODO(phone-api-neutral-names): deprecated alias, kept one release so a
      // browser still on an old bundle (stale service worker) keeps its caller
      // ID. Remove once no frontend reads it.
      ctm_number_id: resolved.ctm_number_id,
      phone_number_id: resolved.phone_number_id,
      formatted: row?.formatted ?? row?.e164 ?? null,
    });
  } catch (err) {
    logger.error('Failed to resolve outbound number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * "My numbers" (master plan Task B3) — the /phone tab's caller-ID PICKER
 * allow-list. Unlike /number-assignments (ADMIN-gated, the full org roster),
 * this returns ONLY what the CURRENT user may legitimately dial from: their
 * own UserPhoneNumber assignments plus the org default (deduped when the org
 * default is also one of their assignments). Never free text, never another
 * user's numbers — the picker in PhoneShell renders exactly this closed list.
 */
export async function getMyNumbers(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const userId = req.user!.id;
    const numberWhere = {
      organization_id: orgId,
      status: 'active',
      ctm_number_id: { not: null },
    } as const;

    const [links, orgDefault] = await Promise.all([
      prisma.userPhoneNumber.findMany({
        where: { user_id: userId, phone_number: numberWhere },
        select: {
          is_default: true,
          phone_number: {
            select: {
              id: true,
              ctm_number_id: true,
              formatted: true,
              e164: true,
              is_org_default: true,
            },
          },
        },
        orderBy: { phone_number: { created_at: 'asc' } },
      }),
      prisma.phoneNumber.findFirst({
        where: { ...numberWhere, is_org_default: true },
        select: { id: true, ctm_number_id: true, formatted: true, e164: true },
      }),
    ]);

    const numbers = links
      .filter((l): l is typeof l & { phone_number: { ctm_number_id: string } } =>
        !!l.phone_number.ctm_number_id,
      )
      .map((l) => ({
        phone_number_id: l.phone_number.id,
        provider_number_id: l.phone_number.ctm_number_id,
        // TODO(phone-api-neutral-names): deprecated alias, one release (see
        // getMyOutboundNumber).
        ctm_number_id: l.phone_number.ctm_number_id,
        formatted: l.phone_number.formatted ?? l.phone_number.e164,
        is_org_default: l.phone_number.is_org_default,
        is_user_default: l.is_default,
      }));

    if (orgDefault?.ctm_number_id && !numbers.some((n) => n.phone_number_id === orgDefault.id)) {
      numbers.push({
        phone_number_id: orgDefault.id,
        provider_number_id: orgDefault.ctm_number_id,
        // TODO(phone-api-neutral-names): deprecated alias, one release (see
        // getMyOutboundNumber).
        ctm_number_id: orgDefault.ctm_number_id,
        formatted: orgDefault.formatted ?? orgDefault.e164,
        is_org_default: true,
        is_user_default: false,
      });
    }

    res.json({ numbers });
  } catch (err) {
    logger.error('Failed to list my numbers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
