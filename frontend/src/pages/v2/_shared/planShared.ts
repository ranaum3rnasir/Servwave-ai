import { formatCurrency } from '@/lib/utils';
import type { ServicePlan } from '@/lib/api/service-plans';

import { EM_DASH } from './glyphs';

/**
 * The four display helpers the legacy page declares at module scope, copied
 * verbatim into one place the v2 page, dialog and sheet can all read.
 *
 * They are copied rather than imported because the legacy file declares them
 * privately (they are not exported) and that file may not be edited. Every rule
 * below is the legacy one, character for character - including the em dash the
 * three "missing value" branches render, which is a real U+2014 in the shipped
 * strings and must stay one. It comes from `glyphs.ts` as an escape, so the
 * rendered string is unchanged while no source file carries the character.
 */

// Delegates to the canonical formatter, which reads the org's configured
// currency. The hardcoded `$` this replaces was the same defect already fixed
// once in phone's fmtMoney - user-facing for any non-USD org.
export const money = formatCurrency;

/** Local timezone, locale-default format - the module's convention throughout. */
export const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString() : EM_DASH);

export const customerName = (p: ServicePlan) =>
  p.customer
    ? p.customer.company_name
      || [p.customer.first_name, p.customer.last_name].filter(Boolean).join(' ')
      || 'Customer'
    : EM_DASH;

export const property = (p: ServicePlan) =>
  (p.service_location ? [p.service_location.city, p.service_location.state].filter(Boolean).join(', ') : EM_DASH);

/** One default-materials row, shared by the builder and the sheet's editor. */
export interface MaterialDraftLine {
  item_id: string;
  item_sku: string | null;
  item_name: string;
  qty: number;
}
