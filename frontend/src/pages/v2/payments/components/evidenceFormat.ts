import type { EvidenceFileField } from '@/lib/api/paymentsPage';

/** What each row of files is called (the people reading it are office staff, not the card network). */
export const FILE_LABELS: Record<EvidenceFileField, string> = {
  receipt: 'Receipt',
  customer_communication: 'Customer communication',
  customer_signature: 'Customer signature',
  service_documentation: 'Service documentation',
  cancellation_policy: 'Cancellation policy',
  refund_policy: 'Refund policy',
  uncategorized_file: 'Other documents',
};

/** 120,000 bytes -> "0.1 MB"; under 100 KB reads in KB. */
export function formatSize(bytes: number): string {
  if (bytes < 100_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(Math.round(bytes / 100_000) / 10).toFixed(1)} MB`;
}

/** Megabytes to one decimal, for the meter ("3.0"). */
export const megabytes = (bytes: number): string => (Math.round(bytes / 100_000) / 10).toFixed(1);

/** "application/pdf" -> "PDF" */
export function typeLabel(mime: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'image/jpeg') return 'JPG';
  if (mime === 'image/png') return 'PNG';
  return 'File';
}
