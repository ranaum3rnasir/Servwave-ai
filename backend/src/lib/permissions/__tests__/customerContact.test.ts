/**
 * #1997 — unit coverage for `redactCustomerContactFor`, the pure per-requester field strip
 * `estimate.controller.ts` / `invoice.controller.ts`'s detail-response presenters apply as their
 * LAST transform. Mirrors `enforce.test.ts`'s `reqWith` pattern (a real `defineAbilityFor` ability,
 * never a bare CASL literal) rather than going through HTTP or a mocked Prisma client — the
 * contract under test is synchronous and DB-free by design (spec: no per-row re-fetch, N+1 across
 * the 11 invoice-lines sites).
 */
import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { defineAbilityFor, type Grant } from '../defineAbility';
import { scopeWhereFor, MATCH_NOTHING } from '../scopeWhereFor';
import { CUSTOMER_CONTACT_KEYS, redactCustomerContactFor, presentEstimateDetail, presentInvoiceDetail } from '../customerContact';

/**
 * #2041 — `isCustomerReadable` (customerContact.ts) no longer asks `req.ability` per row (was
 * `can(req,'read','Customer',row)`, which @casl/prisma THROWS on OWN_CUSTOMER's nested to-one ->
 * to-many arms); it reads the pre-resolved `req.customerScope` (`attachCustomerScope`, mounted on
 * every real router right after `attachAbility`). This unit-level `reqWith` builds a synthetic
 * `req` outside Express, so it computes `customerScope` itself via the SAME pure `scopeWhereFor`
 * the middleware calls — mirroring production, never re-implementing the semantics.
 */
function reqWith(grants: Grant[], userId = 'u1'): Request {
  const ability = defineAbilityFor({ id: userId, role: 'SALES' }, grants);
  const customerScope = scopeWhereFor({ id: userId, role: 'SALES' }, 'Customer', grants);
  return { ability, customerScope } as unknown as Request;
}

// Unauthenticated / un-hydrated: no ability, and MATCH_NOTHING is the fail-closed customerScope
// `attachCustomerScope` itself would never actually attach for such a request in production (no
// route lets an unauthenticated request past `authenticate`) — this constant is the isolated
// unit-level stand-in for that degenerate case.
const NO_ABILITY_REQ = { customerScope: { ...MATCH_NOTHING } } as unknown as Request;

const UNCONDITIONAL_READ_CUSTOMER: Grant = { action: 'read', subject: 'Customer' };
// Denied on THIS row: the requester holds `read Customer` (any unconditional route guard still
// passes) but the per-row condition excludes id 'cust-1' — the exact shape `can()` evaluates.
const DENIED_READ_CUSTOMER: Grant = {
  action: 'read',
  subject: 'Customer',
  conditions: { id: 'zz-not-cust-1' },
};

function fullCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cust-1',
    first_name: 'Dana',
    last_name: 'Whitfield',
    company_name: null,
    email: 'dana@example.com',
    phone: '5550001111',
    billing_address_line1: '900 Oak Ave',
    billing_address_line2: 'Unit 4',
    billing_city: 'Round Rock',
    billing_state: 'TX',
    billing_zip: '78664',
    ...overrides,
  };
}

describe('CUSTOMER_CONTACT_KEYS', () => {
  it('is exactly the seven contact/billing keys the issue names', () => {
    expect([...CUSTOMER_CONTACT_KEYS].sort()).toEqual(
      [
        'email',
        'phone',
        'billing_address_line1',
        'billing_address_line2',
        'billing_city',
        'billing_state',
        'billing_zip',
      ].sort(),
    );
  });
});

describe('redactCustomerContactFor', () => {
  it('strips all seven keys from doc.customer when the requester cannot read this customer row', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = { id: 'e1', customer: fullCustomer() };

    const out = redactCustomerContactFor(req, doc);

    for (const key of CUSTOMER_CONTACT_KEYS) {
      expect(key in out.customer).toBe(false);
    }
    expect(out.customer.id).toBe('cust-1');
    expect(out.customer.first_name).toBe('Dana');
    expect(out.customer.last_name).toBe('Whitfield');
  });

  it('leaves doc.customer untouched when the requester holds an unconditional read Customer', () => {
    const req = reqWith([UNCONDITIONAL_READ_CUSTOMER]);
    const doc = { id: 'e1', customer: fullCustomer() };

    const out = redactCustomerContactFor(req, doc);

    expect(out.customer.email).toBe('dana@example.com');
    expect(out.customer.phone).toBe('5550001111');
    expect(out.customer.billing_address_line1).toBe('900 Oak Ave');
  });

  it('redacts the nested lead.customer independently of the top-level customer', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = {
      id: 'e1',
      customer: null,
      lead: { id: 'lead-1', customer: fullCustomer() },
    };

    const out = redactCustomerContactFor(req, doc);

    for (const key of CUSTOMER_CONTACT_KEYS) {
      expect(key in out.lead.customer).toBe(false);
    }
    expect(out.lead.customer.id).toBe('cust-1');
    expect(out.lead.id).toBe('lead-1'); // sibling lead fields survive
  });

  it('redacts the nested job.customer independently (invoice shape)', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = {
      id: 'inv-1',
      customer: null,
      job: { id: 'job-1', job_number: 'J00042', customer: fullCustomer() },
    };

    const out = redactCustomerContactFor(req, doc);

    for (const key of CUSTOMER_CONTACT_KEYS) {
      expect(key in out.job.customer).toBe(false);
    }
    expect(out.job.customer.id).toBe('cust-1');
    expect(out.job.job_number).toBe('J00042'); // sibling job fields survive
  });

  it('redacts all three anchors at once, each judged on its own row', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = {
      id: 'e1',
      customer: fullCustomer({ id: 'cust-1' }),
      lead: { customer: fullCustomer({ id: 'cust-1' }) },
      job: { customer: fullCustomer({ id: 'cust-1' }) },
    };

    const out = redactCustomerContactFor(req, doc);

    expect('email' in out.customer).toBe(false);
    expect('email' in out.lead.customer).toBe(false);
    expect('email' in out.job.customer).toBe(false);
  });

  it('accepts a null document and returns it unchanged (invoice.controller.ts:3195/:3342, estimate.controller.ts:2557/:3372)', () => {
    const req = reqWith([UNCONDITIONAL_READ_CUSTOMER]);
    expect(redactCustomerContactFor(req, null)).toBeNull();
    expect(redactCustomerContactFor(req, undefined)).toBeUndefined();
  });

  it('is a no-op when doc.customer is null (job-less / lead-less anchor absent)', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = { id: 'e1', customer: null, lead: null };

    const out = redactCustomerContactFor(req, doc);

    expect(out.customer).toBeNull();
    expect(out.lead).toBeNull();
  });

  it('idempotent: redacting an already contact-less customer row does not throw and changes nothing observable', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const alreadyRedacted = { id: 'cust-1', first_name: 'Dana', last_name: 'Whitfield', company_name: null };
    const doc = { id: 'e1', customer: alreadyRedacted };

    const out = redactCustomerContactFor(req, doc);

    for (const key of CUSTOMER_CONTACT_KEYS) {
      expect(key in out.customer).toBe(false);
    }
    expect(out.customer.id).toBe('cust-1');
  });

  it('fails CLOSED when the request carries no ability at all (unauthenticated / un-hydrated)', () => {
    const doc = { id: 'e1', customer: fullCustomer() };

    const out = redactCustomerContactFor(NO_ABILITY_REQ, doc);

    for (const key of CUSTOMER_CONTACT_KEYS) {
      expect(key in out.customer).toBe(false);
    }
  });

  it('fails CLOSED on an id-less customer row (a condition on a column the select never projected cannot match)', () => {
    const req = reqWith([UNCONDITIONAL_READ_CUSTOMER]);
    const { id: _id, ...rowWithoutId } = fullCustomer();
    const doc = { id: 'e1', customer: rowWithoutId };

    const out = redactCustomerContactFor(req, doc);

    for (const key of CUSTOMER_CONTACT_KEYS) {
      expect(key in out.customer).toBe(false);
    }
  });

  it('never mutates the input document or its nested customer rows', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const customer = fullCustomer();
    const doc = { id: 'e1', customer };

    redactCustomerContactFor(req, doc);

    expect(doc.customer).toBe(customer); // same reference — input object untouched
    expect(customer.email).toBe('dana@example.com'); // original row still has every key
  });

  it('never nulls a key — denied keys are ABSENT, not null', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = { id: 'e1', customer: fullCustomer() };

    const out = redactCustomerContactFor(req, doc);

    expect(out.customer.email).toBeUndefined();
    expect('email' in out.customer).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #1997 round 2, finding 5 — `service_locations` (the customer's primary street address), nested
// under `lead.customer` on the estimate side. `presentEstimateDetail` must strip it too;
// `presentInvoiceDetail` must NOT — `invoicePdfSelect`'s customer sub-select carries the same key,
// and alpha-classic.ts's invoice template reads it with no optional chaining (would throw, not
// redact, if deleted).
// ═══════════════════════════════════════════════════════════════════════════════════════════
function customerWithLocation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cust-1',
    first_name: 'Dana',
    last_name: 'Whitfield',
    company_name: null,
    service_locations: [
      { is_primary: true, address_line1: '742 Private Home St', address_line2: null, city: 'Fixtureville', state: 'CA', zip: '95050' },
    ],
    ...overrides,
  };
}

describe('presentEstimateDetail — service_locations (#1997 round 2, finding 5)', () => {
  it('strips lead.customer.service_locations for a denied requester', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = { id: 'e1', lead: { id: 'lead-1', customer: customerWithLocation() } };

    const out = presentEstimateDetail(req, doc);

    expect('service_locations' in out.lead.customer).toBe(false);
    expect(out.lead.customer.id).toBe('cust-1'); // sibling fields survive
  });

  it('leaves lead.customer.service_locations alone for an unconditional reader', () => {
    const req = reqWith([UNCONDITIONAL_READ_CUSTOMER]);
    const doc = { id: 'e1', lead: { id: 'lead-1', customer: customerWithLocation() } };

    const out = presentEstimateDetail(req, doc);

    expect(out.lead.customer.service_locations).toEqual(customerWithLocation().service_locations);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #1997 round 3, finding 2 (MEDIUM) — the invoice PDF's "Bill To" block printed the redacted
// customer's primary street address from `customer.service_locations`, because
// `presentInvoiceDetail` deliberately left that key alone (the invoice PDF template dereferenced
// it with no optional chaining). The template now tolerates the key's absence (see
// `lib/pdf/templates/alpha-classic.ts`), so `presentInvoiceDetail` strips it exactly like
// `presentEstimateDetail` — no more special case.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('presentInvoiceDetail — service_locations IS stripped, same as presentEstimateDetail (#1997 round 3)', () => {
  it('strips customer.service_locations for a denied requester while the scalar keys still strip', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = { id: 'inv-1', customer: customerWithLocation({ email: 'dana@example.com', phone: '5550001111' }) };

    const out = presentInvoiceDetail(req, doc);

    expect('service_locations' in out.customer).toBe(false);
    expect('email' in out.customer).toBe(false);
    expect('phone' in out.customer).toBe(false);
    expect(out.customer.id).toBe('cust-1'); // sibling fields survive
  });

  it('leaves customer.service_locations alone for an unconditional reader — ADMIN control unchanged', () => {
    const req = reqWith([UNCONDITIONAL_READ_CUSTOMER]);
    const doc = { id: 'inv-1', customer: customerWithLocation() };

    const out = presentInvoiceDetail(req, doc);

    expect(out.customer.service_locations).toEqual(customerWithLocation().service_locations);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// #1997 round 3, finding 1 (HIGH) — the redacted response still carried `public_token`, which the
// unauthenticated public PDF twin renders in full for anyone holding it. Both presenters now
// delete `public_token` from the TOP-LEVEL document whenever the anchored customer — top-level
// `customer`, or (only when absent) `lead.customer` (estimate) / `job.customer` (invoice) — fails
// the same read-Customer verdict that strips the seven contact keys.
// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('redactCustomerContactFor — public_token (#1997 round 3)', () => {
  it('deletes public_token when the top-level customer anchor is denied', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = { id: 'e1', public_token: 'tok-1', customer: fullCustomer() };

    const out = redactCustomerContactFor(req, doc);

    expect('public_token' in out).toBe(false);
  });

  it('keeps public_token when the top-level customer anchor is readable', () => {
    const req = reqWith([UNCONDITIONAL_READ_CUSTOMER]);
    const doc = { id: 'e1', public_token: 'tok-1', customer: fullCustomer() };

    const out = redactCustomerContactFor(req, doc);

    expect(out.public_token).toBe('tok-1');
  });

  it('falls back to lead.customer when there is no top-level customer (estimate anchored only through its lead)', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = { id: 'e1', public_token: 'tok-1', customer: null, lead: { id: 'lead-1', customer: fullCustomer() } };

    const out = redactCustomerContactFor(req, doc);

    expect('public_token' in out).toBe(false);
  });

  it('keeps public_token via lead.customer when that anchor is readable and there is no top-level customer', () => {
    const req = reqWith([UNCONDITIONAL_READ_CUSTOMER]);
    const doc = { id: 'e1', public_token: 'tok-1', customer: null, lead: { id: 'lead-1', customer: fullCustomer() } };

    const out = redactCustomerContactFor(req, doc);

    expect(out.public_token).toBe('tok-1');
  });

  it('falls back to job.customer when there is no top-level customer (invoice anchored only through its job)', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = { id: 'inv-1', public_token: 'tok-1', customer: null, job: { id: 'job-1', customer: fullCustomer() } };

    const out = redactCustomerContactFor(req, doc);

    expect('public_token' in out).toBe(false);
  });

  it('prefers the top-level customer verdict over lead.customer when both anchors are present', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    // top-level customer is denied even though the (irrelevant here) lead.customer is a different,
    // readable-shaped row — the top-level anchor's own verdict must decide, not the lead's.
    const doc = {
      id: 'e1',
      public_token: 'tok-1',
      customer: fullCustomer(),
      lead: { id: 'lead-1', customer: fullCustomer({ id: 'cust-1' }) },
    };

    const out = redactCustomerContactFor(req, doc);

    expect('public_token' in out).toBe(false);
  });

  it('is a no-op on documents with no public_token key at all (does not add one)', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = { id: 'e1', customer: fullCustomer() };

    const out = redactCustomerContactFor(req, doc);

    expect('public_token' in out).toBe(false);
  });

  it('leaves public_token alone when there is no customer anchor at all (nothing to judge)', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);
    const doc = { id: 'e1', public_token: 'tok-1', customer: null };

    const out = redactCustomerContactFor(req, doc);

    expect(out.public_token).toBe('tok-1');
  });

  it('presentEstimateDetail and presentInvoiceDetail both apply the public_token strip', () => {
    const req = reqWith([DENIED_READ_CUSTOMER]);

    const estOut = presentEstimateDetail(req, { id: 'e1', public_token: 'tok-1', customer: fullCustomer() });
    const invOut = presentInvoiceDetail(req, { id: 'inv-1', public_token: 'tok-1', customer: fullCustomer() });

    expect('public_token' in estOut).toBe(false);
    expect('public_token' in invOut).toBe(false);
  });
});
