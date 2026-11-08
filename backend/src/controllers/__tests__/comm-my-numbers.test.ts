// Master plan Task B3 — GET /api/communication/my-numbers: the ALLOW-LIST
// source for the /phone tab's caller-ID picker. Returns ONLY the numbers the
// caller may legitimately dial from — their own assigned numbers (via
// UserPhoneNumber) plus the org default — never the full org roster (that's
// the ADMIN-gated /number-assignments endpoint). Gated org-level
// (requireFeature('phone')) + user-level (canDo('create','Communication') —
// the same role-agnostic phone-access grant as /my-outbound-number, Task A0's
// shared baseline). db is mocked (codebase pattern).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../app';
import { prisma } from '../../lib/prisma';
import { clearTokenCache } from '../../middleware/authenticate';
import { clearPermissionCache } from '../../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, TEST_USERS, ALPHA_ORG_ID, ORG_B_ID } from '../../__tests__/helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const PN_ASSIGNED = '00000000-0000-0000-0000-0000000000e1';
const PN_ORG_DEFAULT = '00000000-0000-0000-0000-0000000000e2';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

describe('GET /api/communication/my-numbers', () => {
  it("402s an org whose plan lacks `phone` before any query (org-level gate)", async () => {
    mockAuthAs('realOrgAdmin');
    // Override the SCALE-org test default with a STARTER org lacking `phone`,
    // for this one request only — proves the gate is wired on this router.
    p.user.findUnique.mockResolvedValueOnce({
      ...TEST_USERS.realOrgAdmin,
      organization: { is_demo: false, plan: 'STARTER', trial_ends_at: null, feature_overrides: {} },
    });

    const res = await request(app)
      .get('/api/communication/my-numbers')
      .set(authHeader('realOrgAdmin'));

    expect(res.status).toBe(402);
    expect(res.body.feature).toBe('phone');
    expect(p.userPhoneNumber.findMany).not.toHaveBeenCalled();
    expect(p.phoneNumber.findFirst).not.toHaveBeenCalled();
  });

  it("lists the caller's assigned numbers plus the org default, never the full org roster", async () => {
    mockAuthAs('sales');
    p.userPhoneNumber.findMany.mockResolvedValueOnce([
      {
        is_default: true,
        phone_number: {
          id: PN_ASSIGNED,
          ctm_number_id: 'TPN_ASSIGNED',
          formatted: '(609) 555-0100',
          e164: '+16095550100',
          is_org_default: false,
        },
      },
    ]);
    p.phoneNumber.findFirst.mockResolvedValueOnce({
      id: PN_ORG_DEFAULT,
      ctm_number_id: 'TPN_ORGDEFAULT',
      formatted: '(551) 282-7064',
      e164: '+15512827064',
    });

    const res = await request(app)
      .get('/api/communication/my-numbers')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      numbers: [
        {
          phone_number_id: PN_ASSIGNED,
          provider_number_id: 'TPN_ASSIGNED',
          ctm_number_id: 'TPN_ASSIGNED', // deprecated alias, one release
          formatted: '(609) 555-0100',
          is_org_default: false,
          is_user_default: true,
        },
        {
          phone_number_id: PN_ORG_DEFAULT,
          provider_number_id: 'TPN_ORGDEFAULT',
          ctm_number_id: 'TPN_ORGDEFAULT', // deprecated alias, one release
          formatted: '(551) 282-7064',
          is_org_default: true,
          is_user_default: false,
        },
      ],
    });
  });

  it('de-dupes when the org default is ALSO one of the caller\'s assigned numbers', async () => {
    mockAuthAs('sales');
    p.userPhoneNumber.findMany.mockResolvedValueOnce([
      {
        is_default: false,
        phone_number: {
          id: PN_ORG_DEFAULT,
          ctm_number_id: 'TPN_ORGDEFAULT',
          formatted: '(551) 282-7064',
          e164: '+15512827064',
          is_org_default: true,
        },
      },
    ]);
    p.phoneNumber.findFirst.mockResolvedValueOnce({
      id: PN_ORG_DEFAULT,
      ctm_number_id: 'TPN_ORGDEFAULT',
      formatted: '(551) 282-7064',
      e164: '+15512827064',
    });

    const res = await request(app)
      .get('/api/communication/my-numbers')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.numbers).toHaveLength(1);
    expect(res.body.numbers[0]).toEqual({
      phone_number_id: PN_ORG_DEFAULT,
      provider_number_id: 'TPN_ORGDEFAULT',
      ctm_number_id: 'TPN_ORGDEFAULT', // deprecated alias, one release
      formatted: '(551) 282-7064',
      is_org_default: true,
      is_user_default: false,
    });
  });

  it('returns just the org default when the caller has no assigned numbers', async () => {
    mockAuthAs('sales');
    p.userPhoneNumber.findMany.mockResolvedValueOnce([]);
    p.phoneNumber.findFirst.mockResolvedValueOnce({
      id: PN_ORG_DEFAULT,
      ctm_number_id: 'TPN_ORGDEFAULT',
      formatted: null,
      e164: '+15512827064',
    });

    const res = await request(app)
      .get('/api/communication/my-numbers')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      numbers: [
        {
          phone_number_id: PN_ORG_DEFAULT,
          provider_number_id: 'TPN_ORGDEFAULT',
          ctm_number_id: 'TPN_ORGDEFAULT', // deprecated alias, one release
          formatted: '+15512827064', // falls back to e164 when unformatted
          is_org_default: true,
          is_user_default: false,
        },
      ],
    });
  });

  it('returns an empty list when the org owns no usable number', async () => {
    mockAuthAs('sales');
    p.userPhoneNumber.findMany.mockResolvedValueOnce([]);
    p.phoneNumber.findFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/communication/my-numbers')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ numbers: [] });
  });

  it("is tenant-scoped: queries against the caller's own org, never another", async () => {
    mockAuthAs('orgB_admin');
    p.userPhoneNumber.findMany.mockResolvedValueOnce([]);
    p.phoneNumber.findFirst.mockResolvedValueOnce(null);

    const res = await request(app)
      .get('/api/communication/my-numbers')
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    expect(p.userPhoneNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone_number: expect.objectContaining({ organization_id: ORG_B_ID }),
        }),
      }),
    );
    expect(p.userPhoneNumber.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          phone_number: expect.objectContaining({ organization_id: ALPHA_ORG_ID }),
        }),
      }),
    );
  });
});
