import { describe, it, expect } from 'vitest';
import { lit, buildSetPlanSql, buildCreateOrgSql, buildAuditReport } from '../ops-sql';
import { DEFAULT_GRANTS } from '../../permissions/defaultGrants';

const ORG = '11111111-1111-1111-1111-111111111111';

describe('lit', () => {
  it('escapes single quotes and maps null to NULL', () => {
    expect(lit("O'Brien")).toBe("'O''Brien'");
    expect(lit(null)).toBe('NULL');
    expect(lit('plain')).toBe("'plain'");
  });
});

describe('buildSetPlanSql', () => {
  it('sets plan with a WHERE on the org id', () => {
    const sql = buildSetPlanSql(ORG, { plan: 'PRO' });
    expect(sql).toContain(`"plan" = 'PRO'`);
    expect(sql).toContain(`WHERE "id" = '${ORG}'`);
  });

  it('merges a feature override with idempotent jsonb concat', () => {
    const sql = buildSetPlanSql(ORG, { feature: 'phone', featureOp: 'enable' });
    expect(sql).toContain(`coalesce("feature_overrides", '{}'::jsonb) || '{"phone":true}'::jsonb`);
  });

  it('disables a feature override with a false value', () => {
    const sql = buildSetPlanSql(ORG, { feature: 'phone', featureOp: 'disable' });
    expect(sql).toContain(`'{"phone":false}'::jsonb`);
  });

  it('clears a feature override with jsonb minus', () => {
    const sql = buildSetPlanSql(ORG, { feature: 'phone', featureOp: 'clear' });
    expect(sql).toContain(`"feature_overrides" - 'phone'`);
  });

  it('sets trial end explicitly and end-trial to NULL', () => {
    expect(buildSetPlanSql(ORG, { trialEndsAtISO: '2026-08-05' })).toContain(`"trial_ends_at" = '2026-08-05'`);
    expect(buildSetPlanSql(ORG, { endTrial: true })).toContain(`"trial_ends_at" = NULL`);
  });

  it('throws on an unbuilt feature', () => {
    expect(() => buildSetPlanSql(ORG, { feature: 'quickbooks', featureOp: 'enable' })).toThrow(/not built/i);
  });

  it('throws on an unknown feature', () => {
    expect(() => buildSetPlanSql(ORG, { feature: 'nope', featureOp: 'enable' })).toThrow(/unknown/i);
  });

  it('allows clearing an unbuilt feature (removal is always safe)', () => {
    expect(() => buildSetPlanSql(ORG, { feature: 'quickbooks', featureOp: 'clear' })).not.toThrow();
  });

  it('throws when nothing to update', () => {
    expect(() => buildSetPlanSql(ORG, {})).toThrow(/nothing/i);
  });
});

describe('buildCreateOrgSql', () => {
  const NEW_ORG = '22222222-2222-2222-2222-222222222222';
  const base = {
    orgId: NEW_ORG, name: "O'Brien Plumbing", email: 'admin@obrien.com',
    state: 'TX', addressLine1: '100 Main St', city: 'Austin', postalCode: '78701',
    plan: 'STARTER' as const, trialEndsAtISO: null,
  };
  const sql = buildCreateOrgSql(base);

  it('inserts the org with real address, no TBD/00000 placeholders', () => {
    expect(sql).toContain('INSERT INTO "organizations"');
    expect(sql).toContain("'100 Main St'");
    expect(sql).toContain("'Austin'");
    expect(sql).toContain("'78701'");
    expect(sql).not.toMatch(/TBD|'00000'/);
  });

  it('escapes an apostrophe in the org name', () => {
    expect(sql).toContain("'O''Brien Plumbing'");
  });

  it('writes the plan and a NULL trial for a non-trial org', () => {
    expect(sql).toContain("'STARTER'");
    expect(sql).toMatch(/"trial_ends_at"[\s\S]*?NULL|NULL[\s\S]*?ON CONFLICT/);
  });

  it('emits a trial date when trialEndsAtISO is set', () => {
    const trialSql = buildCreateOrgSql({ ...base, plan: 'SCALE', trialEndsAtISO: '2026-08-05' });
    expect(trialSql).toContain("'2026-08-05'");
  });

  it('seeds exactly every DEFAULT_GRANT row', () => {
    const grantMatches = sql.match(/\(gen_random_uuid\(\), '22222222-2222-2222-2222-222222222222', '(SALES|DISPATCHER|TECHNICIAN)',/g) ?? [];
    expect(grantMatches.length).toBe(DEFAULT_GRANTS.length);
  });

  it('preserves row-scoping conditions as a jsonb object for scoped grants', () => {
    const scoped = DEFAULT_GRANTS.filter((g) => (g as { conditions?: unknown }).conditions).length;
    expect(scoped).toBeGreaterThan(0);
    // scoped grants render conditions as a jsonb object literal, not NULL
    expect(sql).toMatch(/'\{[^']*"[a-zA-Z_]+"[^']*\}'::jsonb/);
  });

  it('renders NULL conditions for unscoped grants', () => {
    // at least one grant has no conditions → the tuple ends in ", NULL, now())"
    expect(sql).toMatch(/, NULL, now\(\)\)/);
  });

  it('seeds the org its own copy of the global tax-rate list', () => {
    // Org-owned tax rates (2026-08-05): `org_tax_rates` is the list the pickers read, so a new
    // org that never got one would open to an empty tax dropdown.
    expect(sql).toContain('INSERT INTO "org_tax_rates"');
    expect(sql).toContain('FROM "state_tax_rates"');
  });

  it('leaves only the org home state visible in the tax picker', () => {
    // The whole point of the change: a Texas contractor should not scroll past 51 other states.
    expect(sql).toMatch(/"state_code" = upper\(btrim\('TX'\)\)/);
  });

  it('makes the tax seed re-runnable', () => {
    // Every other statement here is ON CONFLICT DO NOTHING; this one must be too, or the second
    // run of an idempotent onboarding duplicates 52 rows.
    expect(sql).toMatch(/INSERT INTO "org_tax_rates"[\s\S]*?ON CONFLICT[\s\S]*?DO NOTHING;/);
  });

  it('seeds app_settings including available_payment_methods', () => {
    expect(sql).toContain('INSERT INTO "app_settings"');
    expect(sql).toContain("'available_payment_methods'");
    expect(sql).toContain("'company_name'");
  });

  it('sets non-CARD accepted_payment_methods (CARD needs Stripe Connect)', () => {
    // accepted (what this org accepts) excludes CARD; available (the method catalog
    // in app_settings) still lists CARD — they are different columns.
    expect(sql).toMatch(/"accepted_payment_methods", "feature_overrides", "updated_at"\) VALUES[\s\S]*?'\["BANK_TRANSFER","CHECK","CASH"\]'::jsonb/);
    expect(sql).not.toMatch(/"accepted_payment_methods" = '\[[^\]]*CARD/);
  });

  it('provisions Communication (phone) OFF on the org INSERT', () => {
    expect(sql).toContain('"feature_overrides"');
    expect(sql).toMatch(/'\{"phone": false\}'::jsonb/);
  });

  it('sets phone OFF regardless of plan tier — even PRO/SCALE', () => {
    for (const plan of ['STARTER', 'PRO', 'SCALE'] as const) {
      const planSql = buildCreateOrgSql({ ...base, plan });
      expect(planSql).toMatch(/'\{"phone": false\}'::jsonb/);
    }
  });

  it('does NOT re-affirm feature_overrides via UPDATE (a re-run must not clobber a deliberate phone-onboarding)', () => {
    // accepted_payment_methods has a re-affirm UPDATE; feature_overrides must not,
    // or re-running onboard would flip a phone-on org back to off.
    expect(sql).not.toMatch(/UPDATE "organizations" SET "feature_overrides"/);
  });

  it('is idempotent — every insert guards ON CONFLICT DO NOTHING', () => {
    const conflicts = sql.match(/ON CONFLICT DO NOTHING/g) ?? [];
    expect(conflicts.length).toBeGreaterThanOrEqual(3); // org, grants, app_settings
  });

  // Regression guard for C1: raw SQL bypasses Prisma's client-side @updatedAt /
  // @default(uuid()), so NOT-NULL columns without a DB default must be supplied.
  it('supplies organizations.updated_at (no DB default under raw SQL)', () => {
    expect(sql).toContain('"accepted_payment_methods", "feature_overrides", "updated_at") VALUES');
    expect(sql).toMatch(/'\["BANK_TRANSFER","CHECK","CASH"\]'::jsonb, '\{"phone": false\}'::jsonb, now\(\)\) ON CONFLICT DO NOTHING/);
  });

  it('supplies role_permissions id + updated_at (no DB default under raw SQL)', () => {
    expect(sql).toContain('INSERT INTO "role_permissions" ("id", "organization_id"');
    expect(sql).toContain('"updated_at") VALUES');
    // every grant tuple starts with a generated id and ends with now()
    expect(sql).toMatch(/\(gen_random_uuid\(\), '22222222-2222-2222-2222-222222222222', 'SALES',[\s\S]*?, now\(\)\)/);
  });
});

describe('buildAuditReport', () => {
  const fullGrants = DEFAULT_GRANTS.map((g) => ({
    role: g.role, action: g.action, subject: g.subject,
    conditions: (g as { conditions?: unknown }).conditions ?? null,
  }));

  it('shows the effective plan and org name', () => {
    const report = buildAuditReport({
      org: { id: 'x', name: 'Acme', plan: 'PRO', trial_ends_at: null, feature_overrides: {}, is_demo: false },
      users: [], grants: [],
    });
    expect(report).toContain('Acme');
    expect(report).toMatch(/Effective:\s*PRO/);
  });

  it('resolves a trialing org up to SCALE', () => {
    const report = buildAuditReport({
      org: { id: 'x', name: 'Acme', plan: 'STARTER', trial_ends_at: '2999-01-01', feature_overrides: {}, is_demo: false },
      users: [], grants: [],
    });
    expect(report).toMatch(/Effective:\s*SCALE/);
  });

  it('reports active-login seat count vs allowance', () => {
    const report = buildAuditReport({
      org: { id: 'x', name: 'Acme', plan: 'STARTER', trial_ends_at: null, feature_overrides: {}, is_demo: false },
      users: [
        { email: 'a@x.com', role: 'ADMIN', has_login: true },
        { email: 'b@x.com', role: 'SALES', has_login: true },
        { email: 'c@x.com', role: 'TECHNICIAN', has_login: false },
      ],
      grants: [],
    });
    expect(report).toMatch(/2 \/ 2/); // 2 logins, STARTER allows 2
  });

  it('flags a seat overage', () => {
    const report = buildAuditReport({
      org: { id: 'x', name: 'Acme', plan: 'STARTER', trial_ends_at: null, feature_overrides: {}, is_demo: false },
      users: [
        { email: 'a@x.com', role: 'ADMIN', has_login: true },
        { email: 'b@x.com', role: 'SALES', has_login: true },
        { email: 'c@x.com', role: 'DISPATCHER', has_login: true },
      ],
      grants: [],
    });
    expect(report).toMatch(/OVERAGE/i);
  });

  it('flags all DEFAULT_GRANTS missing when grants is empty', () => {
    const report = buildAuditReport({
      org: { id: 'x', name: 'Acme', plan: 'PRO', trial_ends_at: null, feature_overrides: {}, is_demo: false },
      users: [], grants: [],
    });
    expect(report).toMatch(/missing/i);
  });

  it('reports healthy grants when all DEFAULT_GRANTS are present and scoped', () => {
    const report = buildAuditReport({
      org: { id: 'x', name: 'Acme', plan: 'PRO', trial_ends_at: null, feature_overrides: {}, is_demo: false },
      users: [], grants: fullGrants,
    });
    expect(report).toMatch(/All \d+ DEFAULT_GRANTS present/);
  });

  it('flags a present-but-unscoped grant (row isolation broken)', () => {
    // strip conditions off one scoped grant → it becomes present-but-unscoped
    const brokenGrants = fullGrants.map((g) =>
      g.conditions ? { ...g, conditions: null } : g,
    );
    const report = buildAuditReport({
      org: { id: 'x', name: 'Acme', plan: 'PRO', trial_ends_at: null, feature_overrides: {}, is_demo: false },
      users: [], grants: brokenGrants,
    });
    expect(report).toMatch(/UNSCOPED/i);
  });
});
