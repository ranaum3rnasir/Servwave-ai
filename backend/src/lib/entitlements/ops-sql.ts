/**
 * Pure SQL / report builders for the entitlement ops skills.
 *
 * These functions compute everything in TypeScript (reusing DEFAULT_GRANTS, the
 * resolver, and the catalog) and emit **idempotent** SQL or a report string. They
 * NEVER open a DB connection — the skill applies the SQL via Supabase MCP. This is
 * the single source of truth: grant seeding and plan math are never reimplemented
 * in hand-written SQL elsewhere.
 */
import type { PlanTier } from './catalog';
import { isKnownFeature, isGrantableFeature, catalogEntry } from './catalog';
import { DEFAULT_GRANTS } from '../permissions/defaultGrants';
import { starterTaskCategoriesSql } from '../tasks/categories';

/** SQL string literal: null → NULL, otherwise single-quoted with `'` doubled. */
export function lit(v: string | null): string {
  if (v === null) return 'NULL';
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * Idempotent `UPDATE organizations ...` for a plan/trial/feature-override change.
 * Throws on an unknown feature, or an enable/disable of a declared-but-unbuilt one
 * (clear is always allowed — removing an override can never over-grant).
 */
export function buildSetPlanSql(
  orgId: string,
  opts: {
    plan?: PlanTier;
    endTrial?: boolean;
    trialEndsAtISO?: string | null;
    feature?: string;
    featureOp?: 'enable' | 'disable' | 'clear';
  },
): string {
  const sets: string[] = [];

  if (opts.plan) sets.push(`"plan" = '${opts.plan}'`);

  if (opts.endTrial) sets.push(`"trial_ends_at" = NULL`);
  else if (opts.trialEndsAtISO) sets.push(`"trial_ends_at" = '${opts.trialEndsAtISO}'`);

  if (opts.feature) {
    if (!isKnownFeature(opts.feature)) {
      throw new Error(`Unknown feature "${opts.feature}". Run /audit-org-entitlements to see valid keys.`);
    }
    if (opts.featureOp === 'clear') {
      sets.push(`"feature_overrides" = "feature_overrides" - '${opts.feature}'`);
    } else {
      if (!isGrantableFeature(opts.feature)) {
        throw new Error(
          `"${opts.feature}" is declared but not built (${catalogEntry(opts.feature)?.label}). No gate exists; granting it would do nothing.`,
        );
      }
      const val = opts.featureOp === 'enable';
      sets.push(
        `"feature_overrides" = coalesce("feature_overrides", '{}'::jsonb) || '{"${opts.feature}":${val}}'::jsonb`,
      );
    }
  }

  if (sets.length === 0) {
    throw new Error('Nothing to update. Pass a plan, trial change, or feature override.');
  }
  return `UPDATE "organizations" SET ${sets.join(', ')} WHERE "id" = ${lit(orgId)};`;
}

/**
 * The 9 per-org app_settings rows a new tenant needs (deposit defaults, payment
 * method catalog, estimate template, etc.). Based on src/seed.ts:55-66.
 */
const APP_SETTINGS: ReadonlyArray<[string, string]> = [
  ['deposit_required_default', 'true'],
  ['deposit_percentage', '50'],
  ['available_payment_methods', JSON.stringify(['CARD', 'BANK_TRANSFER', 'CHECK', 'CASH'])],
  ['estimate_validity_days', '30'],
  ['company_name', 'ServWave'],
  ['bank_transfer_instructions', ''],
  ['check_instructions', ''],
  ['cash_instructions', ''],
  ['estimate_email_template', 'Thank you for your recent service inquiry with us. Click the link below to view your estimate.'],
];

// A fresh org can accept every non-CARD method. CARD requires stripe_account_id
// (Stripe Connect), added later by the Connect onboarding flow — never here.
const DEFAULT_ACCEPTED_PAYMENTS = '["BANK_TRANSFER","CHECK","CASH"]';

// Every new org is provisioned with the Communication module (`phone`) OFF,
// regardless of plan tier — even PRO/SCALE, whose plan would otherwise include it.
// The comm module is not yet trusted for live customer use, so phone stays dark
// until a deliberate phone-onboarding step turns it on (`/change-org-plan`
// --feature phone --enable, or clearing the override). Writing the explicit
// `false` (rather than relying on plan) also means a later plan upgrade can't
// silently unlock comm. See CLAUDE.md § Entitlements & Feature Gating.
const DEFAULT_FEATURE_OVERRIDES = '{"phone": false}';

/**
 * One idempotent SQL batch to fully provision a new tenant:
 *   org row (real address, plan, trial, phone OFF) + all DEFAULT_GRANTS
 *   (conditions preserved) + 9 app_settings rows + non-CARD accepted_payment_methods.
 * Every statement is ON CONFLICT DO NOTHING so a re-run is a no-op. Never writes
 * placeholder address data.
 *
 * `feature_overrides` is set to `{"phone": false}` on INSERT only — there is
 * deliberately NO re-affirm UPDATE (unlike accepted_payment_methods). If the org
 * already exists the whole INSERT is skipped, so a re-run never clobbers a
 * deliberate phone-onboarding (`{"phone": true}`) back to off.
 */
export function buildCreateOrgSql(input: {
  orgId: string;
  name: string;
  email: string;
  state: string;
  addressLine1: string;
  city: string;
  postalCode: string;
  plan: PlanTier;
  trialEndsAtISO: string | null;
}): string {
  const { orgId, name, email, state, addressLine1, city, postalCode, plan, trialEndsAtISO } = input;

  // These INSERTs bypass Prisma (applied as raw SQL via MCP), so Prisma's
  // client-side @updatedAt and @default(uuid()) do NOT fire. `updated_at` (both
  // tables) and role_permissions `id` are NOT NULL with no DB default, so they
  // must be supplied here or the INSERT aborts. `created_at` has a real
  // DEFAULT now() and is safely omitted.
  const orgInsert =
    `INSERT INTO "organizations" ` +
    `("id", "name", "email", "state", "address_line1", "city", "postal_code", ` +
    `"estimate_terms", "estimate_notes", "estimate_payment_terms", ` +
    `"plan", "trial_ends_at", "accepted_payment_methods", "feature_overrides", "updated_at") VALUES (` +
    `${lit(orgId)}, ${lit(name)}, ${lit(email)}, ${lit(state)}, ${lit(addressLine1)}, ${lit(city)}, ${lit(postalCode)}, ` +
    `'', '', '', ${lit(plan)}, ${trialEndsAtISO ? lit(trialEndsAtISO) : 'NULL'}, ` +
    `'${DEFAULT_ACCEPTED_PAYMENTS}'::jsonb, '${DEFAULT_FEATURE_OVERRIDES}'::jsonb, now()) ON CONFLICT DO NOTHING;`;

  // Conditions mapper copied from src/lib/e2e-org.ts:79 — preserve row-scope templates
  // (OWN_LEAD, OWN_JOB, …). Dropping them silently grants org-wide access.
  // id via gen_random_uuid() (PG13+ core); ON CONFLICT on the (org,role,action,
  // subject) unique key keeps re-runs idempotent despite the fresh random id.
  const grantValues = DEFAULT_GRANTS.map((g) => {
    const conditions = (g as { conditions?: Record<string, unknown> }).conditions;
    const condSql = conditions == null ? 'NULL' : `${lit(JSON.stringify(conditions))}::jsonb`;
    return `(gen_random_uuid(), ${lit(orgId)}, ${lit(g.role)}, ${lit(g.action)}, ${lit(g.subject)}, ${condSql}, now())`;
  }).join(',\n  ');
  const grantInsert =
    `INSERT INTO "role_permissions" ("id", "organization_id", "role", "action", "subject", "conditions", "updated_at") VALUES\n  ` +
    `${grantValues}\nON CONFLICT DO NOTHING;`;

  const settingsValues = APP_SETTINGS.map(([k, v]) => `(${lit(orgId)}, ${lit(k)}, ${lit(v)})`).join(',\n  ');
  const settingsInsert =
    `INSERT INTO "app_settings" ("organization_id", "key", "value") VALUES\n  ` +
    `${settingsValues}\nON CONFLICT DO NOTHING;`;

  // Org-owned tax rates (2026-08-05). `org_tax_rates` is the list every tax picker reads, so a
  // new org needs its own copy of the global list or its tax dropdown opens empty. Only the home
  // state is left visible - hiding the rest is the point of the feature, and an admin can
  // switch the rest back on from Settings -> Tax Rates without retyping the rate.
  // Idempotent via the partial unique index on (organization_id, state_code).
  const taxRatesInsert =
    `INSERT INTO "org_tax_rates" ` +
    `("id", "organization_id", "name", "rate", "state_code", "is_visible", "created_at", "updated_at")\n` +
    `SELECT gen_random_uuid(), ${lit(orgId)}, s."state_name", s."tax_rate", s."state_code",\n` +
    `  (s."state_code" = upper(btrim(${lit(state)})) OR lower(s."state_name") = lower(btrim(${lit(state)}))),\n` +
    `  now(), now()\n` +
    `FROM "state_tax_rates" s\n` +
    `ON CONFLICT ("organization_id", "state_code") WHERE "state_code" IS NOT NULL DO NOTHING;`;

  // The three starter task categories (visits-and-task-categories slice 08). Idempotent: a
  // category of the same name, in any letter case, is left alone.
  const taskCategoriesInsert = starterTaskCategoriesSql(lit(orgId));

  // Re-affirm accepted_payment_methods for the idempotent case where the org row
  // already existed with the '[]' default (the ON CONFLICT above skipped it).
  const paymentsUpdate =
    `UPDATE "organizations" SET "accepted_payment_methods" = '${DEFAULT_ACCEPTED_PAYMENTS}'::jsonb ` +
    `WHERE "id" = ${lit(orgId)} AND "accepted_payment_methods" = '[]'::jsonb;`;

  return [orgInsert, grantInsert, settingsInsert, taxRatesInsert, taskCategoriesInsert, paymentsUpdate].join('\n\n');
}

// --- Audit report (read-only) --------------------------------------------------
// buildAuditReport turns already-fetched rows into the "why can't they see X"
// report. The skill runs the SELECTs via MCP and feeds the rows here, so the
// report math (effective plan, features, seats, grant health) stays in TS and is
// never re-derived. Ported from scripts/audit-org.ts's console output.

import { effectivePlan, orgFeatures } from './resolve';
import { FEATURE_CATALOG } from './catalog';
import { PLAN_FEATURES } from './plans';

export interface AuditData {
  org: {
    id: string;
    name: string;
    plan: string;
    trial_ends_at: string | null;
    feature_overrides: Record<string, unknown> | null;
    is_demo: boolean;
  };
  users: Array<{ email: string; role: string; has_login: boolean }>;
  grants: Array<{ role: string; action: string; subject: string; conditions: unknown }>;
}

export function buildAuditReport(data: AuditData): string {
  const { org, users, grants } = data;
  const source = {
    plan: org.plan as never,
    trial_ends_at: org.trial_ends_at ? new Date(org.trial_ends_at) : null,
    feature_overrides: (org.feature_overrides ?? {}) as Record<string, unknown>,
  };
  const effective = effectivePlan(source);
  const features = orgFeatures(source);
  const out: string[] = [];

  out.push(`\n━━ ${org.name} (${org.id}) ━━`);
  out.push(`   Stored plan: ${org.plan}`);
  out.push(`   Trial:       ${org.trial_ends_at ? org.trial_ends_at.slice(0, 10) : 'none'}`);
  out.push(`   Effective:   ${effective}`);
  out.push(`   Overrides:   ${JSON.stringify(org.feature_overrides ?? {})}`);
  out.push(`   is_demo:     ${org.is_demo}`);

  out.push(`\n━━ Features ━━`);
  for (const e of FEATURE_CATALOG) {
    const on = features.includes(e.key);
    const note = !e.built ? ' (declared, not built — no gate)' : '';
    out.push(`   ${on ? '✅' : '  '} ${e.key.padEnd(22)} ${e.minPlan.padEnd(11)}${note}`);
  }

  out.push(`\n━━ Seats ━━`);
  const logins = users.filter((u) => u.has_login);
  const allowed = PLAN_FEATURES[effective]?.seats_included;
  const over = allowed !== null && allowed !== undefined && logins.length > allowed;
  out.push(`   Active logins: ${logins.length} / ${allowed ?? '∞'}${over ? '  ⚠️  OVERAGE' : ''}`);
  out.push(`   (Seat caps are REPORTED, never enforced — v1 scope.)`);
  for (const u of users) out.push(`   - ${u.email} (${u.role})${u.has_login ? '' : ' [staff, no login]'}`);

  out.push(`\n━━ Grant health ━━`);
  // DEFAULT_GRANTS covers SALES/DISPATCHER/TECHNICIAN only — ADMIN is a CASL
  // superuser via defineAbility's role short-circuit and holds no rows.
  const actual = new Map(grants.map((rp) => [`${rp.role}:${rp.action}:${rp.subject}`, rp.conditions]));
  const missing = DEFAULT_GRANTS.filter((g) => !actual.has(`${g.role}:${g.action}:${g.subject}`));
  // A grant present but with conditions stripped is WORSE than a missing one:
  // it silently widens row scope (SALES reads every lead instead of own).
  const unscoped = DEFAULT_GRANTS.filter((g) => {
    const expected = (g as { conditions?: unknown }).conditions;
    if (expected == null) return false;
    const key = `${g.role}:${g.action}:${g.subject}`;
    return actual.has(key) && actual.get(key) == null;
  });

  if (missing.length === 0 && unscoped.length === 0) {
    out.push(`   ✅ All ${DEFAULT_GRANTS.length} DEFAULT_GRANTS present and correctly scoped`);
  }
  if (missing.length > 0) {
    out.push(`   ⚠️  ${missing.length} missing (those roles will 403):`);
    for (const g of missing) out.push(`      ${g.role} ${g.action} ${g.subject}`);
  }
  if (unscoped.length > 0) {
    out.push(`   🔴 ${unscoped.length} present but UNSCOPED — row isolation is broken:`);
    for (const g of unscoped) out.push(`      ${g.role} ${g.action} ${g.subject}`);
  }

  return out.join('\n');
}
