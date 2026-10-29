import type { Request } from 'express';

/**
 * Creator stamps, written once at create time and never updated.
 *
 * TWO JOBS, AND ONLY ONE OF THEM IS AUDIT.
 *
 * 1. `created_by_id` is an AUTHORIZATION INPUT: creation confers control. Whoever creates a row has
 *    full control over it - read, edit, reassign, delete - permanently, even after the work is
 *    handed to someone else. There is deliberately no transfer story, which is exactly why the
 *    column is immutable. The condition that reads it is CREATED_BY_ME in
 *    lib/permissions/defaultGrants.ts; the per-instance check is canActOnRow in
 *    lib/permissions/enforce.ts. Writing the WRONG id here therefore grants the wrong person
 *    control, not merely a wrong audit line - which is why nothing below takes it from the body.
 * 2. `created_by_name` + `created_by_source` are AUDIT ONLY: answering "who created this" months
 *    later, including after the user row is permanently deleted. Nothing reads either to decide
 *    access.
 *
 * -> md_files/specs/permissions/2026-08-04-technician-ownership-and-creator-tracking.md
 *
 * created_by_name is a deliberate denormalisation: the FK is ON DELETE SET NULL, so a permanent
 * user delete blanks created_by_id, and the snapshot is what keeps the row answerable afterwards.
 *
 * These are never sourced from the request body - the zod create schemas do not declare them, so a
 * client cannot supply one, and the acting user comes from the authenticated session.
 */

/** The authenticated user did this themselves. */
export function createdByUser(req: Request) {
  const user = req.user!;
  const name = `${user.first_name} ${user.last_name}`.trim();
  return {
    created_by_id: user.id,
    created_by_name: name || user.email,
    created_by_source: 'USER' as const,
  };
}

/**
 * The platform did this on its own - schedulers, seeds, and the derived rows a request mints
 * without a human choosing them (an auto-generated service-plan visit job). No user to record.
 */
export const CREATED_BY_SYSTEM = {
  created_by_id: null,
  created_by_name: null,
  created_by_source: 'SYSTEM' as const,
};

/**
 * The CUSTOMER did this themselves, through a public, unauthenticated surface - a Stripe webhook
 * for a checkout they completed, a public deposit payment, a public estimate approval. There is no
 * ServWave user to record and inventing one would be a lie.
 *
 * This is the case the created_by_source column exists for: without it, a client-driven row and a
 * row of unknown provenance both read back as a null created_by_id and are indistinguishable.
 */
export const CREATED_BY_CLIENT = {
  created_by_id: null,
  created_by_name: null,
  created_by_source: 'CLIENT' as const,
};
