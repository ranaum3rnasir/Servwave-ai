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
 * resolveRecipients, and the real filterRecipientsByAccess. Since S08.21 the
 * filter judges 'CALL' and 'MESSAGE_THREAD' by the single read of the call or
 * conversation (lib/communication/conversationReaders.ts): the people it asks
 * are the recipients the verb names, and anyone who cannot read the
 * conversation is dropped. That single read has its own suites (unit and
 * real-database); here it is the one collaborator that is replaced, by an
 * answer the test gives, so what is proven is the routing and that the filter's
 * answer is the final word.
 *
 * Routing. The missed call and the voicemail (S08.22) and the inbound text
 * (S08.23): the recipients are the people the lookup (conversationAlertAudience) names (the
 * record's people, the holders of All, the people linked to the number and, for a
 * text, the person its reply is attributed to), already through the access
 * filter; no role list is read. That lookup has its own real-database suites
 * (permission-communication-call-alert-db.test.ts and
 * permission-communication-text-alert-db.test.ts); here it is replaced by an
 * answer the test gives, so what is proven is what emit does with it: the
 * weights, the dedup, and that nothing else is added. actorId is null
 * (webhook-driven) so actor exclusion never applies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { emit } from '../services/notifications/notificationService';
import { prisma } from '../lib/prisma';
import { readersOfConversation } from '../lib/communication/conversationReaders';
import { conversationAlertAudience } from '../services/notifications/conversationAlertRecipients';
import { nobodyFallbackRows } from '../services/notifications/conversationAlertFallback';

vi.mock('../lib/communication/conversationReaders', () => ({ readersOfConversation: vi.fn() }));
vi.mock('../services/notifications/conversationAlertRecipients', () => ({ conversationAlertAudience: vi.fn() }));
// The never-silent fallback has its own real-database suite (permission-communication-never-silent-alert-db.test.ts); only the
// function that reads the database is replaced, so the token it makes still has to be real for emit to accept it.
vi.mock('../services/notifications/conversationAlertFallback', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/notifications/conversationAlertFallback')>()),
  nobodyFallbackRows: vi.fn(),
}));

/** What the lookup answers: the people it names, with the call or text they were found for. */
const subject = { objectType: 'CALL', objectId: 'call-1', at: new Date(0), numberShown: '(555) 555-0142' };
const names = (people: string[]) => ({ people, subject }) as never;

const mockPrisma = prisma as any;

const ORG_ID = 'org-1';

// Active users a role-list read would return: no alert of the two verbs below reads them (the tests assert user.findMany is never called)
const ROLE_USERS = [
  { id: 'admin-1', role: 'ADMIN' },
  { id: 'admin-2', role: 'ADMIN' },
  { id: 'disp-1', role: 'DISPATCHER' },
  { id: 'sales-1', role: 'SALES' },
  { id: 'tech-1', role: 'TECHNICIAN' },
];

/** The people the lookup (conversationAlertAudience) names in these tests: no role is implied by any of them. */
const CALL_PEOPLE = ['person-a', 'person-b'];

/** Everyone the filter asks about can read the conversation, unless a test says otherwise. */
function everyoneCanRead() {
  vi.mocked(readersOfConversation).mockImplementation(async (people) => new Set(people.map((p) => p.id)));
}

beforeEach(() => {
  vi.clearAllMocks();
  everyoneCanRead();
  vi.mocked(conversationAlertAudience).mockResolvedValue(names([...CALL_PEOPLE]));
  vi.mocked(nobodyFallbackRows).mockResolvedValue([]);
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
  const missedCall = (over: Record<string, unknown> = {}) => ({
    verb: 'communication.call_missed',
    organizationId: ORG_ID,
    actorId: null,
    object: { type: 'CALL', id: 'call-3', label: 'Acme Doors' },
    entity: {},
    data: { customer_name: 'Acme Doors', caller_number: '+15551234567', call_status: 'missed' },
    dedupKey: 'ctm:SID3:missed',
    ...over,
  });

  it('creates an INTERRUPT + needs_action notification titled "Missed call — …", for the people the lookup names', async () => {
    await emit(missedCall());

    const notif = createdNotification();
    expect(notif.category).toBe('COMMUNICATION');
    expect(notif.priority).toBe('INTERRUPT');
    expect(notif.needs_action).toBe(true);
    expect(notif.object_type).toBe('CALL');
    expect(notif.title).toBe('Missed call — Acme Doors');

    const recips = createdRecipients();
    expect(recips.map((r: any) => r.recipient_id).sort()).toEqual(CALL_PEOPLE);
    recips.forEach((r: any) => {
      expect(r.priority).toBe('INTERRUPT');
      expect(r.needs_action).toBe(true);
    });
  });

  it('asks the lookup about this company and this call, and reads no role list', async () => {
    await emit(missedCall({ object: { type: 'CALL', id: 'call-7', label: 'Acme Doors' } }));

    expect(vi.mocked(conversationAlertAudience)).toHaveBeenCalledWith({ kind: 'call', organizationId: ORG_ID, callId: 'call-7' });
    // The company's people are read for the role lists of the inbound text and email alerts, and for nothing else: not here.
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('tells exactly the people the lookup names: the access filter has already been through them, and is not asked a second time', async () => {
    vi.mocked(conversationAlertAudience).mockResolvedValue(names(['person-c']));
    // Were the filter asked again, it would drop this person: the lookup's answer is final.
    vi.mocked(readersOfConversation).mockResolvedValue(new Set());

    await emit(missedCall());

    expect(createdRecipients().map((r: any) => r.recipient_id)).toEqual(['person-c']);
    expect(vi.mocked(readersOfConversation)).not.toHaveBeenCalled();
  });

  it('writes no alert at all when the lookup names nobody', async () => {
    vi.mocked(conversationAlertAudience).mockResolvedValue(names([]));

    const told = await emit(missedCall());

    expect(told).toEqual([]);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.notificationRecipient.createMany).not.toHaveBeenCalled();
  });

  it('hands the call to the never-silent fallback when the lookup names nobody, and writes nothing itself when the fallback has no one', async () => {
    vi.mocked(conversationAlertAudience).mockResolvedValue(names([]));

    await emit(missedCall());

    expect(vi.mocked(nobodyFallbackRows)).toHaveBeenCalledOnce();
    expect(vi.mocked(nobodyFallbackRows).mock.calls[0]![0]).toEqual({ kind: 'call', organizationId: ORG_ID, callId: 'call-3' });
  });

  it('does not ask the fallback when the lookup names somebody', async () => {
    await emit(missedCall());

    expect(vi.mocked(nobodyFallbackRows)).not.toHaveBeenCalled();
  });

  it('looks nobody up on a webhook retry: the dedup key is checked first', async () => {
    mockPrisma.notification.findFirst.mockResolvedValue({ id: 'notif-1' });

    await emit(missedCall());

    expect(vi.mocked(conversationAlertAudience)).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('renders the voicemail variant when data.call_status === "voicemail", for the same people', async () => {
    await emit(missedCall({
      object: { type: 'CALL', id: 'call-4', label: '+15559876543' },
      data: { customer_name: null, caller_number: '+15559876543', call_status: 'voicemail' },
    }));

    const notif = createdNotification();
    expect(notif.title).toBe('Voicemail — +15559876543');
    expect(notif.priority).toBe('INTERRUPT');
    expect(notif.needs_action).toBe(true);
    expect(createdRecipients().map((r: any) => r.recipient_id).sort()).toEqual(CALL_PEOPLE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// communication.sms_inbound
// ═══════════════════════════════════════════════════════════════════════════════

describe('emit — communication.sms_inbound', () => {
  const inboundText = (over: Record<string, unknown> = {}) => ({
    verb: 'communication.sms_inbound',
    organizationId: ORG_ID,
    actorId: null,
    object: { type: 'MESSAGE_THREAD', id: 'thread-1', label: 'Acme Doors' },
    entity: { message_id: 'msg-1' },
    data: { customer_name: 'Acme Doors', preview: 'Hey, can you come by tomorrow?' },
    dedupKey: 'ctm:MSG1:inbound',
    ...over,
  });

  it('creates a COMMUNICATION/FEED notification with the preview as body, for the people the lookup names', async () => {
    await emit(inboundText());

    const notif = createdNotification();
    expect(notif.category).toBe('COMMUNICATION');
    // Today's weight, unchanged: a feed item that asks for nothing.
    expect(notif.priority).toBe('FEED');
    expect(notif.needs_action).toBe(false);
    expect(notif.object_type).toBe('MESSAGE_THREAD');
    expect(notif.object_id).toBe('thread-1');
    expect(notif.title).toBe('New text — Acme Doors');
    expect(notif.body).toBe('Hey, can you come by tomorrow?');

    const recips = createdRecipients();
    expect(recips.map((r: any) => r.recipient_id).sort()).toEqual(CALL_PEOPLE);
    recips.forEach((r: any) => {
      expect(r.priority).toBe('FEED');
      expect(r.needs_action).toBe(false);
    });
  });

  it('asks the lookup about this company, this conversation and this text, and reads no role list', async () => {
    await emit(inboundText());

    expect(vi.mocked(conversationAlertAudience)).toHaveBeenCalledWith({
      kind: 'text', organizationId: ORG_ID, threadId: 'thread-1', messageId: 'msg-1',
    });
    // The company's people are read for the inbound email alert's role list, and for nothing else: not here.
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it('names no text when the caller names none: the lookup then takes the conversation\'s latest inbound text', async () => {
    await emit(inboundText({ entity: {} }));

    expect(vi.mocked(conversationAlertAudience)).toHaveBeenCalledWith({
      kind: 'text', organizationId: ORG_ID, threadId: 'thread-1', messageId: null,
    });
  });

  it('tells exactly the people the lookup names, and the preview is stored only with them: the filter was already run', async () => {
    vi.mocked(conversationAlertAudience).mockResolvedValue(names(['person-c']));
    // Were the filter asked again, it would drop this person: the lookup's answer is final.
    vi.mocked(readersOfConversation).mockResolvedValue(new Set());

    await emit(inboundText({ object: { type: 'MESSAGE_THREAD', id: 'thread-3', label: 'Acme Doors' }, data: { customer_name: 'Acme Doors', preview: 'Gate code is 4412' } }));

    expect(createdRecipients().map((r: any) => r.recipient_id)).toEqual(['person-c']);
    expect(vi.mocked(readersOfConversation)).not.toHaveBeenCalled();
  });

  it('writes no alert, and so stores no preview, when the lookup names nobody', async () => {
    vi.mocked(conversationAlertAudience).mockResolvedValue(names([]));

    const told = await emit(inboundText({ data: { customer_name: 'Acme Doors', preview: 'Gate code is 4412' } }));

    expect(told).toEqual([]);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.notificationRecipient.createMany).not.toHaveBeenCalled();
  });

  it('hands the text to the never-silent fallback when the lookup names nobody', async () => {
    vi.mocked(conversationAlertAudience).mockResolvedValue(names([]));

    await emit(inboundText());

    expect(vi.mocked(nobodyFallbackRows)).toHaveBeenCalledOnce();
    expect(vi.mocked(nobodyFallbackRows).mock.calls[0]![0]).toMatchObject({ kind: 'text', organizationId: ORG_ID });
  });

  it('looks nobody up on a webhook retry: the dedup key is checked first', async () => {
    mockPrisma.notification.findFirst.mockResolvedValue({ id: 'notif-1' });

    await emit(inboundText());

    expect(vi.mocked(conversationAlertAudience)).not.toHaveBeenCalled();
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('falls back to the raw number (object label) when there is no matched customer', async () => {
    // ingest passes no caller_number for sms — object.label carries the counterpart number.
    await emit(inboundText({
      object: { type: 'MESSAGE_THREAD', id: 'thread-2', label: '+15550001111' },
      data: { customer_name: null, preview: 'STOP' },
    }));

    const notif = createdNotification();
    expect(notif.title).toBe('New text — +15550001111');
  });

  it('says only who texted for a text with no words: no body line', async () => {
    await emit(inboundText({ data: { customer_name: 'Acme Doors', preview: '' } }));

    const notif = createdNotification();
    expect(notif.title).toBe('New text — Acme Doors');
    expect(notif.body).toBeNull();
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
