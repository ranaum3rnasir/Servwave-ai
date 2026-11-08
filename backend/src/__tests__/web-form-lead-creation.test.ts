/**
 * What a web-form submission BECOMES: a Customer and a Lead.
 * Plan: md_files/plans/communication/2026-09-18-web-form-lead-intake.md §3d/§3e,
 * and md_files/plans/communication/2026-09-18-source-is-a-first-touch-customer-attribute.md
 * §1 (R1-R6) for where the source value is allowed to land.
 *
 * Driven through the mounted router with a real POST, the same surface the form
 * plugin hits - never by calling the lib directly, except for the one primitives
 * guard that the adapter can never produce a fixture for.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { processWebFormSubmission } from '../lib/web-form/process';

const app = express();
app.use('/api/webhooks', webhookRoutes);

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const TOKEN = 'a'.repeat(64);
const ORG_ID = 'b0000000-0000-0000-0000-0000000000bb';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000cc';

/** One integration row, with whatever `default_lead_source` a test needs. */
const integration = (over: Record<string, unknown> = {}) => ({
  id: 'wfi-1',
  organization_id: ORG_ID,
  field_map: null,
  default_lead_source: null,
  ...over,
});

/** A submission as the plugin sends it: flat JSON, slugs with UNDERSCORES. */
const SUBMISSION = {
  name_1: 'Dana',
  name_2: 'Okafor',
  email_1: 'Dana.Okafor@example.test',
  phone_1: '(609) 555-0123',
  textarea_1: 'Looking for a quote on a new front door.',
  select_1: 'Replacement',
  current_url: 'https://example.test/contact',
  referer_url: 'https://search.example/',
  form_title: 'Request a Quote',
  entry_time: '2026-09-18 09:41:07',
};

function post(body: unknown, headers: Record<string, string> = {}) {
  let r = request(app)
    .post(`/api/webhooks/web-form/forminator/${TOKEN}`)
    .set('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Let the post-ack setImmediate continuation settle. */
const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));

/** The data object of the n-th create on a delegate. */
const createData = (delegate: any, n = 0) => delegate.create.mock.calls[n][0].data;

beforeEach(() => {
  vi.clearAllMocks();
  p.webFormIntegration.findFirst.mockResolvedValue(integration());
  p.webFormIntegration.update.mockResolvedValue({});
  p.webFormSubmission.create.mockResolvedValue({ id: 'wfs-1' });
  p.webFormSubmission.update.mockResolvedValue({});
  // The transaction runs against the same mocked client, so every delegate a
  // test stubs is the one the code sees inside it.
  p.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(p));
  // Nobody matches by default: no customer, no open lead, no vendor.
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.customer.create.mockResolvedValue({ id: CUSTOMER_ID });
  p.customer.updateMany.mockResolvedValue({ count: 1 });
  p.lead.create.mockResolvedValue({ id: 'lead-1' });
});

describe('a submission from an unknown contact', () => {
  it('creates a Customer and a Lead, both stamped CLIENT', async () => {
    const res = await post(SUBMISSION);
    expect(res.status).toBe(200);
    await flush();

    expect(p.customer.create).toHaveBeenCalledTimes(1);
    expect(createData(p.customer)).toMatchObject({
      organization_id: ORG_ID,
      first_name: 'Dana',
      last_name: 'Okafor',
      email: 'dana.okafor@example.test',
      // Stored digits-only, the one form every other customer-create path writes.
      phone: '6095550123',
      // The CUSTOMER did this themselves through a public, unauthenticated
      // surface. There is no req.user to attribute it to and inventing one
      // would be a lie; SYSTEM would be one too - a visitor decided this.
      created_by_id: null,
      created_by_source: 'CLIENT',
    });

    expect(p.lead.create).toHaveBeenCalledTimes(1);
    expect(createData(p.lead)).toMatchObject({
      organization_id: ORG_ID,
      customer_id: CUSTOMER_ID,
      service_request: 'Looking for a quote on a new front door.',
      created_by_source: 'CLIENT',
    });
  });
});

describe('where the source value lands (first-touch rule R1-R4)', () => {
  it('sets a new customer ad_source from the submission\'s own utm_source', async () => {
    // The hidden URL-capture fields arrive as ordinary flat keys, one per value.
    await post({ ...SUBMISSION, utm_source: 'google', utm_medium: 'cpc' });
    await flush();

    // Written through the guard, not straight onto the create: the same one
    // statement every automated first-touch writer uses.
    //
    // BOTH columns, from the one value, in the one statement. The human path
    // keeps them as mirrors (CustomerFormPage's single "How Did They Hear About
    // Us?" control sets `source` and `ad_source` together), and they surface on
    // DIFFERENT screens: the customers list reads `ad_source`, the customer form
    // reads `source`. Writing one alone gives a form-created customer a source
    // in the list and a blank control on the record - the very control the
    // first-touch plan calls the one-click correction.
    expect(p.customer.updateMany).toHaveBeenCalledWith({
      where: { id: CUSTOMER_ID, organization_id: ORG_ID, ad_source: null, source: null },
      data: { ad_source: 'google', source: 'google' },
    });
  });

  it('falls back to the integration row\'s default_lead_source when the payload names no campaign', async () => {
    // The realistic case today: the hidden URL-capture fields do not exist on
    // the customer's form yet, so the operator's fallback is the origin.
    p.webFormIntegration.findFirst.mockResolvedValue(integration({ default_lead_source: 'Website' }));
    await post(SUBMISSION);
    await flush();

    expect(p.customer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ad_source: 'Website', source: 'Website' } }),
    );
  });

  it('prefers the submission\'s campaign over the fallback', async () => {
    p.webFormIntegration.findFirst.mockResolvedValue(integration({ default_lead_source: 'Website' }));
    await post({ ...SUBMISSION, utm_source: 'google' });
    await flush();

    expect(p.customer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ad_source: 'google', source: 'google' } }),
    );
  });

  it('writes nothing at all when neither exists: a blank string is not an origin', async () => {
    p.webFormIntegration.findFirst.mockResolvedValue(integration({ default_lead_source: '   ' }));
    await post({ ...SUBMISSION, utm_source: '' });
    await flush();

    expect(p.customer.create).toHaveBeenCalledTimes(1);
    expect(p.customer.updateMany).not.toHaveBeenCalled();
    expect(createData(p.customer)).not.toHaveProperty('ad_source');
    expect(createData(p.customer)).not.toHaveProperty('source');
  });
});

describe('a submission matching an existing customer', () => {
  const EXISTING_ID = 'c0000000-0000-0000-0000-00000000dddd';
  /** The customer shape lib/comms-identity selects when it resolves a phone or an email. */
  const existing = (over: Record<string, unknown> = {}) => ({
    id: EXISTING_ID,
    first_name: 'Dana',
    last_name: 'Okafor',
    company_name: null,
    ...over,
  });

  it('opens a Lead on them and does NOT rewrite their source or ad_source (R3/R4)', async () => {
    // The whole point of the rule: this client first came through a Facebook
    // ad, and is now back through a Google campaign. A second touch is not a
    // new origin, and no automated path may say otherwise.
    p.customer.findFirst.mockResolvedValue(existing());
    p.webFormIntegration.findFirst.mockResolvedValue(integration({ default_lead_source: 'Website' }));

    const res = await post({ ...SUBMISSION, utm_source: 'google', utm_campaign: 'spring-doors' });
    expect(res.status).toBe(200);
    await flush();

    // NEITHER column is touched, because no update statement is issued at all -
    // not because a guard filtered one out.
    expect(p.customer.create).not.toHaveBeenCalled();
    expect(p.customer.updateMany).not.toHaveBeenCalled();
    expect(p.customer.update).not.toHaveBeenCalled();

    expect(p.lead.create).toHaveBeenCalledTimes(1);
    expect(createData(p.lead)).toMatchObject({ customer_id: EXISTING_ID });
  });

  it('still writes nothing when their ad_source happens to be empty', async () => {
    // The guarded UPDATE would match a null ad_source, so the guard alone is not
    // what protects an existing customer - the statement is never issued for one.
    // Automation may set an origin when it CREATES a customer, and never again;
    // a person filling the gap in is R5 and is not this code's business.
    p.customer.findFirst.mockResolvedValue(existing({ ad_source: null, source: null }));
    await post({ ...SUBMISSION, utm_source: 'google' });
    await flush();

    expect(p.customer.updateMany).not.toHaveBeenCalled();
    expect(p.lead.create).toHaveBeenCalledTimes(1);
  });

  it('matches on PHONE before email, the handle the office searches on', async () => {
    p.customer.findFirst.mockResolvedValue(existing());
    await post(SUBMISSION);
    await flush();

    // The first customer lookup is the phone one: bare, E.164 and raw forms,
    // across the scalar, the legacy secondary and the phones[] relation.
    const where = p.customer.findFirst.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ORG_ID);
    expect(JSON.stringify(where)).toContain('6095550123');
    expect(JSON.stringify(where)).not.toContain('dana.okafor@example.test');
  });

  it('falls back to the lowercased email when no phone matches', async () => {
    p.customer.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(existing());
    await post(SUBMISSION);
    await flush();

    expect(p.customer.findFirst.mock.calls[1][0].where).toMatchObject({
      organization_id: ORG_ID,
      email: 'dana.okafor@example.test',
    });
    expect(p.customer.create).not.toHaveBeenCalled();
    expect(createData(p.lead)).toMatchObject({ customer_id: EXISTING_ID });
  });

  it('opens a SECOND lead on the SAME customer for a second submission (§3d.4)', async () => {
    // No attach-to-existing-open-lead rule: the agency's own system behaves this
    // way and the office is used to it. Merging stays a human decision made
    // against both records, rather than a rule that silently hides the second.
    p.customer.findFirst.mockResolvedValue(existing());

    // THE OPEN LEAD IS THERE TO BE FOUND, overriding the file-wide `null` stub.
    // Without it this test could not fail: with nothing for an attach rule to
    // resolve, adding one to openLead left every assertion below green, so the
    // rule this test exists to forbid was not forbidden by anything.
    p.lead.findFirst.mockResolvedValue({
      id: 'lead-already-open',
      customer_id: EXISTING_ID,
      status: 'NEW',
      organization_id: ORG_ID,
    });

    p.lead.create.mockResolvedValueOnce({ id: 'lead-1' }).mockResolvedValueOnce({ id: 'lead-2' });

    await post(SUBMISSION);
    await post({ ...SUBMISSION, textarea_1: 'Following up on my quote request.' });
    await flush();

    expect(p.customer.create).not.toHaveBeenCalled();
    expect(p.lead.create).toHaveBeenCalledTimes(2);
    expect(createData(p.lead, 0)).toMatchObject({ customer_id: EXISTING_ID });
    expect(createData(p.lead, 1)).toMatchObject({ customer_id: EXISTING_ID });
    expect(createData(p.lead, 1).service_request).toBe('Following up on my quote request.');
  });
});

describe('what the office reads on the lead', () => {
  it('uses the message as the service request', async () => {
    await post(SUBMISSION);
    await flush();
    expect(createData(p.lead).service_request).toBe('Looking for a quote on a new front door.');
  });

  it('falls back to the selection when the message is empty', async () => {
    await post({ ...SUBMISSION, textarea_1: '   ', text_1: '' });
    await flush();
    expect(createData(p.lead).service_request).toBe('Replacement');
  });

  it('falls back to a neutral string when the form carried neither', async () => {
    // service_request is NOT-NULL, so this fallback is load-bearing. It is read
    // inside the CRM, so it names no vendor - every capability is ServWave's own.
    await post({ ...SUBMISSION, textarea_1: '', text_1: '', select_1: '' });
    await flush();
    expect(createData(p.lead).service_request).toBe('Website form submission');
  });

  it('never writes Lead.source on any path', async () => {
    // The column is dead and must stay that way: source is a first-touch
    // CUSTOMER attribute, so a lead-level one would give a returning customer
    // two different origins and let the most recent quietly win any report.
    p.webFormIntegration.findFirst.mockResolvedValue(integration({ default_lead_source: 'Website' }));

    // New customer, campaign in the payload.
    await post({ ...SUBMISSION, utm_source: 'google' });
    // New customer, fallback only.
    await post({ ...SUBMISSION, phone_1: '(609) 555-0188', email_1: 'other@example.test' });
    // Existing customer.
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID, first_name: 'D', last_name: null, company_name: null });
    await post({ ...SUBMISSION, utm_source: 'facebook' });
    await flush();

    expect(p.lead.create).toHaveBeenCalledTimes(3);
    for (const call of p.lead.create.mock.calls) {
      expect(call[0].data).not.toHaveProperty('source');
    }
  });

  it('opens the lead unassigned, with no commission owner and no visit', async () => {
    await post(SUBMISSION);
    await flush();
    const data = createData(p.lead);
    expect(data).not.toHaveProperty('commission_owner_id');
    expect(data).not.toHaveProperty('lead_assignees');
    expect(data).not.toHaveProperty('visits');
  });
});

describe('the status a form lead opens in', () => {
  it('passes no status, so the database default (NEW) applies like it does for a lead made in the app', async () => {
    // Lead statuses are fixed (walkthrough lead-statuses PRD, D12): a lead is a lead however it
    // arrived, and every one starts at the column's default.
    await post(SUBMISSION);
    await flush();

    expect(createData(p.lead)).not.toHaveProperty('status');
  });
});

describe('Lead.attribution (plan §3e)', () => {
  it('writes the same key names the call side already uses', async () => {
    // One column reads the same whether the lead came from a call or a form, so
    // "which campaign produced revenue" is one UNION rather than two schemas.
    await post({
      ...SUBMISSION,
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'spring-doors',
      utm_term: 'front door replacement',
      gclid: 'CjwKCAjw-REAL-CLICK-ID',
      // The paid-social and paid-Bing click ids the call side already writes.
      // Missing here, the shared vocabulary breaks for exactly the two channels
      // these keys exist to identify, and the UNION needs two schemas again.
      fbclid: 'IwAR0-REAL-META-CLICK-ID',
      msclkid: 'a1b2c3d4-REAL-BING-CLICK-ID',
    });
    await flush();

    expect(createData(p.lead).attribution).toEqual({
      source: 'google',
      medium: 'cpc',
      campaign: 'spring-doors',
      keyword: 'front door replacement',
      referrer: 'https://search.example/',
      landing_page: 'https://example.test/contact',
      gclid: 'CjwKCAjw-REAL-CLICK-ID',
      fbclid: 'IwAR0-REAL-META-CLICK-ID',
      msclkid: 'a1b2c3d4-REAL-BING-CLICK-ID',
    });
  });

  it('omits what the submission did not carry rather than storing empty strings', async () => {
    // An empty bucket in a GROUP BY is worse than no bucket, and a row of nulls
    // makes "no campaign" indistinguishable from "never captured".
    await post({ ...SUBMISSION, utm_source: 'google', utm_medium: '', referer_url: '' });
    await flush();

    const attribution = createData(p.lead).attribution;
    expect(attribution).toEqual({
      source: 'google',
      landing_page: 'https://example.test/contact',
    });
    expect(Object.keys(attribution)).not.toContain('medium');
    expect(Object.keys(attribution)).not.toContain('referrer');
  });

  it('is SQL NULL, never {}, when nothing survived', async () => {
    await post({ form_title: 'Request a Quote', name_1: 'Dana', phone_1: '(609) 555-0123' });
    await flush();
    expect(createData(p.lead).attribution).toBe(Prisma.DbNull);
  });

  it('keeps the per-submission campaign for a RETURNING customer, whose origin it must not rewrite', async () => {
    // This is the point of having both columns: the detail is not lost, it just
    // does not rewrite who the customer is.
    p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID, first_name: 'D', last_name: null, company_name: null });
    await post({ ...SUBMISSION, utm_source: 'facebook', utm_campaign: 'retargeting' });
    await flush();

    expect(p.customer.updateMany).not.toHaveBeenCalled();
    expect(createData(p.lead).attribution).toMatchObject({ source: 'facebook', campaign: 'retargeting' });
  });

  it('lets no non-primitive reach the column, whatever the payload does', async () => {
    // The phone system's gclid is the literal string `[object Object]` on 507 of
    // 507 prod rows because an object was String()d into it. The same key names
    // land here, so the same mistake must be impossible on this side.
    await post({
      ...SUBMISSION,
      utm_source: { cid: 'GA1.2.323960849.1785942110', ga4: [['_ga_X', 'GS2.1']] },
      gclid: { nested: { deeper: true } },
      utm_campaign: 'spring-doors',
    });
    await flush();

    const attribution = createData(p.lead).attribution;
    expect(attribution).toEqual({
      campaign: 'spring-doors',
      referrer: 'https://search.example/',
      landing_page: 'https://example.test/contact',
    });
    for (const value of Object.values(attribution)) {
      expect(typeof value).toBe('string');
      expect(value).not.toBe('[object Object]');
    }
  });
});

describe('what a public form is allowed to make long', () => {
  it('caps every free-text value it writes at the ceiling the human path already enforces', async () => {
    // These are all Postgres `text`, so the database takes a 95KB name happily
    // and the office then reads it in every customer list, every picker and
    // every export. `Customer.source` was already capped at 100 to agree with
    // the human form; nothing else was capped at all.
    const huge = 'x'.repeat(95_000);
    await post({
      ...SUBMISSION,
      name_1: huge,
      name_2: huge,
      email_1: `${huge}@example.test`,
      textarea_1: huge,
      current_url: `https://example.test/${huge}`,
    });
    await flush();

    const customer = createData(p.customer);
    // 100: `z.string().max(100)` on first_name/last_name in customer.controller.
    expect(customer.first_name).toHaveLength(100);
    expect(customer.last_name).toHaveLength(100);
    // 254: RFC 5321's maximum path length. normalizeEmail shape-checks and
    // lowercases but does not bound length, so a 95KB address normalises fine.
    expect(customer.email.length).toBeLessThanOrEqual(254);

    const lead = createData(p.lead);
    // 2000: `z.string().min(1).max(2000)` on service_request in lead.controller.
    expect(lead.service_request).toHaveLength(2000);
    expect(lead.attribution.landing_page).toHaveLength(2000);
  });
});

describe('the primitives guard, independent of the adapter', () => {
  it('drops a non-primitive tracking value even when one is handed straight to the lib', async () => {
    // The only test here that does not go through the router: the adapter
    // physically cannot produce this event, because `str()` already flattens or
    // drops every non-primitive before `trackingParams` is built. That is
    // exactly why the guard at the write site needs its own proof - the next
    // vendor's adapter has not been written yet, and the call side's 507 bad
    // rows are what one unchecked String() costs.
    const event = {
      provider: 'forminator' as const,
      vendorSubmissionId: 'entry-77',
      formTitle: 'Request a Quote',
      firstName: 'Dana',
      lastName: null,
      phone: '+16095550123',
      email: null,
      message: 'Quote please',
      selection: null,
      landingPageUrl: null,
      referringUrl: null,
      trackingParams: {
        utm_source: { cid: 'GA1.2.323960849' },
        utm_campaign: ['spring', 'doors'],
        gclid: () => 'nope',
        utm_medium: 'cpc',
      } as unknown as Record<string, string>,
      submittedAt: new Date(),
      extras: {},
    };

    await processWebFormSubmission(p, ORG_ID, event, { entry_id: 'entry-77' }, new Date(), null);

    const attribution = createData(p.lead).attribution;
    expect(attribution).toEqual({ medium: 'cpc' });
    expect(JSON.stringify(attribution)).not.toContain('[object Object]');
  });
});

describe('the ledger row is the audit trail', () => {
  it('records which Customer and which Lead the payload became', async () => {
    await post(SUBMISSION);
    await flush();

    expect(p.webFormSubmission.update).toHaveBeenCalledWith({
      where: { id: 'wfs-1' },
      data: { lead_id: 'lead-1', customer_id: CUSTOMER_ID },
    });
  });

  it('survives with the raw payload and null ids when the lead work throws', async () => {
    // The submission is NEVER lost. A failure costs the Lead, not the record of
    // what arrived, and the 200 has already gone out - this vendor does not
    // retry, so a non-2xx would destroy the lead outright.
    p.customer.create.mockRejectedValue(new Error('customers table is on fire'));

    const res = await post(SUBMISSION);
    expect(res.status).toBe(200);
    await flush();

    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(1);
    expect(createData(p.webFormSubmission)).toMatchObject({ payload: SUBMISSION });
    expect(p.webFormSubmission.update).not.toHaveBeenCalled();
    expect(p.lead.create).not.toHaveBeenCalled();
  });

  it('names the submission key in the failure log, and no contact handle', async () => {
    p.customer.create.mockRejectedValue(new Error('customers table is on fire'));
    await post(SUBMISSION);
    await flush();

    const line = (logger.error as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(line).toContain('key=');
    expect(line).not.toContain('6095550123');
    expect(line).not.toContain('555-0123');
    expect(line).not.toContain('dana.okafor@example.test');
    expect(line).not.toContain('Okafor');
  });
});

describe('the slice-1 gates still hold', () => {
  it('creates no Customer and no Lead for the save-time test probe', async () => {
    // The probe's values are field LABELS. Without this gate the agency's first
    // Save opens a lead called "First Name" and a customer to hang it on.
    const res = await post(
      { name_1: 'First Name', email_1: 'Email Address', phone_1: 'Phone Number' },
      { 'X-Hook-Test': 'true' },
    );
    expect(res.status).toBe(200);
    await flush();

    expect(p.customer.create).not.toHaveBeenCalled();
    expect(p.lead.create).not.toHaveBeenCalled();
    expect(p.webFormSubmission.create).not.toHaveBeenCalled();
  });

  it('creates exactly one Customer and one Lead when the same key arrives twice', async () => {
    // The claim-insert is the lock and it runs BEFORE any of this work, so the
    // loser of the unique index never reaches the customer path at all.
    p.webFormSubmission.create
      .mockResolvedValueOnce({ id: 'wfs-1' })
      .mockRejectedValueOnce(Object.assign(new Error('unique violation'), { code: 'P2002' }));

    await post(SUBMISSION);
    await post(SUBMISSION);
    await flush();

    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(2);
    expect(p.customer.create).toHaveBeenCalledTimes(1);
    expect(p.lead.create).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('creates nothing for a submission with no usable contact handle', async () => {
    const res = await post({ form_title: 'Request a Quote', name_1: 'Dana', textarea_1: 'call me' });
    expect(res.status).toBe(202);
    await flush();

    expect(p.customer.create).not.toHaveBeenCalled();
    expect(p.lead.create).not.toHaveBeenCalled();
  });
});

/**
 * MULTI-TENANCY: whose submission key is it?
 *
 * The vendor's own entry id is the form plugin's PER-SITE sequential entry
 * counter - every site's second submission is `2` - so a key without the org in
 * it is a GLOBAL key. Under one, an ordinary submission for org B is a
 * "duplicate" of org A's, and the duplicate branch stores nothing at all: no
 * ledger row (the payload is not even archived), no Customer, no Lead, and the
 * only trace is a log line that reads like healthy de-duplication. That is a
 * paying customer losing an inbound lead silently.
 *
 * The constraint is READ from the generated client rather than restated here,
 * so these two tests enforce whatever `WebFormSubmission`'s `@@unique` actually
 * declares. Narrow it back to (provider, submission_key) and the first one goes
 * red.
 */
describe('two orgs sending the same submission key', () => {
  const LEDGER_UNIQUE = Prisma.dmmf.datamodel.models.find((m) => m.name === 'WebFormSubmission')!
    .uniqueIndexes[0].fields;

  const ORG_B = 'd0000000-0000-0000-0000-0000000000dd';
  const TOKEN_B = 'e'.repeat(64);
  /** The plugin's per-site counter, identical on both sites. */
  const ENTRY_ID = '12';

  const postTo = (token: string, body: unknown) =>
    request(app)
      .post(`/api/webhooks/web-form/forminator/${token}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));

  beforeEach(() => {
    // Stand-in for the unique index: the first claim on a key wins, every later
    // one gets the P2002 Postgres would raise.
    const claimed = new Set<string>();
    p.webFormSubmission.create.mockImplementation(async ({ data }: any) => {
      const key = JSON.stringify(LEDGER_UNIQUE.map((f: string) => String(data[f])));
      if (claimed.has(key)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: 'P2002',
        });
      }
      claimed.add(key);
      return { id: `wfs-${claimed.size}` };
    });
    p.webFormIntegration.findFirst.mockImplementation(async ({ where }: any) =>
      where.url_token === TOKEN_B ? integration({ id: 'wfi-2', organization_id: ORG_B }) : integration(),
    );
    p.customer.create.mockImplementation(async ({ data }: any) => ({ id: `cust-${data.organization_id}` }));
    p.lead.create.mockImplementation(async ({ data }: any) => ({ id: `lead-${data.organization_id}` }));
  });

  it('gives each org its own ledger row, its own Customer and its own Lead', async () => {
    expect((await postTo(TOKEN, { ...SUBMISSION, entry_id: ENTRY_ID })).status).toBe(200);
    await flush();
    expect((await postTo(TOKEN_B, { ...SUBMISSION, entry_id: ENTRY_ID })).status).toBe(200);
    await flush();

    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(2);
    expect(createData(p.webFormSubmission, 0)).toMatchObject({
      organization_id: ORG_ID,
      submission_key: ENTRY_ID,
    });
    // The second claim SUCCEEDS: same key, different org, different row.
    expect(createData(p.webFormSubmission, 1)).toMatchObject({
      organization_id: ORG_B,
      submission_key: ENTRY_ID,
    });

    expect(p.customer.create).toHaveBeenCalledTimes(2);
    expect(p.lead.create).toHaveBeenCalledTimes(2);
    expect(createData(p.lead, 0)).toMatchObject({ organization_id: ORG_ID });
    expect(createData(p.lead, 1)).toMatchObject({ organization_id: ORG_B });

    // The losing org would be told nothing but this line.
    const info = (logger.info as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(info).not.toContain('duplicate submission ignored');
  });

  it('still collapses a real duplicate WITHIN one org to one Customer and one Lead', async () => {
    // Org-scoping the key must not cost the double-click de-duplication the key
    // exists for.
    await postTo(TOKEN, { ...SUBMISSION, entry_id: ENTRY_ID });
    await flush();
    await postTo(TOKEN, { ...SUBMISSION, entry_id: ENTRY_ID });
    await flush();

    expect(p.webFormSubmission.create).toHaveBeenCalledTimes(2);
    expect(p.customer.create).toHaveBeenCalledTimes(1);
    expect(p.lead.create).toHaveBeenCalledTimes(1);
    const info = (logger.info as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(info).toContain('duplicate submission ignored');
  });
});
