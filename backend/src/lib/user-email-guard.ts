import { prisma } from './prisma';

/**
 * Non-disclosive by design: never reveals which org owns the email, to
 * preserve cross-tenant privacy (org B should not learn an email belongs
 * to org A). Used identically by both create and invite — see
 * md_files/plans/security/2026-07-16-single-org-email-guard-design.md.
 */
export const EMAIL_ALREADY_REGISTERED_MSG =
  "This email already belongs to a Servwave account and can't be added to another organization.";

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super(EMAIL_ALREADY_REGISTERED_MSG);
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/**
 * Deliberately unscoped (no tenantWhere) — checks across every organization,
 * not just the caller's. Case-insensitive to also catch legacy/imported rows
 * that predate the emailSchema lowercase-on-write normalization.
 */
export async function assertEmailAvailable(email: string): Promise<void> {
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existing) {
    throw new EmailAlreadyRegisteredError();
  }
}
