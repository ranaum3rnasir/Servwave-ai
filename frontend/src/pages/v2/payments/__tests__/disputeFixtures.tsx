import { vi } from 'vitest';

import api from '@/lib/axios';
import {
  EVIDENCE_FILE_FIELDS, EVIDENCE_TEXT_FIELDS, type DisputeEvidenceSaved, type DisputeEvidenceState, type EvidenceFile,
} from '@/lib/api/paymentsPage';

export const mockApi = vi.mocked(api);

export const DISPUTE_ID = '11111111-1111-4111-8111-111111111111';
export const INVOICE_ID = '22222222-2222-4222-8222-222222222222';
export const PAYMENT_ID = '33333333-3333-4333-8333-333333333333';
export const DISPUTE_REF = 'DSP-A1B2C3D4';
export const OPENED_AT = '2026-10-01T15:00:00.000Z';
export const FILE_URL = 'https://files.example.test/evidence-file';

const DAY = 86_400_000;
// A few minutes over, so a test that reads "N days left" is not one clock tick short of the boundary.
export const inDays = (n: number) => new Date(Date.now() + n * DAY + 300_000).toISOString();
export const inHours = (n: number) => new Date(Date.now() + n * 3_600_000 + 300_000).toISOString();

export const emptyFiles = (): Record<string, EvidenceFile | null> =>
  Object.fromEntries(EVIDENCE_FILE_FIELDS.map((f) => [f, null]));
export const emptyText = (): Record<string, string> => Object.fromEntries(EVIDENCE_TEXT_FIELDS.map((f) => [f, '']));

export const file = (id: string, name: string, over: Partial<EvidenceFile> = {}): EvidenceFile => ({
  attachment_id: id, file_name: name, mime: 'application/pdf', size_bytes: 120_000, page_count: 2, ...over,
});

type Over = Omit<Partial<DisputeEvidenceState>, 'dispute' | 'form'> & {
  dispute?: Partial<DisputeEvidenceState['dispute']>;
  form?: Partial<DisputeEvidenceState['form']>;
};

/** The P10 payload for an open card dispute the caller may answer, with its overrides. */
export function makeEvidence(over: Over = {}): DisputeEvidenceState {
  const { dispute, form, ...rest } = over;
  return {
    dispute: {
      id: DISPUTE_ID, reference: DISPUTE_REF, opened_at: OPENED_AT, payment: { id: PAYMENT_ID, reference: 'PMT-000041' },
      status: 'NEEDS_RESPONSE', reason_text: 'The customer does not recognize the charge', amount: 250,
      respond_by: inDays(5), days_left: 5, is_bank_return: false, closed_at: null, outcome: null,
      customer_name: 'Dana Whitfield', invoice: { id: INVOICE_ID, number: 'INV-1042' },
      ...dispute,
    },
    form: {
      files: emptyFiles(),
      text: emptyText(),
      defaults: { ...emptyText(), customer_name: 'Dana Whitfield', customer_email_address: 'dana@example.test', service_date: '2026-09-30' },
      version: 0,
      ...form,
    },
    totals: { bytes: 0, pages: 0, chars: 0 },
    limits: { max_bytes: 4_500_000, max_pages: 49, max_chars: 150_000, types: ['application/pdf', 'image/jpeg', 'image/png'] },
    submitted: null,
    customer_block: {
      restricted: false, id: 'c-1', customer_number: 'C-1001', name: 'Dana Whitfield', company: null, address: null,
      phone: null, email: null, job: null, lead: null, invoice: { id: INVOICE_ID, number: 'INV-1042' },
    },
    can_edit: true,
    can_submit: false,
    recommended: ['receipt', 'customer_communication', 'service_documentation', 'uncategorized_text'],
    ...rest,
  };
}

export interface InvoiceFile {
  id: string; file_name: string; display_name: string; file_type: string; file_size: number; created_at: string;
  uploader: { id: string; first_name: string; last_name: string };
}
export const invoiceFile = (id: string, name: string, over: Partial<InvoiceFile> = {}): InvoiceFile => ({
  id, file_name: name, display_name: name.replace(/\.[^.]+$/, ''), file_type: 'application/pdf', file_size: 250_000,
  created_at: '2026-10-01T15:00:00.000Z', uploader: { id: 'u-1', first_name: 'Maya', last_name: 'Ortiz' }, ...over,
});

export interface ServeDispute {
  /** Answers for a file's link; a function can throw to fail it. */
  link?: (attachmentId: string) => Record<string, unknown> | Promise<Record<string, unknown>>;
  evidence?: DisputeEvidenceState | (() => DisputeEvidenceState | Promise<DisputeEvidenceState>);
  files?: InvoiceFile[] | (() => InvoiceFile[]);
}

/** Routes GET calls the drawer makes. A function for `evidence` is called on every read, so a refetch can answer differently. */
export function serveDispute({ evidence = makeEvidence(), files = [], link }: ServeDispute = {}) {
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: 'America/Los_Angeles' } });
    if (url === `/api/payments-page/disputes/${DISPUTE_ID}/evidence`) {
      return Promise.resolve(typeof evidence === 'function' ? evidence() : evidence).then((d) => ({ data: d }));
    }
    const fileRoute = url.match(new RegExp(`^/api/payments-page/disputes/${DISPUTE_ID}/evidence/files/(.+)$`));
    if (fileRoute) {
      const id = fileRoute[1]!;
      return Promise.resolve(link ? link(id) : { url: `${FILE_URL}/${id}`, file_name: 'x', mime: 'application/pdf', size_bytes: 1, page_count: 1 })
        .then((d) => ({ data: d }));
    }
    if (url.startsWith('/api/attachments/')) {
      return Promise.resolve({ data: { attachments: typeof files === 'function' ? files() : files } });
    }
    return Promise.resolve({ data: {} });
  }) as never);
}

export const saved = (state: DisputeEvidenceState, extra: Partial<DisputeEvidenceSaved> = {}): DisputeEvidenceSaved => ({
  ...state, staged: true, warnings: [], ...extra,
});

/** An axios-shaped rejection carrying the API's `{ error, field }` body. */
export const apiError = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: body } });
