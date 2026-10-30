/**
 * Payments go-live P10 - the pure rules of dispute evidence.
 *
 * What an office user may attach to a dispute, the limits the card networks put on it, and the words ServWave
 * uses when a rule is broken. Nothing here reads the database or asks the processor, so every rule is tested at
 * its boundary. Bytes are judged here (type from the leading bytes, page count from the document), never from
 * what the browser declared.
 */
import { PDFDocument } from 'pdf-lib';
import { sniffMime } from './file-sniff';
import { describeDisputeReason } from './payment-failure-reasons';

/** Documents the person attaches, one file per kind. Keys are the processor's evidence field names. */
export const FILE_FIELDS = [
  'receipt', 'customer_communication', 'customer_signature', 'service_documentation',
  'cancellation_policy', 'refund_policy', 'uncategorized_file',
] as const;
export type FileField = (typeof FILE_FIELDS)[number];

export const TEXT_FIELDS = ['uncategorized_text', 'product_description', 'service_date', 'customer_name', 'customer_email_address'] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

/** What the form calls each field. */
export const FIELD_LABELS: Record<FileField | TextField, string> = {
  receipt: 'Receipt or invoice',
  customer_communication: 'Messages with the customer',
  customer_signature: 'Customer signature',
  service_documentation: 'Proof the service was done',
  cancellation_policy: 'Cancellation policy',
  refund_policy: 'Refund policy',
  uncategorized_file: 'Other documents',
  uncategorized_text: 'Your explanation',
  product_description: 'What was provided',
  service_date: 'Service date',
  customer_name: 'Customer name',
  customer_email_address: 'Customer email',
};

/** Longest value one text field takes (the combined limit below still applies on top). */
export const TEXT_FIELD_MAX: Record<TextField, number> = {
  uncategorized_text: 150_000, product_description: 150_000, service_date: 40, customer_name: 200, customer_email_address: 320,
};

export const LIMITS = {
  max_bytes: 4_500_000,
  max_pages: 49,
  max_pages_mastercard: 19,
  max_chars: 150_000,
  types: ['application/pdf', 'image/jpeg', 'image/png'],
} as const;

const OWN = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
export const isFileField = (f: string): f is FileField => (FILE_FIELDS as readonly string[]).includes(f);
export const isTextField = (f: string): f is TextField => (TEXT_FIELDS as readonly string[]).includes(f);

export const NOT_A_PDF_JPG_PNG = 'Evidence must be a PDF, JPG or PNG. Save it as a PDF and attach that.';
export const PDF_UNREADABLE = "This PDF can't be read. Save it again as a PDF and attach that.";
export const ONE_FILE_PER_FIELD = 'Each kind of document takes one file. Combine them into one PDF and attach that.';

export type InspectedBytes = { ok: true; mime: string; pages: number } | { ok: false; error: string };

/** The real type and page count of the stored bytes. An image is one page; an unreadable or encrypted PDF is refused. */
export async function inspectEvidenceBytes(bytes: Buffer): Promise<InspectedBytes> {
  const mime = sniffMime(bytes);
  if (!mime || !(LIMITS.types as readonly string[]).includes(mime)) return { ok: false, error: NOT_A_PDF_JPG_PNG };
  if (mime !== 'application/pdf') return { ok: true, mime, pages: 1 };
  try {
    // Without ignoreEncryption an encrypted file throws, which is the refusal we want.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = doc.getPageCount();
    if (pages < 1) return { ok: false, error: PDF_UNREADABLE };
    return { ok: true, mime, pages };
  } catch {
    return { ok: false, error: PDF_UNREADABLE };
  }
}

export interface EvidenceSlot { field: string; size_bytes: number; page_count: number }
export interface EvidenceProblem { error: string; field?: string }

export const textTotal = (text: Record<string, string | undefined>): number =>
  Object.values(text).reduce((n, v) => n + (typeof v === 'string' ? v.length : 0), 0);

const isMastercard = (brand: string | null | undefined) => (brand ?? '').toLowerCase() === 'mastercard';

/**
 * The combined limits, checked across every slot in field order. Each problem names the field that crossed the line
 * so the form can focus it.
 */
export function checkTotals(input: { slots: EvidenceSlot[]; text: Record<string, string | undefined>; cardBrand: string | null | undefined }): EvidenceProblem | null {
  const seen = new Set<string>();
  for (const s of input.slots) {
    if (seen.has(s.field)) return { error: ONE_FILE_PER_FIELD, field: s.field };
    seen.add(s.field);
  }
  const slots = [...input.slots].sort((a, b) => FILE_FIELDS.indexOf(a.field as FileField) - FILE_FIELDS.indexOf(b.field as FileField));
  const pageLimit = isMastercard(input.cardBrand) ? LIMITS.max_pages_mastercard : LIMITS.max_pages;
  let bytes = 0;
  for (const s of slots) {
    bytes += s.size_bytes;
    if (bytes > LIMITS.max_bytes) {
      const mb = Math.round(bytes / 100_000) / 10;
      return { error: `The files total ${mb} MB. The limit is 4.5 MB for all files together.`, field: s.field };
    }
  }
  let pages = 0;
  for (const s of slots) {
    pages += s.page_count;
    if (pages > pageLimit) {
      const limit = isMastercard(input.cardBrand)
        ? `The limit is ${pageLimit} pages for a Mastercard payment.`
        : `The limit is ${pageLimit} pages for all files together.`;
      return { error: `The files total ${pages} pages. ${limit}`, field: s.field };
    }
  }
  let chars = 0;
  for (const f of TEXT_FIELDS) {
    const v = input.text[f];
    if (typeof v !== 'string') continue;
    chars += v.length;
    if (chars > LIMITS.max_chars) {
      return { error: `The text totals ${chars.toLocaleString('en-US')} characters. The limit is ${LIMITS.max_chars.toLocaleString('en-US')} for all text together.`, field: f };
    }
  }
  return null;
}

const FILLS: Record<string, Array<FileField | TextField>> = {
  fraudulent: ['receipt', 'customer_signature', 'customer_communication', 'service_documentation', 'customer_name', 'customer_email_address'],
  unrecognized: ['receipt', 'customer_communication', 'service_documentation', 'customer_name', 'customer_email_address'],
  product_not_received: ['service_documentation', 'service_date', 'customer_communication', 'receipt', 'product_description'],
  product_unacceptable: ['service_documentation', 'customer_communication', 'refund_policy', 'product_description', 'receipt'],
  duplicate: ['receipt', 'service_documentation'],
  subscription_canceled: ['cancellation_policy', 'customer_communication', 'receipt'],
  credit_not_processed: ['refund_policy', 'customer_communication', 'receipt'],
  general: ['receipt', 'customer_communication', 'service_documentation'],
};

/** The fields worth filling for this reason code, so the form can mark them Recommended. Always includes the explanation. */
export function recommendedFields(reason: string | null | undefined): Array<FileField | TextField> {
  const fills = reason && OWN(FILLS, reason) ? FILLS[reason] : FILLS.general;
  return [...fills, 'uncategorized_text'];
}

/** Why the customer disputed it, in ServWave's words. */
export const describeReason = describeDisputeReason;

const GENERIC_FAILURE = "We couldn't send this to the card network. Try again in a moment, or contact ServWave support.";

/**
 * What the person reads when the processor refuses the evidence. The processor's own wording is never returned (the
 * caller logs it, redacted); an unknown refusal reads the generic line.
 */
export function describeProcessorFailure(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code.toLowerCase() : '';
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  const has = (...needles: string[]) => needles.some((n) => code.includes(n) || msg.includes(n));
  if (has('already been submitted', 'already submitted', 'already_submitted')) return 'Evidence was already submitted';
  if (has('past_due', 'past due', 'deadline')) return 'The deadline has passed';
  if (has('file_too_large', 'too large', 'exceeds the size', 'file size')) return 'The file is too large';
  if (has('file_invalid_type', 'invalid type', 'file type')) return "The file type isn't accepted";
  return GENERIC_FAILURE;
}

/** The processor's own words, for the server log only: any id in them is masked first. */
export function redactProcessorText(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const text = `${typeof e.code === 'string' ? `[${e.code}] ` : ''}${typeof e.message === 'string' ? e.message : String(err)}`;
  return text.replace(/\b(?:acct|du|dp|file|pi|ch|re|po|cs|card|pm|tok)_[A-Za-z0-9]+/g, '[id]').slice(0, 500);
}
