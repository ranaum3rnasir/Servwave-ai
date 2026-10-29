import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';

/**
 * Duplicate-customer guard (#42) — catalog rows INT-11..INT-14 + negative control.
 *
 * WRITTEN 2026-06-10, NOT YET EXECUTED.
 *
 * Catalog: md_files/specs/testing/lifecycle-regression-catalog.md §3 (INT-11/12/13/14,
 * all 🔲 GAP — the guard has ZERO tests anywhere) + §4 Wave-1 item 2 (this file).
 * Behavior map: md_files/specs/testing/segments/01-intake-customer-lead.md §2 Step 1
 * (guard contract + override audit), §3 "Duplicate 409 fork", §4 Hard Blocker #4.
 * Source of truth (code wins over both docs):
 *  - backend/src/lib/customer-duplicate.ts — normalizeEmail (trim+lowercase),
 *    normalizePhone (digits-only; strip ONE leading '1' from an 11-digit result);
 *    match = normalized primary email OR primary phone equality, org-scoped; the JS
 *    pass normalizes BOTH sides (stored rows are un-normalized).
 *  - backend/src/controllers/customer.controller.ts create() — 409
 *    {error:'duplicate', existing:{id, customer_number, first_name, last_name,
 *    company_name, email, phone, is_active, archived_at, primary_address}};
 *    `?override=true` bypasses + stamps the CUSTOMER_CREATED timeline event with
 *    description 'Customer created (duplicate of <number> bypassed)' and metadata
 *    {duplicate_override:true, matched_customer_id, matched_customer_number}.
 *  - backend/src/controllers/lead.controller.ts create() — the inline new_customer
 *    branch runs the SAME guard (same 409/override contract) BEFORE its transaction.
 *
 * Suite conventions: ONE shared provisioned org, serial (workers:1) — data accumulates,
 * so every seed here uses a unique email (api.suffix @e2e-qa.invalid) AND a unique
 * phone (uniquePhone() below). Unique phones are load-bearing in this file: the guard
 * matches org-wide, and several legacy builders reuse hardcoded phones — a shared
 * constant would make `existing` non-deterministic.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

/**
 * Unique 10-digit phone per call — the digits analogue of api.suffix.
 * '98' prefix keeps it disjoint from every hardcoded fixture phone in the suite
 * ('5551234567', '617555NNNN', '5123456789', …) and never starts with '1', so the
 * 11-digit `1${p}` variant in INT-12 genuinely exercises the strip-leading-1 branch.
 */
let phoneSeq = 0;
function uniquePhone(): string {
  phoneSeq = (phoneSeq + 1) % 10;
  return `98${Date.now().toString().slice(-7)}${phoneSeq}`;
}

/** Raw seed (surfaces the real status, unlike api.createCustomer) with one primary location. */
async function seedCustomer(opts: {
  first: string; last: string; email: string; phone: string; line1?: string;
}) {
  const { res, body } = await api.raw('post', '/api/customers', {
    first_name: opts.first, last_name: opts.last,
    email: opts.email, phone: opts.phone,
    kind: 'PERSON', segment: 'RESIDENTIAL',
    locations: [{
      address_line1: opts.line1 ?? '10 Dupe St', city: 'Boston', state: 'MA', zip: '02108',
      is_primary: true,
    }],
  });
  expect(res.status(), 'seed customer must 201 (unique email+phone)').toBe(201);
  return body.customer;
}

test.describe('Duplicate-customer guard (INT-11..INT-14)', () => {
  // ─── INT-11: primary-email match → 409 + full `existing` payload ──────────────────
  test('INT-11: same email different phone → 409 duplicate with existing payload; case-variant email still 409s', async () => {
    const s = api.suffix;
    const emailA = `dupe-${s}@e2e-qa.invalid`;
    const phoneA = uniquePhone();
    const a = await seedCustomer({ first: `Dupe-${s}`, last: 'Guard', email: emailA, phone: phoneA });

    // Same email, DIFFERENT (unique) phone, different name → blocked on the email leg alone.
    const dup = await api.raw('post', '/api/customers', {
      first_name: `Other-${s}`, last_name: 'Person',
      email: emailA, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    expect(dup.res.status()).toBe(409);
    expect(dup.body.error).toBe('duplicate');

    // `existing` carries the duplicate-warning-modal payload (customer-duplicate.ts ExistingMatch).
    const existing = dup.body.existing;
    expect(existing.id).toBe(a.id);
    expect(existing.customer_number).toBe(a.customer_number);
    expect(existing.first_name).toBe(`Dupe-${s}`);
    expect(existing.last_name).toBe('Guard');
    expect(existing).toHaveProperty('company_name'); // null for a PERSON, but the key is present
    expect(existing.email).toBe(emailA);
    expect(existing.phone).toBe(phoneA);
    expect(existing.is_active).toBe(true);
    expect(existing.archived_at).toBeNull();
    expect(existing.primary_address).toEqual({ line1: '10 Dupe St', city: 'Boston', state: 'MA' });

    // Case variant: normalizeEmail lowercases both sides → still a 409 on the same row.
    // NOTE: a WHITESPACE-padded email is unreachable through the API — createCustomerSchema's
    // z.string().email() rejects padded input with a 400 BEFORE the guard runs, so the
    // trim half of normalizeEmail cannot be exercised over HTTP; case-folding is the
    // API-testable half.
    const cased = await api.raw('post', '/api/customers', {
      first_name: `Cased-${s}`, last_name: 'Person',
      email: emailA.toUpperCase(), phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    expect(cased.res.status()).toBe(409);
    expect(cased.body.error).toBe('duplicate');
    expect(cased.body.existing.id).toBe(a.id);
  });

  // ─── INT-12: primary-phone match across formats ───────────────────────────────────
  test('INT-12: same phone in formatted and 11-digit-leading-1 variants → each 409', async () => {
    const s = api.suffix;
    const p = uniquePhone(); // suffix-derived unique 10 digits, stored RAW on the seed row
    const c = await seedCustomer({
      first: `Phone-${s}`, last: 'Guard', email: `phone-${s}@e2e-qa.invalid`, phone: p,
    });
    // Stored un-normalized (controllers write the raw string) — the guard normalizes
    // BOTH sides in JS, which is exactly what the two variants below prove.
    expect((await api.getCustomer(c.id)).phone).toBe(p);

    // Variant 1: punctuation-formatted '(98X) XXX-XXXX' — digits-only normalization matches.
    const formatted = `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`;
    const dupFmt = await api.raw('post', '/api/customers', {
      first_name: `Fmt-${s}`, last_name: 'Person',
      email: `fmt-${s}@e2e-qa.invalid`, phone: formatted, // different email — phone leg only
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    expect(dupFmt.res.status()).toBe(409);
    expect(dupFmt.body.error).toBe('duplicate');
    expect(dupFmt.body.existing.id).toBe(c.id);

    // Variant 2: 11-digit with country '1' — normalizePhone strips the leading 1.
    const dupEleven = await api.raw('post', '/api/customers', {
      first_name: `Eleven-${s}`, last_name: 'Person',
      email: `eleven-${s}@e2e-qa.invalid`, phone: `1${p}`,
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    expect(dupEleven.res.status()).toBe(409);
    expect(dupEleven.body.error).toBe('duplicate');
    expect(dupEleven.body.existing.id).toBe(c.id);
  });

  // ─── INT-13: ?override=true bypass + audit trail ──────────────────────────────────
  test('INT-13: override=true creates past the 409 and stamps the bypass on the CUSTOMER_CREATED timeline event', async () => {
    const s = api.suffix;
    const emailA = `ovr-${s}@e2e-qa.invalid`;
    const a = await seedCustomer({ first: `Ovr-${s}`, last: 'Guard', email: emailA, phone: uniquePhone() });

    const dupBody = {
      first_name: `OvrTwin-${s}`, last_name: 'Guard',
      email: emailA, phone: uniquePhone(),
      kind: 'PERSON' as const, segment: 'RESIDENTIAL' as const,
    };
    // Precondition: without the flag this body is blocked.
    const blocked = await api.raw('post', '/api/customers', dupBody);
    expect(blocked.res.status()).toBe(409);

    // Same body + ?override=true → 201, a SECOND customer with its own allocated number.
    const over = await api.raw('post', '/api/customers?override=true', dupBody);
    expect(over.res.status()).toBe(201);
    const created = over.body.customer;
    expect(created.id).not.toBe(a.id);
    expect(created.customer_number).toBeTruthy();
    expect(created.customer_number).not.toBe(a.customer_number);

    // Audit trail. The bypassed match is recorded on a CUSTOMER_CREATED TimelineEvent with
    // metadata {duplicate_override:true, matched_customer_id, matched_customer_number}
    // (customer.controller.ts create(), the only forward audit of a bypass — no merge tool yet).
    // OBSERVABILITY LIMIT: no read endpoint exposes CUSTOMER-event metadata — the only
    // metadata-selecting timeline GET is /api/jobs/:id/timeline (JOB-scoped), and the
    // dashboard activity feed omits `metadata`. The bypass DESCRIPTION
    // 'Customer created (duplicate of <number> bypassed)' is written in the SAME branch,
    // iff the metadata is (the matched number embedded in it = metadata.matched_customer_number),
    // so asserting it via the dashboard feed is the strongest API-observable proof.
    // If a customer-timeline endpoint ever lands, upgrade this to assert the metadata keys.
    const dash = await api.raw('get', '/api/dashboard');
    expect(dash.res.status()).toBe(200);
    const evt = (dash.body.activity ?? []).find((e: any) =>
      e.entity_type === 'CUSTOMER' && e.entity_id === created.id && e.event_type === 'CUSTOMER_CREATED');
    expect(evt, 'override-create CUSTOMER_CREATED event surfaces in the activity feed').toBeTruthy();
    expect(evt.description).toBe(`Customer created (duplicate of ${a.customer_number} bypassed)`);
  });

  // ─── INT-14: the lead inline-customer path runs the same guard, pre-create ────────
  test('INT-14: POST /api/leads with new_customer matching an existing email → 409 duplicate (guard fires before the create)', async () => {
    const s = api.suffix;
    const emailA = `leaddupe-${s}@e2e-qa.invalid`;
    const a = await seedCustomer({ first: `LeadDupe-${s}`, last: 'Guard', email: emailA, phone: uniquePhone() });

    // The guard runs BEFORE the inline-create transaction (lead.controller.ts new_customer
    // branch), so this 409 is reachable even though the post-guard create itself is the
    // suspected-broken INT-18 path. Same contract as POST /api/customers.
    // raw() because the typed createLead wrapper requires customer_id — the inline
    // new_customer shape legitimately omits it (createLeadSchema XOR).
    const { res, body } = await api.raw('post', '/api/leads', {
      new_customer: {
        first_name: `Inline-${s}`, last_name: 'Person',
        email: emailA,           // matches the seed → email leg fires
        phone: uniquePhone(),    // unique — proves the match is the email, not the phone
        location: { address_line1: '22 Inline Ave', city: 'Boston', state: 'MA', zip: '02108' },
      },
      service_request: `INT-14 dupe-guard ${s}`,
    });
    expect(res.status()).toBe(409);
    expect(body.error).toBe('duplicate');
    expect(body.existing.id).toBe(a.id);
    expect(body.existing.customer_number).toBe(a.customer_number);

    // Deliberately NOT testing `?override=true` create-success here: the post-guard inline
    // create is predicted broken (missing customer_number/kind/segment → 500) and is pinned
    // by the INT-18 probe in redesign-26-probes-intake-sell.spec.ts. Testing override-create
    // here would conflate guard behavior with that bug; add it when INT-18 flips to 201.
  });

  // ─── Negative control: names never match — only contact info does ─────────────────
  test('INT-11/12 negative control: same name but unique email+phone → 201 (no name-based false positive)', async () => {
    const s = api.suffix;
    await seedCustomer({
      first: 'Negative', last: 'Control',
      email: `neg-a-${s}@e2e-qa.invalid`, phone: uniquePhone(),
    });
    // Identical first+last name; email AND phone both fresh → the guard must stay silent.
    const twin = await api.raw('post', '/api/customers', {
      first_name: 'Negative', last_name: 'Control',
      email: `neg-b-${s}@e2e-qa.invalid`, phone: uniquePhone(),
      kind: 'PERSON', segment: 'RESIDENTIAL',
    });
    expect(twin.res.status()).toBe(201);
    expect(twin.body.customer.id).toBeTruthy();
  });
});
