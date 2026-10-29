import { Request, Response } from 'express';
import { z } from 'zod';
import { CopilotMsgStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { transcribeAudio, GeminiNotConfiguredError, type GeminiContent } from '../services/copilot/gemini-generate';
import { generateReply, isBrainNotConfigured, isBrainQuotaError } from '../services/copilot/brain';
import { buildSystemInstruction, buildVoiceInstruction, type RecentTurn } from '../services/copilot/persona';
import { mintLiveToken } from '../services/copilot/gemini-token';
import { copilotRateLimiter, rateKey } from '../services/copilot/rate-limit';
import { detectContradiction, SAFE_FALLBACK } from '../services/copilot/safety';
import { env } from '../config/env';

// ─── Validation schemas (exported for the validate() middleware) ───

export const generateRequestSchema = z.object({
  // The Gemini conversation. Parts are passed through verbatim (text /
  // functionCall / functionResponse); the SDK validates their shape.
  contents: z
    .array(z.object({ role: z.string().max(20), parts: z.array(z.any()).max(50) }))
    .min(1)
    .max(100),
  // Function declarations the browser built from the user's CASL ability. Not
  // trusted for authorization — every tool still runs through the gated /api/*.
  tools: z.array(z.any()).max(5).optional(),
  locale: z.string().max(10).optional(),
});

export const transcribeRequestSchema = z.object({
  // Base64 audio from the browser recorder (16 kHz mono WAV ≈ 43 KB/s of
  // base64). 6M chars ≈ 4.5 MB ≈ a generous 30+ second utterance.
  audio: z.string().min(100).max(6_000_000),
  mime_type: z.enum(['audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4']).default('audio/wav'),
  locale: z.string().max(10).optional(),
});

export const liveTokenSchema = z.object({
  // The browser's recent transcript, re-injected into the voice persona so the
  // stateless Live session has cross-reconnect memory. Content-bounded; never
  // trusted for anything but prompt context.
  recent_turns: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(2000) }))
    .max(20)
    .optional(),
  locale: z.string().max(10).optional(),
});

export const createConversationSchema = z.object({
  title: z.string().max(200).optional(),
});

export const appendTurnSchema = z.object({
  conversation_id: z.string().uuid(),
  role: z.enum(['USER', 'ASSISTANT']),
  modality: z.enum(['TEXT', 'VOICE']),
  content: z.string().min(1).max(20000),
  status: z.enum(['FINAL', 'STOPPED', 'FALLBACK']).optional(),
  label_key: z.string().max(100).optional(),
  capability_id: z.string().max(100).optional(),
  execution_mode: z.string().max(50).optional(),
  meta: z.record(z.any()).optional(),
});

export const feedbackSchema = z.object({
  message_id: z.string().uuid(),
  value: z.enum(['UP', 'DOWN']),
});

// ─── Audit helper (content-free; never blocks the request) ───

async function recordAudit(
  req: Request,
  event_type: string,
  allowed: boolean,
  extra?: { capability_id?: string; execution_mode?: string; reason?: string },
): Promise<void> {
  try {
    await prisma.copilotAuditEvent.create({
      data: {
        organization_id: req.user!.organization_id,
        user_id: req.user!.id,
        event_type,
        allowed,
        capability_id: extra?.capability_id ?? null,
        execution_mode: extra?.execution_mode ?? null,
        reason: extra?.reason ?? null,
      },
    });
  } catch (err) {
    logger.error('Copilot audit write failed:', err);
  }
}

// ─── POST /api/copilot/generate ───
// The browser sends the running conversation (Gemini `contents`) + the tool
// declarations the user is allowed to use. We add the server-owned persona and
// the API key, call Gemini, run the contradiction detector on the reply, and
// return the text + any function calls for the browser to execute (gated again
// at the underlying /api/*). Voice (STT/TTS) happens entirely in the browser.
export async function generate(req: Request, res: Response) {
  const userId = req.user!.id;
  const orgId = req.user!.organization_id;
  const contents = (req.body.contents ?? []) as GeminiContent[];

  // Rate-limit only fresh user turns, not the tool-result continuation rounds:
  // one spoken request can fan out into several generate calls as the model
  // reads data, and those shouldn't drain the bucket.
  if (!isToolContinuation(contents)) {
    const limit = copilotRateLimiter.tryConsume(rateKey(orgId, userId));
    if (!limit.allowed) {
      await recordAudit(req, 'rate_limited', false, { reason: 'token bucket empty' });
      res.setHeader('Retry-After', Math.ceil(limit.retryAfterMs / 1000).toString());
      res.status(429).json({ error: 'Too many copilot messages, please slow down', retryAfterMs: limit.retryAfterMs });
      return;
    }
  }

  try {
    const org = await prisma.organization
      .findFirst({ where: { id: orgId }, select: { name: true, timezone: true } })
      .catch(() => null);

    const systemInstruction = buildSystemInstruction({
      orgName: (org as { name?: string } | null)?.name ?? null,
      userName: `${req.user!.first_name} ${req.user!.last_name}`.trim(),
      role: req.user!.role,
      locale: req.body?.locale ?? null,
      now: new Date(),
      timezone: (org as { timezone?: string } | null)?.timezone ?? null,
    });

    const result = await generateReply({ contents, tools: req.body.tools, systemInstruction });

    // Safety backstop: never let the model CLAIM it sent/deleted something. If
    // the reply text trips the detector, swap to the safe fallback and drop any
    // function calls — we will not act on a tripped response.
    const check = detectContradiction(result.text);
    if (check.tripped) {
      await recordAudit(req, 'contradiction_fallback', false, { reason: check.reason });
      res.json({ text: SAFE_FALLBACK, functionCalls: [], fallback: true });
      return;
    }

    await recordAudit(req, 'generate', true, {
      execution_mode: result.functionCalls.length ? 'tool_call' : 'text',
    });
    res.json({ text: result.text, functionCalls: result.functionCalls, fallback: false });
  } catch (err) {
    if (isBrainNotConfigured(err)) {
      await recordAudit(req, 'not_configured', false, { reason: 'brain provider key missing' });
      res.status(503).json({ error: 'Copilot is not configured yet. Add the AI provider key to enable Servy.' });
      return;
    }
    if (isBrainQuotaError(err)) {
      logger.warn('Copilot generate hit the AI provider free-tier quota');
      res.status(429).json({ error: "Servy hit the AI provider's free usage limit — wait a minute and try again." });
      return;
    }
    // Never log the raw upstream provider body (CodexApiError.body can echo request
    // fragments / secrets). Log only the shape we control (F-58).
    logger.error('Copilot generate failed', {
      name: (err as Error)?.name,
      message: (err as Error)?.message,
      status: (err as { status?: number })?.status,
    });
    res.status(502).json({ error: 'Servy could not respond just now. Please try again.' });
  }
}

// The SDK surfaces provider quota exhaustion as an ApiError with status 429
// (RESOURCE_EXHAUSTED). Distinguish it from our own rate bucket so the user
// gets an honest "AI quota" message instead of "check your connection".
function isGeminiQuotaError(err: unknown): boolean {
  return (err as { status?: number })?.status === 429;
}

// ─── POST /api/copilot/transcribe ───
// Speech-to-text for the voice mode: the browser records a WAV turn and posts
// it here; Gemini transcribes it with the server key. Counts against the same
// rate bucket as a fresh turn (it IS a Gemini call).
export async function transcribe(req: Request, res: Response) {
  const userId = req.user!.id;
  const orgId = req.user!.organization_id;

  const limit = copilotRateLimiter.tryConsume(rateKey(orgId, userId));
  if (!limit.allowed) {
    await recordAudit(req, 'rate_limited', false, { reason: 'token bucket empty (transcribe)' });
    res.setHeader('Retry-After', Math.ceil(limit.retryAfterMs / 1000).toString());
    res.status(429).json({ error: 'Too many copilot messages, please slow down', retryAfterMs: limit.retryAfterMs });
    return;
  }

  try {
    const text = await transcribeAudio({
      audioBase64: req.body.audio,
      mimeType: req.body.mime_type ?? 'audio/wav',
      locale: req.body.locale ?? null,
    });
    await recordAudit(req, 'transcribe', true);
    res.json({ text });
  } catch (err) {
    if (err instanceof GeminiNotConfiguredError) {
      await recordAudit(req, 'not_configured', false, { reason: 'GEMINI_API_KEY missing' });
      res.status(503).json({ error: 'Copilot is not configured yet. Add a GEMINI_API_KEY to enable Servy.' });
      return;
    }
    if (isGeminiQuotaError(err)) {
      logger.warn('Copilot transcribe hit the Gemini free-tier quota');
      res.status(429).json({ error: "Servy hit the AI provider's free usage limit — wait a minute and try again." });
      return;
    }
    logger.error('Copilot transcribe failed:', err);
    res.status(502).json({ error: 'Servy could not hear that. Please try again.' });
  }
}

// ─── POST /api/copilot/token ───
// Mints a single-use ephemeral token for the browser's Gemini Live voice
// session and returns the slim voice persona + model + voice. The GEMINI_API_KEY
// never leaves the server; the browser connects to Gemini Live directly with the
// token. The Live model is only the "mouth" — it calls ask_servy for every CRM
// question/action, which routes back through /api/copilot/generate (the brain).
export async function liveToken(req: Request, res: Response) {
  const userId = req.user!.id;
  const orgId = req.user!.organization_id;

  // Starting a voice session counts as one fresh turn against the bucket
  // (reconnect storms shouldn't be free); the in-session turns are WebSocket
  // messages that never touch this endpoint.
  const limit = copilotRateLimiter.tryConsume(rateKey(orgId, userId));
  if (!limit.allowed) {
    await recordAudit(req, 'rate_limited', false, { reason: 'token bucket empty (live token)' });
    res.setHeader('Retry-After', Math.ceil(limit.retryAfterMs / 1000).toString());
    res.status(429).json({ error: 'Too many copilot messages, please slow down', retryAfterMs: limit.retryAfterMs });
    return;
  }

  try {
    const org = await prisma.organization
      .findFirst({ where: { id: orgId }, select: { name: true, timezone: true } })
      .catch(() => null);

    const systemInstruction = buildVoiceInstruction({
      orgName: (org as { name?: string } | null)?.name ?? null,
      userName: `${req.user!.first_name} ${req.user!.last_name}`.trim(),
      role: req.user!.role,
      locale: req.body?.locale ?? null,
      recentTurns: (req.body?.recent_turns ?? []) as RecentTurn[],
      now: new Date(),
      timezone: (org as { timezone?: string } | null)?.timezone ?? null,
    });

    const { token, expireTime } = await mintLiveToken();
    await recordAudit(req, 'live_token', true);
    res.json({
      token,
      expireTime,
      model: env.GEMINI_LIVE_MODEL,
      voiceName: env.COPILOT_VOICE_NAME,
      systemInstruction,
    });
  } catch (err) {
    if (err instanceof GeminiNotConfiguredError) {
      await recordAudit(req, 'not_configured', false, { reason: 'GEMINI_API_KEY missing (live token)' });
      res.status(503).json({ error: 'Voice is not configured yet. Add a GEMINI_API_KEY to enable Servy voice.' });
      return;
    }
    if (isGeminiQuotaError(err)) {
      logger.warn('Copilot live-token mint hit the Gemini quota');
      res.status(429).json({ error: "Servy voice hit the AI provider's usage limit — wait a minute and try again." });
      return;
    }
    logger.error('Copilot live-token mint failed:', err);
    res.status(502).json({ error: 'Servy could not start a voice session just now. Please try again.' });
  }
}

// A continuation round is one whose last content carries function responses
// (the browser feeding tool results back) rather than a fresh user message.
function isToolContinuation(contents: GeminiContent[]): boolean {
  const last = contents[contents.length - 1];
  if (!last || last.role === 'model') return false;
  const parts = Array.isArray(last.parts) ? last.parts : [];
  return parts.some((p) => p !== null && typeof p === 'object' && 'functionResponse' in (p as object));
}

// ─── Conversations CRUD (org + user scoped; user-private) ───

export async function listConversations(req: Request, res: Response) {
  try {
    const conversations = await prisma.copilotConversation.findMany({
      where: { ...tenantWhere(req), user_id: req.user!.id },
      orderBy: { updated_at: 'desc' },
      select: { id: true, title: true, created_at: true, updated_at: true },
    });
    res.json({ conversations });
  } catch (err) {
    logger.error('Copilot listConversations failed:', err);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
}

export async function createConversation(req: Request, res: Response) {
  try {
    const conversation = await prisma.copilotConversation.create({
      data: {
        organization_id: req.user!.organization_id,
        user_id: req.user!.id,
        title: req.body.title ?? null,
      },
      select: { id: true, title: true, created_at: true, updated_at: true },
    });
    res.status(201).json({ conversation });
  } catch (err) {
    logger.error('Copilot createConversation failed:', err);
    res.status(500).json({ error: 'Failed to create conversation' });
  }
}

export async function getConversation(req: Request, res: Response) {
  try {
    const conversation = await prisma.copilotConversation.findFirst({
      where: { id: String(req.params.id), ...tenantWhere(req), user_id: req.user!.id },
      include: {
        messages: {
          orderBy: { created_at: 'asc' },
          select: {
            id: true,
            role: true,
            modality: true,
            content: true,
            status: true,
            label_key: true,
            capability_id: true,
            feedback: true,
            created_at: true,
          },
        },
      },
    });
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json({ conversation });
  } catch (err) {
    logger.error('Copilot getConversation failed:', err);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
}

export async function deleteConversation(req: Request, res: Response) {
  try {
    // Guard tenancy + ownership BEFORE deleting (findFirst with the org+user filter
    // returns null for a foreign conversation → 404, never a cross-tenant delete).
    const existing = await prisma.copilotConversation.findFirst({
      where: { id: String(req.params.id), ...tenantWhere(req), user_id: req.user!.id },
      select: { id: true },
    });
    if (!existing) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    // Hard delete (messages cascade). The content-free audit trail survives.
    await prisma.copilotConversation.delete({ where: { id: existing.id } });
    await recordAudit(req, 'conversation_deleted', true);
    res.json({ success: true });
  } catch (err) {
    logger.error('Copilot deleteConversation failed:', err);
    res.status(500).json({ error: 'Failed to delete conversation' });
  }
}

// ─── POST /api/copilot/turns ───
// Persists a committed turn; runs the contradiction detector on assistant turns.
export async function appendTurn(req: Request, res: Response) {
  try {
    const conversation = await prisma.copilotConversation.findFirst({
      where: { id: req.body.conversation_id, ...tenantWhere(req), user_id: req.user!.id },
      select: { id: true },
    });
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    let content: string = req.body.content;
    let status: CopilotMsgStatus = (req.body.status ?? 'FINAL') as CopilotMsgStatus;
    let fallback = false;
    let contradictionReason: string | undefined;

    if (req.body.role === 'ASSISTANT') {
      const check = detectContradiction(content);
      if (check.tripped) {
        content = SAFE_FALLBACK;
        status = 'FALLBACK';
        fallback = true;
        contradictionReason = check.reason;
        await recordAudit(req, 'contradiction_fallback', false, {
          capability_id: req.body.capability_id,
          execution_mode: req.body.execution_mode,
          reason: check.reason,
        });
      }
    }

    const message = await prisma.copilotMessage.create({
      data: {
        conversation_id: conversation.id,
        organization_id: req.user!.organization_id,
        user_id: req.user!.id,
        role: req.body.role,
        modality: req.body.modality,
        content,
        status,
        label_key: req.body.label_key ?? null,
        capability_id: req.body.capability_id ?? null,
        execution_mode: req.body.execution_mode ?? null,
        meta: req.body.meta ?? undefined,
      },
      select: {
        id: true,
        role: true,
        modality: true,
        content: true,
        status: true,
        label_key: true,
        created_at: true,
      },
    });

    // Touch the conversation so it sorts to the top of the list.
    await prisma.copilotConversation
      .update({ where: { id: conversation.id }, data: { updated_at: new Date() } })
      .catch(() => undefined);

    res.status(201).json({ message, fallback, reason: contradictionReason });
  } catch (err) {
    logger.error('Copilot appendTurn failed:', err);
    res.status(500).json({ error: 'Failed to save message' });
  }
}

// ─── POST /api/copilot/feedback ───
export async function feedback(req: Request, res: Response) {
  try {
    const updated = await prisma.copilotMessage.updateMany({
      where: { id: req.body.message_id, ...tenantWhere(req), user_id: req.user!.id },
      data: { feedback: req.body.value },
    });
    if (updated.count === 0) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error('Copilot feedback failed:', err);
    res.status(500).json({ error: 'Failed to record feedback' });
  }
}
