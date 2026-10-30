import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID } from './helpers';
import { matchesWhere, type Row } from './whereMatcher';

/**
 * Roles & Permissions S08.11: Play recording and Download recording.
 *
 * The recording link refuses without Play recording; a separate download link refuses without Download recording;
 * a call response says a recording exists only to a holder of either switch. As in comm-call-log-scope.test.ts, the
 * stored switch values decide (each person below is the same base role with only the two switches changed), and a
 * call the person cannot read is proven through the `where` the handler handed the database.
 */

const mockPrisma = prisma as any;
const storage = () =>
  supabaseAdmin.storage.from('call-recordings') as unknown as { createSignedUrl: Mock };

const CALL_ID = 'c0000000-0000-4000-8000-0000000000a1';
const PLAY = 'play_recording';
const DOWNLOAD = 'download_recording';
const SIGNED = 'https://test.supabase.co/storage/v1/object/sign/call-recordings/key.mp3?token=mock';

function callRow(fields: Partial<Row> = {}): Row {
  return {
    id: CALL_ID, organization_id: ALPHA_ORG_ID, direction: 'in', from_number: '+15555550100', to_number: '+15555550199',
    status: 'completed', answered_by: null, agent_id: null, started_at: new Date('2026-10-01T12:00:00Z'),
    has_recording: true, recording_key: 'org/key.mp3', phone_number_id: null, job_id: null, job: null, lead_id: null,
    lead: null, customer_id: null, customer: null, vendor_id: null, ...fields,
  };
}

const sees = async (play: boolean, download: boolean) => {
  mockAuthAs('dispatcher');
  mockRoleSwitches({ [PLAY]: play, [DOWNLOAD]: download });
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockPrisma.callSession.findMany.mockResolvedValue([]);
  mockPrisma.callSession.findFirst.mockResolvedValue(callRow());
  storage().createSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED }, error: null });
});

describe('the catalog entries behind the two switches', () => {
  it('give each switch a server check of its own and no longer park either as pending', () => {
    for (const key of [PLAY, DOWNLOAD]) {
      const entry = SWITCH_CATALOG.find((s) => s.key === key)!;
      expect(entry.serverChecks.length, key).toBeGreaterThan(0);
      expect(entry.pending, key).toBeUndefined();
    }
  });

  it('says in the Download recording help text that it hides the download button and that playback can still be captured', () => {
    const help = SWITCH_CATALOG.find((s) => s.key === DOWNLOAD)!.helpText;
    expect(help).toMatch(/hides the download button/i);
    expect(help).toMatch(/playback can (still )?be captured/i);
  });
});

describe('GET /communication/calls/:id/recording (Play recording)', () => {
  it('hands out the playback link to a person with Play recording', async () => {
    await sees(true, false);
    const res = await request(app).get(`/api/communication/calls/${CALL_ID}/recording`).set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED);
    // A playback link is not marked as a file download.
    expect(storage().createSignedUrl.mock.calls[0][2]).toBeUndefined();
  });

  it('refuses without Play recording even with Download recording on, and mints nothing', async () => {
    await sees(false, true);
    const res = await request(app).get(`/api/communication/calls/${CALL_ID}/recording`).set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
    expect(storage().createSignedUrl).not.toHaveBeenCalled();
    expect(mockPrisma.callSession.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a call the person cannot read even with both switches on', async () => {
    await sees(true, true);
    mockPrisma.callSession.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/api/communication/calls/${CALL_ID}/recording`).set(authHeader('dispatcher'));
    expect(res.status).toBe(404);
    expect(storage().createSignedUrl).not.toHaveBeenCalled();
    // The row filter is in the query: the same read scope the call detail uses.
    const where = (mockPrisma.callSession.findFirst as Mock).mock.calls[0][0].where as Record<string, unknown>;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(matchesWhere(callRow({ organization_id: 'another-org' }), where)).toBe(false);
  });
});

describe('GET /communication/calls/:id/recording/download (Download recording)', () => {
  it('hands out a link marked as a file download to a person with Download recording', async () => {
    await sees(false, true);
    const res = await request(app).get(`/api/communication/calls/${CALL_ID}/recording/download`).set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body.url).toBe(SIGNED);
    const options = storage().createSignedUrl.mock.calls[0][2] as { download?: unknown };
    expect(options?.download).toBeTruthy();
  });

  it('refuses without Download recording even with Play recording on, and mints nothing', async () => {
    await sees(true, false);
    const res = await request(app).get(`/api/communication/calls/${CALL_ID}/recording/download`).set(authHeader('dispatcher'));
    expect(res.status).toBe(403);
    expect(storage().createSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a call the person cannot read even with both switches on', async () => {
    await sees(true, true);
    mockPrisma.callSession.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/api/communication/calls/${CALL_ID}/recording/download`).set(authHeader('dispatcher'));
    expect(res.status).toBe(404);
    expect(storage().createSignedUrl).not.toHaveBeenCalled();
  });

  it('answers a quiet 404 when the recording is not stored yet', async () => {
    await sees(false, true);
    mockPrisma.callSession.findFirst.mockResolvedValue(callRow({ recording_key: null }));
    const res = await request(app).get(`/api/communication/calls/${CALL_ID}/recording/download`).set(authHeader('dispatcher'));
    expect(res.status).toBe(404);
  });

  it('404s on a malformed id before reaching the database', async () => {
    await sees(false, true);
    const res = await request(app).get('/api/communication/calls/not-a-uuid/recording/download').set(authHeader('dispatcher'));
    expect(res.status).toBe(404);
    expect(mockPrisma.callSession.findFirst).not.toHaveBeenCalled();
  });
});

describe('a call response says a recording exists only to a holder of either switch', () => {
  const cases: Array<[string, boolean, boolean, boolean]> = [
    ['Play recording alone', true, false, true],
    ['Download recording alone', false, true, true],
    ['both', true, true, true],
    ['neither', false, false, false],
  ];

  it.each(cases)('the call list and the call detail, for a person with %s', async (_label, play, download, expected) => {
    await sees(play, download);
    mockPrisma.callSession.findMany.mockResolvedValue([callRow()]);

    const list = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(list.status).toBe(200);
    expect(list.body.calls).toHaveLength(1);
    expect('hasRecording' in list.body.calls[0]).toBe(expected);

    const detail = await request(app).get(`/api/communication/calls/${CALL_ID}`).set(authHeader('dispatcher'));
    expect(detail.status).toBe(200);
    expect('hasRecording' in detail.body.call).toBe(expected);
  });

  it('never leaks the storage key, whatever the switches', async () => {
    await sees(true, true);
    mockPrisma.callSession.findMany.mockResolvedValue([callRow()]);
    const list = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(JSON.stringify(list.body)).not.toContain('org/key.mp3');
  });
});
