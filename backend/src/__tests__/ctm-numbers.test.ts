import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import * as numbersController from '../controllers/comm-numbers.controller';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const FLOW_ID = '0b6f5f6e-6c1d-4d29-9d5a-1f2e3a4b5c6d';
const FOREIGN_FLOW_ID = 'e2d1c0b9-a8f7-4e6d-b5c4-3a2b1c0d9e8f';

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const req = (body: Record<string, unknown> = {}, params: Record<string, string> = {}) =>
  ({
    body,
    params,
    headers: {},
    user: { id: 'user-1', organization_id: 'org-1', email: 'admin@test.dev' },
  }) as any;

function ctmError(httpStatus: number, reason: string) {
  const err: any = new client.CtmApiError(`CTM API error ${httpStatus}: ${reason}`);
  err.httpStatus = httpStatus;
  err.reason = reason;
  return err;
}

const dbRow = (over: Record<string, unknown> = {}) => ({
  id: 'pn-1',
  e164: '+12015550123',
  formatted: '(201) 555-0123',
  label: null,
  source: 'ctm',
  type: null,
  sms_enabled: true,
  ctm_number_id: 'TPN-NEW',
  call_flow_id: FLOW_ID,
  status: 'active',
  created_at: new Date('2026-07-09T12:00:00Z'),
  organization_id: 'org-1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();

  client.isCtmConfigured.mockReturnValue(true);
  client.searchNumbers.mockResolvedValue([
    { phone_number: '+12015550100', friendly_name: '(201) 555-0100' },
  ]);
  client.buyNumber.mockResolvedValue({ id: 'TPN-NEW', number: '+12015550123' });
  client.createReceivingNumber.mockResolvedValue({});
  client.updateNumberRouting.mockResolvedValue({});
  client.enableSms.mockResolvedValue('ok');

  p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111' });
  p.phoneNumber.findMany.mockResolvedValue([dbRow()]);
  p.phoneNumber.findFirst.mockResolvedValue(dbRow());
  p.phoneNumber.upsert.mockResolvedValue(dbRow());
  p.phoneNumber.update.mockResolvedValue(dbRow());
  p.phoneNumber.create.mockResolvedValue(dbRow({ source: 'byo', ctm_number_id: null, sms_enabled: false }));
  p.callFlow.findFirst.mockResolvedValue({ id: FLOW_ID });
  p.auditLog.create.mockResolvedValue({});
});

// ─── Schemas ─────────────────────────────────────────────────────────────────

describe('searchNumbersSchema', () => {
  it('accepts an empty body and a 3-digit areacode + type', () => {
    expect(numbersController.searchNumbersSchema.safeParse({}).success).toBe(true);
    expect(
      numbersController.searchNumbersSchema.safeParse({ areacode: '201', type: 'local' }).success,
    ).toBe(true);
    expect(numbersController.searchNumbersSchema.safeParse({ type: 'tollfree' }).success).toBe(true);
  });

  it('rejects malformed areacodes and unknown types', () => {
    expect(numbersController.searchNumbersSchema.safeParse({ areacode: '20' }).success).toBe(false);
    expect(numbersController.searchNumbersSchema.safeParse({ areacode: '2011' }).success).toBe(false);
    expect(numbersController.searchNumbersSchema.safeParse({ areacode: '20a' }).success).toBe(false);
    expect(numbersController.searchNumbersSchema.safeParse({ type: 'mobile' }).success).toBe(false);
  });
});

describe('buyNumberSchema (routing destination required)', () => {
  it('requires phone_number AND an E.164-normalizable forward_to_e164; call_flow_id is optional', () => {
    expect(
      numbersController.buyNumberSchema.safeParse({
        phone_number: '+12015550123',
        forward_to_e164: '+16462023002',
      }).success,
    ).toBe(true);
    // The bare 10-digit spelling normalizes too.
    expect(
      numbersController.buyNumberSchema.safeParse({
        phone_number: '+12015550123',
        forward_to_e164: '6462023002',
      }).success,
    ).toBe(true);
    // Optional flow metadata still validates as a uuid when present.
    expect(
      numbersController.buyNumberSchema.safeParse({
        phone_number: '+12015550123',
        forward_to_e164: '+16462023002',
        call_flow_id: FLOW_ID,
      }).success,
    ).toBe(true);
    expect(
      numbersController.buyNumberSchema.safeParse({
        phone_number: '+12015550123',
        forward_to_e164: '+16462023002',
        call_flow_id: 'main_ivr',
      }).success,
    ).toBe(false);
    // Missing/garbage forward destination → 400 at the validate() middleware.
    expect(
      numbersController.buyNumberSchema.safeParse({ phone_number: '+12015550123' }).success,
    ).toBe(false);
    expect(
      numbersController.buyNumberSchema.safeParse({
        phone_number: '+12015550123',
        forward_to_e164: 'not-a-number',
      }).success,
    ).toBe(false);
    expect(
      numbersController.buyNumberSchema.safeParse({ forward_to_e164: '+16462023002' }).success,
    ).toBe(false);
  });
});

describe('updateNumberSchema', () => {
  it('accepts a uuid or explicit null, rejects everything else', () => {
    expect(numbersController.updateNumberSchema.safeParse({ call_flow_id: FLOW_ID }).success).toBe(true);
    expect(numbersController.updateNumberSchema.safeParse({ call_flow_id: null }).success).toBe(true);
    expect(numbersController.updateNumberSchema.safeParse({}).success).toBe(false);
    expect(numbersController.updateNumberSchema.safeParse({ call_flow_id: 'nope' }).success).toBe(false);
  });
});

describe('registerByoSchema', () => {
  it('requires an E.164 number; label optional', () => {
    expect(numbersController.registerByoSchema.safeParse({ e164: '+12015551234' }).success).toBe(true);
    expect(
      numbersController.registerByoSchema.safeParse({ e164: '+12015551234', label: 'Office line' })
        .success,
    ).toBe(true);
    expect(numbersController.registerByoSchema.safeParse({ e164: '2015551234' }).success).toBe(false);
    expect(numbersController.registerByoSchema.safeParse({ e164: 'not-a-number' }).success).toBe(false);
    expect(numbersController.registerByoSchema.safeParse({}).success).toBe(false);
  });
});

// ─── GET /numbers ────────────────────────────────────────────────────────────

describe('listNumbers', () => {
  it('lists tenant-scoped rows ordered by created_at', async () => {
    const res = mockRes();
    await numbersController.listNumbers(req(), res);

    expect(p.phoneNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organization_id: 'org-1' },
        orderBy: { created_at: 'asc' },
      }),
    );
    const body = res.json.mock.calls[0][0];
    expect(body.numbers).toHaveLength(1);
    expect(body.numbers[0]).toMatchObject({
      id: 'pn-1',
      e164: '+12015550123',
      call_flow_id: FLOW_ID,
      sms_enabled: true,
      status: 'active',
    });
  });

  // Vendor names stay out of what the browser receives (CLAUDE.md boundary):
  // the number's id at the phone service travels as `provider_number_id`, and a
  // number bought through the phone service reads as source 'servwave'.
  it('sends the phone-service number id under a neutral key, with the old key as a deprecated alias', async () => {
    const res = mockRes();
    await numbersController.listNumbers(req(), res);

    const row = res.json.mock.calls[0][0].numbers[0];
    expect(row.provider_number_id).toBe('TPN-NEW');
    // TODO(phone-api-neutral-names): drop with the alias.
    expect(row.ctm_number_id).toBe('TPN-NEW');
  });

  it("presents a number bought through the phone service as source 'servwave', and keeps 'byo'", async () => {
    p.phoneNumber.findMany.mockResolvedValueOnce([
      dbRow(),
      dbRow({ id: 'pn-2', source: 'byo', ctm_number_id: null }),
    ]);
    const res = mockRes();
    await numbersController.listNumbers(req(), res);

    const [bought, byo] = res.json.mock.calls[0][0].numbers;
    expect(bought.source).toBe('servwave');
    expect(byo.source).toBe('byo');
    expect(byo.provider_number_id).toBeNull();
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/"ctm"/);
  });
});

// ─── POST /numbers/search ────────────────────────────────────────────────────

describe('searchNumbers', () => {
  it('503s when CTM keys are not configured', async () => {
    client.isCtmConfigured.mockReturnValue(false);
    const res = mockRes();
    await numbersController.searchNumbers(req({}), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(client.searchNumbers).not.toHaveBeenCalled();
  });

  it('409s when the org is not CTM-connected', async () => {
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });
    const res = mockRes();
    await numbersController.searchNumbers(req({}), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(client.searchNumbers).not.toHaveBeenCalled();
  });

  it('proxies a local areacode search to the CTM client under the org account', async () => {
    const res = mockRes();
    await numbersController.searchNumbers(req({ areacode: '201', type: 'local' }), res);
    expect(client.searchNumbers).toHaveBeenCalledWith('111111', { areacode: '201' });
  });

  // `type` is OUR API vocabulary, not CTM's. CTM has no `type` parameter: it
  // ignores the key, falls back to searchby=area and hands back LOCAL numbers,
  // which we then presented to the user as toll-free. Toll-free has to be
  // asked for as searchby=tollfree.
  it('translates type=tollfree into CTM searchby=tollfree', async () => {
    const res = mockRes();
    await numbersController.searchNumbers(req({ type: 'tollfree' }), res);
    expect(client.searchNumbers).toHaveBeenCalledWith('111111', { searchby: 'tollfree' });
  });

  // A local areacode alongside searchby=tollfree flips CTM back to an area
  // search, reintroducing the exact bug.
  it('drops a local areacode from a toll-free search', async () => {
    const res = mockRes();
    await numbersController.searchNumbers(req({ areacode: '201', type: 'tollfree' }), res);
    expect(client.searchNumbers).toHaveBeenCalledWith('111111', { searchby: 'tollfree' });
  });

  it('keeps a toll-free areacode, which CTM honours as a toll-free search', async () => {
    const res = mockRes();
    await numbersController.searchNumbers(req({ areacode: '833', type: 'tollfree' }), res);
    expect(client.searchNumbers).toHaveBeenCalledWith('111111', {
      searchby: 'tollfree',
      areacode: '833',
    });
  });

  it('never forwards `type` to the CTM client, under any input', async () => {
    const bodies = [{ type: 'local' }, { type: 'tollfree' }, { areacode: '201', type: 'tollfree' }];
    for (const body of bodies) {
      client.searchNumbers.mockClear();
      await numbersController.searchNumbers(req(body), mockRes());
      expect(client.searchNumbers.mock.calls[0][1]).not.toHaveProperty('type');
    }
  });

  it('STRIPS every price/cost field from the CTM response items', async () => {
    client.searchNumbers.mockResolvedValue([
      {
        phone_number: '+12015550100',
        friendly_name: '(201) 555-0100',
        price: '2.00',
        cost: 2,
        monthly_price: '1.00',
        setup_cost: '0.50',
      },
    ]);
    const res = mockRes();
    await numbersController.searchNumbers(req({}), res);

    const body = res.json.mock.calls[0][0];
    expect(body.numbers).toHaveLength(1);
    expect(body.numbers[0]).toMatchObject({
      phone_number: '+12015550100',
      friendly_name: '(201) 555-0100',
    });
    // No pricing key survives, under any spelling.
    expect(JSON.stringify(body)).not.toMatch(/price|cost/i);
  });

  it('502s a CTM API failure', async () => {
    client.searchNumbers.mockRejectedValue(ctmError(500, 'upstream broke'));
    const res = mockRes();
    await numbersController.searchNumbers(req({}), res);
    expect(res.status).toHaveBeenCalledWith(502);
  });
});

// ─── POST /numbers/buy ───────────────────────────────────────────────────────

describe('buyNumber', () => {
  const FORWARD_TO = '+16462023002';
  const buyBody = { phone_number: '+12015550123', forward_to_e164: FORWARD_TO, call_flow_id: FLOW_ID };

  it('409s when the org is not CTM-connected', async () => {
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });
    const res = mockRes();
    await numbersController.buyNumber(req(buyBody), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(client.buyNumber).not.toHaveBeenCalled();
  });

  it('404s a missing / foreign-org call_flow_id WITHOUT buying (when a flow is named)', async () => {
    p.callFlow.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await numbersController.buyNumber(req({ ...buyBody, call_flow_id: FOREIGN_FLOW_ID }), res);

    expect(p.callFlow.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: FOREIGN_FLOW_ID, organization_id: 'org-1' }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(client.buyNumber).not.toHaveBeenCalled();
    expect(p.phoneNumber.upsert).not.toHaveBeenCalled();
  });

  it('keeps test:true even when NODE_ENV=production unless CTM_PURCHASE_LIVE is set (staging trap)', async () => {
    // Render sets NODE_ENV=production on EVERY service including staging, so
    // NODE_ENV must not be the discriminator for real money. Only an explicit
    // CTM_PURCHASE_LIVE=true may disarm the test flag.
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const res = mockRes();
      await numbersController.buyNumber(req(buyBody), res);
      expect(client.buyNumber).toHaveBeenCalledWith('111111', {
        phone_number: '+12015550123',
        test: true,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('CTM_PURCHASE_LIVE=true is the only way to place a real (billed) purchase', async () => {
    vi.stubEnv('CTM_PURCHASE_LIVE', 'true');
    try {
      const res = mockRes();
      await numbersController.buyNumber(req(buyBody), res);
      expect(client.buyNumber).toHaveBeenCalledWith('111111', {
        phone_number: '+12015550123',
        test: false,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('buys with test:true outside production, ROUTES the new TPN to forward_to_e164, persists, and audits', async () => {
    const res = mockRes();
    await numbersController.buyNumber(req(buyBody), res);

    // NODE_ENV is 'test' under vitest → the CTM test flag must be set.
    expect(client.buyNumber).toHaveBeenCalledWith('111111', {
      phone_number: '+12015550123',
      test: true,
    });

    // Mandatory routing: receiving number registered, then the NEW TPN id
    // dial-routes to it (the PM blocker — a bought number must actually ring).
    expect(client.createReceivingNumber).toHaveBeenCalledWith('111111', FORWARD_TO);
    expect(client.updateNumberRouting).toHaveBeenCalledWith('111111', 'TPN-NEW', {
      dial_route: 'forward',
      numbers: [FORWARD_TO],
    });

    const upsert = p.phoneNumber.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({
      organization_id_e164: { organization_id: 'org-1', e164: '+12015550123' },
    });
    expect(upsert.create).toMatchObject({
      e164: '+12015550123',
      source: 'ctm',
      ctm_number_id: 'TPN-NEW',
      call_flow_id: FLOW_ID,
      route_to: { forward_to: FORWARD_TO },
      sms_enabled: true,
      status: 'active',
      organization_id: 'org-1',
    });
    expect(upsert.update.route_to).toEqual({ forward_to: FORWARD_TO });

    expect(p.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'number.purchased', org_id: 'org-1' }),
      }),
    );

    const body = res.json.mock.calls[0][0];
    expect(body.number).toMatchObject({ e164: '+12015550123', provider_number_id: 'TPN-NEW', source: 'servwave' });
    expect(body.warnings).toEqual([]);
  });

  // Regression, live incident 2026-08-05. The provider's real POST /numbers
  // wraps the created number under `number` (GET returns it flat), so
  // `purchased.id` was undefined and `String(purchased.number)` stored the
  // literal "[object Object]". A null tpnId then skipped BOTH `enableSms` AND
  // routing via the `if (tpnId)` guards - a paid number that rang nowhere,
  // recorded under a garbage e164. Every earlier test passed because the mock
  // used the flat shape: the fixture encoded the same wrong assumption as the
  // code. Unwrapping is the seam's job (see ctm-client.test.ts); what the
  // controller owes is that a shape it cannot parse degrades loudly instead of
  // writing a corrupt row.
  it('a purchase response it cannot parse never becomes a garbage row - it warns instead', async () => {
    client.buyNumber.mockResolvedValue({
      number: { id: 'TPN-WRAPPED', number: '+16095968565', formatted: '(609) 596-8565' },
    });
    const res = mockRes();
    await numbersController.buyNumber(
      req({ phone_number: '+16095968565', forward_to_e164: FORWARD_TO }),
      res,
    );

    const upsert = p.phoneNumber.upsert.mock.calls[0][0];
    expect(upsert.create.e164).toBe('+16095968565');
    expect(upsert.create.e164).not.toContain('object Object');
    expect(upsert.create.formatted).toBeNull();
    expect(upsert.create.ctm_number_id).toBeNull();

    // No tracking-number id means nothing downstream can run - say so.
    const warnings: string[] = res.json.mock.calls[0][0].warnings;
    expect(warnings).toContain('Texting could not be switched on for +16095968565.');
    expect(warnings.join(' ')).toMatch(/routing failed/i);
    expect(warnings.join(' ')).not.toMatch(/tracking-number|phone system|SMS/i);
  });

  // Defence in depth, independent of the provider's shape: an unparseable
  // number must never become a row. Fall back to what the caller asked to buy.
  it('never persists a non-E.164 e164 - falls back to the requested number', async () => {
    client.buyNumber.mockResolvedValue({ unexpected: { shape: true } });
    const res = mockRes();
    await numbersController.buyNumber(
      req({ phone_number: '+16095968565', forward_to_e164: FORWARD_TO }),
      res,
    );

    const upsert = p.phoneNumber.upsert.mock.calls[0][0];
    expect(upsert.create.e164).toBe('+16095968565');
    expect(upsert.where.organization_id_e164.e164).toBe('+16095968565');
  });

  it('buys WITHOUT call_flow_id (optional metadata) — no flow lookup, flow persists null', async () => {
    const res = mockRes();
    await numbersController.buyNumber(
      req({ phone_number: '+12015550123', forward_to_e164: FORWARD_TO }),
      res,
    );

    expect(p.callFlow.findFirst).not.toHaveBeenCalled();
    expect(client.buyNumber).toHaveBeenCalledTimes(1);
    expect(client.updateNumberRouting).toHaveBeenCalledWith('111111', 'TPN-NEW', {
      dial_route: 'forward',
      numbers: [FORWARD_TO],
    });
    const upsert = p.phoneNumber.upsert.mock.calls[0][0];
    expect(upsert.create.call_flow_id).toBeNull();
    expect(upsert.update.call_flow_id).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('normalizes a bare 10-digit forward_to_e164 before routing', async () => {
    const res = mockRes();
    await numbersController.buyNumber(
      req({ phone_number: '+12015550123', forward_to_e164: '6462023002' }),
      res,
    );

    expect(client.createReceivingNumber).toHaveBeenCalledWith('111111', FORWARD_TO);
    expect(client.updateNumberRouting).toHaveBeenCalledWith('111111', 'TPN-NEW', {
      dial_route: 'forward',
      numbers: [FORWARD_TO],
    });
  });

  it("tolerates an 'already exists' receiving-number error and still routes", async () => {
    client.createReceivingNumber.mockRejectedValue(ctmError(406, 'Receiving number already exists'));
    const res = mockRes();
    await numbersController.buyNumber(req(buyBody), res);

    expect(client.updateNumberRouting).toHaveBeenCalledWith('111111', 'TPN-NEW', {
      dial_route: 'forward',
      numbers: [FORWARD_TO],
    });
    expect(p.phoneNumber.upsert.mock.calls[0][0].create.route_to).toEqual({ forward_to: FORWARD_TO });
    expect(res.json.mock.calls[0][0].warnings).toEqual([]);
  });

  it('routing failure NEVER loses the purchased row — persists with route_to null + a warning', async () => {
    client.updateNumberRouting.mockRejectedValue(ctmError(500, 'routing exploded'));
    const res = mockRes();
    await numbersController.buyNumber(req(buyBody), res);

    // The row still lands (route_to unset = SQL NULL) …
    const upsert = p.phoneNumber.upsert.mock.calls[0][0];
    expect(upsert.create.route_to).toBeUndefined();
    expect(upsert.update.route_to).toBeUndefined();
    // … the response is still a 201 with the typed warning.
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0][0];
    expect(body.warnings.join(' ')).toMatch(
      /purchased but routing failed — contact support to finish setup/i,
    );
  });

  it('surfaces an enable_sms 406 as a warning + sms_enabled false — never fails the buy', async () => {
    client.enableSms.mockResolvedValue('failure');
    p.phoneNumber.upsert.mockResolvedValue(dbRow({ sms_enabled: false }));
    const res = mockRes();
    await numbersController.buyNumber(req(buyBody), res);

    expect(p.phoneNumber.upsert.mock.calls[0][0].create.sms_enabled).toBe(false);
    const body = res.json.mock.calls[0][0];
    // The warning becomes a toast: plain words, never the provider's outcome code.
    expect(body.warnings).toEqual([`Texting could not be switched on for ${buyBody.phone_number}.`]);
    expect(body.warnings.join(' ')).not.toMatch(/failure|SMS|\(/);
    expect(res.status).not.toHaveBeenCalledWith(502);
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it('surfaces an enable_sms 404 (notfound) the same way', async () => {
    client.enableSms.mockResolvedValue('notfound');
    const res = mockRes();
    await numbersController.buyNumber(req(buyBody), res);
    expect(p.phoneNumber.upsert.mock.calls[0][0].create.sms_enabled).toBe(false);
    expect(res.json.mock.calls[0][0].warnings).toEqual([
      `Texting could not be switched on for ${buyBody.phone_number}.`,
    ]);
    expect(res.json.mock.calls[0][0].warnings.join(' ')).not.toMatch(/notfound|SMS|\(/);
  });

  it('a texting check that throws is reported in the same plain words', async () => {
    client.enableSms.mockRejectedValue(ctmError(500, 'enable_sms exploded'));
    const res = mockRes();
    await numbersController.buyNumber(req(buyBody), res);
    expect(res.json.mock.calls[0][0].warnings).toEqual([
      `Texting could not be switched on for ${buyBody.phone_number}.`,
    ]);
  });

  it("409s CTM 'unavailable'/duplicate purchase errors (typed, not 502)", async () => {
    client.buyNumber.mockRejectedValue(ctmError(406, 'That phone number is unavailable'));
    const res = mockRes();
    await numbersController.buyNumber(req(buyBody), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].code).toBe('NUMBER_UNAVAILABLE');
    expect(p.phoneNumber.upsert).not.toHaveBeenCalled();
  });

  it('502s an unexpected CtmApiError', async () => {
    client.buyNumber.mockRejectedValue(ctmError(500, 'internal upstream error'));
    const res = mockRes();
    await numbersController.buyNumber(req(buyBody), res);
    expect(res.status).toHaveBeenCalledWith(502);
  });
});

// ─── PATCH /numbers/:id ──────────────────────────────────────────────────────

describe('updateNumber (flow reassign)', () => {
  it("404s another org's number (org-scoped findFirst)", async () => {
    p.phoneNumber.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await numbersController.updateNumber(req({ call_flow_id: FLOW_ID }, { id: 'pn-org-b' }), res);

    expect(p.phoneNumber.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'pn-org-b', organization_id: 'org-1' }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(p.phoneNumber.update).not.toHaveBeenCalled();
  });

  it('404s a foreign call_flow_id', async () => {
    p.callFlow.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await numbersController.updateNumber(req({ call_flow_id: FOREIGN_FLOW_ID }, { id: 'pn-1' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(p.phoneNumber.update).not.toHaveBeenCalled();
  });

  it('updates call_flow_id ONLY', async () => {
    const res = mockRes();
    await numbersController.updateNumber(req({ call_flow_id: FLOW_ID }, { id: 'pn-1' }), res);

    expect(p.phoneNumber.update).toHaveBeenCalledWith({
      where: { id: 'pn-1' },
      data: { call_flow_id: FLOW_ID },
    });
    expect(res.json.mock.calls[0][0].number).toMatchObject({ id: 'pn-1' });
  });

  it('clears the flow with call_flow_id: null (no flow lookup)', async () => {
    const res = mockRes();
    await numbersController.updateNumber(req({ call_flow_id: null }, { id: 'pn-1' }), res);
    expect(p.callFlow.findFirst).not.toHaveBeenCalled();
    expect(p.phoneNumber.update).toHaveBeenCalledWith({
      where: { id: 'pn-1' },
      data: { call_flow_id: null },
    });
  });
});

// ─── POST /numbers/register-byo ──────────────────────────────────────────────

describe('registerByoNumber', () => {
  it("creates a source:'byo' row with NO CTM calls", async () => {
    const res = mockRes();
    await numbersController.registerByoNumber(req({ e164: '+12015551234', label: 'Office' }), res);

    expect(p.phoneNumber.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        e164: '+12015551234',
        label: 'Office',
        source: 'byo',
        sms_enabled: false,
        status: 'active',
        organization_id: 'org-1',
      }),
    });
    expect(client.buyNumber).not.toHaveBeenCalled();
    expect(client.enableSms).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('409s a duplicate (org, e164) registration', async () => {
    p.phoneNumber.create.mockRejectedValue({ code: 'P2002' });
    const res = mockRes();
    await numbersController.registerByoNumber(req({ e164: '+12015551234' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

// ─── Route gating (addendum §A.2: ADMIN idiom for money/config actions) ──────

describe('route gating', () => {
  const src = () => readFileSync(join(__dirname, '../routes/comm-numbers.routes.ts'), 'utf8');

  it("gates search/buy/register-byo with canDo('update','Organization')", () => {
    const lines = src().split('\n');
    for (const path of ['/numbers/search', '/numbers/buy', '/numbers/register-byo']) {
      const line = lines.find((l) => l.includes(`'${path}'`));
      expect(line, `route ${path} missing`).toBeTruthy();
      expect(line).toContain("canDo('update', 'Organization')");
    }
  });

  it("gates GET /numbers with read-Communication and PATCH with update-Communication", () => {
    const lines = src().split('\n');
    const getLine = lines.find((l) => l.includes(".get('/numbers'"));
    expect(getLine, 'GET /numbers missing').toBeTruthy();
    expect(getLine).toContain("canDo('read', 'Communication')");

    const patchLine = lines.find((l) => l.includes(".patch('/numbers/:id'"));
    expect(patchLine, 'PATCH /numbers/:id missing').toBeTruthy();
    expect(patchLine).toContain("canDo('update', 'Communication')");
  });

  it('is mounted as a communication router in app.ts', () => {
    const appSrc = readFileSync(join(__dirname, '../app.ts'), 'utf8');
    expect(appSrc).toMatch(/app\.use\('\/api\/communication',\s*commNumbersRoutes\)/);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
