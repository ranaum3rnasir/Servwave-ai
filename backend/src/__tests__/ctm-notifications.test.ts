/**
 * ctm-notifications.test.ts — Slice 10ab: communication bell notifications.
 *
 * The CTM ingest layer (lib/ctm/ingest.ts) emits two verbs:
 *   - communication.call_missed    (inbound call ends missed/voicemail;
 *                                    data.call_status carries which)
 *   - communication.sms_inbound    (new inbound text)
 * (call_incoming was removed 2026-07-21 — inbound rings the cell, not the
 * app, so only the missed-call outcome is worth a bell; see the removed-verb
 * no-op test below.)
 *
 * These tests go through the REAL emit() (notificationService) with the
 * globally-mocked prisma (setup.ts), the real templates registry, the real
 * resolveRecipients, and the real filterRecipientsByAccess. 'CALL' and
 * 'MESSAGE_THREAD' are NOT row-scoped object types, so the access filter must
 * pass recipients through unchanged — asserted implicitly by the recipient
 * rows landing.
 *
 * Routing: all three verbs → every active DISPATCHER + ADMIN in the org
 * (org-wide phone coverage); SALES / TECHNICIAN are never recipients.
 * actorId is null (webhook-driven) so actor exclusion never applies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { emit } from '../services/notifications/notificationService';
import { prisma } from '../lib/prisma';

const mockPrisma = prisma as any;

const ORG_ID = 'org-1';

// Active users returned by loadRoleHolders' user.findMany
const ROLE_USERS = [
  { id: 'admin-1', role: 'ADMIN' },
  { id: 'admin-2', role: 'ADMIN' },
  { id: 'disp-1', role: 'DISPATCHER' },
  { id: 'sales-1', role: 'SALES' },
  { id: 'tech-1', role: 'TECHNICIAN' },
];

const DISPATCH_ADMIN_IDS = ['admin-1', 'admin-2', 'disp-1'].sort();

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findMany.mockResolvedValue(ROLE_USERS);
  mockPrisma.notification.findFirst.mockResolvedValue(null); // dedup guard: no existing row
  mockPrisma.notification.create.mockResolvedValue({ id: 'notif-1' });
  mockPrisma.notificationRecipient.createMany.mockResolvedValue({ count: 3 });
});

function createdNotification() {
  expect(mockPrisma.notification.create).toHaveBeenCalledOnce();
  return mockPrisma.notification.create.mock.calls[0][0].data;
}

function createdRecipients() {
  expect(mockPrisma.notificationRecipient.createMany).toHaveBeenCalledOnce();
  return mockPrisma.notificationRecipient.createMany.mock.calls[0][0].data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// communication.call_incoming — removed verb
// ═══════════════════════════════════════════════════════════════════════════════

describe('emit — communication.call_incoming (removed verb)', () => {
  it('is no longer a known verb: emit() is a silent no-op', async () => {
    await emit({
      verb: 'communication.call_incoming',
      organizationId: ORG_ID,
      actorId: null,
      object: { type: 'CALL', id: 'call-1', label: 'Acme Doors' },
      entity: {},
      data: { customer_name: 'Acme Doors', caller_number: '+15551234567' },
      dedupKey: 'ctm:SID1:incoming',
    });

    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.notificationRecipient.createMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// communication.call_missed
// ═══════════════════════════════════════════════════════════════════════════════

describe('emit — communication.call_missed', () => {
  it('creates an INTERRUPT + needs_action notification titled "Missed call — …"', async () => {
    await emit({
      verb: 'communication.call_missed',
      organizationId: ORG_ID,
      actorId: null,
      object: { type: 'CALL', id: 'call-3', label: 'Acme Doors' },
      entity: {},
      data: { customer_name: 'Acme Doors', caller_number: '+15551234567', call_status: 'missed' },
      dedupKey: 'ctm:SID3:missed',
    });

    const notif = createdNotification();
    expect(notif.category).toBe('COMMUNICATION');
    expect(notif.priority).toBe('INTERRUPT');
    expect(notif.needs_action).toBe(true);
    expect(notif.object_type).toBe('CALL');
    expect(notif.title).toBe('Missed call — Acme Doors');

    const recips = createdRecipients();
    expect(recips.map((r: any) => r.recipient_id).sort()).toEqual(DISPATCH_ADMIN_IDS);
    recips.forEach((r: any) => {
      expect(r.priority).toBe('INTERRUPT');
      expect(r.needs_action).toBe(true);
    });
  });

  it('renders the voicemail variant when data.call_status === "voicemail"', async () => {
    await emit({
      verb: 'communication.call_missed',
      organizationId: ORG_ID,
      actorId: null,
      object: { type: 'CALL', id: 'call-4', label: '+15559876543' },
      entity: {},
      data: { customer_name: null, caller_number: '+15559876543', call_status: 'voicemail' },
    });

    const notif = createdNotification();
    expect(notif.title).toBe('Voicemail — +15559876543');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// communication.sms_inbound
// ═══════════════════════════════════════════════════════════════════════════════

describe('emit — communication.sms_inbound', () => {
  it('creates a COMMUNICATION/FEED notification with the preview as body', async () => {
    await emit({
      verb: 'communication.sms_inbound',
      organizationId: ORG_ID,
      actorId: null,
      object: { type: 'MESSAGE_THREAD', id: 'thread-1', label: 'Acme Doors' },
      entity: {},
      data: { customer_name: 'Acme Doors', preview: 'Hey, can you come by tomorrow?' },
      dedupKey: 'ctm:MSG1:inbound',
    });

    const notif = createdNotification();
    expect(notif.category).toBe('COMMUNICATION');
    expect(notif.priority).toBe('FEED');
    expect(notif.object_type).toBe('MESSAGE_THREAD');
    expect(notif.object_id).toBe('thread-1');
    expect(notif.title).toBe('New text — Acme Doors');
    expect(notif.body).toBe('Hey, can you come by tomorrow?');

    const recips = createdRecipients();
    expect(recips.map((r: any) => r.recipient_id).sort()).toEqual(DISPATCH_ADMIN_IDS);
    recips.forEach((r: any) => expect(r.priority).toBe('FEED'));
  });

  it('falls back to the raw number (object label) when there is no matched customer', async () => {
    // ingest passes no caller_number for sms — object.label carries the counterpart number.
    await emit({
      verb: 'communication.sms_inbound',
      organizationId: ORG_ID,
      actorId: null,
      object: { type: 'MESSAGE_THREAD', id: 'thread-2', label: '+15550001111' },
      entity: {},
      data: { customer_name: null, preview: 'STOP' },
    });

    const notif = createdNotification();
    expect(notif.title).toBe('New text — +15550001111');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Dedup + unknown-verb regression
// ═══════════════════════════════════════════════════════════════════════════════

describe('emit — dedup + unknown verbs', () => {
  it('emitting twice with the same dedupKey creates a single notification', async () => {
    const args = {
      verb: 'communication.call_missed',
      organizationId: ORG_ID,
      actorId: null,
      object: { type: 'CALL', id: 'call-5', label: 'Acme Doors' },
      entity: {},
      data: { customer_name: 'Acme Doors', caller_number: '+15551234567', call_status: 'missed' },
      dedupKey: 'ctm:SID5:missed',
    } as const;

    mockPrisma.notification.findFirst
      .mockResolvedValueOnce(null) // first emit: no existing row
      .mockResolvedValue({ id: 'notif-1' }); // second emit: dedup hit

    await emit({ ...args });
    await emit({ ...args });

    expect(mockPrisma.notification.create).toHaveBeenCalledOnce();
  });

  it('still silently skips unknown communication verbs (regression)', async () => {
    await emit({
      verb: 'communication.call_ended',
      organizationId: ORG_ID,
      actorId: null,
      object: { type: 'CALL', id: 'call-6' },
      entity: {},
    });

    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.notificationRecipient.createMany).not.toHaveBeenCalled();
  });
});
