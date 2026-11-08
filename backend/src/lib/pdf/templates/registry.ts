import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { buildAlphaClassicPdf, buildAlphaClassicInvoicePdf, type InvoiceForPdf, type OrgForPdf } from './alpha-classic';
import { buildCrmDefaultPdf, buildCrmDefaultInvoicePdf } from './crm-default';

export const templateRegistry = {
  'alpha-classic': buildAlphaClassicPdf,
  'crm-default': buildCrmDefaultPdf,
} as const;

export type TemplateKey = keyof typeof templateRegistry;

type InvoiceBuilder = (invoice: InvoiceForPdf, org: OrgForPdf) => TDocumentDefinitions;

// Same template keys as templateRegistry — the picked template applies to both documents
// (Branding & Templates has one picker, not a separate one per document). `satisfies` (rather
// than `as const` alone) makes a template added to one registry without the other a type error,
// instead of relying on the comment above to keep them in sync.
export const invoiceTemplateRegistry = {
  'alpha-classic': buildAlphaClassicInvoicePdf,
  'crm-default': buildCrmDefaultInvoicePdf,
} as const satisfies Record<TemplateKey, InvoiceBuilder>;
