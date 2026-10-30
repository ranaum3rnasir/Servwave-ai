// The company number a call or text went through, as a link to the organization's own phone_numbers
// row (roles & permissions S08.1). The phone service's activity carries it as the tracking number
// for both directions: the line that was called or texted, or the line the call or text went out
// from. Matched inside the organization only: the same digits in another organization's list are
// never a match.
import type { Prisma, PrismaClient } from '@prisma/client';
import { normalizeNAPhone } from '../comms-identity';

type Db = PrismaClient | Prisma.TransactionClient;

/** The id of the organization's phone number the feed's tracking number names, or null. */
export async function resolveCompanyNumberId(
  db: Db,
  orgId: string,
  trackingNumber: unknown,
): Promise<string | null> {
  const raw = trackingNumber == null ? '' : String(trackingNumber);
  const e164 = normalizeNAPhone(raw) ?? raw;
  if (!e164) return null;
  const number = await db.phoneNumber.findFirst({
    where: { organization_id: orgId, e164 },
    select: { id: true },
  });
  return number?.id ?? null;
}
