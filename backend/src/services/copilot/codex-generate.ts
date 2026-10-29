/**
 * Codex (ChatGPT-subscription) brain for Servy — a native, in-house client.
 *
 * This talks DIRECTLY to the same backend the Codex CLI uses
 * (`https://chatgpt.com/backend-api/codex/responses`, the OpenAI Responses API)
 * using the subscription OAuth token the Codex CLI already stored in
 * `~/.codex/auth.json`. No third-party proxy binary touches the credentials —
 * the whole client is right here and auditable.
 *
 * Why this exists: it gives Servy a GPT-5.5 brain on a flat-rate ChatGPT
 * subscription (metered per 5-hour window, not per-minute), which sidesteps the
 * free-tier tokens-per-minute wall that throttled the Groq path.
 *
 * Format note: this backend is UNDOCUMENTED. The request struct, headers and SSE
 * event shapes below were pinned empirically against the live endpoint and match
 * the open-source `openai/codex` `codex-api` crate (ResponsesApiRequest). They
 * can change without notice; if a request starts failing, re-probe the endpoint.
 *
 * Same GenerateInput → GenerateOutput contract as the other brains, so the
 * controller, tool bridge and approval flow are untouched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env } from '../../config/env';
import type { GenerateInput, GenerateOutput, GeminiContent, GeminiFunctionCall } from './gemini-generate';

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';

export class CodexNotConfiguredError extends Error {
  code = 'CODEX_NOT_CONFIGURED' as const;
  constructor(message = 'Codex auth not found') {
    super(message);
    this.name = 'CodexNotConfiguredError';
  }
}

/** Carries the HTTP status so the controller can map 401 (re-auth) / 429 (quota). */
export class CodexApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Codex API error ${status}`);
    this.status = status;
    this.body = body;
    this.name = 'CodexApiError';
  }
}

// ─── Auth: read the Codex CLI's stored subscription token ───

interface CodexAuth {
  token: string;
  accountId: string;
}

function authPath(): string {
  return env.CODEX_AUTH_PATH?.trim() || path.join(os.homedir(), '.codex', 'auth.json');
}

function readAuth(): CodexAuth {
  let raw: string;
  try {
    raw = fs.readFileSync(authPath(), 'utf8');
  } catch {
    throw new CodexNotConfiguredError(`Codex auth file not found at ${authPath()} — run \`codex login\` first.`);
  }
  let parsed: { tokens?: { access_token?: string; account_id?: string }; auth_mode?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CodexNotConfiguredError('Codex auth file is not valid JSON.');
  }
  const token = parsed.tokens?.access_token;
  const accountId = parsed.tokens?.account_id;
  if (!token || !accountId) {
    throw new CodexNotConfiguredError('Codex auth file is missing tokens.access_token / account_id.');
  }
  return { token, accountId };
}

// ─── Part guards (Gemini parts arrive as `unknown`; narrow defensively) ───

function asObj(p: unknown): Record<string, unknown> | null {
  return p !== null && typeof p === 'object' ? (p as Record<string, unknown>) : null;
}
function textOf(parts: unknown[]): string {
  return parts
    .map(asObj)
    .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}
function functionCallsOf(parts: unknown[]): GeminiFunctionCall[] {
  return parts
    .map(asObj)
    .map((p) => (p ? (p.functionCall as GeminiFunctionCall | undefined) : undefined))
    .filter((fc): fc is GeminiFunctionCall => Boolean(fc?.name));
}
function functionResponsesOf(parts: unknown[]): { id?: string; name?: string; response?: { output?: string } }[] {
  return parts
    .map(asObj)
    .map((p) => (p ? (p.functionResponse as { id?: string; name?: string; response?: { output?: string } } | undefined) : undefined))
    .filter((fr): fr is { id?: string; name?: string; response?: { output?: string } } => Boolean(fr));
}

// ─── Translate: Gemini `contents` → Responses API `input` items ───
// message(user/assistant) · function_call (model→tool) · function_call_output
// (tool→model). The call_id round-trips: our loop echoes the id we hand back
// into the functionResponse, and we map it straight to function_call_output.

type ResponseInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: { type: 'input_text' | 'output_text'; text: string }[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export function toInputItems(contents: GeminiContent[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];
  let synthetic = 0;

  for (const c of contents) {
    const parts = Array.isArray(c.parts) ? c.parts : [];

    if (c.role === 'model') {
      const text = textOf(parts);
      if (text) items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const fc of functionCallsOf(parts)) {
        items.push({
          type: 'function_call',
          call_id: fc.id || `call_${synthetic++}`,
          name: fc.name,
          arguments: JSON.stringify(fc.args ?? {}),
        });
      }
      continue;
    }

    // user (or anything non-model): tool outputs first, then user text.
    for (const fr of functionResponsesOf(parts)) {
      items.push({
        type: 'function_call_output',
        call_id: fr.id || fr.name || `call_${synthetic++}`,
        output: typeof fr.response?.output === 'string' ? fr.response.output : JSON.stringify(fr.response ?? {}),
      });
    }
    const text = textOf(parts);
    if (text) items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
  }

  return items;
}

/** `[{ functionDeclarations: [{ name, description, parametersJsonSchema }] }]` → Responses function tools. */
export function toResponsesTools(tools: unknown[] | undefined): Record<string, unknown>[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map(asObj)
    .flatMap((t) => (t && Array.isArray(t.functionDeclarations) ? (t.functionDeclarations as unknown[]) : []))
    .map(asObj)
    .filter((d): d is Record<string, unknown> => Boolean(d && typeof d.name === 'string'))
    .map((d) => ({
      type: 'function',
      name: d.name as string,
      ...(typeof d.description === 'string' ? { description: d.description } : {}),
      strict: false,
      parameters: (d.parametersJsonSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    }));
}

// ─── Parse the SSE stream into { text, functionCalls } ───
// We accumulate output_text and collect completed function_call items from
// `response.output_item.done`. (We read the whole stream then parse — the
// generate contract is non-streaming.)

export function parseResponsesSse(sse: string): GenerateOutput {
  let text = '';
  const functionCalls: GeminiFunctionCall[] = [];
  let failed: string | null = null;

  for (const line of sse.split('\n')) {
    const trimmed = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!trimmed || trimmed === '[DONE]') continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const type = evt.type;
    if (type === 'response.output_item.done') {
      const item = asObj(evt.item);
      if (!item) continue;
      if (item.type === 'function_call' && typeof item.name === 'string') {
        functionCalls.push({
          id: typeof item.call_id === 'string' ? item.call_id : undefined,
          name: item.name,
          args: safeParseArgs(item.arguments),
        });
      } else if (item.type === 'message') {
        // final text — prefer the assembled item text over deltas
        const content = Array.isArray(item.content) ? item.content : [];
        for (const part of content) {
          const p = asObj(part);
          if (p && typeof p.text === 'string') text += p.text;
        }
      }
    } else if (type === 'response.failed' || type === 'response.incomplete') {
      const resp = asObj(evt.response);
      const err = asObj(resp?.error);
      failed = (err?.message as string) || (typeof type === 'string' ? type : 'response failed');
    } else if (type === 'error') {
      failed = (evt.message as string) || 'stream error';
    }
  }

  if (failed && !text && functionCalls.length === 0) throw new CodexApiError(502, failed);
  return { text: text.trim(), functionCalls };
}

function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ─── The brain call ───

export async function generateReply(input: GenerateInput): Promise<GenerateOutput> {
  const { token, accountId } = readAuth();

  const body = {
    model: env.CODEX_MODEL,
    instructions: input.systemInstruction,
    input: toInputItems(input.contents),
    tools: toResponsesTools(input.tools),
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [] as string[],
  };

  const res = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'ChatGPT-Account-ID': accountId,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      // Match the Codex CLI's identity so the backend accepts the request.
      originator: 'codex_cli_rs',
      'User-Agent': 'codex_cli_rs/0.0.0',
      'OpenAI-Beta': 'responses=experimental',
      session_id: env.CODEX_SESSION_ID,
    },
    body: JSON.stringify(body),
  });

  const sse = await res.text();
  if (!res.ok) throw new CodexApiError(res.status, sse.slice(0, 500));
  return parseResponsesSse(sse);
}
