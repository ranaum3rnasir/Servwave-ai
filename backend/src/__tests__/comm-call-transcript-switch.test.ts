import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID, JOB_FIXTURE, CUSTOMER_FIXTURE } from './helpers';
import type { Row } from './whereMatcher';

/**
 * Roles & Permissions S08.12: View transcript covers the transcript and the call summary.
 *
 * The transcript endpoint refuses without View transcript. Without it, no call response carries the transcript text,
 * the per-speaker turns or the call summary: the call list and detail, and the job, lead and customer conversation
 * lists (their preview line is the summary). As in comm-call-recording-switches.test.ts, the stored switch values decide:
 * each person below is the same base role with only this switch changed.
 */

const mockPrisma = prisma as any;

const CALL_ID = 'c0000000-0000-4000-8000-0000000000b1';
const JOB_ID = JOB_FIXTURE.id;
const LEAD_ID = 'e0000000-0000-4000-8000-0000000000b1';
const CUSTOMER_ID = CUSTOMER_FIXTURE.id;
const SWITCH = 'view_transcript';
const SUMMARY = 'Confirmed Thursday 8am. Asked for COI before arrival.';
const TRANSCRIPT = 'Caller: can you come Thursday? Agent: yes, eight in the morning.';
const TURNS = [
  { speaker: 'Caller', text: 'Can you come Thursday?', channel: 1, startSec: 0.5, endSec: 2.1 },
  { speaker: 'Agent', text: 'Yes, eight in the morning.', channel: 2, startSec: 2.4, endSec: 3.9 },
];

function callRow(fields: Partial<Row> = {}): Row {
  return {
    id: CALL_ID, organization_id: ALPHA_ORG_ID, direction: 'in', from_number: '+15555550100', to_number: '+15555550199',
    status: 'completed', answered_by: null, agent_id: null, started_at: new Date('2026-10-01T12:00:00Z'), duration_sec: 90,
    summary: SUMMARY, transcript_preview: TRANSCRIPT, transcript_turns: TURNS, has_recording: false, ctm_call_id: 'v-1',
    phone_number_id: null, job_id: JOB_ID, job_label: 'J00001', job: null, lead_id: LEAD_ID, lead: null,
    customer_id: CUSTOMER_ID, customer: null, vendor_id: null, ...fields,
  };
}

const holds = (on: boolean) => {
  mockAuthAs('dispatcher');
  mockRoleSwitches({ [SWITCH]: on });
};

/** Everything a response could say about what was said on the call. */
const SPOKEN = [SUMMARY, TRANSCRIPT, 'Can you come Thursday?', 'Yes, eight in the morning.'];
function expectNothingSpoken(body: unknown) {
  const text = JSON.stringify(body);
  for (const fragment of SPOKEN) expect(text, fragment).not.toContain(fragment);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockPrisma.callSession.findMany.mockResolvedValue([callRow()]);
  mockPrisma.callSession.findFirst.mockResolvedValue(callRow());
  mockPrisma.message.findMany.mockResolvedValue([]);
  mockPrisma.email.findMany.mockResolvedValue([]);
  mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
  mockPrisma.manualCommunicationLog.findMany.mockResolvedValue([]);
  mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
  mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
  mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_ID });
});

describe('the catalog entries behind the two transcript switches', () => {
  it('gives View transcript a server check of its own and no longer parks it as pending', () => {
    const entry = SWITCH_CATALOG.find((s) => s.key === SWITCH)!;
    expect(entry.serverChecks.length).toBeGreaterThan(0);
    expect(entry.pending).toBeUndefined();
  });

  it('says in the View transcript help text that it covers the call summary too', () => {
    expect(SWITCH_CATALOG.find((s) => s.key === SWITCH)!.helpText).toMatch(/call summary/i);
  });

  it('says in the Download transcript help text that no transcript download exists yet, and keeps it dormant', () => {
    const entry = SWITCH_CATALOG.find((s) => s.key === 'download_transcript')!;
    expect(entry.helpText).toMatch(/no transcript download exists yet/i);
    expect(entry.serverChecks).toEqual([]);
  });
});

describe('GET /communication/calls/:id/transcript (View transcript)', () => {
  it('answers the transcript, the summary and the turns to a person with View transcript', async () => {
    holds(true);
    const res = await request(app).get(`/api/communication/calls/${CALL_ID}/transcript`).set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transcript: TRANSCRIPT, summary: SUMMARY, turns: TURNS });
  });

  it('refuses without View transcript and never reads the call', async () => {
    holds(false);
    const res = await request(app).get(`/api/communication/calls/${CALL_ID}/transcript`).set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
    expectNothingSpoken(res.body);
    expect(mockPrisma.callSession.findFirst).not.toHaveBeenCalled();
  });
});

describe('the call list and the call detail', () => {
  it('carry the summary and the transcript text for a person with View transcript', async () => {
    holds(true);
    const list = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(list.status).toBe(200);
    expect(list.body.calls[0]).toMatchObject({ summary: SUMMARY, transcriptPreview: TRANSCRIPT });

    const detail = await request(app).get(`/api/communication/calls/${CALL_ID}`).set(authHeader('dispatcher'));
    expect(detail.status).toBe(200);
    expect(detail.body.call).toMatchObject({ summary: SUMMARY, transcriptPreview: TRANSCRIPT });
  });

  it('leave out the summary, the transcript and the turns for a person without it, and still answer the call', async () => {
    holds(false);
    const list = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(list.status).toBe(200);
    expect(list.body.calls).toHaveLength(1);
    expect(list.body.calls[0].id).toBe(CALL_ID);
    expectNothingSpoken(list.body);
    for (const field of ['summary', 'transcriptPreview', 'transcript', 'turns', 'transcriptTurns']) {
      expect(field in list.body.calls[0], `list: ${field}`).toBe(false);
    }

    const detail = await request(app).get(`/api/communication/calls/${CALL_ID}`).set(authHeader('dispatcher'));
    expect(detail.status).toBe(200);
    expect(detail.body.call.id).toBe(CALL_ID);
    expectNothingSpoken(detail.body);
    for (const field of ['summary', 'transcriptPreview', 'transcript', 'turns', 'transcriptTurns']) {
      expect(field in detail.body.call, `detail: ${field}`).toBe(false);
    }
  });

  it('leave them out of the call outcome lookup too', async () => {
    holds(false);
    const res = await request(app).get('/api/communication/calls/outcome?to_number=%2B15555550199&since=2026-10-01T00:00:00Z').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expectNothingSpoken(res.body);
  });
});

describe('the job, lead and customer conversation lists', () => {
  const routes: Array<[string, string]> = [
    ['job', `/api/jobs/${JOB_ID}/communications`],
    ['lead', `/api/leads/${LEAD_ID}/communications`],
    ['customer', `/api/customers/${CUSTOMER_ID}/communications`],
  ];

  it.each(routes)('show the call summary on the preview line of the %s list for a person with View transcript', async (_kind, path) => {
    holds(true);
    const res = await request(app).get(path).set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].preview).toBe(SUMMARY);
  });

  it.each(routes)('leave the call summary off the preview line of the %s list for a person without it, and keep the call row', async (_kind, path) => {
    holds(false);
    const res = await request(app).get(path).set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: CALL_ID, channel: 'call', jobId: JOB_ID, title: 'Inbound call · 1m 30s' });
    expect(res.body.items[0].preview).toBe('');
    expectNothingSpoken(res.body);
  });

  it('leave a text on the same list untouched by the switch', async () => {
    holds(false);
    mockPrisma.message.findMany.mockResolvedValue([
      {
        id: 'aa000000-0000-4000-8000-000000000001', thread_id: 'ab000000-0000-4000-8000-000000000001', direction: 'out',
        body: 'See you Thursday.', ts: new Date('2026-10-01T13:00:00Z'), job_id: JOB_ID, job_label: 'J00001',
        thread: { title: null, customer: null }, organization_id: ALPHA_ORG_ID,
      },
    ]);
    const res = await request(app).get(`/api/jobs/${JOB_ID}/communications`).set(authHeader('dispatcher'));
    const text = (res.body.items as Array<{ channel: string; preview: string }>).find((i) => i.channel === 'sms');
    expect(text?.preview).toBe('See you Thursday.');
  });
});
