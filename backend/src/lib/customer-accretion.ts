import { Prisma } from '@prisma/client';
import { normalizeEmail, normalizePhone } from './customer-duplicate';

type Tx = Prisma.TransactionClient;

/**
 * Workiz-style accretion (spec: md_files/plans/customers/2026-07-14-unified-client-creation.md
 * §3/§5.3). A phone/email typed while linking a lead/job to an EXISTING customer never
 * overwrites that customer's primary — it is added as a new secondary CustomerPhone/
 * CustomerEmail, unless it already matches (normalized) something the customer already has.
 * No-op when neither phone nor email is supplied. CustomerPhone/CustomerEmail have no
 * organization_id column — they are reached only via the (already tenant-scoped) customer.
 */
export async function accreteContactMethods(
  tx: Tx,
  customerId: string,
  input: { phone?: string | null; email?: string | null },
): Promise<void> {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  if (!phone && !email) return;

  const existing = await tx.customer.findUnique({
    where: { id: customerId },
    select: {
      phone: true,
      email: true,
      phones: { select: { phone: true } },
      extra_emails: { select: { email: true } },
    },
  });
  if (!existing) return;

  if (phone) {
    const existingPhones = [existing.phone, ...existing.phones.map((p) => p.phone)]
      .map((p) => normalizePhone(p))
      .filter((p): p is string => Boolean(p));
    if (!existingPhones.includes(phone)) {
      await tx.customerPhone.create({ data: { customer_id: customerId, phone, is_primary: false } });
    }
  }

  if (email) {
    const existingEmails = [existing.email, ...existing.extra_emails.map((e) => e.email)]
      .map((e) => normalizeEmail(e))
      .filter((e): e is string => Boolean(e));
    if (!existingEmails.includes(email)) {
      await tx.customerEmail.create({ data: { customer_id: customerId, email: input.email!.trim() } });
    }
  }
}
