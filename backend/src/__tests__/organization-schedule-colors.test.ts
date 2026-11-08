import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { SCHEDULE_EVENT_COLOR_TOKENS } from '../controllers/organization.controller';

beforeEach(() => {
  vi.clearAllMocks();
});

function mockOrgTx(current: Record<string, unknown> = {}) {
  (prisma.$transaction as any).mockImplementation((fn: any) =>
    fn({
      $executeRaw: vi.fn().mockResolvedValue(1),
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          lead_first_issued_at: null,
          estimate_first_issued_at: null,
          job_first_issued_at: null,
          invoice_first_issued_at: null,
          customer_first_issued_at: null,
          lead_prefix: 'L',
          estimate_prefix: 'E',
          job_prefix: 'J',
          invoice_prefix: 'I',
          customer_prefix: 'C',
          number_padding: 5,
          stripe_account_id: null,
          accepted_payment_methods: [],
          ...current,
        }),
        update: vi.fn().mockImplementation((args: any) => Promise.resolve({ id: ALPHA_ORG_ID, ...args.data })),
      },
    }),
  );
}

/**
 * Per-org scheduler event colours. The board's four event types (job / walkthrough /
 * service-plan / calendar-entry) ship with token defaults; an org may override any subset.
 *
 * Values are design-system TOKEN NAMES, not hexes (owner, 2026-09-15): the org picks from the
 * palette the app already ships, never a colour of its own. Storing the name rather than the
 * resolved value is what lets a retuned token repaint every org's board. The list is the
 * contract with frontend/src/design-system/scheduleEventPalette.ts - the two must match.
 *
 * Stored as a partial map so "unset" stays distinguishable from "set to the default" - an org
 * that never touched the setting keeps following the design system if the tokens move.
 */
describe('PATCH /api/organization - schedule_event_colors', () => {
  it('accepts a partial map of event type to palette token', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ schedule_event_colors: { job: 'sage-700', walkthrough: 'status-purple' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      schedule_event_colors: { job: 'sage-700', walkthrough: 'status-purple' },
    });
  });

  it('accepts every palette token for every event type', async () => {
    mockAuthAs('admin');
    for (const token of SCHEDULE_EVENT_COLOR_TOKENS) {
      mockOrgTx();
      const res = await request(app)
        .patch('/api/organization')
        .set(authHeader('admin'))
        .send({
          schedule_event_colors: {
            job: token, walkthrough: token, 'service-plan': token, 'calendar-entry': token,
          },
        });
      expect(res.status, token).toBe(200);
      expect(res.body.schedule_event_colors['calendar-entry']).toBe(token);
    }
  });

  it('accepts an empty map - the org reverting every type to the design-system default', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ schedule_event_colors: {} });
    expect(res.status).toBe(200);
    expect(res.body.schedule_event_colors).toEqual({});
  });

  it('rejects an unknown event type', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ schedule_event_colors: { 'time-off': 'sage-700' } });
    expect(res.status).toBe(400);
  });

  it('rejects a hex - the org picks from the palette, never a colour of its own', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ schedule_event_colors: { job: '#2563EB' } });
    expect(res.status).toBe(400);
  });

  it('rejects a token that is not in the palette, even a real one', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    // --terracotta exists in tokens.css, but it is --danger and the needs-crew notch: a Job painted
    // in it would make the board's one red mean two things. Not offered.
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ schedule_event_colors: { job: 'terracotta' } });
    expect(res.status).toBe(400);
  });

  it('is returned by GET /api/organization', async () => {
    mockAuthAs('admin');
    (prisma.organization.findUnique as any).mockResolvedValue({
      id: ALPHA_ORG_ID,
      name: 'Alpha',
      schedule_event_colors: { job: 'sage-700' },
    });
    const res = await request(app).get('/api/organization').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.schedule_event_colors).toEqual({ job: 'sage-700' });
  });
});
