/**
 * Ruling Q3 (b1, ticket 29): the inbox emails a teammate BY ID, because a non-Admin's team list no longer carries
 * addresses (M3). The server resolves each id to the person's address here, and only for an active, un-erased person in
 * the sender's own company. Anything else (another company's person, a deactivated one, an id that names no one) makes
 * the whole answer null, so the send is refused before anything goes out and the answer never says which id failed.
 */
import type { PrismaClient } from '@prisma/client';

/** The largest number of teammates one send may name by id: a sanity cap, well above any team list's group. */
export const MAX_TEAMMATE_RECIPIENTS = 200;

export async function teammateAddresses(db: Pick<PrismaClient, 'user'>, organizationId: string, ids: readonly string[]): Promise<string[] | null> {
  // Ids are compared in lower case: the database matches an id whatever its case and answers in lower case, so the same
  // person named twice in two cases is one recipient, and every id is counted against the rows that came back.
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (wanted.length === 0) return [];
  const people = await db.user.findMany({
    where: { id: { in: wanted }, organization_id: organizationId, is_active: true, erased_at: null },
    select: { id: true, email: true },
  });
  const found = new Set(people.map((p) => p.id.toLowerCase()));
  if (people.length !== wanted.length || wanted.some((id) => !found.has(id))) return null;
  // The addresses come from the rows themselves, and a person with no address refuses the whole send: a send never goes
  // out with a recipient silently missing.
  const addresses = people.map((p) => p.email?.trim() ?? '');
  return addresses.every(Boolean) ? addresses : null;
}
