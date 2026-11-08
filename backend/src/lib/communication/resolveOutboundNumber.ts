import type { Prisma, PrismaClient } from '@prisma/client';

type Db = Prisma.TransactionClient | PrismaClient;

export interface ResolveOutboundParams {
  orgId: string;
  /** The sending user. Omitted for system sends (e.g. automations) — then the
   *  per-user branches are skipped and resolution starts at the org default. */
  userId?: string;
  /** A number the caller explicitly picked (Slice 5). Honored only if it is
   *  assigned to `userId` and otherwise valid; ignored (falls through) if not. */
  explicitNumberId?: string;
  /** SMS requires an sms_enabled number; calls do not. */
  requireSms?: boolean;
}

export interface ResolvedOutboundNumber {
  /** The CTM "TPN…" id — placeCall.from_number + sendSms.from + embed dialFrom. */
  ctm_number_id: string;
  phone_number_id: string;
}

/**
 * Resolve which org tracking number an outbound call/SMS presents as caller ID.
 *
 * Precedence (first match wins):
 *   1. explicit pick — only if assigned to the user and otherwise valid
 *   2. the user's default assignment (`UserPhoneNumber.is_default`)
 *   3. the org default (`PhoneNumber.is_org_default`)
 *   4. legacy fallback — the org's oldest active number (pre-mapping behavior)
 *   5. null — the org owns no usable number
 *
 * Every candidate must be active, carry a `ctm_number_id`, belong to `orgId`,
 * and (when `requireSms`) be sms_enabled. Returns the resolved TPN id + row id,
 * or null when nothing qualifies (callers 409/NO_*_NUMBER on null).
 */
export async function resolveOutboundNumber(
  db: Db,
  params: ResolveOutboundParams,
): Promise<ResolvedOutboundNumber | null> {
  const { orgId, userId, explicitNumberId, requireSms } = params;

  const numberWhere: Prisma.PhoneNumberWhereInput = {
    organization_id: orgId,
    status: 'active',
    ctm_number_id: { not: null },
    ...(requireSms ? { sms_enabled: true } : {}),
  };

  const toResult = (
    pn: { id: string; ctm_number_id: string | null } | null | undefined,
  ): ResolvedOutboundNumber | null =>
    pn && pn.ctm_number_id ? { ctm_number_id: pn.ctm_number_id, phone_number_id: pn.id } : null;

  // 1) Explicit pick — honored only when it is assigned to THIS user and valid.
  if (explicitNumberId && userId) {
    const link = await db.userPhoneNumber.findFirst({
      where: { user_id: userId, phone_number_id: explicitNumberId, phone_number: numberWhere },
      select: { phone_number: { select: { id: true, ctm_number_id: true } } },
    });
    const hit = toResult(link?.phone_number);
    if (hit) return hit;
  }

  // 2) The user's default assignment.
  if (userId) {
    const link = await db.userPhoneNumber.findFirst({
      where: { user_id: userId, is_default: true, phone_number: numberWhere },
      select: { phone_number: { select: { id: true, ctm_number_id: true } } },
    });
    const hit = toResult(link?.phone_number);
    if (hit) return hit;
  }

  // 3) The org default.
  const orgDefault = await db.phoneNumber.findFirst({
    where: { ...numberWhere, is_org_default: true },
    select: { id: true, ctm_number_id: true },
  });
  const orgHit = toResult(orgDefault);
  if (orgHit) return orgHit;

  // 4) Legacy fallback — the org's oldest active number (pre-mapping behavior).
  const legacy = await db.phoneNumber.findFirst({
    where: numberWhere,
    orderBy: { created_at: 'asc' },
    select: { id: true, ctm_number_id: true },
  });
  return toResult(legacy);
}
