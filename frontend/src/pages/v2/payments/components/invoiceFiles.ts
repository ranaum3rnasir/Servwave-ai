import api from '@/lib/axios';

/** What a dispute takes: the same three types the server accepts. */
export const EVIDENCE_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const isEvidenceMime = (mime: string | null | undefined) => (EVIDENCE_MIME_TYPES as readonly string[]).includes(mime ?? '');

/** A file on the invoice, as the attachments list returns it. */
export interface InvoiceFileItem {
  id: string;
  file_name: string;
  display_name: string;
  file_type: string;
  file_size: number;
  created_at: string;
  uploader: { id: string; first_name: string; last_name: string } | null;
}

export const invoiceFilesKey = (invoiceId: string) => ['attachments', 'INVOICE', invoiceId] as const;
export const fetchInvoiceFiles = (invoiceId: string) =>
  api.get(`/api/attachments/INVOICE/${invoiceId}`).then((r) => ((r.data?.attachments ?? []) as InvoiceFileItem[]));
