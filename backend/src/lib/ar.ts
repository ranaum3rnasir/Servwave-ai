import { InvoiceStatus, InvoiceKind, Prisma } from '@prisma/client';

// Shared "outstanding AR" filter used by BOTH the AR Aging report (getArAging)
// and the dashboard AR KPI so the two totals can never diverge.
// Outstanding = has a balance and isn't voided/paid/draft. The DEPOSIT kind is
// excluded — deposits are their own flow, not trade AR.
// Carries NO org scope — always spread AFTER tenantWhere(req)/orgWhere.
export const AR_OUTSTANDING_STATUSES: InvoiceStatus[] = [
  InvoiceStatus.SENT,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.PARTIALLY_REFUNDED,
  InvoiceStatus.DISPUTED,
];

export const arOutstandingWhere = {
  kind: { not: InvoiceKind.DEPOSIT },
  voided_at: null,
  amount_due: { gt: 0 },
  status: { in: AR_OUTSTANDING_STATUSES },
} satisfies Prisma.InvoiceWhereInput;
