// The `answeredBy.id` contract between ingest and the Calls/Performance UI.
//
// The UI has always keyed off `answeredBy.id` - to name the answerer in the
// Calls table, and to scope the per-agent Performance drawer via
// `.filter(c => c.answeredBy.id === agent.id)`. NOTHING has ever written an
// `id` key: a softphone answer stores `ctm_agent_id` (a vendor id) and the
// forwarded-answer resolver stores `user_id`. So every per-agent stat has
// silently been zero for everyone, and would have stayed zero even after
// attribution started resolving people.
//
// The identity both sides can agree on is the ServWave user, which the row
// already carries in `agent_id` - the column ingest resolves from the agent's
// email, from a claimed click-to-call stash, or from the forwarded-answer
// resolver. That is what `id` means here.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrisma = prisma as any;

const USER_ID = '00000000-0000-0000-0000-0000000000aa';

function callRow(over: Record<string, unknown> = {}) {
  return {
    id: 'ca000000-0000-0000-0000-000000000001',
    direction: 'in',
    from_number: '+15551234567',
    to_number: '+15550001111',
    tracking_source: null,
    status: 'completed',
    answered_by: { kind: 'none' },
    agent_id: null,
    started_at: new Date('2026-08-12T10:00:00Z'),
    duration_sec: 30,
    customer_id: null,
    lead_id: null,
    vendor_id: null,
    job_id: null,
    job_label: null,
    organization_id: ALPHA_ORG_ID,
    ...over,
  };
}

async function listCalls() {
  const res = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
  expect(res.status).toBe(200);
  return res.body.calls[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockAuthAs('dispatcher');
});

describe('GET /api/communication/calls - answeredBy.id', () => {
  it('names the ServWave user who answered a softphone call', async () => {
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow({
        answered_by: { kind: 'csr', ctm_agent_id: '12', name: 'Dana Reyes', email: 'dana@a.com' },
        agent_id: USER_ID,
      }),
    ]);

    expect(await listCalls()).toMatchObject({
      answeredBy: { kind: 'csr', id: USER_ID, name: 'Dana Reyes' },
    });
  });

  it('names the ServWave user who answered a forwarded call', async () => {
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow({
        answered_by: { kind: 'external', receiving_number_id: '3906455', user_id: USER_ID },
        agent_id: USER_ID,
      }),
    ]);

    expect(await listCalls()).toMatchObject({
      answeredBy: { kind: 'external', id: USER_ID },
    });
  });

  it('leaves the vendor agent id alone - `id` is never a vendor identifier', async () => {
    const call = await (async () => {
      mockPrisma.callSession.findMany.mockResolvedValue([
        callRow({
          answered_by: { kind: 'csr', ctm_agent_id: '12', name: 'Dana Reyes' },
          agent_id: USER_ID,
        }),
      ]);
      return listCalls();
    })();

    expect(call.answeredBy.id).toBe(USER_ID);
    expect(call.answeredBy.id).not.toBe('12');
  });

  it('adds no id to an unanswered call, even when the row carries an agent', async () => {
    // agent_id on an outbound leg is who PLACED the call. Stamping it as
    // `answeredBy.id` while kind is 'none' would credit an unanswered call to
    // them in every per-agent stat.
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow({ direction: 'out', answered_by: { kind: 'none' }, agent_id: USER_ID }),
    ]);

    const call = await listCalls();
    expect(call.answeredBy.kind).toBe('none');
    expect(call.answeredBy.id).toBeUndefined();
  });

  it('tolerates a row with no answered_by at all', async () => {
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow({ answered_by: null, agent_id: null }),
    ]);

    expect((await listCalls()).answeredBy).toEqual({ kind: 'none' });
  });

  it('does not invent an id when nobody was resolved', async () => {
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow({ answered_by: { kind: 'external', receiving_number_id: '3906455' }, agent_id: null }),
    ]);

    const call = await listCalls();
    expect(call.answeredBy.kind).toBe('external');
    expect(call.answeredBy.id).toBeUndefined();
  });
});

// The stored JSON carries the phone service's own identifiers (the agent's id
// there, the forwarded destination's filter id). Neither is ServWave's, no
// frontend reads either, and a vendor identifier never goes to the browser
// (CLAUDE.md boundary). The response is an explicit field list, not a spread.
describe('GET /api/communication/calls - answeredBy carries no phone-service identifiers', () => {
  it('drops the vendor agent id from a softphone answer and keeps who answered', async () => {
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow({
        answered_by: { kind: 'csr', ctm_agent_id: '12', name: 'Dana Reyes', email: 'dana@a.com' },
        agent_id: USER_ID,
      }),
    ]);

    expect((await listCalls()).answeredBy).toEqual({
      kind: 'csr',
      id: USER_ID,
      name: 'Dana Reyes',
      email: 'dana@a.com',
    });
  });

  it('drops the forwarded destination id and keeps the resolved user', async () => {
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow({
        answered_by: {
          kind: 'external',
          receiving_number_id: '3906455',
          user_id: USER_ID,
          name: 'Dana Reyes',
          email: 'dana@a.com',
        },
        agent_id: USER_ID,
      }),
    ]);

    expect((await listCalls()).answeredBy).toEqual({
      kind: 'external',
      id: USER_ID,
      user_id: USER_ID,
      name: 'Dana Reyes',
      email: 'dana@a.com',
    });
  });

  it('keeps the assignment marker on an assumed answerer', async () => {
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow({
        answered_by: { kind: 'external', user_id: USER_ID, name: 'Dana Reyes', email: null, resolved_from: 'assignment' },
        agent_id: USER_ID,
      }),
    ]);

    expect((await listCalls()).answeredBy).toEqual({
      kind: 'external',
      id: USER_ID,
      user_id: USER_ID,
      name: 'Dana Reyes',
      email: null,
      resolved_from: 'assignment',
    });
  });

  it('sends an unanswered call as just its kind and empty name, with no vendor key', async () => {
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow({ answered_by: { kind: 'none', ctm_agent_id: null, name: null, email: null } }),
    ]);

    expect((await listCalls()).answeredBy).toEqual({ kind: 'none', name: null, email: null });
  });

  // `answered_by` is a Json column, so a malformed row can hold a bare string,
  // number or array. `key in` throws on a primitive, which would 500 the whole
  // list; such a row reads exactly like a row with no answered_by at all.
  it.each([
    ['a string', 'csr'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['csr']],
  ])('reads %s in answered_by as an unanswered call, never a 500', async (_label, value) => {
    mockPrisma.callSession.findMany.mockResolvedValue([
      callRow({ answered_by: value, agent_id: USER_ID }),
      callRow({ id: 'ca000000-0000-0000-0000-000000000002', answered_by: { kind: 'csr', name: 'Dana Reyes' }, agent_id: USER_ID }),
    ]);

    const res = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body.calls[0].answeredBy).toEqual({ kind: 'none' });
    expect(res.body.calls[1].answeredBy).toEqual({ kind: 'csr', id: USER_ID, name: 'Dana Reyes' });
  });

  it('applies the same list on GET /calls/:id', async () => {
    mockPrisma.callSession.findFirst.mockResolvedValue(
      callRow({ answered_by: { kind: 'voicemail', ctm_agent_id: null, name: null, email: null } }),
    );

    const res = await request(app)
      .get('/api/communication/calls/ca000000-0000-0000-0000-000000000001')
      .set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body.call.answeredBy).toEqual({ kind: 'voicemail', name: null, email: null });
  });
});
