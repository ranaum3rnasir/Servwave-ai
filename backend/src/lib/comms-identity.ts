import type { PrismaClient } from '@prisma/client';
// The one definition of the three statuses a lead never moves on from. This module used to carry
// a byte-identical private copy of the list; the lead status writer needs the same three for its
// transition guard, and two copies of a list that must agree is how a fourth terminal status ends
// up honoured in one place and ignored in the other.
import { TERMINAL_LEAD_STATUSES } from '../services/lead-stage.service';

/**
 * Provider-agnostic comms↔CRM identity resolver (DEC6).
 * Read-only: never creates. Resolves a participant (phone OR email) to a
 * Customer, an open Lead, or a Vendor in precedence order Customer → Lead →
 * Vendor (the billable CRM party wins; a supplier matches only as a fallback).
 * The no-match path is the caller's DEC6 "unmatched → offer create-Lead" UX —
 * this module never auto-creates a Lead. Used by CTM (Plan C) and WhatsApp
 * (Plan W) plus the internal create handlers in this phase; the email channel
 * picks it up again when the Resend path lands.
 *
 * Phase 2 is US/Canada-only for phone; international parsing is deferred.
 * No plus-addressing handling for email.
 */

// The narrow Prisma surface the resolver needs (lets unit tests inject a stub).
type ResolverPrisma = Pick<PrismaClient, 'customer' | 'lead' | 'vendor' | 'vendorContact'>;

export interface IdentityMatch {
  kind: 'customer' | 'lead' | 'vendor';
  id: string;            // the matched entity's id (customer/lead/vendor)
  customerId: string | null;
  leadId: string | null;
  vendorId: string | null;
  label: string;         // human-friendly name for "unmatched"-vs-linked UI
}

/** Normalize a North-American phone string to E.164 (+1XXXXXXXXXX), or null. */
export function normalizeNAPhone(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Normalize an email (lowercase + trim). Returns null when it is not an email. */
export function normalizeEmail(raw: string): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  // Minimal shape check — local@domain.tld; no plus-addressing handling (DEC6).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

function customerName(c: { first_name: string | null; last_name: string | null; company_name: string | null }): string {
  return c.company_name ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer');
}

/** Resolve a phone number to a Customer / open Lead / Vendor in `orgId`. */
export async function matchByPhone(
  prisma: ResolverPrisma,
  orgId: string,
  raw: string,
): Promise<IdentityMatch | null> {
  const e164 = normalizeNAPhone(raw);
  if (!e164) return null;
  const bare = e164.replace('+1', '');
  // Customer.phone is stored UNFORMATTED ("5551234567"); match the bare form,
  // the E.164 form, and the raw input to cover any stored variant.
  const phoneIn = { in: [e164, bare, raw] };
  // Customers keep numbers in three places: the scalar phone, the legacy
  // secondary_phone, and the phones[] relation (customer_phones — where the
  // current create/edit flow writes). Matching only the scalar left real
  // inbound calls from phones[]-stored customers unlinked.
  const customerPhoneOr = [
    { phone: phoneIn },
    { secondary_phone: phoneIn },
    { phones: { some: { phone: phoneIn } } },
  ];

  const customer = await prisma.customer.findFirst({
    where: { organization_id: orgId, OR: customerPhoneOr },
    select: { id: true, first_name: true, last_name: true, company_name: true },
  });
  if (customer) {
    return { kind: 'customer', id: customer.id, customerId: customer.id, leadId: null, vendorId: null, label: customerName(customer) };
  }

  const lead = await prisma.lead.findFirst({
    where: {
      organization_id: orgId,
      status: { notIn: [...TERMINAL_LEAD_STATUSES] },
      customer: { OR: customerPhoneOr },
    },
    select: { id: true, lead_number: true, customer_id: true },
    orderBy: { created_at: 'desc' },
  });
  if (lead) {
    return { kind: 'lead', id: lead.id, customerId: lead.customer_id, leadId: lead.id, vendorId: null, label: lead.lead_number };
  }

  const vendor = await prisma.vendor.findFirst({
    where: { organization_id: orgId, contact_phone: phoneIn },
    select: { id: true, name: true },
  });
  if (vendor) {
    return { kind: 'vendor', id: vendor.id, customerId: null, leadId: null, vendorId: vendor.id, label: vendor.name };
  }

  const vc = await prisma.vendorContact.findFirst({
    where: { organization_id: orgId, phone: phoneIn },
    select: { id: true, vendor_id: true, vendor: { select: { id: true, name: true } } },
  });
  if (vc) {
    return { kind: 'vendor', id: vc.vendor_id, customerId: null, leadId: null, vendorId: vc.vendor_id, label: vc.vendor?.name ?? 'Vendor' };
  }

  return null;
}

/** Resolve an email address to a Customer / open Lead / Vendor in `orgId`. */
export async function matchByEmail(
  prisma: ResolverPrisma,
  orgId: string,
  raw: string,
): Promise<IdentityMatch | null> {
  const email = normalizeEmail(raw);
  if (!email) return null;

  const customer = await prisma.customer.findFirst({
    where: { organization_id: orgId, email },
    select: { id: true, first_name: true, last_name: true, company_name: true },
  });
  if (customer) {
    return { kind: 'customer', id: customer.id, customerId: customer.id, leadId: null, vendorId: null, label: customerName(customer) };
  }

  const lead = await prisma.lead.findFirst({
    where: {
      organization_id: orgId,
      status: { notIn: [...TERMINAL_LEAD_STATUSES] },
      customer: { email },
    },
    select: { id: true, lead_number: true, customer_id: true },
    orderBy: { created_at: 'desc' },
  });
  if (lead) {
    return { kind: 'lead', id: lead.id, customerId: lead.customer_id, leadId: lead.id, vendorId: null, label: lead.lead_number };
  }

  const vendor = await prisma.vendor.findFirst({
    where: { organization_id: orgId, contact_email: email },
    select: { id: true, name: true },
  });
  if (vendor) {
    return { kind: 'vendor', id: vendor.id, customerId: null, leadId: null, vendorId: vendor.id, label: vendor.name };
  }

  const vc = await prisma.vendorContact.findFirst({
    where: { organization_id: orgId, email },
    select: { id: true, vendor_id: true, vendor: { select: { id: true, name: true } } },
  });
  if (vc) {
    return { kind: 'vendor', id: vc.vendor_id, customerId: null, leadId: null, vendorId: vc.vendor_id, label: vc.vendor?.name ?? 'Vendor' };
  }

  return null;
}
