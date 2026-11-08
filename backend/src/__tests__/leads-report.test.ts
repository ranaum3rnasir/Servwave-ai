import { describe, it, expect } from 'vitest';
import {
  buildLeadsReport,
  displayStatusFor,
  parseLeadNumber,
  WON_DISPLAY_STATUSES,
  type LeadInput,
  type LeadEstimateInput,
} from '../services/leads-report';

function est(over: Partial<LeadEstimateInput> = {}): LeadEstimateInput {
  return { total: 1000, status: 'WON', approvedAt: new Date('2026-06-10T00:00:00.000Z'), ...over };
}

function lead(over: Partial<LeadInput> = {}): LeadInput {
  return {
    leadNumber: 'L00001',
    client: 'Acme Co',
    email: 'a@acme.com',
    phone: '(201) 555-0100',
    address: '1 Main St, Brooklyn, NY',
    status: 'NEW',
    source: 'Google',
    jobType: 'Alarm System',
    assigned: 'Emanuel Dahan',
    createdBy: 'Dispatch',
    tags: [],
    createdAt: new Date('2026-06-01T12:00:00.000Z'),
    scheduledAt: null,
    estimates: [],
    ...over,
  };
}

describe('displayStatusFor', () => {
  it('maps WON → Sold-done', () => {
    expect(displayStatusFor('WON')).toBe('Sold-done');
  });
  it('maps ESTIMATED → Converted', () => {
    expect(displayStatusFor('ESTIMATED')).toBe('Converted');
  });
  it('maps LOST and CANCELLED → Lost', () => {
    expect(displayStatusFor('LOST')).toBe('Lost');
    expect(displayStatusFor('CANCELLED')).toBe('Lost');
  });
  it('maps pipeline statuses → Open', () => {
    for (const s of ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED']) {
      expect(displayStatusFor(s)).toBe('Open');
    }
  });

  it('every WON_DISPLAY_STATUS is a value the mapper can emit', () => {
    const emitted = ['WON', 'ESTIMATED'].map(displayStatusFor);
    for (const w of WON_DISPLAY_STATUSES.filter((x) => x !== 'Sold')) {
      expect(emitted).toContain(w);
    }
  });
});

describe('parseLeadNumber', () => {
  it('strips a prefix and parses the digits', () => {
    expect(parseLeadNumber('L00017680')).toBe(17680);
    expect(parseLeadNumber('L17680')).toBe(17680);
    expect(parseLeadNumber('17680')).toBe(17680);
  });
  it('returns 0 when there are no digits', () => {
    expect(parseLeadNumber('LEAD')).toBe(0);
    expect(parseLeadNumber('')).toBe(0);
  });
});

describe('buildLeadsReport', () => {
  it('maps a bare lead to the frontend row shape with safe defaults', () => {
    const [row] = buildLeadsReport([lead({ source: null, jobType: null })]);
    expect(row).toMatchObject({
      leadNumber: 1,
      client: 'Acme Co',
      status: 'Open',
      source: '',
      jobType: '',
      estimates: 0,
      value: 0,
      convertedAt: null,
      scheduledAt: null,
    });
    expect(row?.createdAt).toBe('2026-06-01T12:00:00.000Z');
  });

  it('sums WON estimate totals into value and counts all estimates', () => {
    const [row] = buildLeadsReport([
      lead({
        status: 'WON',
        estimates: [
          est({ total: 1200, status: 'WON', approvedAt: new Date('2026-06-05T00:00:00.000Z') }),
          est({ total: 800, status: 'WON', approvedAt: new Date('2026-06-09T00:00:00.000Z') }),
          est({ total: 500, status: 'DECLINED', approvedAt: null }),
        ],
      }),
    ]);
    expect(row?.estimates).toBe(3);
    expect(row?.value).toBe(2000); // only the two WON
    // convertedAt = latest approvedAt
    expect(row?.convertedAt).toBe('2026-06-09T00:00:00.000Z');
  });

  it('does not fabricate value/convertedAt for a won lead without approved estimates', () => {
    const [row] = buildLeadsReport([
      lead({ status: 'WON', estimates: [est({ status: 'DRAFT', approvedAt: null })] }),
    ]);
    expect(row?.status).toBe('Sold-done');
    expect(row?.value).toBe(0);
    expect(row?.convertedAt).toBeNull();
    expect(row?.estimates).toBe(1);
  });

  it('serializes scheduledAt when present', () => {
    const [row] = buildLeadsReport([
      lead({ scheduledAt: new Date('2026-06-03T15:30:00.000Z') }),
    ]);
    expect(row?.scheduledAt).toBe('2026-06-03T15:30:00.000Z');
  });

  it('sorts rows by lead number descending (newest first)', () => {
    const rows = buildLeadsReport([
      lead({ leadNumber: 'L00010' }),
      lead({ leadNumber: 'L00099' }),
      lead({ leadNumber: 'L00050' }),
    ]);
    expect(rows.map((r) => r.leadNumber)).toEqual([99, 50, 10]);
  });

  it('passes tags through unchanged', () => {
    const [row] = buildLeadsReport([lead({ tags: ['Followup', 'Callback'] })]);
    expect(row?.tags).toEqual(['Followup', 'Callback']);
  });
});
