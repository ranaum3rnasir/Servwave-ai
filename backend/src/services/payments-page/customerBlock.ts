/**
 * The customer block every Payments drawer opens with (V7 BE-2): who the customer is, how to reach them, and the job,
 * lead and invoice the money belongs to. Built from ServWave's own rows only; it never carries a processor id.
 *
 * A folder next to services/payments-page.ts: do not add an index.ts here, or `from '../payments-page'` would resolve to it.
 *
 * The caller must be able to open the invoice (invoiceOpenerFor with checkOrg). Otherwise the answer is
 * `{ customer: null, restricted: true }` and nothing about the person. Phone and email go only to callers who also hold
 * View payments.
 */
import type { Request } from 'express';
import { prisma } from '../../lib/prisma';
import { tenantWhere } from '../../lib/tenant';
import { invoiceOpenerFor } from '../../lib/permissions/invoiceAccess';

export interface CustomerBlock {
  restricted: false;
  id: string;
  customer_number: string;
  name: string;
  company: string | null;
  /** One line from the primary active service location, or null. */
  address: string | null;
  phone: string | null;
  email: string | null;
  job: { id: string; number: string; type: string | null } | null;
  lead: { id: string; number: string } | null;
  invoice: { id: string; number: string };
}
export interface RestrictedCustomerBlock {
  customer: null;
  restricted: true;
}

const RESTRICTED: RestrictedCustomerBlock = { customer: null, restricted: true };

const clean = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

/** The person's name (first and last), else the company name, else "Unknown". */
function nameOf(c: { first_name: string | null; last_name: string | null; company_name: string | null }): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || clean(c.company_name) || 'Unknown';
}

/** Street (and line 2 when set), city, state and zip, as one line. */
function addressLine(l: { address_line1: string; address_line2: string | null; city: string; state: string; zip: string }): string {
  const street = [l.address_line1, clean(l.address_line2)].filter(Boolean).join(', ');
  return [street, l.city, [l.state, l.zip].filter(Boolean).join(' ')].filter((p) => p && p.trim()).join(', ');
}

export async function customerBlockFor(by: { invoiceId: string }, req: Request): Promise<CustomerBlock | RestrictedCustomerBlock> {
  const openable = await (await invoiceOpenerFor(req, { checkOrg: true }))([by.invoiceId]);
  if (!openable.has(by.invoiceId)) return RESTRICTED;
  const invoice = await prisma.invoice.findFirst({
    where: { id: by.invoiceId, ...tenantWhere(req) },
    select: {
      id: true, invoice_number: true,
      job: { select: { id: true, job_number: true, job_type: true, lead: { select: { id: true, lead_number: true } } } },
      customer: {
        select: {
          id: true, customer_number: true, first_name: true, last_name: true, company_name: true, email: true, phone: true,
          phones: { select: { phone: true, is_primary: true }, orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }], take: 1 },
          service_locations: {
            where: { is_primary: true, is_active: true },
            select: { address_line1: true, address_line2: true, city: true, state: true, zip: true },
            orderBy: { created_at: 'asc' },
            take: 1,
          },
        },
      },
    },
  });
  if (!invoice) return RESTRICTED;
  const c = invoice.customer;
  // Contact details are for people who may see payments at all (the route already asks; this keeps the helper safe on its own).
  const mayContact = Boolean(req.ability?.can('view_payments', 'Organization'));
  return {
    restricted: false,
    id: c.id,
    customer_number: c.customer_number,
    name: nameOf(c),
    company: clean(c.company_name),
    address: c.service_locations[0] ? addressLine(c.service_locations[0]) : null,
    phone: mayContact ? (clean(c.phones[0]?.phone) ?? clean(c.phone)) : null,
    email: mayContact ? clean(c.email) : null,
    job: invoice.job ? { id: invoice.job.id, number: invoice.job.job_number, type: clean(invoice.job.job_type) } : null,
    lead: invoice.job?.lead ? { id: invoice.job.lead.id, number: invoice.job.lead.lead_number } : null,
    invoice: { id: invoice.id, number: invoice.invoice_number },
  };
}
