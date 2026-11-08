import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { fmtCurrency } from './alpha-classic';

// The statement only needs the org letterhead fields — all optional so a minimal org
// payload (e.g. { name, logo_url }) renders without blanks. Wider than OrgForPdf on
// purpose so callers can pass the raw org row.
export interface StatementOrgForPdf {
  name?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  email?: string | null;
  website?: string | null;
  logo_url?: string | null;
  brand_color?: string | null;
}

// ─── Statement PDF (entity-redesign §9) ───────────────
// A read-only ledger document mirroring the estimate/invoice PDF pattern. EVERY cell
// coalesces so no 'undefined'/'null' literal can leak into the document (#24 regression
// class). Reuses the Inter fonts + LETTER page geometry from alpha-classic.

export type StatementLineType =
  | 'invoice'
  | 'payment'
  | 'deposit_credit'
  | 'credit'
  | 'refund';

export interface StatementPdfLine {
  date: Date | string | null;
  type: StatementLineType;
  label: string;
  invoice_number: string | null;
  amount: number;
  running_balance: number;
}

export interface StatementForPdf {
  scope: 'job' | 'customer';
  title: string;
  party: { name: string | null; email: string | null };
  lines: StatementPdfLine[];
  totals: {
    billed: number;
    paid: number;
    deposit_credit?: number;
    refunded: number;
    credited: number;
    balance: number;
  };
}

// Date guard: never renders 'Invalid Date' / 'undefined'. Null → ''.
function fmtDateSafe(d: Date | string | null | undefined): string {
  if (d == null) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// Human label per line type — never undefined.
function pickLabel(type: StatementLineType): string {
  switch (type) {
    case 'invoice': return 'Invoice issued';
    case 'payment': return 'Payment';
    case 'deposit_credit': return 'Deposit credit applied';
    case 'credit': return 'Credit';
    case 'refund': return 'Refund';
    default: return 'Entry';
  }
}

// A charge (money owed: invoice + refund) goes in the Charge column; a settlement
// (payment / deposit-credit / credit lowering the bill) goes in the Payment/Credit column.
function isCharge(type: StatementLineType): boolean {
  return type === 'invoice' || type === 'refund';
}

export function buildStatementPdf(
  statement: StatementForPdf,
  org: StatementOrgForPdf,
): TDocumentDefinitions {
  const partyName = (statement.party.name && statement.party.name.trim()) || 'Customer';
  const partyEmail = statement.party.email ?? '';

  const logoBlock = org.logo_url
    ? { image: org.logo_url, fit: [200, 80] as [number, number] }
    : { text: org.name ?? 'Statement', fontSize: 24, bold: true, color: org.brand_color ?? '#242424' };

  const tableBody: any[] = [
    [
      { text: 'Date', bold: true, fillColor: '#f5f5f5' },
      { text: 'Description', bold: true, fillColor: '#f5f5f5' },
      { text: 'Invoice #', bold: true, fillColor: '#f5f5f5' },
      { text: 'Charge', bold: true, fillColor: '#f5f5f5', alignment: 'right' },
      { text: 'Payment/Credit', bold: true, fillColor: '#f5f5f5', alignment: 'right' },
      { text: 'Balance', bold: true, fillColor: '#f5f5f5', alignment: 'right' },
    ],
  ];

  for (const line of statement.lines) {
    const label = (line.label && line.label.trim()) || pickLabel(line.type);
    const invNo = line.invoice_number ?? '—';
    const magnitude = Math.abs(Number(line.amount ?? 0));
    const chargeCell = isCharge(line.type) ? fmtCurrency(magnitude) : '';
    const settleCell = isCharge(line.type) ? '' : fmtCurrency(magnitude);
    tableBody.push([
      { text: fmtDateSafe(line.date) },
      { text: label },
      { text: invNo },
      { text: chargeCell, alignment: 'right' },
      { text: settleCell, alignment: 'right' },
      { text: fmtCurrency(Number(line.running_balance ?? 0)), alignment: 'right' },
    ]);
  }

  const totals = statement.totals;
  const totalsTable = {
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        table: {
          widths: [110, 90] as any,
          body: [
            [{ text: 'Billed', alignment: 'right' }, { text: fmtCurrency(Number(totals.billed ?? 0)), alignment: 'right' }],
            [{ text: 'Paid', alignment: 'right' }, { text: fmtCurrency(Number(totals.paid ?? 0)), alignment: 'right' }],
            [{ text: 'Deposit credit applied', alignment: 'right' }, { text: fmtCurrency(Number(totals.deposit_credit ?? 0)), alignment: 'right' }],
            [{ text: 'Credited', alignment: 'right' }, { text: fmtCurrency(Number(totals.credited ?? 0)), alignment: 'right' }],
            [{ text: 'Refunded', alignment: 'right' }, { text: fmtCurrency(Number(totals.refunded ?? 0)), alignment: 'right' }],
            [
              { text: 'Balance Due', alignment: 'right', bold: true, fontSize: 12 },
              { text: fmtCurrency(Number(totals.balance ?? 0)), alignment: 'right', bold: true, fontSize: 12 },
            ],
          ],
        },
        layout: 'noBorders',
      },
    ],
    margin: [0, 10, 0, 20] as any,
  };

  return {
    content: [
      {
        columns: [
          { width: 200, ...logoBlock },
          { text: 'STATEMENT', fontSize: 32, bold: true, color: '#666', alignment: 'right' },
        ],
        margin: [0, 0, 0, 20] as any,
      },
      {
        columns: [
          {
            stack: [
              org.name ?? '',
              [org.address_line1, org.city, org.state, org.postal_code].filter(Boolean).join(', '),
              org.email ?? '',
              org.website ?? '',
            ].filter((t) => t !== ''),
          },
          {
            stack: [
              { text: statement.title || 'Statement', bold: true, alignment: 'right' },
              { text: partyName, alignment: 'right' },
              { text: partyEmail, alignment: 'right' },
            ],
          },
        ],
        margin: [0, 0, 0, 30] as any,
      },
      {
        table: {
          headerRows: 1,
          widths: [70, '*', 60, 70, 80, 80] as any,
          body: tableBody,
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0,
          hLineColor: () => '#e5e5e5',
        },
      },
      totalsTable as any,
      { text: 'Thank You For Your Business', fontSize: 18, bold: true, alignment: 'center', margin: [0, 30, 0, 0] as any },
    ],
    defaultStyle: { font: 'Inter', fontSize: 10 },
    styles: {
      paragraph: { fontSize: 10, lineHeight: 1.3 },
    },
    pageMargins: [40, 40, 40, 40],
    pageSize: 'LETTER',
  };
}
