import { describe, it, expect, vi } from 'vitest';
import {
  normalizeNAPhone, normalizeEmail, matchByPhone, matchByEmail,
} from '../lib/comms-identity';

const ORG = '00000000-0000-0000-0000-000000000001';

describe('normalizeNAPhone', () => {
  it('normalizes common NANP formats to E.164', () => {
    expect(normalizeNAPhone('(555) 123-4567')).toBe('+15551234567');
    expect(normalizeNAPhone('555-123-4567')).toBe('+15551234567');
    expect(normalizeNAPhone('5551234567')).toBe('+15551234567');
    expect(normalizeNAPhone('15551234567')).toBe('+15551234567');
    expect(normalizeNAPhone('+1 555 123 4567')).toBe('+15551234567');
    expect(normalizeNAPhone('+15551234567')).toBe('+15551234567'); // idempotent
  });
  it('returns null for invalid input', () => {
    expect(normalizeNAPhone('')).toBeNull();
    expect(normalizeNAPhone('abc')).toBeNull();
    expect(normalizeNAPhone('123')).toBeNull();          // too short
    expect(normalizeNAPhone('12345678901234')).toBeNull(); // too long
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  John@Doe.COM ')).toBe('john@doe.com');
    expect(normalizeEmail('a@b.co')).toBe('a@b.co');
  });
  it('returns null for non-emails (no plus-addressing handling needed)', () => {
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('@b.co')).toBeNull();
    expect(normalizeEmail('a@')).toBeNull();
  });
});

describe('matchByPhone', () => {
  it('returns a customer match (highest precedence) scoped to the org', async () => {
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue({ id: 'cust-1', first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' }) },
      lead: { findFirst: vi.fn() },
      vendor: { findFirst: vi.fn() },
      vendorContact: { findFirst: vi.fn() },
    } as any;
    const m = await matchByPhone(prisma, ORG, '(555) 123-4567');
    // Customers store numbers in THREE places: the scalar phone, the legacy
    // secondary_phone, and the phones[] relation (customer_phones — where the
    // current create/edit flow writes). All three must match, or real inbound
    // calls from phones[]-stored customers ingest as unmatched.
    const phoneIn = { in: ['+15551234567', '5551234567', '(555) 123-4567'] };
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: {
        organization_id: ORG,
        OR: [
          { phone: phoneIn },
          { secondary_phone: phoneIn },
          { phones: { some: { phone: phoneIn } } },
        ],
      },
      select: { id: true, first_name: true, last_name: true, company_name: true },
    });
    expect(m).toEqual({ kind: 'customer', id: 'cust-1', customerId: 'cust-1', leadId: null, vendorId: null, label: 'Doe HVAC' });
    // Customer matched → no lead/vendor lookups (short-circuit).
    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(prisma.vendor.findFirst).not.toHaveBeenCalled();
  });

  it('falls through to an OPEN lead when no customer matches', async () => {
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue(null) },
      lead: { findFirst: vi.fn().mockResolvedValue({ id: 'lead-1', lead_number: 'L00001', customer_id: 'cust-9' }) },
      vendor: { findFirst: vi.fn() },
      vendorContact: { findFirst: vi.fn() },
    } as any;
    const m = await matchByPhone(prisma, ORG, '5551234567');
    const phoneIn = { in: ['+15551234567', '5551234567', '5551234567'] };
    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: {
        organization_id: ORG,
        status: { notIn: ['WON', 'LOST', 'CANCELLED'] },
        // The lead's identity is its customer's phone — match all three
        // storage places there too.
        customer: {
          OR: [
            { phone: phoneIn },
            { secondary_phone: phoneIn },
            { phones: { some: { phone: phoneIn } } },
          ],
        },
      },
      select: { id: true, lead_number: true, customer_id: true },
      orderBy: { created_at: 'desc' },
    });
    expect(m).toEqual({ kind: 'lead', id: 'lead-1', customerId: 'cust-9', leadId: 'lead-1', vendorId: null, label: 'L00001' });
    expect(prisma.vendor.findFirst).not.toHaveBeenCalled();
  });

  it('falls through to a Vendor (then VendorContact) when no customer/lead matches', async () => {
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue(null) },
      lead: { findFirst: vi.fn().mockResolvedValue(null) },
      vendor: { findFirst: vi.fn().mockResolvedValue({ id: 'ven-1', name: 'Acme Supply' }) },
      vendorContact: { findFirst: vi.fn() },
    } as any;
    const m = await matchByPhone(prisma, ORG, '5551234567');
    expect(prisma.vendor.findFirst).toHaveBeenCalledWith({
      where: { organization_id: ORG, contact_phone: { in: ['+15551234567', '5551234567', '5551234567'] } },
      select: { id: true, name: true },
    });
    expect(m).toEqual({ kind: 'vendor', id: 'ven-1', customerId: null, leadId: null, vendorId: 'ven-1', label: 'Acme Supply' });
    // Vendor matched on the vendor row → no VendorContact lookup.
    expect(prisma.vendorContact.findFirst).not.toHaveBeenCalled();
  });

  it('matches a VendorContact phone when the vendor row has no match', async () => {
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue(null) },
      lead: { findFirst: vi.fn().mockResolvedValue(null) },
      vendor: { findFirst: vi.fn().mockResolvedValue(null) },
      vendorContact: { findFirst: vi.fn().mockResolvedValue({ id: 'vc-1', vendor_id: 'ven-2', vendor: { id: 'ven-2', name: 'Bolt Co' } }) },
    } as any;
    const m = await matchByPhone(prisma, ORG, '5551234567');
    expect(prisma.vendorContact.findFirst).toHaveBeenCalledWith({
      where: { organization_id: ORG, phone: { in: ['+15551234567', '5551234567', '5551234567'] } },
      select: { id: true, vendor_id: true, vendor: { select: { id: true, name: true } } },
    });
    expect(m).toEqual({ kind: 'vendor', id: 'ven-2', customerId: null, leadId: null, vendorId: 'ven-2', label: 'Bolt Co' });
  });

  it('returns null without querying when the number is invalid', async () => {
    const prisma = { customer: { findFirst: vi.fn() }, lead: { findFirst: vi.fn() }, vendor: { findFirst: vi.fn() }, vendorContact: { findFirst: vi.fn() } } as any;
    const m = await matchByPhone(prisma, ORG, 'not-a-number');
    expect(m).toBeNull();
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when nothing matches', async () => {
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue(null) },
      lead: { findFirst: vi.fn().mockResolvedValue(null) },
      vendor: { findFirst: vi.fn().mockResolvedValue(null) },
      vendorContact: { findFirst: vi.fn().mockResolvedValue(null) },
    } as any;
    expect(await matchByPhone(prisma, ORG, '5551234567')).toBeNull();
  });
});

describe('matchByEmail', () => {
  it('returns a customer match scoped to the org (normalized)', async () => {
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue({ id: 'cust-1', first_name: 'John', last_name: 'Doe', company_name: null }) },
      lead: { findFirst: vi.fn() },
      vendor: { findFirst: vi.fn() },
      vendorContact: { findFirst: vi.fn() },
    } as any;
    const m = await matchByEmail(prisma, ORG, '  John@Doe.com ');
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { organization_id: ORG, email: 'john@doe.com' },
      select: { id: true, first_name: true, last_name: true, company_name: true },
    });
    expect(m).toEqual({ kind: 'customer', id: 'cust-1', customerId: 'cust-1', leadId: null, vendorId: null, label: 'John Doe' });
  });

  it('falls through to Vendor then VendorContact by email', async () => {
    const prisma = {
      customer: { findFirst: vi.fn().mockResolvedValue(null) },
      lead: { findFirst: vi.fn().mockResolvedValue(null) },
      vendor: { findFirst: vi.fn().mockResolvedValue(null) },
      vendorContact: { findFirst: vi.fn().mockResolvedValue({ id: 'vc-1', vendor_id: 'ven-2', vendor: { id: 'ven-2', name: 'Bolt Co' } }) },
    } as any;
    const m = await matchByEmail(prisma, ORG, 'sales@bolt.co');
    expect(prisma.vendor.findFirst).toHaveBeenCalledWith({
      where: { organization_id: ORG, contact_email: 'sales@bolt.co' },
      select: { id: true, name: true },
    });
    expect(prisma.vendorContact.findFirst).toHaveBeenCalledWith({
      where: { organization_id: ORG, email: 'sales@bolt.co' },
      select: { id: true, vendor_id: true, vendor: { select: { id: true, name: true } } },
    });
    expect(m).toEqual({ kind: 'vendor', id: 'ven-2', customerId: null, leadId: null, vendorId: 'ven-2', label: 'Bolt Co' });
  });

  it('returns null without querying for an invalid email', async () => {
    const prisma = { customer: { findFirst: vi.fn() }, lead: { findFirst: vi.fn() }, vendor: { findFirst: vi.fn() }, vendorContact: { findFirst: vi.fn() } } as any;
    expect(await matchByEmail(prisma, ORG, 'nope')).toBeNull();
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });
});
