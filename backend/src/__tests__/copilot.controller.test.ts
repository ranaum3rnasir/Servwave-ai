import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';
import { copilotRateLimiter } from '../services/copilot/rate-limit';
import { SAFE_FALLBACK } from '../services/copilot/safety';
import { generateReply, transcribeAudio, GeminiNotConfiguredError } from '../services/copilot/gemini-generate';

// Mock the Gemini generate service so the controller's behaviour (text /
// function-call passthrough / contradiction fallback / 503) is tested without
// the network. importOriginal keeps GeminiNotConfiguredError real so the
// controller's `instanceof` check still works.
vi.mock('../services/copilot/gemini-generate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/copilot/gemini-generate')>();
  return { ...actual, generateReply: vi.fn(), transcribeAudio: vi.fn() };
});
const mockGenerate = vi.mocked(generateReply);
const mockTranscribe = vi.mocked(transcribeAudio);

const mockPrisma = prisma as unknown as {
  copilotConversation: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  copilotMessage: { create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  copilotAuditEvent: { create: ReturnType<typeof vi.fn> };
};

// A conversation owned by the ALPHA admin — the tenant-attack tests prove org B
// can never read or mutate it.
const ALPHA_CONVO_ID = 'aa000000-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  copilotRateLimiter.reset();
  // Default-resolve the copilot mocks so the controllers' chained .catch()/await
  // calls never hit `undefined.catch`.
  mockPrisma.copilotAuditEvent.create.mockResolvedValue({});
  mockPrisma.copilotConversation.update.mockResolvedValue({});
});

describe('POST /api/copilot/generate', () => {
  const userTurn = { contents: [{ role: 'user', parts: [{ text: 'how many jobs today?' }] }] };

  beforeEach(() => {
    mockGenerate.mockResolvedValue({ text: 'You have 4 jobs today.', functionCalls: [] });
  });

  it('returns the model reply for an authed user', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/copilot/generate').set(authHeader('admin')).send(userTurn);
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('You have 4 jobs today.');
    expect(res.body.fallback).toBe(false);
    // The server builds the persona itself; the client never supplies it.
    const arg = mockGenerate.mock.calls[0][0];
    expect(arg.systemInstruction).toContain('Servy');
  });

  it('passes through the function calls the model wants to run', async () => {
    mockAuthAs('admin');
    mockGenerate.mockResolvedValue({ text: '', functionCalls: [{ name: 'query_crm', args: { resource: 'jobs' } }] });
    const res = await request(app).post('/api/copilot/generate').set(authHeader('admin')).send(userTurn);
    expect(res.status).toBe(200);
    expect(res.body.functionCalls).toHaveLength(1);
    expect(res.body.functionCalls[0].name).toBe('query_crm');
  });

  it('swaps a contradicting reply for the safe fallback and drops function calls', async () => {
    mockAuthAs('admin');
    mockGenerate.mockResolvedValue({ text: "I've sent the invoice email to the customer.", functionCalls: [{ name: 'create_lead' }] });
    const res = await request(app).post('/api/copilot/generate').set(authHeader('admin')).send(userTurn);
    expect(res.status).toBe(200);
    expect(res.body.fallback).toBe(true);
    expect(res.body.text).toBe(SAFE_FALLBACK);
    expect(res.body.functionCalls).toEqual([]);
    expect(mockPrisma.copilotAuditEvent.create).toHaveBeenCalled();
  });

  it('rate-limits a fresh user turn (429)', async () => {
    mockAuthAs('admin');
    vi.spyOn(copilotRateLimiter, 'tryConsume').mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await request(app).post('/api/copilot/generate').set(authHeader('admin')).send(userTurn);
    expect(res.status).toBe(429);
  });

  it('does NOT rate-limit tool-result continuation rounds', async () => {
    mockAuthAs('admin');
    const spy = vi.spyOn(copilotRateLimiter, 'tryConsume');
    const continuation = {
      contents: [
        { role: 'user', parts: [{ text: 'jobs?' }] },
        { role: 'model', parts: [{ functionCall: { name: 'query_crm', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'query_crm', response: { output: '4 jobs' } } }] },
      ],
    };
    const res = await request(app).post('/api/copilot/generate').set(authHeader('admin')).send(continuation);
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 503 when GEMINI_API_KEY is not configured', async () => {
    mockAuthAs('admin');
    mockGenerate.mockRejectedValueOnce(new GeminiNotConfiguredError());
    const res = await request(app).post('/api/copilot/generate').set(authHeader('admin')).send(userTurn);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/copilot/generate').send(userTurn);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/copilot/transcribe', () => {
  // ~"RIFF…" — any base64 ≥100 chars passes the schema; content is opaque here.
  const clip = { audio: 'UklGR'.repeat(40), mime_type: 'audio/wav', locale: 'en-US' };

  beforeEach(() => {
    mockTranscribe.mockResolvedValue('create a lead for Jane Doe');
  });

  it('returns the transcript for an authed user', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/copilot/transcribe').set(authHeader('admin')).send(clip);
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('create a lead for Jane Doe');
    const arg = mockTranscribe.mock.calls[0][0];
    expect(arg.mimeType).toBe('audio/wav');
    expect(arg.locale).toBe('en-US');
  });

  it('consumes the shared rate bucket (429 when empty)', async () => {
    mockAuthAs('admin');
    vi.spyOn(copilotRateLimiter, 'tryConsume').mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await request(app).post('/api/copilot/transcribe').set(authHeader('admin')).send(clip);
    expect(res.status).toBe(429);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it('returns 503 when GEMINI_API_KEY is not configured', async () => {
    mockAuthAs('admin');
    mockTranscribe.mockRejectedValueOnce(new GeminiNotConfiguredError());
    const res = await request(app).post('/api/copilot/transcribe').set(authHeader('admin')).send(clip);
    expect(res.status).toBe(503);
  });

  it('returns 502 on a Gemini failure', async () => {
    mockAuthAs('admin');
    mockTranscribe.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app).post('/api/copilot/transcribe').set(authHeader('admin')).send(clip);
    expect(res.status).toBe(502);
  });

  it('rejects bad payloads (audio too short / bad mime)', async () => {
    mockAuthAs('admin');
    const tooShort = await request(app).post('/api/copilot/transcribe').set(authHeader('admin')).send({ audio: 'abc' });
    expect(tooShort.status).toBe(400);
    const badMime = await request(app)
      .post('/api/copilot/transcribe')
      .set(authHeader('admin'))
      .send({ ...clip, mime_type: 'audio/x-evil' });
    expect(badMime.status).toBe(400);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/api/copilot/transcribe').send(clip);
    expect(res.status).toBe(401);
  });
});

describe('Copilot conversations CRUD', () => {
  it('creates a conversation scoped to the org + user', async () => {
    mockAuthAs('admin');
    mockPrisma.copilotConversation.create.mockResolvedValue({
      id: ALPHA_CONVO_ID,
      title: 'Morning briefing',
      created_at: new Date(),
      updated_at: new Date(),
    });
    const res = await request(app)
      .post('/api/copilot/conversations')
      .set(authHeader('admin'))
      .send({ title: 'Morning briefing' });
    expect(res.status).toBe(201);
    expect(res.body.conversation.id).toBe(ALPHA_CONVO_ID);
    const createArg = mockPrisma.copilotConversation.create.mock.calls[0][0];
    expect(createArg.data.organization_id).toBe(ALPHA_ORG_ID);
    expect(createArg.data.user_id).toBe(TEST_USERS.admin.id);
  });

  it('lists only the calling user\'s conversations', async () => {
    mockAuthAs('admin');
    mockPrisma.copilotConversation.findMany.mockResolvedValue([
      { id: ALPHA_CONVO_ID, title: 'x', created_at: new Date(), updated_at: new Date() },
    ]);
    const res = await request(app).get('/api/copilot/conversations').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    const whereArg = mockPrisma.copilotConversation.findMany.mock.calls[0][0].where;
    expect(whereArg.organization_id).toBe(ALPHA_ORG_ID);
    expect(whereArg.user_id).toBe(TEST_USERS.admin.id);
  });

  it('gets a conversation the user owns', async () => {
    mockAuthAs('admin');
    mockPrisma.copilotConversation.findFirst.mockImplementation((args: { where: { organization_id: string; user_id: string } }) =>
      args.where.organization_id === ALPHA_ORG_ID && args.where.user_id === TEST_USERS.admin.id
        ? Promise.resolve({ id: ALPHA_CONVO_ID, title: 'x', messages: [] })
        : Promise.resolve(null),
    );
    const res = await request(app).get(`/api/copilot/conversations/${ALPHA_CONVO_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.conversation.id).toBe(ALPHA_CONVO_ID);
  });
});

describe('Copilot tenant isolation (cross-org attack)', () => {
  // org B's admin tries to touch ALPHA's conversation. The org+user filter in
  // findFirst makes it return null → 404, and no mutation runs.
  beforeEach(() => {
    mockPrisma.copilotConversation.findFirst.mockImplementation((args: { where: { organization_id: string; user_id: string } }) =>
      args.where.organization_id === ALPHA_ORG_ID && args.where.user_id === TEST_USERS.admin.id
        ? Promise.resolve({ id: ALPHA_CONVO_ID, title: 'x', messages: [] })
        : Promise.resolve(null),
    );
  });

  it('cannot READ another org\'s conversation (404)', async () => {
    mockAuthAs('orgB_admin');
    const res = await request(app).get(`/api/copilot/conversations/${ALPHA_CONVO_ID}`).set(authHeader('orgB_admin'));
    expect(res.status).toBe(404);
  });

  it('cannot DELETE another org\'s conversation (404, no delete call)', async () => {
    mockAuthAs('orgB_admin');
    const res = await request(app).delete(`/api/copilot/conversations/${ALPHA_CONVO_ID}`).set(authHeader('orgB_admin'));
    expect(res.status).toBe(404);
    expect(mockPrisma.copilotConversation.delete).not.toHaveBeenCalled();
  });

  it('cannot append a turn to another org\'s conversation (404, no message created)', async () => {
    mockAuthAs('orgB_admin');
    const res = await request(app)
      .post('/api/copilot/turns')
      .set(authHeader('orgB_admin'))
      .send({ conversation_id: ALPHA_CONVO_ID, role: 'USER', modality: 'TEXT', content: 'hi' });
    expect(res.status).toBe(404);
    expect(mockPrisma.copilotMessage.create).not.toHaveBeenCalled();
  });

  it('the owner CAN delete their own conversation', async () => {
    mockAuthAs('admin');
    mockPrisma.copilotConversation.delete.mockResolvedValue({ id: ALPHA_CONVO_ID });
    const res = await request(app).delete(`/api/copilot/conversations/${ALPHA_CONVO_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.copilotConversation.delete).toHaveBeenCalledWith({ where: { id: ALPHA_CONVO_ID } });
  });
});

describe('POST /api/copilot/turns (persistence + contradiction detector)', () => {
  beforeEach(() => {
    mockPrisma.copilotConversation.findFirst.mockResolvedValue({ id: ALPHA_CONVO_ID });
  });

  it('persists a normal assistant turn unchanged', async () => {
    mockAuthAs('admin');
    mockPrisma.copilotMessage.create.mockImplementation((args: { data: { content: string; status: string } }) =>
      Promise.resolve({ id: 'm1', role: 'ASSISTANT', modality: 'TEXT', content: args.data.content, status: args.data.status, created_at: new Date() }),
    );
    const res = await request(app)
      .post('/api/copilot/turns')
      .set(authHeader('admin'))
      .send({ conversation_id: ALPHA_CONVO_ID, role: 'ASSISTANT', modality: 'TEXT', content: 'You have 4 jobs today.' });
    expect(res.status).toBe(201);
    expect(res.body.fallback).toBe(false);
    expect(res.body.message.content).toBe('You have 4 jobs today.');
  });

  it('replaces a contradicting assistant turn with the safe fallback + logs an audit event', async () => {
    mockAuthAs('admin');
    mockPrisma.copilotMessage.create.mockImplementation((args: { data: { content: string; status: string } }) =>
      Promise.resolve({ id: 'm2', role: 'ASSISTANT', modality: 'VOICE', content: args.data.content, status: args.data.status, created_at: new Date() }),
    );
    const res = await request(app)
      .post('/api/copilot/turns')
      .set(authHeader('admin'))
      .send({ conversation_id: ALPHA_CONVO_ID, role: 'ASSISTANT', modality: 'VOICE', content: "I've sent the invoice email to the customer." });
    expect(res.status).toBe(201);
    expect(res.body.fallback).toBe(true);
    expect(res.body.message.content).toBe(SAFE_FALLBACK);
    expect(res.body.message.status).toBe('FALLBACK');
    expect(mockPrisma.copilotAuditEvent.create).toHaveBeenCalled();
  });

  it('does NOT run the detector on user turns', async () => {
    mockAuthAs('admin');
    mockPrisma.copilotMessage.create.mockImplementation((args: { data: { content: string; status: string } }) =>
      Promise.resolve({ id: 'm3', role: 'USER', modality: 'TEXT', content: args.data.content, status: args.data.status, created_at: new Date() }),
    );
    const res = await request(app)
      .post('/api/copilot/turns')
      .set(authHeader('admin'))
      .send({ conversation_id: ALPHA_CONVO_ID, role: 'USER', modality: 'TEXT', content: 'I sent the email' });
    expect(res.status).toBe(201);
    expect(res.body.fallback).toBe(false);
    expect(res.body.message.content).toBe('I sent the email');
  });
});

describe('POST /api/copilot/feedback', () => {
  it('records thumbs feedback on the user\'s own message', async () => {
    mockAuthAs('admin');
    mockPrisma.copilotMessage.updateMany.mockResolvedValue({ count: 1 });
    const res = await request(app)
      .post('/api/copilot/feedback')
      .set(authHeader('admin'))
      .send({ message_id: '11111111-1111-1111-1111-111111111111', value: 'UP' });
    expect(res.status).toBe(200);
    const whereArg = mockPrisma.copilotMessage.updateMany.mock.calls[0][0].where;
    expect(whereArg.organization_id).toBe(ALPHA_ORG_ID);
    expect(whereArg.user_id).toBe(TEST_USERS.admin.id);
  });

  it('404s when the message is not the user\'s (or not found)', async () => {
    mockAuthAs('admin');
    mockPrisma.copilotMessage.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(app)
      .post('/api/copilot/feedback')
      .set(authHeader('admin'))
      .send({ message_id: '22222222-2222-2222-2222-222222222222', value: 'DOWN' });
    expect(res.status).toBe(404);
  });
});
