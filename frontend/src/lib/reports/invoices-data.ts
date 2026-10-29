import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { hashStr, mulberry32, rangeRnd } from './random';

// ───────────────────────────────────────────────────────────────────────────
// Invoices report data — demo mock + live query, sharing one row shape.
//  • demo org  → the deterministic sample invoices (so sales can show the full
//    layout without a backend), anchored to INVOICES_MOCK_NOW.
//  • real org  → GET /api/reports/invoices (org-scoped invoices with derived
//    salesperson = estimate→lead→commission_owner and technician = first job
//    assignee), against the live clock.
// ───────────────────────────────────────────────────────────────────────────

export const STATUSES = ['Paid', 'Due', 'Overdue', 'Unsent', 'Partial'] as const;
export type InvoiceStatus = (typeof STATUSES)[number];

export interface InvoiceRow {
  number: string;
  client: string;
  email: string;
  created: number; // epoch ms
  subtotal: number;
  tax: number;
  discountPct: number;
  amount: number;
  due: number;
  status: InvoiceStatus;
  job: string;
  salesperson: string;
  technician: string;
  jobType: string;
}

// App "today" for the deterministic mock — fixed so sample data + relative date
// filters resolve to stable values across renders.
export const INVOICES_MOCK_NOW = new Date(Date.parse('2026-06-06T12:00:00Z'));
const BASE_MS = INVOICES_MOCK_NOW.getTime();
const DAY = 86_400_000;

export const REPS = ['Maria Lopez', 'James Carter', 'Aisha Khan', 'Tom Becker', 'Sofia Rossi'];
export const TECHS = ['Marcus Bell', 'Sofia Reyes', 'Devon Clark', 'Priya Nair', 'Tyler Brooks'];
export const JOB_TYPES = ['HVAC', 'Plumbing', 'Electrical'] as const;

const CLIENTS: { name: string; email: string }[] = [
  { name: 'Nadav', email: 'info@activesecurityinc.com' },
  { name: 'Bilton', email: 'tomer.gat@bilton.tech' },
  { name: 'Valerie', email: 'valmarasco@gmail.com' },
  { name: 'Acme Facilities', email: 'ap@acmefacilities.com' },
  { name: 'Westside Plumbing', email: 'office@westsideplumb.com' },
  { name: 'Greenfield Co', email: 'billing@greenfield.co' },
  { name: 'Marina Towers', email: 'manager@marinatowers.com' },
  { name: 'Robert Hayes', email: 'r.hayes@gmail.com' },
  { name: 'Sunrise Cafe', email: 'owner@sunrisecafe.com' },
  { name: 'Delgado Rentals', email: 'admin@delgadorentals.com' },
  { name: 'Patel Residence', email: 'n.patel@outlook.com' },
  { name: 'Harbor Logistics', email: 'invoices@harborlog.com' },
];

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Deterministic sample invoices — identical to the original inline mock. */
export function buildMockInvoices(): InvoiceRow[] {
  const rng = mulberry32(hashStr('invoices-report-v1'));
  const rows: InvoiceRow[] = [];
  for (let i = 0; i < 36; i++) {
    const client = pick(rng, CLIENTS);
    const status = pick(rng, STATUSES);
    const subtotal = Math.round(rangeRnd(rng, 150, 4500));
    const discountPct = pick(rng, [0, 0, 0, 5, 10]);
    const discountAmt = (subtotal * discountPct) / 100;
    const tax = Math.round((subtotal - discountAmt) * 0.0887 * 100) / 100;
    const amount = Math.round((subtotal - discountAmt + tax) * 100) / 100;
    const due = status === 'Paid' ? 0 : status === 'Partial' ? Math.round(amount * 0.5 * 100) / 100 : amount;
    const created = BASE_MS - Math.floor(rangeRnd(rng, 0, 180)) * DAY;
    rows.push({
      number: String(596720 - i),
      client: client.name,
      email: client.email,
      created,
      subtotal,
      tax,
      discountPct,
      amount,
      due,
      status,
      job: String(698494 - i),
      salesperson: pick(rng, REPS),
      technician: pick(rng, TECHS),
      jobType: pick(rng, JOB_TYPES),
    });
  }
  return rows;
}

/**
 * Invoice rows + the "now" they filter against.
 *  • demo org → deterministic sample invoices, anchored to INVOICES_MOCK_NOW.
 *  • real org → GET /api/reports/invoices. Rows already carry derived
 *    salesperson/technician/discountPct/status from the service.
 * Live `now` is memoized once per mount so the report's useMemos stay stable.
 */
export function useInvoicesReport(isDemo: boolean): { rows: InvoiceRow[]; now: Date; isLoading: boolean } {
  const liveNow = useMemo(() => new Date(), []);
  const live = useQuery({
    queryKey: ['reports', 'invoices'],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/invoices');
      return (data.rows ?? []) as InvoiceRow[];
    },
    staleTime: 60_000,
    enabled: !isDemo,
  });

  if (isDemo) return { rows: buildMockInvoices(), now: INVOICES_MOCK_NOW, isLoading: false };
  return { rows: live.data ?? [], now: liveNow, isLoading: live.isLoading };
}
