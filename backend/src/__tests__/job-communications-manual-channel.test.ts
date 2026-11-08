// Manual Communication Log — the timeline mapper's channel pinning (slice 8, carry-forward C9).
//
// `mapManual` builds a row's title out of the OPTIONAL columns — duration and subject. Until this
// slice only `subject` consulted the channel; duration did not. A row with channel=EMAIL and
// duration=12 therefore rendered
//
//     "Outbound email · 12m"
//
// which states that an email had a length.
//
// (This suite once also pinned the same rule for the `outcome` column. That column and its enum
// were dropped in the outcome retirement's phase 2, so those specs went with them — a row can no
// longer carry an outcome for the mapper to mis-read.)
//
// WHY IT MATTERED EVEN THOUGH THE API REFUSES THE PAIRING. There is NO DB CHECK behind that
// refusal — the create endpoint's validation was the whole of the enforcement, and slice 8 added
// a second endpoint that writes the same columns. A rule with one guard and no backstop is one
// bad merge away from being no rule at all, and the failure is silent: the row stores fine and
// only the reader is lied to.
//
// So the rule now has two guards, and this suite is the one that pins the READER. The writer's
// half is in comm-manual-log-edit.test.ts ("the optional fields belong to their own channel").
//
// The rows below are written STRAIGHT INTO THE STORE rather than through the API, on purpose:
// they are precisely the rows the API refuses, and a test that could not construct them could not
// test the mapper at all.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, LEAD_FIXTURE } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockPrisma = prisma as any;

const LEAD_ID = LEAD_FIXTURE.id;

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
  mockPrisma.callSession.findMany.mockResolvedValue([]);
  mockPrisma.message.findMany.mockResolvedValue([]);
  mockPrisma.email.findMany.mockResolvedValue([]);
  mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
});

/** A stored row exactly as the column set allows it, whether or not the API would write it. */
function storedRow(overrides: Record<string, unknown>) {
  return {
    id: '11110000-0000-0000-0000-000000000001',
    organization_id: ALPHA_ORG_ID,
    channel: 'CALL',
    direction: 'OUT',
    occurred_at: new Date('2026-08-26T20:00:00.000Z'),
    notes: 'Whatever was said.',
    duration_minutes: null,
    subject: null,
    lead_id: LEAD_ID,
    job_id: null,
    lead: { lead_number: 'L00001', customer: null },
    job: null,
    performer: { first_name: 'Test', last_name: 'Admin' },
    logger: { first_name: 'Test', last_name: 'Admin' },
    ...overrides,
  };
}

async function timelineItem(row: Record<string, unknown>) {
  mockPrisma.manualCommunicationLog.findMany.mockResolvedValue([storedRow(row)]);
  const res = await request(app)
    .get(`/api/leads/${LEAD_ID}/communications`)
    .set(authHeader('admin'));
  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(1);
  return res.body.items[0];
}

describe('a duration is a call’s duration, whatever the column happens to hold', () => {
  it('says how long a CALL lasted', async () => {
    const item = await timelineItem({ channel: 'CALL', duration_minutes: 12 });
    expect(item.title).toBe('Outbound call · 12m');
  });

  it.each([
    ['SMS', 'Outbound text'],
    ['EMAIL', 'Outbound email'],
  ])('never says a %s had a length', async (channel, expected) => {
    const item = await timelineItem({ channel, duration_minutes: 12 });
    expect(item.title).toBe(expected);
    expect(item.title).not.toContain('12m');
  });
});

describe('the fields that already followed the channel still do', () => {
  it('shows an email’s subject and not a call’s', async () => {
    expect((await timelineItem({ channel: 'EMAIL', subject: 'Revised scope' })).title).toBe(
      'Outbound email · Revised scope',
    );
    expect((await timelineItem({ channel: 'CALL', subject: 'Revised scope' })).title).toBe(
      'Outbound call',
    );
  });
});
