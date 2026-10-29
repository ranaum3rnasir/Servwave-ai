/**
 * Groq brain for Servy — a free, OpenAI-compatible drop-in for `generateReply`.
 *
 * Servy's whole frontend (conversationLoop, the 16 CASL-gated tools, the
 * hash-pinned approval flow) speaks the Gemini dialect: `contents` with
 * text / functionCall / functionResponse parts, and `[{ functionDeclarations }]`
 * tools. That dialect is OURS — it only ever travels between the browser and
 * /api/copilot/generate — so we translate it to the OpenAI chat-completions
 * shape entirely here on the server. The browser never changes.
 *
 * Groq (and GitHub Models / Mistral / OpenRouter) all speak this same OpenAI
 * dialect, so swapping providers later is a base-URL + model change, not a
 * rewrite. We use plain `fetch` (no SDK) to keep the dependency surface flat.
 */
import { env } from '../../config/env';
import type { GenerateInput, GenerateOutput, GeminiContent, GeminiFunctionCall } from './gemini-generate';

export class GroqNotConfiguredError extends Error {
  code = 'GROQ_NOT_CONFIGURED' as const;
  constructor() {
    super('GROQ_API_KEY is not configured');
    this.name = 'GroqNotConfiguredError';
  }
}

/** Carries the HTTP status so the controller can tell quota (429) from other failures. */
export class GroqApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Groq API error ${status}`);
    this.status = status;
    this.body = body;
    this.name = 'GroqApiError';
  }
}

// ─── OpenAI chat-completions shapes (only the fields we use) ───

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}
interface OpenAITool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

// ─── Part guards / helpers ───
// Parts arrive as `unknown` (the zod schema passes them through verbatim), so we
// narrow defensively rather than trust the shape.

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
function functionResponsesOf(
  parts: unknown[],
): { id?: string; name?: string; response?: { output?: string } }[] {
  return parts
    .map(asObj)
    .map((p) => (p ? (p.functionResponse as { id?: string; name?: string; response?: { output?: string } } | undefined) : undefined))
    .filter((fr): fr is { id?: string; name?: string; response?: { output?: string } } => Boolean(fr));
}

/**
 * Gemini `contents` (+ a system instruction) → OpenAI `messages`.
 *
 * - 'model' turns become `assistant` messages; their functionCall parts become
 *   `tool_calls` (args stringified). The call id round-trips: we set the tool_call
 *   id to fc.id, which the browser later echoes back in the functionResponse.
 * - 'user' turns carrying functionResponse parts become one `tool` message each
 *   (matched to the assistant tool_call by tool_call_id); plain-text 'user' turns
 *   become a `user` message. Tool results are emitted before any user text so the
 *   assistant→tool pairing OpenAI requires is preserved.
 *
 * Pure — exported for unit tests.
 */
export function toMessages(contents: GeminiContent[], systemInstruction: string): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: 'system', content: systemInstruction }];

  for (const c of contents) {
    const parts = Array.isArray(c.parts) ? c.parts : [];

    if (c.role === 'model') {
      const text = textOf(parts);
      const toolCalls: OpenAIToolCall[] = functionCallsOf(parts).map((fc, i) => ({
        id: fc.id || `call_${i}`,
        type: 'function',
        function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
      }));
      const msg: OpenAIMessage = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }

    // 'user' (or anything non-model): tool results first, then user text.
    const responses = functionResponsesOf(parts);
    for (const fr of responses) {
      messages.push({
        role: 'tool',
        tool_call_id: fr.id || fr.name || 'tool',
        content: typeof fr.response?.output === 'string' ? fr.response.output : JSON.stringify(fr.response ?? {}),
      });
    }
    const text = textOf(parts);
    if (text) messages.push({ role: 'user', content: text });
  }

  return messages;
}

/** `[{ functionDeclarations: [{ name, description, parametersJsonSchema }] }]` → OpenAI `tools`. Pure. */
export function toTools(tools: unknown[] | undefined): OpenAITool[] {
  if (!Array.isArray(tools)) return [];
  const decls = tools
    .map(asObj)
    .flatMap((t) => (t && Array.isArray(t.functionDeclarations) ? (t.functionDeclarations as unknown[]) : []))
    .map(asObj)
    .filter((d): d is Record<string, unknown> => Boolean(d && typeof d.name === 'string'));

  return decls.map((d) => ({
    type: 'function',
    function: {
      name: d.name as string,
      ...(typeof d.description === 'string' ? { description: d.description } : {}),
      parameters: (d.parametersJsonSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    },
  }));
}

/** OpenAI chat-completions response → Servy's `{ text, functionCalls }`. Pure. */
export function fromResponse(json: unknown): GenerateOutput {
  const msg = (asObj(json)?.choices as unknown[] | undefined)?.[0];
  const message = asObj(asObj(msg)?.message);
  const text = message && typeof message.content === 'string' ? message.content : '';

  const rawCalls = Array.isArray(message?.tool_calls) ? (message!.tool_calls as unknown[]) : [];
  const functionCalls: GeminiFunctionCall[] = rawCalls
    .map(asObj)
    .filter((tc): tc is Record<string, unknown> => Boolean(tc && tc.type === 'function'))
    .map((tc) => {
      const fn = asObj(tc.function);
      const name = fn && typeof fn.name === 'string' ? fn.name : '';
      return { id: typeof tc.id === 'string' ? tc.id : undefined, name, args: safeParseArgs(fn?.arguments) };
    })
    .filter((c) => Boolean(c.name));

  return { text, functionCalls };
}

/** Tool-call arguments arrive as a JSON string; never throw on a malformed body. */
function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function postChatCompletion(apiKey: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${env.GROQ_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new GroqApiError(res.status, text);
  return JSON.parse(text);
}

// Appended to the conversation on a single corrective retry after a malformed
// tool call. Open-weight models sometimes emit a generic `{name, parameters}`
// blob that drops a required field; this nudges them back to a valid call.
const TOOL_FIX_NUDGE =
  'Your previous tool call was rejected as malformed or missing a required field. ' +
  'Re-issue exactly ONE tool call as valid JSON that includes EVERY required parameter for that tool. ' +
  'Do not wrap it in extra keys.';

/**
 * Same signature as the Gemini `generateReply`. Translates in, calls Groq, and
 * translates out. On a 400 `tool_use_failed` (the model malformed a tool call)
 * we retry AT MOST ONCE, appending a corrective nudge — never in a loop. A loop
 * here is actively harmful: the error is often deterministic, so retries don't
 * fix it and instead multiply token/request volume against the per-minute rate
 * limit (that storm is what surfaced as a bogus "free usage limit" 429). All
 * other errors (incl. genuine 429 quota) bubble to the controller.
 */
export async function generateReply(input: GenerateInput): Promise<GenerateOutput> {
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) throw new GroqNotConfiguredError();

  const messages = toMessages(input.contents, input.systemInstruction);
  const tools = toTools(input.tools);
  const body: Record<string, unknown> = {
    model: env.GROQ_MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 1024,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
  };

  try {
    return fromResponse(await postChatCompletion(apiKey, body));
  } catch (err) {
    if (err instanceof GroqApiError && err.status === 400 && /tool_use_failed/i.test(err.body)) {
      const corrected = { ...body, messages: [...messages, { role: 'system', content: TOOL_FIX_NUDGE }] };
      return fromResponse(await postChatCompletion(apiKey, corrected));
    }
    throw err;
  }
}
