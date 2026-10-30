import { vi } from 'vitest';

import api from '@/lib/axios';
import {
  EVIDENCE_FILE_FIELDS, EVIDENCE_TEXT_FIELDS, type DisputeEvidenceSaved, type DisputeEvidenceState, type EvidenceFile,
} from '@/lib/api/paymentsPage';

export const mockApi = vi.mocked(api);

export const DISPUTE_ID = '11111111-1111-4111-8111-111111111111';
export const INVOICE_ID = '22222222-2222-4222-8222-222222222222';

const DAY = 86_400_000;
export const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();

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
      id: DISPUTE_ID, status: 'NEEDS_RESPONSE', reason_text: 'The customer does not recognize the charge', amount: 250,
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
  evidence?: DisputeEvidenceState | (() => DisputeEvidenceState | Promise<DisputeEvidenceState>);
  files?: InvoiceFile[] | (() => InvoiceFile[]);
}

/** Routes GET calls the drawer makes. A function for `evidence` is called on every read, so a refetch can answer differently. */
export function serveDispute({ evidence = makeEvidence(), files = [] }: ServeDispute = {}) {
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: 'America/Los_Angeles' } });
    if (url === `/api/payments-page/disputes/${DISPUTE_ID}/evidence`) {
      return Promise.resolve(typeof evidence === 'function' ? evidence() : evidence).then((d) => ({ data: d }));
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
