/**
 * Seeds an organization's default estimate boilerplate.
 *
 * Run with: cd backend && npm run db:seed:org
 *
 * SEED_ORG_ID=<uuid> npm run db:seed:org points the seed at whatever org you
 * name, and OVERWRITES that org's estimate terms, notes and payment terms with
 * the placeholder copy below. The only guard here keys on `is_demo`, so it
 * offers a real tenant no protection at all: naming a live customer's org id
 * destroys boilerplate they have customised, with no confirmation and no undo.
 * Know which id you are passing, and which database `backend/.env` points at.
 *
 * The copy below is generic placeholder text, not any one company's legal
 * paperwork, and the routine refuses to write to an organization flagged
 * `is_demo`. Both matter because the default target id is a plain stub row in a
 * fresh database but the SHARED DEMO ORG on the deployed environments, whose
 * estimate pages are served to unauthenticated visitors. `backend/.env` points
 * at staging, so an unguarded local run lands there, not on a local database.
 *
 * SEED_ALLOW_DEMO_ORG=true overrides the demo guard. Only CI sets it, because
 * only CI's Postgres is thrown away at the end of the run. Migration
 * 20260619000000_org_is_demo_flag flips is_demo TRUE on the default id, so even
 * a freshly migrated throwaway database needs the override.
 */
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

export const DEFAULT_SEED_ORG_ID = '00000000-0000-0000-0000-000000000001';

export const ESTIMATE_TERMS = `Estimates are an approximation of charges to you, and they are based on the anticipated details of the work to be done. It is possible for unexpected complications to cause some deviation from the estimate. If additional parts or labor are required you will be contacted immediately.`;

export const ESTIMATE_NOTES = `1. Any change to product quantities or labor that is not covered by this estimate will be charged separately.

2. Warranty coverage applies only to parts, materials, and hardware supplied and installed by this company. Alterations, modifications, or repairs performed by anyone not authorized by this company void the warranty immediately. That includes adding materials or components to the hardware as originally installed.

**Coverage:**
Warranty coverage runs for 90 days from the date installation is completed. Accessories such as cables, connectors, and moldings are covered for 30 days.

**Exclusions:**
Coverage is void in any of the following cases:
- Unauthorized modifications or repairs
- Tampering or adjustments
- Damage from misuse or interference
- Acts of vandalism

**Ownership:**
All materials and products remain the property of this company until payment is received in full.

**Service Hours:**
Warranty service is available Monday through Friday, 9:00 am to 5:00 pm, excluding holidays. Work requested outside those hours is billed at the after-hours rate.

**Existing Equipment Disclaimer:**
This company is not responsible for the operation, compatibility, or condition of any pre-existing equipment that falls outside this scope of work, whether it is connected to the work performed or simply located nearby.

**Post-Warranty Service:**
Once the warranty period ends, troubleshooting and repair are billed at an hourly rate per technician, plus materials. Ask about extended coverage options for continued protection.

3. The customer is responsible for arranging site access for technicians. Delays caused by access problems are billed at an hourly rate.

4. Prices are subject to change after 60 days.

5. The purchaser is responsible for any patching, painting, or ceiling tile replacement required as a result of the proposed scope of work.

6. Change orders must be submitted in writing at least 48 hours in advance.

7. All equipment remains the property of this company until the final payment is settled. Ownership transfers to the client once that payment is received.`;

export const ESTIMATE_PAYMENT_TERMS = `**Late Payment:** Any invoice amount that remains unpaid more than thirty (30) days after the invoice date is subject to a late charge of 5% per month, or the maximum rate allowed by law, whichever is less.

- 50% due upon acceptance
- 50% due upon completion
- Deposits are non-refundable once work has been scheduled
- Card payments may carry an additional processing fee
- Prices are subject to change after 60 days`;

/** The two calls this routine is allowed to make, and nothing else. */
export type SeedOrganizationClient = Pick<PrismaClient, 'organization'>;

/**
 * Reads the demo-org override out of its raw environment-variable form.
 *
 * Exported, and its own function, because environment variables arrive as
 * STRINGS: every value except the literal 'true' below is truthy in JavaScript,
 * so a `Boolean(process.env.SEED_ALLOW_DEMO_ORG)` reading would turn
 * SEED_ALLOW_DEMO_ORG=false into permission to overwrite the public demo org.
 * Strict equality, and a test table that pins it.
 */
export function parseAllowDemoOrg(raw: string | undefined): boolean {
  return raw === 'true';
}

export interface SeedOrganizationOptions {
  /**
   * Permit writing to an organization flagged `is_demo`. Set ONLY for a
   * throwaway database that is discarded at the end of the run, which in
   * practice means CI. Never set it against a deployed environment.
   */
  allowDemoOrg?: boolean;
}

export async function seedOrganization(
  client: SeedOrganizationClient,
  orgId: string,
  options: SeedOrganizationOptions = {},
): Promise<void> {
  // Read before writing. The default id is the shared demo organization on
  // staging and production, and that org's estimate pages are served to
  // unauthenticated visitors, so a stray local run publishes whatever it wrote.
  // Refuse unless the caller has said this database is disposable.
  const org = await client.organization.findUnique({
    where: { id: orgId },
    select: { id: true, is_demo: true },
  });

  if (!org) {
    throw new Error(
      `No organization exists at ${orgId}. Nothing was written. ` +
        'Set SEED_ORG_ID to the id you meant to seed.',
    );
  }

  if (org.is_demo && !options.allowDemoOrg) {
    throw new Error(
      `Organization ${orgId} is a demo organization, whose estimate pages are ` +
        'served to unauthenticated visitors. Refusing to overwrite its estimate ' +
        'boilerplate. Nothing was written. If this really is a throwaway ' +
        'database that gets discarded at the end of the run, set ' +
        'SEED_ALLOW_DEMO_ORG=true. Never set it against a deployed environment.',
    );
  }

  await client.organization.update({
    where: { id: orgId },
    data: {
      estimate_terms: ESTIMATE_TERMS,
      estimate_notes: ESTIMATE_NOTES,
      estimate_payment_terms: ESTIMATE_PAYMENT_TERMS,
    },
  });
  console.log('Organization seeded:', orgId);
}

// Only run when executed directly, never when imported by a test.
if (require.main === module) {
  dotenv.config();
  const prisma = new PrismaClient();
  seedOrganization(prisma, process.env.SEED_ORG_ID ?? DEFAULT_SEED_ORG_ID, {
    allowDemoOrg: parseAllowDemoOrg(process.env.SEED_ALLOW_DEMO_ORG),
  })
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
