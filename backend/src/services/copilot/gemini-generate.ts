/**
 * Server-side Gemini text generation for Servy.
 *
 * The browser does voice locally (Web Speech STT/TTS) and never receives the
 * API key. It sends the running conversation (Gemini `contents`) here; we call
 * `generateContent` with the server key and return the model's text + any
 * function calls for the browser to execute against the authed /api/* (the
 * fail-closed gate). Isolated so the controller can be tested with this mocked.
 */
import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env';

export class GeminiNotConfiguredError extends Error {
  code = 'GEMINI_NOT_CONFIGURED' as const;
  constructor() {
    super('GEMINI_API_KEY is not configured');
    this.name = 'GeminiNotConfiguredError';
  }
}

/** A Gemini conversation entry. `parts` are passed through verbatim (text /
 *  functionCall / functionResponse). Kept loose — the SDK validates the shape. */
export interface GeminiContent {
  role: string; // 'user' | 'model'
  parts: unknown[];
}

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface GenerateInput {
  contents: GeminiContent[];
  tools?: unknown[];
  systemInstruction: string;
}

export interface GenerateOutput {
  text: string;
  functionCalls: GeminiFunctionCall[];
}

export async function generateReply(input: GenerateInput): Promise<GenerateOutput> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiNotConfiguredError();

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: env.GEMINI_TEXT_MODEL,
    contents: input.contents as never,
    config: {
      systemInstruction: input.systemInstruction,
      ...(input.tools && input.tools.length ? { tools: input.tools as never } : {}),
    },
  });

  const functionCalls = (response.functionCalls ?? [])
    .filter((c): c is { name: string; args?: Record<string, unknown>; id?: string } => Boolean(c?.name))
    .map((c) => ({ id: c.id, name: c.name, args: c.args }));

  return { text: response.text ?? '', functionCalls };
}

// ─── Speech-to-text ───
// The browser records the user's voice (16 kHz mono WAV) and posts it here; we
// have Gemini transcribe it with the same server-side key. This replaces the
// browser SpeechRecognition engine, which silently fails in many setups (privacy
// browsers, VPNs, blocked Google speech service) — Gemini STT works anywhere a
// mic works, in EN/HE/ES alike.

export interface TranscribeInput {
  audioBase64: string;
  mimeType: string; // e.g. 'audio/wav'
  locale?: string | null;
}

export async function transcribeAudio(input: TranscribeInput): Promise<string> {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new GeminiNotConfiguredError();

  const langHint = input.locale ? ` The speaker most likely speaks ${input.locale}, but transcribe whatever language is actually spoken.` : '';
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: env.GEMINI_TEXT_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: input.mimeType, data: input.audioBase64 } },
          {
            text:
              'Transcribe the speech in this audio verbatim. Reply with ONLY the transcript text — no quotes, no labels, no commentary.' +
              ' If there is no intelligible speech, reply with exactly: NONE' +
              langHint,
          },
        ],
      },
    ] as never,
    config: { temperature: 0 },
  });

  return cleanTranscript(response.text ?? '');
}

/**
 * Normalize the STT reply: the model is told to say "NONE" for silence, but
 * smaller models sometimes answer with a refusal sentence instead — neither
 * may ever be treated as something the user said. Pure (unit-tested).
 */
export function cleanTranscript(raw: string): string {
  const text = raw.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!text) return '';
  if (/^NONE[.!]?$/i.test(text)) return '';
  if (/^(i'?m sorry|i cannot|i can'?t|unable to|there (is|was) no (speech|audio)|no (intelligible )?speech)/i.test(text)) return '';
  return text;
}
