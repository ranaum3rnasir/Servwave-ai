import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { copilotRateLimiter } from '../services/copilot/rate-limit';
import { mintLiveToken } from '../services/copilot/gemini-token';
import { GeminiNotConfiguredError } from '../services/copilot/gemini-generate';
import { buildVoiceInstruction } from '../services/copilot/persona';

// Mock the ephemeral-token mint so the endpoint is tested without the network /
// real GEMINI_API_KEY. The controller's `instanceof GeminiNotConfiguredError`
// 503 branch is exercised by making the mock throw the real error class.
vi.mock('../services/copilot/gemini-token', () => ({ mintLiveToken: vi.fn() }));
const mockMint = vi.mocked(mintLiveToken);

const mockPrisma = prisma as unknown as {
  organization: { findFirst: ReturnType<typeof vi.fn> };
  copilotAuditEvent: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  copilotRateLimiter.reset();
  mockPrisma.copilotAuditEvent.create.mockResolvedValue({});
  mockPrisma.organization.findFirst.mockResolvedValue({ name: 'Alpha HVAC', timezone: 'America/New_York' });
});

describe('POST /api/copilot/token (Gemini Live)', () => {
  it('mints a token and returns the slim voice persona for an authed user', async () => {
    mockAuthAs('admin');
    mockMint.mockResolvedValue({ token: 'auth_tokens/abc123', expireTime: '2026-06-12T23:00:00.000Z' });

    const res = await request(app).post('/api/copilot/token').set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('auth_tokens/abc123');
    expect(typeof res.body.model).toBe('string');
    expect(res.body.model.length).toBeGreaterThan(0);
    expect(typeof res.body.voiceName).toBe('string');
    // The persona is built server-side and instructs the voice to delegate.
    expect(res.body.systemInstruction).toContain('ask_servy');
  });

  it('re-injects the recent transcript into the voice persona for memory', async () => {
    mockAuthAs('admin');
    mockMint.mockResolvedValue({ token: 'auth_tokens/abc', expireTime: '2026-06-12T23:00:00.000Z' });

    const res = await request(app)
      .post('/api/copilot/token')
      .set(authHeader('admin'))
      .send({ recent_turns: [{ role: 'user', text: 'show me lead L00042' }] });

    expect(res.status).toBe(200);
    expect(res.body.systemInstruction).toContain('L00042');
  });

  it('returns 503 when voice is not configured (no GEMINI_API_KEY)', async () => {
    mockAuthAs('admin');
    mockMint.mockRejectedValue(new GeminiNotConfiguredError());

    const res = await request(app).post('/api/copilot/token').set(authHeader('admin')).send({});

    expect(res.status).toBe(503);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/copilot/token').send({});
    expect(res.status).toBe(401);
  });
});

describe('buildVoiceInstruction', () => {
  it('forces every CRM question through ask_servy and forbids answering from memory', () => {
    const text = buildVoiceInstruction({ userName: 'Art', role: 'ADMIN', orgName: 'Alpha HVAC' });
    expect(text).toContain('ask_servy');
    expect(text).toMatch(/never answer.*from your own memory/i);
    expect(text).toContain('Servy');
  });

  it('folds recent turns in as cross-reconnect memory', () => {
    const text = buildVoiceInstruction({
      recentTurns: [
        { role: 'user', text: 'schedule a job for Dana' },
        { role: 'assistant', text: 'Done — created J00012.' },
      ],
    });
    expect(text).toContain('schedule a job for Dana');
    expect(text).toContain('J00012');
  });
});
