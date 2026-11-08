import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';
import { findDuplicateCustomer } from '../lib/customer-duplicate';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

function makeClient(customers: unknown[]) {
  return { customer: { findMany: vi.fn().mockResolvedValue(customers) } } as never;
}

// A stub requester with a permissive ability (ADMIN — manage all, via the superuser
// short-circuit). These tests are about the finder's matching/exclusion logic, not the #1996
// redaction contract itself (that lives in customer-duplicate-redaction.test.ts and the frozen
// repro-1996.test.ts) — a permissive `req` keeps every case here focused on `finding.match`.
// #2041 — the readable verdict now reads `req.customerScope` (attachCustomerScope, never
// simulated by this bare stub); `{}` is what an ADMIN's unconditional scope resolves to.
const permissiveReq = {
  ability: defineAbilityFor({ id: 'admin-1', role: 'ADMIN' }, []),
  customerScope: {},
} as unknown as Request;

const BASE = {
  id: 'c1', customer_number: 'C00001', first_name: 'Bob', last_name: null,
  company_name: 'Chestnut', email: null, phone: null, is_active: true, archived_at: null,
  organization_id: 'org-1',
  service_locations: [], phones: [], extra_emails: [],
};

describe('findDuplicateCustomer — relation-aware (unified-client-creation §5.4)', () => {
  it('matches a phone that only exists in the phones[] relation (not the scalar phone column)', async () => {
    const client = makeClient([{ ...BASE, phones: [{ phone: '5559998888' }] }]);
    const finding = await findDuplicateCustomer(client, 'org-1', { phone: '(555) 999-8888' }, { requester: permissiveReq });
    expect(finding?.match.id).toBe('c1');
  });

  it('matches an email that only exists in the extra_emails[] relation (not the scalar email column)', async () => {
    const client = makeClient([{ ...BASE, extra_emails: [{ email: 'ops@chestnut.com' }] }]);
    const finding = await findDuplicateCustomer(client, 'org-1', { email: 'OPS@chestnut.com' }, { requester: permissiveReq });
    expect(finding?.match.id).toBe('c1');
  });

  it('still returns null when neither the scalar nor any relation matches', async () => {
    const client = makeClient([{ ...BASE, phones: [{ phone: '5551110000' }], extra_emails: [{ email: 'other@x.com' }] }]);
    const finding = await findDuplicateCustomer(client, 'org-1', { phone: '5559998888', email: 'ops@chestnut.com' }, { requester: permissiveReq });
    expect(finding).toBeNull();
  });

  it('queries with an OR across the scalar email column and the extra_emails relation (widening, not narrowing, the pre-filter)', async () => {
    const client = makeClient([]);
    await findDuplicateCustomer(client, 'org-1', { email: 'ops@chestnut.com' }, { requester: permissiveReq });

    const where = (client as any).customer.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe('org-1');
    expect(where.OR).toEqual([
      { email: { equals: 'ops@chestnut.com', mode: 'insensitive' } },
      { extra_emails: { some: { email: { equals: 'ops@chestnut.com', mode: 'insensitive' } } } },
    ]);
  });
});

describe('findDuplicateCustomer — reports the matched value (dialog needs which value actually collided)', () => {
  it('reports the matched PRIMARY phone in matched.phone', async () => {
    const client = makeClient([{ ...BASE, phone: '5559998888' }]);
    const finding = await findDuplicateCustomer(client, 'org-1', { phone: '(555) 999-8888' }, { requester: permissiveReq });
    expect(finding?.match.matched).toEqual({ email: null, phone: '5559998888' });
  });

  it('reports the matched SECONDARY phone (from phones[]) — NOT the primary the user never typed', async () => {
    const client = makeClient([{ ...BASE, phone: '5551112222', phones: [{ phone: '5559998888' }] }]);
    const finding = await findDuplicateCustomer(client, 'org-1', { phone: '(555) 999-8888' }, { requester: permissiveReq });
    expect(finding?.match.matched.phone).toBe('5559998888'); // the value that actually matched
    expect(finding?.match.matched.email).toBeNull();
    expect(finding?.match.phone).toBe('5551112222'); // primary still surfaced for identity
  });

  it('reports the matched SECONDARY email (from extra_emails[]) in matched.email', async () => {
    const client = makeClient([{ ...BASE, email: 'primary@x.com', extra_emails: [{ email: 'ops@chestnut.com' }] }]);
    const finding = await findDuplicateCustomer(client, 'org-1', { email: 'OPS@chestnut.com' }, { requester: permissiveReq });
    expect(finding?.match.matched.email).toBe('ops@chestnut.com');
    expect(finding?.match.matched.phone).toBeNull();
    expect(finding?.match.email).toBe('primary@x.com');
  });
});

describe('findDuplicateCustomer — excludeCustomerId (cross-customer accretion guard)', () => {
  it('adds id:{not} to the phone-path where so the linked customer is excluded', async () => {
    const client = makeClient([]);
    await findDuplicateCustomer(client, 'org-1', { phone: '5559998888' }, { requester: permissiveReq, excludeCustomerId: 'linked-id' });
    const where = (client as any).customer.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ not: 'linked-id' });
    expect(where.organization_id).toBe('org-1');
  });

  it('adds id:{not} to the email-only-path where as well', async () => {
    const client = makeClient([]);
    await findDuplicateCustomer(client, 'org-1', { email: 'ops@chestnut.com' }, { requester: permissiveReq, excludeCustomerId: 'linked-id' });
    const where = (client as any).customer.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ not: 'linked-id' });
    expect(where.OR).toBeDefined();
  });

  it('does NOT add id:{not} when excludeCustomerId is omitted (back-compat)', async () => {
    const client = makeClient([]);
    await findDuplicateCustomer(client, 'org-1', { phone: '5559998888' }, { requester: permissiveReq });
    const where = (client as any).customer.findMany.mock.calls[0][0].where;
    expect(where.id).toBeUndefined();
  });
});

// ─── #1996 — readable/fail-closed (N7/N8; the redaction shape itself is pinned in
// customer-duplicate-redaction.test.ts and the frozen repro-1996.test.ts) ─────────────────────
describe('findDuplicateCustomer — readable verdict', () => {
  it('N8: a permissive ability -> readable === true, and finding.match equals today\'s ExistingMatch field-for-field', async () => {
    const client = makeClient([{ ...BASE, phone: '5559998888' }]);
    const finding = await findDuplicateCustomer(client, 'org-1', { phone: '(555) 999-8888' }, { requester: permissiveReq });

    expect(finding?.readable).toBe(true);
    expect(finding?.match).toEqual({
      id: 'c1',
      customer_number: 'C00001',
      first_name: 'Bob',
      last_name: null,
      company_name: 'Chestnut',
      email: null,
      phone: '5559998888',
      is_active: true,
      archived_at: null,
      primary_address: null,
      matched: { email: null, phone: '5559998888' },
    });
  });

  it('N7: req.ability absent -> readable === false (fail-closed, enforce.ts:52)', async () => {
    const client = makeClient([{ ...BASE, phone: '5559998888' }]);
    const noAbilityReq = {} as Request;
    const finding = await findDuplicateCustomer(client, 'org-1', { phone: '(555) 999-8888' }, { requester: noAbilityReq });

    expect(finding?.readable).toBe(false);
    expect(finding?.match.id).toBe('c1'); // the full match is still returned server-side
  });
});
