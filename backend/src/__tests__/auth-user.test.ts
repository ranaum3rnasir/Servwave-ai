import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { resolveAppUser } from '../lib/auth-user';

const mockPrisma = prisma as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
};

// Shape Prisma returns (includes the joined organization relation).
// plan: SCALE, no trial, no overrides — deliberately not STARTER, so these
// tests exercise real plan resolution instead of just the fail-closed default.
const ROW = {
  id: 'app-id',
  email: 'alice@acme.com',
  first_name: 'Alice',
  last_name: 'A',
  role: 'ADMIN',
  is_active: true,
  organization_id: 'org-1',
  department_id: null,
  location_id: null,
  organization: { is_demo: false, plan: 'SCALE', trial_ends_at: null, feature_overrides: {} },
};

// Shape resolveAppUser returns: the org relation flattened to org_is_demo, plus
// org_plan/org_features resolved from ROW.organization via effectivePlan/orgFeatures
// (lib/entitlements/resolve.ts). trial_ends_at is null, so effectivePlan is just
// coercePlan('SCALE') = 'SCALE'. feature_overrides is {}, so orgFeatures is exactly
// PLAN_FEATURES.SCALE.features (lib/entitlements/plans.ts) — computed by hand from
// catalog.ts as: every built:true entry with minPlan index <= SCALE's index (2),
// in catalog order - STARTER core (11, `email` included since the email slice
// split it out of PRO `phone`) + PRO-built (5) + inventory (SCALE-built, 1).
const APP_USER = {
  id: 'app-id',
  email: 'alice@acme.com',
  first_name: 'Alice',
  last_name: 'A',
  role: 'ADMIN',
  is_active: true,
  organization_id: 'org-1',
  department_id: null,
  location_id: null,
  org_is_demo: false,
  org_plan: 'SCALE',
  feature_overrides: {},
  org_features: [
    'customers', 'jobs', 'estimates', 'invoices', 'payments',
    'scheduling', 'basic_reports', 'online_payments', 'mobile_field_app', 'ai_center_view', 'email',
    // No 'advanced_reports' - declared but not built (#1021). No gate exists for it
    // anywhere, so granting it would be a claim the audit tooling then reports as real.
    'leads', 'service_plans', 'phone', 'automations',
    'inventory',
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveAppUser', () => {
  it('returns the user matched by Supabase id', async () => {
    mockPrisma.user.findUnique.mockImplementation((args: { where: { id?: string; email?: string } }) =>
      Promise.resolve(args.where.id === 'app-id' ? ROW : null),
    );

    const result = await resolveAppUser({ id: 'app-id', email: 'alice@acme.com', email_confirmed_at: '2026-01-01' });

    expect(result).toEqual(APP_USER);
  });

  it('flattens organization.is_demo into org_is_demo (demo org)', async () => {
    // Preserve the rest of the organization fixture (plan/trial/overrides) —
    // only is_demo differs — so org_plan/org_features stay SCALE-derived.
    mockPrisma.user.findUnique.mockResolvedValue({ ...ROW, organization: { ...ROW.organization, is_demo: true } });

    const result = await resolveAppUser({ id: 'app-id', email: 'alice@acme.com', email_confirmed_at: '2026-01-01' });

    expect(result).toEqual({ ...APP_USER, org_is_demo: true });
  });

  it('falls back to a confirmed-email match when the id misses', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockImplementation((args: { where: { email?: { equals?: string } } }) =>
      Promise.resolve(args.where.email?.equals === 'alice@acme.com' ? ROW : null),
    );

    const result = await resolveAppUser({ id: 'different-supa-id', email: 'alice@acme.com', email_confirmed_at: '2026-01-01' });

    expect(result).toEqual(APP_USER);
  });

  it('matches the email fallback case-insensitively (provider lowercases what we stored mixed-case)', async () => {
    // Prisma row stored 'Sagiv@acme.com'; the provider hands us 'sagiv@acme.com'.
    // resolveAppUser must use a case-insensitive query so the two still reconcile.
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockImplementation((args: { where: { email?: { equals?: string; mode?: string } } }) =>
      Promise.resolve(args.where.email?.mode === 'insensitive' ? ROW : null),
    );

    const result = await resolveAppUser({ id: 'different-supa-id', email: 'sagiv@acme.com', email_confirmed_at: '2026-01-01' });

    expect(result).toEqual(APP_USER);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: { equals: 'sagiv@acme.com', mode: 'insensitive' } } }),
    );
  });

  it('fails closed to STARTER plan/features when the organization relation is missing', async () => {
    // toAppUser must never leak a paid plan's features when the org relation
    // didn't come back (source.plan/trial_ends_at/feature_overrides all fall
    // back to their fail-closed defaults — see auth-user.ts::toAppUser).
    mockPrisma.user.findUnique.mockResolvedValue({ ...ROW, organization: null });

    const result = await resolveAppUser({ id: 'app-id', email: 'alice@acme.com', email_confirmed_at: '2026-01-01' });

    expect(result).toEqual({
      ...APP_USER,
      org_plan: 'STARTER',
      org_features: [
        'customers', 'jobs', 'estimates', 'invoices', 'payments',
        'scheduling', 'basic_reports', 'online_payments', 'mobile_field_app', 'ai_center_view', 'email',
      ],
    });
  });

  it('does NOT match by email when the email is unconfirmed', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockResolvedValue(ROW);

    const result = await resolveAppUser({ id: 'different-supa-id', email: 'alice@acme.com', email_confirmed_at: null });

    expect(result).toBeNull();
    // unconfirmed email must never reach the DB email lookup
    expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when neither id nor email match', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockResolvedValue(null);

    const result = await resolveAppUser({ id: 'x', email: 'nobody@acme.com', email_confirmed_at: '2026-01-01' });

    expect(result).toBeNull();
  });
});
