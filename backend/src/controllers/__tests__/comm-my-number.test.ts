// Master plan Task B1 — GET /api/communication/my-outbound-number: a thin,
// tenant-scoped wrapper over resolveOutboundNumber (explicit -> user default ->
// org default -> legacy) for req.user, so the /phone tab can fetch the
// caller's resolved caller-ID TPN. Gated org-level (requireFeature('phone'),
// mounted per-router) + user-level (canDo('create','Communication') — the
// role-agnostic phone-access grant, Task A0's shared baseline). db is mocked
// (codebase pattern).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../../app';
import { prisma } from '../../lib/prisma';
import { clearTokenCache } from '../../middleware/authenticate';
import { clearPermissionCache } from '../../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, TEST_USERS, ALPHA_ORG_ID, ORG_B_ID } from '../../__tests__/helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const PN1 = '00000000-0000-0000-0000-0000000000d1';
const PN2 = '00000000-0000-0000-0000-0000000000d2';

function expectOrgScoped(mockFn: Mock, orgId: string) {
  expect(mockFn).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ organization_id: orgId }) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

describe('GET /api/communication/my-outbound-number', () => {
  it("402s an org whose plan lacks `phone` before any resolution (org-level gate)", async () => {
    mockAuthAs('realOrgAdmin');
    // Override the SCALE-org test default with a STARTER org lacking `phone`,
    // for this one request only — proves the gate is wired on this router.
    p.user.findUnique.mockResolvedValueOnce({
      ...TEST_USERS.realOrgAdmin,
      organization: { is_demo: false, plan: 'STARTER', trial_ends_at: null, feature_overrides: {} },
    });

    const res = await request(app)
      .get('/api/communication/my-outbound-number')
      .set(authHeader('realOrgAdmin'));

    expect(res.status).toBe(402);
    expect(res.body.feature).toBe('phone');
    expect(p.userPhoneNumber.findFirst).not.toHaveBeenCalled();
    expect(p.phoneNumber.findFirst).not.toHaveBeenCalled();
  });

  it("returns the caller's own default assignment when set", async () => {
    mockAuthAs('sales');
    p.userPhoneNumber.findFirst.mockResolvedValueOnce({
      phone_number: { id: PN1, ctm_number_id: 'TPN111' },
    });
    p.phoneNumber.findUnique.mockResolvedValue({ formatted: '(201) 555-1234', e164: '+12015551234' });

    const res = await request(app)
      .get('/api/communication/my-outbound-number')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    // The neutral key is what the frontend reads; `ctm_number_id` is the
    // deprecated alias kept one release for a browser still on an old bundle.
    expect(res.body).toEqual({
      provider_number_id: 'TPN111',
      ctm_number_id: 'TPN111',
      phone_number_id: PN1,
      formatted: '(201) 555-1234',
    });
    // Resolved on the user-default tier — never fell through to the org default.
    expect(p.phoneNumber.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to the org default when the caller has no default assignment', async () => {
    mockAuthAs('sales');
    p.userPhoneNumber.findFirst.mockResolvedValue(null);
    p.phoneNumber.findFirst.mockResolvedValueOnce({ id: PN2, ctm_number_id: 'TPN222' }); // org-default tier
    p.phoneNumber.findUnique.mockResolvedValue({ formatted: null, e164: '+12015559999' });

    const res = await request(app)
      .get('/api/communication/my-outbound-number')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    // No `formatted` on the row falls back to the raw e164.
    expect(res.body).toEqual({
      provider_number_id: 'TPN222',
      ctm_number_id: 'TPN222',
      phone_number_id: PN2,
      formatted: '+12015559999',
    });
    expectOrgScoped(p.phoneNumber.findFirst as Mock, ALPHA_ORG_ID);
  });

  it('returns { none: true } when the org owns no usable number', async () => {
    mockAuthAs('sales');
    p.userPhoneNumber.findFirst.mockResolvedValue(null);
    p.phoneNumber.findFirst.mockResolvedValue(null); // org-default AND legacy tiers both miss

    const res = await request(app)
      .get('/api/communication/my-outbound-number')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ none: true });
    expect(p.phoneNumber.findUnique).not.toHaveBeenCalled();
  });

  it('is tenant-scoped: resolves against the caller\'s own org, never another', async () => {
    mockAuthAs('orgB_admin');
    p.userPhoneNumber.findFirst.mockResolvedValue(null);
    p.phoneNumber.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/communication/my-outbound-number')
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    expect(p.userPhoneNumber.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone_number: expect.objectContaining({ organization_id: ORG_B_ID }),
        }),
      }),
    );
    // Never queried using the OTHER org's id.
    expect(p.userPhoneNumber.findFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone_number: expect.objectContaining({ organization_id: ALPHA_ORG_ID }),
        }),
      }),
    );
  });
});
