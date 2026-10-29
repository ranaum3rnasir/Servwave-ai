import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import {
  agingBucketOf,
  bucketAging,
  buildReport,
  computeBuckets,
  computeByRep,
  computeContext,
  computeConversion,
  median,
  selectDrillRows,
  type ConversionModel,
  type NormalizedRow,
  type ReportFilters,
} from '../services/estimate-conversion-report';

// ── Pure-row factory ──────────────────────────────────────────────────────────
let seq = 0;
function row(over: Partial<NormalizedRow> = {}): NormalizedRow {
  seq += 1;
  return {
    id: `id-${seq}`,
    number: `E${1000 + seq}`,
    customerName: 'Acme',
    repId: 'rep-1',
    repName: 'Marcus Bell',
    source: 'Google',
    jobType: 'HVAC',
    amount: 1000,
    status: 'SENT',
    createdAt: new Date('2026-03-01'),
    sentAt: new Date('2026-03-02'),
    decidedAt: null,
    lastActivityAt: new Date('2026-03-02'),
    leadCreatedAt: new Date('2026-03-01'),
    lostReason: null,
    ...over,
  };
}

describe('conversion math', () => {
  // Won=3, Lost=1, Open=4 (sent2+pending2), Cancelled=5, Expired=3
  const rows: NormalizedRow[] = [
    ...Array.from({ length: 3 }, () => row({ status: 'WON', amount: 1000 })),
    ...Array.from({ length: 1 }, () => row({ status: 'DECLINED', amount: 500 })),
    ...Array.from({ length: 2 }, () => row({ status: 'SENT', amount: 200 })),
    ...Array.from({ length: 2 }, () => row({ status: 'PENDING', amount: 300 })),
    ...Array.from({ length: 5 }, () => row({ status: 'ARCHIVED', amount: 9999 })),
    ...Array.from({ length: 3 }, () => row({ status: 'EXPIRED', amount: 9999 })),
  ];
  const buckets = computeBuckets(rows);

  it('Won / Decided = Won / (Won + Lost), cancelled + expired excluded', () => {
    const r = computeConversion(buckets, 'decided');
    expect(r.num).toBe(3);
    expect(r.denom).toBe(4); // 3 won + 1 lost — NOT cancelled/expired
    expect(r.rate).toBe(75);
  });

  it('Won / Sent = Won / (Won + Lost + Open), cancelled + expired excluded', () => {
    const r = computeConversion(buckets, 'sent');
    expect(r.denom).toBe(8); // 3 + 1 + 4
    expect(r.rate).toBe(38); // round(3/8 * 100)
  });

  it('returns 0 when denominator is empty', () => {
    expect(computeConversion(computeBuckets([]), 'sent').rate).toBe(0);
  });
});

describe('aging buckets', () => {
  it('maps boundary days to the correct bucket', () => {
    expect(agingBucketOf(0)).toBe('0-7');
    expect(agingBucketOf(7)).toBe('0-7');
    expect(agingBucketOf(8)).toBe('8-14');
    expect(agingBucketOf(14)).toBe('8-14');
    expect(agingBucketOf(15)).toBe('15-30');
    expect(agingBucketOf(30)).toBe('15-30');
    expect(agingBucketOf(31)).toBe('30+');
    expect(agingBucketOf(999)).toBe('30+');
  });

  it('buckets only open quotes (SENT/PENDING with sent_at) by age', () => {
    const asOf = new Date('2026-04-01');
    const mk = (daysAgo: number, status: NormalizedRow['status']) =>
      row({ status, sentAt: new Date(asOf.getTime() - daysAgo * 86_400_000), amount: 100 });
    const rows = [
      mk(3, 'SENT'),    // 0-7
      mk(10, 'PENDING'),// 8-14
      mk(20, 'SENT'),   // 15-30
      mk(45, 'SENT'),   // 30+
      mk(50, 'WON'),         // excluded — not open
      row({ status: 'SENT', sentAt: null }), // excluded — no sent date
    ];
    const out = bucketAging(rows, asOf);
    expect(out['0-7'].count).toBe(1);
    expect(out['8-14'].count).toBe(1);
    expect(out['15-30'].count).toBe(1);
    expect(out['30+'].count).toBe(1);
    expect(out['0-7'].value).toBe(100);
  });
});

describe('median', () => {
  it('handles odd, even, and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('context metrics', () => {
  const rows: NormalizedRow[] = [
    row({ status: 'WON', amount: 1000, sentAt: new Date('2026-03-01'), decidedAt: new Date('2026-03-05'), leadCreatedAt: new Date('2026-03-01T00:00:00Z') }), // 4d
    row({ status: 'WON', amount: 2000, sentAt: new Date('2026-03-01'), decidedAt: new Date('2026-03-07'), leadCreatedAt: new Date('2026-03-01T00:00:00Z') }), // 6d
    row({ status: 'DECLINED', amount: 500, sentAt: new Date('2026-03-01'), decidedAt: new Date('2026-03-06'), leadCreatedAt: new Date('2026-03-01T00:00:00Z') }), // 5d
  ];

  it('computes avg ticket won/lost', () => {
    const c = computeContext(rows);
    expect(c.avgTicketWon).toBe(1500);
    expect(c.avgTicketLost).toBe(500);
  });

  it('computes median days to decision over decided rows', () => {
    // diffs: 4, 6, 5 → median 5
    expect(computeContext(rows).medianDaysToDecision).toBe(5);
  });
});

describe('per-rep aggregation', () => {
  it('groups by rep and computes per-rep conversion + totals', () => {
    const rows: NormalizedRow[] = [
      row({ repId: 'a', repName: 'Alice', status: 'WON', amount: 1000 }),
      row({ repId: 'a', repName: 'Alice', status: 'DECLINED', amount: 400 }),
      row({ repId: 'b', repName: 'Bob', status: 'WON', amount: 5000 }),
    ];
    const byRep = computeByRep(rows, 'decided' as ConversionModel);
    const alice = byRep.find((r) => r.repId === 'a')!;
    const bob = byRep.find((r) => r.repId === 'b')!;
    expect(alice.wonValue).toBe(1000);
    expect(alice.lostValue).toBe(400);
    expect(alice.conversionPct).toBe(50); // 1 won / (1 won + 1 lost)
    expect(bob.conversionPct).toBe(100);
    // sorted by wonValue desc → Bob first
    expect(byRep[0].repId).toBe('b');
  });
});

describe('buildReport', () => {
  const filters: ReportFilters = {
    anchor: 'sent', from: new Date('2026-03-01'), to: new Date('2026-03-31'),
    repId: 'all', source: 'all', jobType: 'all', model: 'sent',
  };
  const now = new Date('2026-03-15');

  it('filters to the current period and computes a prior period', () => {
    const rows: NormalizedRow[] = [
      row({ status: 'WON', sentAt: new Date('2026-03-10') }), // current
      row({ status: 'WON', sentAt: new Date('2026-02-10') }), // prior (Feb)
      row({ status: 'SENT', sentAt: new Date('2025-12-01') }),     // older — excluded from both
    ];
    const payload = buildReport(rows, filters, now);
    expect(payload.summary.won.count).toBe(1);
    expect(payload.prior.won.count).toBe(1);
    expect(payload.options.reps.length).toBeGreaterThan(0);
  });

  it('drill selectors narrow by outcome', () => {
    const rows = [row({ status: 'WON' }), row({ status: 'DECLINED' }), row({ status: 'SENT' })];
    const won = selectDrillRows(rows, { outcome: 'won' }, 'sent', now);
    expect(won.every((r) => r.status === 'WON')).toBe(true);
    expect(won.length).toBe(1);
  });
});

// ── Endpoint tests (Prisma mocked) ───────────────────────────────────────────
const mockPrisma = prisma as unknown as {
  estimate: { findMany: ReturnType<typeof vi.fn> };
};

function pRow(over: Record<string, any> = {}) {
  return {
    id: over.id ?? 'e1',
    estimate_number: over.estimate_number ?? 'E1001',
    status: over.status ?? 'WON',
    total_amount: over.total_amount ?? 1000,
    lead_source: over.lead_source ?? 'Google',
    job_type: over.job_type ?? 'HVAC',
    lost_reason: over.lost_reason ?? null,
    sent_at: over.sent_at ?? new Date('2026-02-10'),
    approved_at: over.approved_at ?? new Date('2026-02-15'),
    declined_at: over.declined_at ?? null,
    created_at: over.created_at ?? new Date('2026-02-01'),
    updated_at: over.updated_at ?? new Date('2026-02-16'),
    lead: over.lead ?? {
      created_at: new Date('2026-01-30'),
      commission_owner_id: 'rep-1',
      commission_owner: { id: 'rep-1', first_name: 'Marcus', last_name: 'Bell' },
      customer: { first_name: 'John', last_name: 'Doe', company_name: 'Doe HVAC' },
    },
  };
}

describe('GET /api/reports/estimate-conversion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
  });

  it('returns the report payload shape', async () => {
    mockPrisma.estimate.findMany.mockResolvedValue([
      pRow({ id: 'e1', status: 'WON' }),
      pRow({ id: 'e2', status: 'DECLINED', approved_at: null, declined_at: new Date('2026-02-15') }),
      pRow({ id: 'e3', status: 'SENT', approved_at: null }),
    ]);

    const res = await request(app)
      .get('/api/reports/estimate-conversion?anchor=sent&from=2026-02-01&to=2026-02-28&model=sent')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.summary.won.count).toBe(1);
    expect(res.body.summary.lost.count).toBe(1);
    expect(res.body.summary.open.count).toBe(1);
    expect(res.body.summary.conversion).toHaveProperty('rate');
    expect(res.body).toHaveProperty('prior');
    expect(res.body).toHaveProperty('byRep');
    expect(res.body).toHaveProperty('byMonth');
    expect(res.body).toHaveProperty('aging');
    expect(res.body.options.sources).toContain('Google');
  });

  it('respects the date range for the active anchor', async () => {
    mockPrisma.estimate.findMany.mockResolvedValue([
      pRow({ id: 'in', sent_at: new Date('2026-02-10') }),
      pRow({ id: 'out', sent_at: new Date('2026-06-10') }),
    ]);
    const res = await request(app)
      .get('/api/reports/estimate-conversion?anchor=sent&from=2026-02-01&to=2026-02-28')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.summary.totalCount).toBe(1); // only the in-range row
  });

  it('narrows by rep', async () => {
    mockPrisma.estimate.findMany.mockResolvedValue([
      pRow({ id: 'a', lead: { created_at: new Date('2026-01-30'), commission_owner_id: 'rep-1', commission_owner: { id: 'rep-1', first_name: 'A', last_name: 'A' }, customer: { company_name: 'X' } } }),
      pRow({ id: 'b', lead: { created_at: new Date('2026-01-30'), commission_owner_id: 'rep-2', commission_owner: { id: 'rep-2', first_name: 'B', last_name: 'B' }, customer: { company_name: 'Y' } } }),
    ]);
    const res = await request(app)
      .get('/api/reports/estimate-conversion?anchor=sent&from=2026-02-01&to=2026-02-28&rep=rep-1')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.summary.totalCount).toBe(1);
  });
});

describe('GET /api/reports/estimate-conversion/estimates (drill-down)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
  });

  it('returns only matching rows for an outcome selector', async () => {
    mockPrisma.estimate.findMany.mockResolvedValue([
      pRow({ id: 'won', status: 'WON' }),
      pRow({ id: 'lost', status: 'DECLINED', approved_at: null, declined_at: new Date('2026-02-15') }),
    ]);
    const res = await request(app)
      .get('/api/reports/estimate-conversion/estimates?anchor=sent&from=2026-02-01&to=2026-02-28&outcome=won')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].status).toBe('WON');
    expect(res.body.rows[0]).toHaveProperty('daysOpen');
  });
});
