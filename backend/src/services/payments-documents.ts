/**
 * Payments go-live V7-10a - the Documents tab's data: the files uploaded from the Payments page (attachments
 * carrying `source = 'PAYMENTS_DOCUMENTS'`) and the search behind the Upload dialog's "Find" list.
 *
 * Everything is scoped to the caller's company and to the records the caller can open. The row-scope questions
 * are asked in batches (one query per kind of record for the whole page), never once per row.
 */
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { PAYMENTS_DOCUMENTS_SOURCE } from '../lib/attachment-types';
import { buildAccessUrl } from '../lib/attachment-access';
import { scopeWhereForReq } from '../lib/permissions/enforce';
import { resolveCustomerScope } from '../lib/permissions/customerScope';
import { buildPaginationMeta, type PaginationParams } from '../lib/pagination';
import { customerNameOf } from './payments-page';

export const TARGET_LIMIT = 25;
export type TargetKind = 'invoice' | 'job' | 'customer';
export const TARGET_KINDS: readonly string[] = ['invoice', 'job', 'customer'];

const KIND_OF = { INVOICE: 'invoice', JOB: 'job', CUSTOMER: 'customer' } as const;
type AttachedKind = (typeof KIND_OF)[keyof typeof KIND_OF];

const CUSTOMER_NAME_SELECT = { company_name: true, first_name: true, last_name: true } as const;

type AttachedTo = { kind: AttachedKind; id: string | null; label: string | null };

/** Which of these records the caller can open, and the label each shows. One query per kind of record. */
async function openableLabels(req: Request, rows: Array<{ entity_type: string; entity_id: string }>): Promise<Map<string, string>> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.entity_type === type).map((r) => r.entity_id))];
  const labels = new Map<string, string>();

  const invoiceIds = ids('INVOICE');
  if (invoiceIds.length) {
    const scope = (await scopeWhereForReq(req, 'Invoice')) as Prisma.InvoiceWhereInput;
    for (const i of await prisma.invoice.findMany({
      where: { id: { in: invoiceIds }, ...tenantWhere(req), ...scope }, select: { id: true, invoice_number: true },
    })) labels.set(`INVOICE:${i.id}`, i.invoice_number);
  }
  const jobIds = ids('JOB');
  if (jobIds.length) {
    const scope = (await scopeWhereForReq(req, 'Job')) as Prisma.JobWhereInput;
    for (const j of await prisma.job.findMany({
      where: { id: { in: jobIds }, ...tenantWhere(req), ...scope }, select: { id: true, job_number: true },
    })) labels.set(`JOB:${j.id}`, j.job_number);
  }
  const customerIds = ids('CUSTOMER');
  if (customerIds.length) {
    const scope = (await resolveCustomerScope(req)) as Prisma.CustomerWhereInput;
    for (const c of await prisma.customer.findMany({
      where: { id: { in: customerIds }, ...tenantWhere(req), ...scope }, select: { id: true, ...CUSTOMER_NAME_SELECT },
    })) labels.set(`CUSTOMER:${c.id}`, customerNameOf(c));
  }
  return labels;
}

/** One page of the uploaded files, newest first. A file on a record the caller cannot open is listed without a link or a download. */
export async function listDocuments(req: Request, pagination: PaginationParams) {
  const where: Prisma.AttachmentWhereInput = { ...tenantWhere(req), source: PAYMENTS_DOCUMENTS_SOURCE };
  const rows = await prisma.attachment.findMany({
    where,
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    skip: pagination.skip,
    take: pagination.limit,
    select: {
      id: true, display_name: true, file_size: true, created_at: true, storage_path: true, file_url: true, entity_type: true, entity_id: true,
    },
  });
  const total = await prisma.attachment.count({ where });
  const labels = await openableLabels(req, rows);

  const documents = await Promise.all(rows.map(async (r) => {
    const kind = KIND_OF[r.entity_type as keyof typeof KIND_OF];
    const label = labels.get(`${r.entity_type}:${r.entity_id}`) ?? null;
    const attached_to: AttachedTo = label === null ? { kind, id: null, label: null } : { kind, id: r.entity_id, label };
    return {
      id: r.id,
      name: r.display_name,
      type: 'Uploaded' as const,
      date: r.created_at.toISOString(),
      size: r.file_size,
      attached_to,
      // Withheld when the caller cannot open the record the file hangs on.
      download_url: label === null ? null : await buildAccessUrl(r.storage_path, r.file_url),
    };
  }));
  return { documents, pagination: buildPaginationMeta(total, pagination) };
}

/** Every word of the search must match one of the fields (so "marcus del" finds Marcus Delgado). */
function wordsMatch(q: string, fieldsFor: (word: string) => Array<Record<string, unknown>>) {
  const words = q.split(/\s+/).filter(Boolean).slice(0, 6);
  return words.map((word) => ({ OR: fieldsFor(word) }));
}
const has = (word: string) => ({ contains: word, mode: 'insensitive' as const });
const customerFields = (word: string) => [
  { company_name: has(word) }, { first_name: has(word) }, { last_name: has(word) },
];

export type DocumentTarget = {
  id: string; main: string; sub: string | null; amount?: number; due_date?: string | null;
};

/** The records a file can be attached to that match `q` (newest first when empty), only ones the caller can open. At most 25. */
export async function findTargets(req: Request, kind: TargetKind, q: string): Promise<DocumentTarget[]> {
  if (kind === 'invoice') {
    const scope = (await scopeWhereForReq(req, 'Invoice')) as Prisma.InvoiceWhereInput;
    const rows = await prisma.invoice.findMany({
      where: {
        ...tenantWhere(req), ...scope,
        AND: wordsMatch(q, (w) => [{ invoice_number: has(w) }, { customer: { is: { OR: customerFields(w) } } }]) as Prisma.InvoiceWhereInput[],
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: TARGET_LIMIT,
      select: { id: true, invoice_number: true, total_amount: true, due_date: true, customer: { select: CUSTOMER_NAME_SELECT } },
    });
    return rows.map((i) => ({
      id: i.id, main: `${i.invoice_number} · ${customerNameOf(i.customer)}`, sub: null,
      amount: Number(i.total_amount), due_date: i.due_date ? i.due_date.toISOString() : null,
    }));
  }
  if (kind === 'job') {
    const scope = (await scopeWhereForReq(req, 'Job')) as Prisma.JobWhereInput;
    const rows = await prisma.job.findMany({
      where: {
        ...tenantWhere(req), ...scope,
        AND: wordsMatch(q, (w) => [{ job_number: has(w) }, { job_type: has(w) }, { customer: { is: { OR: customerFields(w) } } }]) as Prisma.JobWhereInput[],
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: TARGET_LIMIT,
      select: { id: true, job_number: true, job_type: true, customer: { select: CUSTOMER_NAME_SELECT } },
    });
    return rows.map((j) => ({
      id: j.id, main: j.job_type ? `${j.job_number} · ${j.job_type}` : j.job_number, sub: customerNameOf(j.customer),
    }));
  }
  const scope = (await resolveCustomerScope(req)) as Prisma.CustomerWhereInput;
  const rows = await prisma.customer.findMany({
    where: {
      ...tenantWhere(req), ...scope, archived_at: null,
      AND: wordsMatch(q, (w) => [...customerFields(w), { phone: has(w) }, { email: has(w) }]) as Prisma.CustomerWhereInput[],
    },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: TARGET_LIMIT,
    select: { id: true, phone: true, email: true, ...CUSTOMER_NAME_SELECT },
  });
  return rows.map((c) => ({ id: c.id, main: customerNameOf(c), sub: c.phone || c.email || null }));
}
