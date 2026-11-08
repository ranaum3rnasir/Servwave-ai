/**
 * The Servy "brain" facade — one wire contract, swappable provider.
 *
 * The controller calls `generateReply` here and never learns which model
 * answered. `BRAIN_PROVIDER` selects: 'groq' (free OpenAI-compatible, the demo
 * default) or 'gemini' (paid Tier 1 for production). Both honor the same
 * GenerateInput → GenerateOutput shape, so the frontend tool bridge and approval
 * flow are untouched either way.
 *
 * Speech-to-text (/transcribe) is NOT routed here — it stays on Gemini directly
 * (see gemini-generate.ts), independent of the brain choice.
 */
import { env } from '../../config/env';
import {
  generateReply as geminiGenerateReply,
  GeminiNotConfiguredError,
  type GenerateInput,
  type GenerateOutput,
} from './gemini-generate';
import { generateReply as groqGenerateReply, GroqNotConfiguredError } from './groq-generate';
import { generateReply as codexGenerateReply, CodexNotConfiguredError } from './codex-generate';

export async function generateReply(input: GenerateInput): Promise<GenerateOutput> {
  if (env.BRAIN_PROVIDER === 'codex') return codexGenerateReply(input);
  if (env.BRAIN_PROVIDER === 'groq') return groqGenerateReply(input);
  return geminiGenerateReply(input);
}

/** The selected provider's credential is missing → the endpoint should answer 503. */
export function isBrainNotConfigured(err: unknown): boolean {
  return (
    err instanceof GroqNotConfiguredError ||
    err instanceof GeminiNotConfiguredError ||
    err instanceof CodexNotConfiguredError
  );
}

/** Provider quota exhaustion (Codex/Groq/Gemini all surface HTTP 429). */
export function isBrainQuotaError(err: unknown): boolean {
  return (err as { status?: number })?.status === 429;
}
