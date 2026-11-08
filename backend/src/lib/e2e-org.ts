import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { supabaseAdmin } from './supabase';
import { env } from '../config/env';
import { purgeCustomerSubtree, purgeOrganization } from './purge';
import { DEFAULT_GRANTS } from './permissions/defaultGrants';
import { seedStarterTaskCategories } from './tasks/categories';

export const E2E_ORG_NAME_PREFIX = 'e2e-qa-';
export const E2E_EMAIL_DOMAIN = 'e2e-qa.invalid';
const ADMIN_PASSWORD = 'E2eAdmin123!@#';

/**
 * Refuse to run against any DB host not explicitly allowlisted (staging/local only).
 *
 * The Supabase POOLER hostname is shared between staging and prod, so a host-only
 * allowlist is too weak. We require BOTH:
 *   (a) DATABASE_URL hostname ∈ E2E_ALLOWED_DB_HOSTS, AND
 *   (b) E2E_ALLOWED_DB_REF set and present as a substring of DATABASE_URL — it is the
 *       Supabase project ref embedded in the connection username (e.g. `postgres.<ref>`),
 *       which uniquely identifies the staging project even on a shared pooler host.
 */
export function assertSafeDbHost(): void {
  const allow = (env.E2E_ALLOWED_DB_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const host = new URL(env.DATABASE_URL).hostname;
  if (!allow.includes(host)) {
    throw new Error(
      `E2E provisioning refusing to run: DB host "${host}" is not in the allowlist (E2E_ALLOWED_DB_HOSTS). ` +
      `Set E2E_ALLOWED_DB_HOSTS to the staging/local host only — NEVER a production host.`,
    );
  }
  const ref = (env.E2E_ALLOWED_DB_REF ?? '').trim();
  if (!ref || !env.DATABASE_URL.includes(ref)) {
    throw new Error(
      `E2E provisioning refusing to run: DB project ref "${ref}" not found in DATABASE_URL. ` +
      `Set E2E_ALLOWED_DB_REF to the staging Supabase project ref (the value embedded in the ` +
      `connection username, e.g. postgres.<ref>) — NEVER a production ref.`,
    );
  }
}

export interface ProvisionedOrg {
  organizationId: string;
  adminEmail: string;
  adminPassword: string;
  adminUserId: string;
  runId: string;
}

/** Create a fresh org + confirmed admin (Supabase Auth + Prisma User with id === auth id). */
export async function provisionTestOrg(): Promise<ProvisionedOrg> {
  assertSafeDbHost();
  const runId = crypto.randomUUID().slice(0, 8);
  const orgId = crypto.randomUUID();
  const adminEmail = `admin-${runId}@${E2E_EMAIL_DOMAIN}`;

  await prisma.organization.create({
    data: {
      id: orgId,
      plan: 'SCALE',
      name: `${E2E_ORG_NAME_PREFIX}${runId}`,
      address_line1: '1 Test Way', city: 'Boston', state: 'MA', postal_code: '02108',
      email: `org-${runId}@${E2E_EMAIL_DOMAIN}`,
      estimate_terms: 'E2E terms', estimate_notes: 'E2E notes', estimate_payment_terms: 'E2E payment terms',
      // Webhooks resolve + don't 200-no-op on CARD:
      stripe_account_id: `acct_e2e_${runId}`,
      stripe_charges_enabled: true,
      stripe_details_submitted: true,
      accepted_payment_methods: ['CARD', 'CASH', 'CHECK', 'BANK_TRANSFER', 'EXTERNAL_CARD'],
      // Deposit defaults the e2e suite assumes. The schema default is 50, but the specs hardcode a
      // 30% pinned org deposit (e.g. redesign-14 asserts send_config.deposit_percentage === 30;
      // redesign-15/17 compute 30% of the tax-inclusive total). A provisioned org MUST set 30
      // explicitly or every deposit/tax/money total drifts (50 vs 30).
      deposit_default_type: 'PERCENTAGE',
      deposit_default_percentage: 30,
    },
  });

  // Seed the org's role grants from DEFAULT_GRANTS so non-admin users (e.g. a SALES
  // walkthrough performer) have real abilities. A real org gets these on creation; a
  // provisioned throwaway org must too, or any non-admin permission check sees zero grants.
  await prisma.rolePermission.createMany({
    data: DEFAULT_GRANTS.map((g) => {
      const conditions = (g as { conditions?: Record<string, unknown> }).conditions;
      return {
        organization_id: orgId,
        role: g.role,
        action: g.action,
        subject: g.subject,
        conditions: conditions == null ? Prisma.JsonNull : (conditions as Prisma.InputJsonValue),
      };
    }),
  });

  // Every new organization starts with the three starter task categories.
  await seedStarterTaskCategories(prisma, orgId);

  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email: adminEmail, password: ADMIN_PASSWORD, email_confirm: true,
  });
  if (authError || !authData?.user) {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    throw new Error(`E2E admin Auth create failed: ${authError?.message}`);
  }

  const adminUserId = authData.user.id;
  await prisma.user.create({
    data: {
      id: adminUserId, email: adminEmail, first_name: 'E2E', last_name: 'Admin',
      role: 'ADMIN', is_active: true, has_login: true, organization_id: orgId,
    },
  });

  return { organizationId: orgId, adminEmail, adminPassword: ADMIN_PASSWORD, adminUserId, runId };
}

/**
 * Per-transaction budget. Each transaction now covers ONE customer subtree (or the org-level
 * rows), so this is a generous per-item ceiling rather than a whole-org one.
 */
const PURGE_TX_TIMEOUT_MS = 120_000;

/**
 * Tear down one org by id (Prisma name-guarded purge) + sweep ALL @e2e-qa.invalid Auth users.
 *
 * ONE TRANSACTION PER CUSTOMER SUBTREE, not one for the whole org. This used to wrap the entire
 * purge in a single interactive transaction, but purgeOrganization walks customers one subtree at
 * a time, and past roughly 40 customers that loop needs more than the timeout's worth of round
 * trips. The transaction then expires mid-purge ("Transaction not found ... refers to an old
 * closed transaction"), the whole thing rolls back, and the org survives intact. Measured on
 * staging 2026-08-04 while sweeping 10 leaked `e2e-qa-*` orgs: the 7 small ones tore down fine,
 * the 40-, 41- and 99-customer ones all failed this way - which is very likely how they leaked,
 * since each QA run against a big org left its org behind permanently.
 *
 * WHAT gets deleted is unchanged: purgeCustomerSubtree and purgeOrganization are reused as-is,
 * and purgeOrganization's own customer loop simply finds nothing left to do. Only the
 * transaction boundaries moved.
 *
 * The trade, accepted deliberately: the purge is no longer atomic. For a throwaway QA org that
 * is strictly better than the alternative - a partial purge leaves less behind than a total
 * rollback, and a retry resumes where it stopped because deleted customers stay deleted.
 *
 * Because the customer loop now runs BEFORE purgeOrganization (which is where the name guard
 * lives), the guard is asserted HERE too, up front. Without that the split would open a hole
 * the single-transaction version did not have: a mis-aimed org id would get its customer
 * subtrees deleted before anything checked the org's name.
 */
export async function teardownTestOrg(orgId?: string): Promise<void> {
  assertSafeDbHost();
  if (orgId) {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, name: true },
    });
    // Already gone - nothing to purge. Fall through to the Auth sweep, same as before.
    if (org) {
      if (!org.name.startsWith(E2E_ORG_NAME_PREFIX)) {
        throw new Error(
          `Refusing to purge org ${orgId}: name "${org.name}" does not start with guard "${E2E_ORG_NAME_PREFIX}"`,
        );
      }
      const customers = await prisma.customer.findMany({
        where: { organization_id: orgId },
        select: { id: true },
      });
      for (const c of customers) {
        await prisma.$transaction(async (tx) => {
          await purgeCustomerSubtree(tx as any, c.id, orgId);
        }, { timeout: PURGE_TX_TIMEOUT_MS });
      }
      // Small by construction now: zero customers remain, so only org-level rows are left.
      await prisma.$transaction(async (tx) => {
        await purgeOrganization(tx as any, orgId, E2E_ORG_NAME_PREFIX);
      }, { timeout: PURGE_TX_TIMEOUT_MS });
    }
  }
  // Best-effort Auth sweep — Auth users are global, can't be deleted in a Prisma tx.
  // FULL-domain match only (never a loose prefix) so it can never touch a real user.
  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    if (users.length === 0) break;
    for (const u of users) {
      if (u.email && u.email.endsWith(`@${E2E_EMAIL_DOMAIN}`)) {
        await supabaseAdmin.auth.admin.deleteUser(u.id).catch(() => {});
      }
    }
    if (users.length < 200) break;
    page += 1;
  }
}

/** Hard-fail unless the DB is the post-D3 migrated shape (§3.7 #5). */
export async function assertMigratedSchema(): Promise<void> {
  // SERV10X-61 - the one-approved-estimate-per-lead index was intentionally dropped (spec §5.9,
  // migration 20260723000000): the feature allows several simultaneously-WON estimates per lead.
  // Fingerprint on the per-container estimate counter instead - its presence proves the
  // customer-anchored migration landed (and it lands in the same migration as the index drop).
  const col = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'estimate_seq'`,
  );
  if (col.length === 0) {
    throw new Error('Schema fingerprint failed: leads.estimate_seq missing - SERV10X-61 migration not applied.');
  }
  // A RESTRICT FK on the financial spine (Payment→Invoice). confdeltype 'r' = RESTRICT.
  // Verified present on staging: payments_invoice_id_fkey (confdeltype='r').
  const fk = await prisma.$queryRawUnsafe<Array<{ confdeltype: string }>>(
    `SELECT confdeltype FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'payments' AND c.contype = 'f' AND c.confdeltype = 'r' LIMIT 1`,
  );
  if (fk.length === 0) {
    throw new Error('Schema fingerprint failed: no RESTRICT FK on payments — D2 tighten not applied.');
  }
}

/**
 * Assert the shared global fixtures the worked-numbers depend on exist (§3.4 / §3.7 #6).
 *
 * Verified against staging schema.prisma: StateTaxRate uses `state_code` (not `state`)
 * and `tax_rate` (not `rate`). Verified against the staging DB: the MA row stores the
 * rate as the fraction 0.0625 (i.e. 6.25%), so we compare against 0.0625.
 */
export async function assertGlobalFixtures(): Promise<void> {
  const ma = await prisma.stateTaxRate.findFirst({ where: { state_code: 'MA' } });
  if (!ma) throw new Error('Global fixture missing: StateTaxRate MA (worked example needs 6.25%).');
  const rate = Number(ma.tax_rate);
  if (Math.abs(rate - 0.0625) > 0.0001) {
    throw new Error(`Global fixture drift: StateTaxRate MA = ${rate}, expected 0.0625.`);
  }
}
