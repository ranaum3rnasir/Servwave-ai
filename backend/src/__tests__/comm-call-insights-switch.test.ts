import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID } from './helpers';
import type { Row } from './whereMatcher';

/**
 * Roles & Permissions S08.13: See call insights, agent scorecards and money on calls.
 *
 * Without See call insights a call response leaves out the sentiment and the "needs review" flag (the call score, who
 * answered and the call details stay), and the phone agents list still answers with each agent's identity but none of
 * the scorecard metrics. Call revenue and agent revenue follow See company figures (PRD 1's money redaction), whatever
 * the insights switch says. As in comm-call-transcript-switch.test.ts, the stored switch values decide: each person is
 * the same base role with only these two switches changed.
 */

const mockPrisma = prisma as any;

const CALL_ID = 'c0000000-0000-4000-8000-0000000000c1';
const AGENT_ID = 'a0000000-0000-4000-8000-0000000000c1';
const USER_ID = 'b0000000-0000-4000-8000-0000000000c1';
const INSIGHTS = 'see_call_insights';
const FIGURES = 'see_company_figures';
const CALL_REVENUE = 41200;
const AGENT_REVENUE = 28800;

function callRow(fields: Partial<Row> = {}): Row {
  return {
    id: CALL_ID, organization_id: ALPHA_ORG_ID, direction: 'in', from_number: '+15555550100', to_number: '+15555550199',
    status: 'completed', answered_by: { kind: 'human', user_id: USER_ID, name: 'Dana Lee' }, agent_id: USER_ID,
    started_at: new Date('2026-10-01T12:00:00Z'), duration_sec: 90, phone_number_id: null, job_id: null, job: null,
    lead_id: null, lead: null, customer_id: null, customer: null, vendor_id: null, has_recording: false,
    sentiment: 'negative', review_flag: 'Low-confidence booking', qa_score: 87, disposition: 'needs_manager',
    revenue: CALL_REVENUE, ...fields,
  };
}

function agentRow(): Row {
  return {
    id: AGENT_ID, organization_id: ALPHA_ORG_ID, kind: 'human', name: 'Dana Lee', role: 'CSR',
    calls: 412, answer_rate_pct: 91, booking_rate_pct: 64, aht_sec: 233, sentiment_pct: 88,
    revenue: AGENT_REVENUE, script_adherence_pct: 93, containment_pct: null,
    user: { id: USER_ID, first_name: 'Dana', last_name: 'Lee', email: 'dana@example.test' },
  };
}

const holds = (insights: boolean, figures: boolean) => {
  mockAuthAs('dispatcher');
  mockRoleSwitches({ [INSIGHTS]: insights, [FIGURES]: figures });
};

/** The scorecard metrics of an agent row, which only See call insights lets through. */
const METRICS = ['calls', 'answerRatePct', 'bookingRatePct', 'ahtSec', 'sentimentPct', 'scriptAdherencePct', 'containmentPct'];

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockPrisma.callSession.findMany.mockResolvedValue([callRow()]);
  mockPrisma.callSession.findFirst.mockResolvedValue(callRow());
  mockPrisma.phoneAgent.findMany.mockResolvedValue([agentRow()]);
  mockPrisma.phoneAgent.findFirst.mockResolvedValue(agentRow());
});

describe('the catalog entry behind See call insights', () => {
  it('has server checks of its own and is no longer parked as pending', () => {
    const entry = SWITCH_CATALOG.find((s) => s.key === INSIGHTS)!;
    expect(entry.serverChecks.length).toBeGreaterThan(0);
    expect(entry.pending).toBeUndefined();
  });

  it('lists, on See company figures, the two places this slice leaves company money out', () => {
    const entry = SWITCH_CATALOG.find((s) => s.key === FIGURES)!;
    expect(entry.serverChecks).toEqual(expect.arrayContaining(['call-revenue', 'agent-revenue']));
  });
});

describe('the call list, the call detail and the outcome lookup (See call insights)', () => {
  it('carry the sentiment and the review flag for a person with See call insights', async () => {
    holds(true, false);
    const list = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(list.status).toBe(200);
    expect(list.body.calls[0]).toMatchObject({ sentiment: 'negative', reviewFlag: 'Low-confidence booking' });

    const detail = await request(app).get(`/api/communication/calls/${CALL_ID}`).set(authHeader('dispatcher'));
    expect(detail.status).toBe(200);
    expect(detail.body.call).toMatchObject({ sentiment: 'negative', reviewFlag: 'Low-confidence booking' });
  });

  it('leave them out for a person without it, and keep the call score, who answered and the call details', async () => {
    holds(false, false);
    const list = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(list.status).toBe(200);
    const detail = await request(app).get(`/api/communication/calls/${CALL_ID}`).set(authHeader('dispatcher'));
    expect(detail.status).toBe(200);
    const outcome = await request(app)
      .get('/api/communication/calls/outcome?to_number=%2B15555550199&since=2026-10-01T00:00:00Z')
      .set(authHeader('dispatcher'));
    expect(outcome.status).toBe(200);

    for (const [where, call] of [['list', list.body.calls[0]], ['detail', detail.body.call], ['outcome', outcome.body.call]] as const) {
      expect(call, where).toBeTruthy();
      expect('sentiment' in call, `${where}: sentiment`).toBe(false);
      expect('reviewFlag' in call, `${where}: reviewFlag`).toBe(false);
      expect(JSON.stringify(call), where).not.toContain('Low-confidence booking');
      expect(call, where).toMatchObject({
        id: CALL_ID, qaScore: 87, disposition: 'needs_manager', durationSec: 90, status: 'completed',
        answeredBy: { id: USER_ID, name: 'Dana Lee' },
      });
    }
  });
});

describe('call revenue (See company figures)', () => {
  it('rides on the call list and the call detail for a person with See company figures', async () => {
    holds(true, true);
    const list = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(list.body.calls[0].revenue).toBe(CALL_REVENUE);
    const detail = await request(app).get(`/api/communication/calls/${CALL_ID}`).set(authHeader('dispatcher'));
    expect(detail.body.call.revenue).toBe(CALL_REVENUE);
  });

  it('is left out of every call response without it, even with See call insights', async () => {
    holds(true, false);
    const list = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    const detail = await request(app).get(`/api/communication/calls/${CALL_ID}`).set(authHeader('dispatcher'));
    const outcome = await request(app)
      .get('/api/communication/calls/outcome?to_number=%2B15555550199&since=2026-10-01T00:00:00Z')
      .set(authHeader('dispatcher'));
    for (const [where, body] of [['list', list.body], ['detail', detail.body], ['outcome', outcome.body]] as const) {
      expect(JSON.stringify(body), where).not.toContain(String(CALL_REVENUE));
    }
    expect('revenue' in list.body.calls[0]).toBe(false);
    expect('revenue' in detail.body.call).toBe(false);
  });

  it('is independent of See call insights: figures without insights still carry the revenue', async () => {
    holds(false, true);
    const list = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(list.body.calls[0].revenue).toBe(CALL_REVENUE);
    expect('sentiment' in list.body.calls[0]).toBe(false);
  });
});

describe('GET /communication/agents and /agents/:id (the scorecards)', () => {
  it('answer with identity and every metric for a person with both switches', async () => {
    holds(true, true);
    const list = await request(app).get('/api/communication/agents').set(authHeader('dispatcher'));
    expect(list.status).toBe(200);
    expect(list.body.agents[0]).toMatchObject({
      id: AGENT_ID, kind: 'human', name: 'Dana Lee', role: 'CSR', userId: USER_ID,
      linkedUser: { id: USER_ID, name: 'Dana Lee', email: 'dana@example.test' },
      calls: 412, answerRatePct: 91, bookingRatePct: 64, ahtSec: 233, sentimentPct: 88, scriptAdherencePct: 93,
      revenue: AGENT_REVENUE,
    });
    const one = await request(app).get(`/api/communication/agents/${AGENT_ID}`).set(authHeader('dispatcher'));
    expect(one.status).toBe(200);
    expect(one.body.agent).toMatchObject({ calls: 412, sentimentPct: 88, revenue: AGENT_REVENUE });
  });

  it('answer with identity and no scorecard metric, not even agent revenue, without See call insights', async () => {
    holds(false, true);
    const list = await request(app).get('/api/communication/agents').set(authHeader('dispatcher'));
    const one = await request(app).get(`/api/communication/agents/${AGENT_ID}`).set(authHeader('dispatcher'));
    expect(list.status).toBe(200);
    expect(one.status).toBe(200);
    for (const [where, agent] of [['list', list.body.agents[0]], ['one', one.body.agent]] as const) {
      expect(agent, where).toMatchObject({
        id: AGENT_ID, kind: 'human', name: 'Dana Lee', role: 'CSR', userId: USER_ID,
        linkedUser: { id: USER_ID, name: 'Dana Lee', email: 'dana@example.test' },
      });
      for (const metric of [...METRICS, 'revenue']) expect(metric in agent, `${where}: ${metric}`).toBe(false);
      expect(JSON.stringify(agent), where).not.toContain(String(AGENT_REVENUE));
    }
  });

  it('keep every metric but leave agent revenue out without See company figures', async () => {
    holds(true, false);
    const list = await request(app).get('/api/communication/agents').set(authHeader('dispatcher'));
    const one = await request(app).get(`/api/communication/agents/${AGENT_ID}`).set(authHeader('dispatcher'));
    for (const [where, agent] of [['list', list.body.agents[0]], ['one', one.body.agent]] as const) {
      expect(agent, where).toMatchObject({ calls: 412, answerRatePct: 91, sentimentPct: 88, scriptAdherencePct: 93 });
      expect('revenue' in agent, `${where}: revenue`).toBe(false);
      expect(JSON.stringify(agent), where).not.toContain(String(AGENT_REVENUE));
    }
  });

  it('are not refused without See call insights: the agents list is also how a screen names who answered', async () => {
    holds(false, false);
    expect((await request(app).get('/api/communication/agents').set(authHeader('dispatcher'))).status).toBe(200);
    expect((await request(app).get(`/api/communication/agents/${AGENT_ID}`).set(authHeader('dispatcher'))).status).toBe(200);
  });
});
