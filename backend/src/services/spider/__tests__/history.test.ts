/**
 * The History tab's pure rules (S3): reading one alert row into what the contractor's table and
 * preview drawer show, for rows written with the alert-time copy and for rows from before it, and
 * the query parameters his toolbar sends.
 */
import { describe, expect, it } from 'vitest';
import {
  historyFiltersSchema,
  historyItem,
  legacyChannels,
  overallOutcome,
  type HistoryRow,
} from '../history';

const T = new Date('2026-10-10T15:30:00.000Z');

function row(over: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: 'a1',
    lead_id: 'lead-1',
    status: 'NEW',
    entered_status_at: new Date(T.getTime() - 3 * 3_600_000),
    alerted_at: T,
    limit_value: 2,
    limit_unit: 'HOUR',
    recipient_ids: ['u1'],
    delivery: {},
    lead_number: null,
    customer_id: null,
    customer_name: null,
    company_name: null,
    service_request: null,
    service_location: null,
    stage_name: null,
    elapsed_value: null,
    elapsed_unit: null,
    channels: null,
    recipients: null,
    email_subject: null,
    email_body: null,
    sms_message: null,
    in_app_message: null,
    kind: 'ALERTED',
    lead: {
      lead_number: 'L00042',
      customer_id: 'cust-1',
      service_request: 'Fix the door',
      customer: { first_name: 'Pat', last_name: 'Payer', company_name: 'Payer Homes', service_locations: [] },
      service_location: null,
    },
    ...over,
  };
}

const users = new Map([['u1', { id: 'u1', first_name: 'Ann', last_name: 'Admin', email: 'ann@example.test', role: 'ADMIN' }]]);

describe('historyItem - a row with the alert-time copy', () => {
  const stored = row({
    lead_number: 'L00042',
    customer_id: 'cust-1',
    customer_name: 'Pat Payer',
    company_name: 'Payer Homes',
    service_request: 'Fix the door',
    service_location: '2 Primary Road, Testville, MA, 02108',
    stage_name: 'New',
    elapsed_value: 3,
    elapsed_unit: 'HOUR',
    channels: {
      email: { enabled: true, status: 'SENT', sent: 1, skipped: 0, failed: 0, error: null, skip_reason: null, from: 'ServWave Spider Alerts <alerts@spider.servwave.com>' },
      sms: { enabled: true, status: 'FAILED', sent: 0, skipped: 0, failed: 1, error: 'Text message delivery failed', skip_reason: null },
      in_app: { enabled: true, status: 'SENT' },
    },
    recipients: [{ id: 'u1', name: 'Ann Admin (then)', email: 'ann-then@example.test', role: 'SALES', type: 'user', email_outcome: null, text_outcome: null }],
    email_subject: 'Spider Alert - Pat Payer (L00042)',
    email_body: 'body',
    sms_message: 'sms',
    in_app_message: 'This lead was created 3 hours ago and has not yet been contacted.',
  });

  it('shows what was stored, not what the lead or the person reads now', () => {
    const item = historyItem(stored, users);
    expect(item).toMatchObject({
      id: 'a1',
      lead_id: 'lead-1',
      lead_number: 'L00042',
      customer_id: 'cust-1',
      customer_name: 'Pat Payer',
      company_name: 'Payer Homes',
      service_location: '2 Primary Road, Testville, MA, 02108',
      stage_name: 'New',
      elapsed: { value: 3, unit: 'HOUR' },
      alerted_at: T.toISOString(),
      recipients: [{ id: 'u1', name: 'Ann Admin (then)', email: 'ann-then@example.test', role: 'SALES', type: 'user', email_outcome: null, text_outcome: null }],
      email_subject: 'Spider Alert - Pat Payer (L00042)',
      email_body: 'body',
      sms_message: 'sms',
      in_app_message: 'This lead was created 3 hours ago and has not yet been contacted.',
    });
    expect(item.outcomes.sms).toMatchObject({ status: 'FAILED', error: 'Text message delivery failed' });
    expect(item.outcome).toBe('FAILED');
  });

  it('a channel the log never finished writing (only {enabled}) has no outcome, never "Sent"', () => {
    const item = historyItem(row({ ...stored, channels: { email: { enabled: true }, sms: { enabled: false }, in_app: { enabled: true } } }), users);
    expect(item.outcomes.email).toBeNull();
    expect(item.outcomes.in_app).toBeNull();
    expect(item.outcomes.sms).toMatchObject({ enabled: false, status: 'SKIPPED' });
    expect(item.outcome).toBeNull();
  });
});

describe('historyItem - a row from before the alert-time copy', () => {
  it('reads the lead, customer and people as they are now, derives the time in the stage, and claims no message text', () => {
    const item = historyItem(row(), users);
    expect(item).toMatchObject({
      lead_number: 'L00042',
      customer_id: 'cust-1',
      customer_name: 'Pat Payer',
      company_name: 'Payer Homes',
      service_request: 'Fix the door',
      service_location: 'Service location on file',
      stage_name: 'New',
      elapsed: { value: 3, unit: 'HOUR' },
      email_subject: null,
      email_body: null,
      sms_message: null,
      in_app_message: null,
      recipients: [{ id: 'u1', name: 'Ann Admin', email: 'ann@example.test', role: 'ADMIN', type: null, email_outcome: null, text_outcome: null }],
    });
  });

  it('names a recipient who no longer exists as a former team member', () => {
    const item = historyItem(row({ recipient_ids: ['gone'] }), users);
    expect(item.recipients).toEqual([{ id: 'gone', name: 'Former team member', email: null, role: null, type: null, email_outcome: null, text_outcome: null }]);
  });

  it('names a retired stage by its lead status label', () => {
    expect(historyItem(row({ status: 'ESTIMATED' }), users).stage_name).toBe('Estimate Sent');
    expect(historyItem(row({ status: 'WALKTHROUGH_COMPLETED' }), users).stage_name).toBe('Walkthrough Completed');
  });

  it('with no recorded delivery shows no channel and no outcome, never "Sent"', () => {
    const item = historyItem(row({ delivery: {} }), users);
    expect(item.outcomes).toEqual({ email: null, sms: null, in_app: null });
    expect(item.outcome).toBeNull();
  });
});

describe('historyItem - the fields the History screen read before S3, in their old shape', () => {
  it('keeps status_label, entered_status_at, limit, the sentence channels and the per-person sentences', () => {
    const item = historyItem(
      row({
        delivery: {
          in_app: { outcome: 'Shown in the app' },
          email: { outcome: 'Email sent', recipients: [{ user_id: 'u1', outcome: 'Email sent' }] },
          text: { outcome: 'Text alerts are switched off' },
        },
      }),
      users,
    );
    expect(item).toMatchObject({
      status_label: 'New',
      entered_status_at: new Date(T.getTime() - 3 * 3_600_000).toISOString(),
      limit: { value: 2, unit: 'HOUR' },
      channels: { in_app: 'Shown in the app', email: 'Email sent', text: 'Text alerts are switched off' },
    });
    expect(item.recipients[0]).toMatchObject({ name: 'Ann Admin', email_outcome: 'Email sent', text_outcome: null });
  });
});

describe('legacyChannels - our own fixed sentences read back as outcome codes', () => {
  it('counts each person and keeps the first reason, in his wording where he had one', () => {
    const ch = legacyChannels({
      in_app: { outcome: 'Shown in the app' },
      email: {
        outcome: 'Email sent (1 of 3)',
        recipients: [
          { user_id: 'a', outcome: 'Email sent' },
          { user_id: 'b', outcome: 'Email skipped: address is suppressed' },
          { user_id: 'c', outcome: 'Email could not be delivered' },
        ],
      },
      text: {
        outcome: 'Text skipped: no phone number on profile',
        recipients: [{ user_id: 'a', outcome: 'Text skipped: no phone number on profile' }],
      },
    });
    expect(ch.email).toMatchObject({ enabled: true, status: 'SENT', sent: 1, skipped: 1, failed: 1, error: 'Email delivery failed', skip_reason: 'Recipient opted out' });
    expect(ch.sms).toMatchObject({ enabled: true, status: 'SKIPPED', sent: 0, skipped: 1, failed: 0, skip_reason: 'no phone number' });
    expect(ch.in_app).toEqual({ enabled: true, status: 'SENT' });
  });

  it('reads a switched-off channel as not enabled, and nobody in the app as skipped', () => {
    const ch = legacyChannels({
      in_app: { outcome: 'No one to alert in the app' },
      email: { outcome: 'Email alerts are switched off' },
      text: { outcome: 'Text alerts are switched off' },
    });
    expect(ch.email).toMatchObject({ enabled: false, status: 'SKIPPED' });
    expect(ch.sms).toMatchObject({ enabled: false, status: 'SKIPPED' });
    expect(ch.in_app).toEqual({ enabled: true, status: 'SKIPPED' });
    expect(legacyChannels({ in_app: { outcome: 'In-app alerts are switched off' } }).in_app).toEqual({ enabled: false, status: 'SKIPPED' });
  });

  it('a sentence it does not know is no outcome', () => {
    expect(legacyChannels({ email: { outcome: 'something else' } }).email).toBeNull();
  });
});

describe('overallOutcome - his alert-log status rule', () => {
  const ch = (status: 'SENT' | 'FAILED' | 'SKIPPED', sent: number, failed: number, enabled = true) => ({
    enabled, status, sent, skipped: 0, failed, error: null, skip_reason: null,
  });
  it('FAILED when an on email or text channel sent nothing and failed', () => {
    expect(overallOutcome({ email: ch('FAILED', 0, 1), sms: ch('SENT', 1, 0), in_app: { enabled: true, status: 'SENT' } })).toBe('FAILED');
  });
  it('PARTIAL when a channel both sent and failed', () => {
    expect(overallOutcome({ email: ch('SENT', 1, 1), sms: ch('SKIPPED', 0, 0, false), in_app: { enabled: false, status: 'SKIPPED' } })).toBe('PARTIAL');
  });
  it('SENT when anything went out, SKIPPED when nothing did', () => {
    expect(overallOutcome({ email: ch('SKIPPED', 0, 0, false), sms: ch('SKIPPED', 0, 0, false), in_app: { enabled: true, status: 'SENT' } })).toBe('SENT');
    expect(overallOutcome({ email: ch('SKIPPED', 0, 0), sms: ch('SKIPPED', 0, 0), in_app: { enabled: false, status: 'SKIPPED' } })).toBe('SKIPPED');
  });
  it('unknown unless every channel is known', () => {
    expect(overallOutcome({ email: null, sms: null, in_app: null })).toBeNull();
    expect(overallOutcome({ email: ch('SENT', 1, 0), sms: null, in_app: { enabled: true, status: 'SENT' } })).toBeNull();
  });
});

describe('historyFiltersSchema - his toolbar, sent to the server', () => {
  it('reads comma lists, ranges and the search', () => {
    const parsed = historyFiltersSchema.parse({
      search: '  payer ',
      stage: 'NEW,WALKTHROUGH',
      ranges: '2026-10-01T00:00:00.000Z~2026-10-02T00:00:00.000Z',
      recipients: '6f1d2c1e-0000-4000-8000-000000000001',
      customers: '6f1d2c1e-0000-4000-8000-000000000002',
      roles: 'ADMIN,SALES',
    });
    expect(parsed).toEqual({
      search: 'payer',
      stage: ['NEW', 'WALKTHROUGH'],
      ranges: [{ from: new Date('2026-10-01T00:00:00.000Z'), to: new Date('2026-10-02T00:00:00.000Z') }],
      recipients: ['6f1d2c1e-0000-4000-8000-000000000001'],
      customers: ['6f1d2c1e-0000-4000-8000-000000000002'],
      roles: ['ADMIN', 'SALES'],
    });
  });

  it('defaults to no filter', () => {
    expect(historyFiltersSchema.parse({})).toEqual({ search: '', stage: [], ranges: [], recipients: [], customers: [], roles: [] });
  });

  it('refuses an unknown stage or role, a bad id, and a range that ends before it starts', () => {
    expect(historyFiltersSchema.safeParse({ stage: 'WON' }).success).toBe(false);
    expect(historyFiltersSchema.safeParse({ roles: 'OWNER' }).success).toBe(false);
    expect(historyFiltersSchema.safeParse({ recipients: 'not-an-id' }).success).toBe(false);
    expect(historyFiltersSchema.safeParse({ ranges: '2026-10-02T00:00:00.000Z~2026-10-01T00:00:00.000Z' }).success).toBe(false);
    expect(historyFiltersSchema.safeParse({ search: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('historyItem - the starting summary (#2794)', () => {
  it('marks a row reported in a starting summary, and no other', () => {
    expect(historyItem(row({ kind: 'SUMMARIZED' }), users).in_starting_summary).toBe(true);
    expect(historyItem(row(), users).in_starting_summary).toBe(false);
  });
});
