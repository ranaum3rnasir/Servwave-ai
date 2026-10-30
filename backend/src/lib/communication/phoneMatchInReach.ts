import type { Request } from 'express';
import { prisma } from '../prisma';
import { matchByPhone, type IdentityMatch } from '../comms-identity';
import { canReadCustomerById } from '../permissions/customerScope';

/**
 * Re-audit P2-1 (the text and call twins of N9): the customer, open lead or vendor a phone number belongs to, as a signed-in
 * person's request may use it. `matchByPhone` answers for the whole company; a match whose customer the person cannot open
 * (a customer match, or a lead on that customer) is no match at all here, so nothing is filed on that customer and the answer
 * does not name it, exactly as for a number nobody has. The same customer reach the email side uses for the recipient's
 * customer (`customerInReach`, comm-whatsapp-email.controller.ts). A vendor match carries no customer and is kept.
 *
 * Every signed-in door resolves a number through this; permission-phone-match-reach-guard.test.ts holds the callers of the
 * raw resolver to a list with reasons.
 */
export async function matchByPhoneInReach(req: Request, raw: string): Promise<IdentityMatch | null> {
  const match = await matchByPhone(prisma, req.user!.organization_id, raw);
  if (!match?.customerId) return match;
  return (await canReadCustomerById(req, match.customerId)) ? match : null;
}
