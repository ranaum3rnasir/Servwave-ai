import { describe, it, expect } from 'vitest';
import {
  buildEstimatesReport,
  toEstimateReportRow,
  customerName,
  repName,
  type EstimateSourceRow,
} from '../services/estimates-report';

function source(over: Partial<EstimateSourceRow>): EstimateSourceRow {
  return {
    id: 'est-1',
    estimate_number: 'E10001',
    status: 'SENT',
    total_amount: 1500,
    created_at: new Date('2026-06-07T12:00:00.000Z'),
    creator: { first_name: 'Jordan', last_name: 'Mills' },
    lead: { customer: { company_name: 'Bilton Tech' } },
    job: null,
    send_config: { deposit_amount: 450 },
    ...over,
  };
}

describe('customerName', () => {
  it('prefers company_name', () => {
    expect(customerName({ company_name: 'Acme', first_name: 'A', last_name: 'B' })).toBe('Acme');
  });
  it('falls back to "First Last"', () => {
    expect(customerName({ company_name: null, first_name: 'Tim', last_name: 'Clyde' })).toBe('Tim Clyde');
  });
  it('is "Unknown" when nothing is present', () => {
    expect(customerName(null)).toBe('Unknown');
    expect(customerName({ company_name: null, first_name: null, last_name: null })).toBe('Unknown');
  });
});

describe('repName', () => {
  it('joins first + last', () => {
    expect(repName({ first_name: 'Robin', last_name: 'Shah' })).toBe('Robin Shah');
  });
  it('is "Unassigned" when missing', () => {
    expect(repName(null)).toBe('Unassigned');
    expect(repName({ first_name: null, last_name: null })).toBe('Unassigned');
  });
});

describe('toEstimateReportRow', () => {
  it('flattens a Prisma estimate into the frontend EstimateRow shape', () => {
    const row = toEstimateReportRow(source({}));
    expect(row).toEqual({
      id: 'est-1',
      number: 'E10001',
      customer: 'Bilton Tech',
      rep: 'Jordan Mills',
      createdAt: '2026-06-07',
      amount: 1500,
      depositDue: 450,
      status: 'SENT',
      hasJob: false,
    });
  });

  it('sets hasJob true when a linked job exists (drives "won")', () => {
    const row = toEstimateReportRow(source({ status: 'WON', job: { id: 'job-1' } }));
    expect(row.hasJob).toBe(true);
    expect(row.status).toBe('WON');
  });

  it('coerces a Prisma Decimal-like amount and defaults a missing deposit to 0', () => {
    const row = toEstimateReportRow(source({ total_amount: '2999.50' as unknown, send_config: null }));
    expect(row.amount).toBe(2999.5);
    expect(row.depositDue).toBe(0);
  });

  it('renders createdAt as a UTC yyyy-mm-dd date string', () => {
    const row = toEstimateReportRow(source({ created_at: new Date('2026-01-15T23:00:00.000Z') }));
    expect(row.createdAt).toBe('2026-01-15');
  });

  it('handles a missing customer / creator gracefully', () => {
    const row = toEstimateReportRow(source({ lead: null, creator: null }));
    expect(row.customer).toBe('Unknown');
    expect(row.rep).toBe('Unassigned');
  });

  // SERV10X-61 - a lead-less (customer-anchored) estimate has no `lead`, so the customer must
  // resolve off the direct `customer` anchor (R6). Reverting `e.lead?.customer ?? e.customer`
  // back to `e.lead?.customer` makes this 'Unknown' (non-placebo).
  it('resolves the customer name from the direct anchor when the estimate is lead-less', () => {
    const row = toEstimateReportRow(source({ lead: null, customer: { company_name: 'Direct Anchor Co' } }));
    expect(row.customer).toBe('Direct Anchor Co');
  });
});

describe('buildEstimatesReport', () => {
  it('maps every source row, preserving order', () => {
    const rows = buildEstimatesReport([
      source({ id: 'a', estimate_number: 'E1' }),
      source({ id: 'b', estimate_number: 'E2' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows.map((r) => r.number)).toEqual(['E1', 'E2']);
  });

  it('returns [] for no rows', () => {
    expect(buildEstimatesReport([])).toEqual([]);
  });
});
