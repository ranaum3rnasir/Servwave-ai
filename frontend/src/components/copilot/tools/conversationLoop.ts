/**
 * The pure Servy conversation loop.
 *
 * Drives ONE user turn through the Gemini `generate` proxy and the tool bridge
 * to completion, with no React or network coupling — both the proxy call and
 * the tool execution are injected, so it is unit-testable in isolation.
 *
 *   generate → text only?           → done (speak it)
 *           → function calls?        → execute → feed results back → generate again
 *
 * Writes never execute here. A write tool returns an `approval` outcome; the
 * loop records the prepared action and voices the tool's ready "prepared,
 * confirm?" line directly (no extra generate round), then stops — no further
 * tools run while a write is pending.
 */
import type { GeminiContent, GeminiFunctionCall, GeminiPart } from '@/lib/copilot/api';
import type { ToolOutcome } from './toolHandlers';
import type { PreparedAction } from './approval';

export type GenerateFn = (
  contents: GeminiContent[],
  tools: unknown[],
) => Promise<{ text: string; functionCalls: GeminiFunctionCall[]; fallback?: boolean }>;

export type ExecuteToolFn = (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;

export interface LoopDeps {
  generate: GenerateFn;
  executeTool: ExecuteToolFn;
  /** UI status hook ('thinking' before a model call, 'reading'/'preparing' per tool). */
  onPhase?: (phase: 'thinking' | 'reading' | 'preparing') => void;
  maxRounds?: number;
}

export interface PendingApprovalRef {
  action: PreparedAction;
  call: GeminiFunctionCall;
}

export interface LoopResult {
  assistantText: string;
  pending: PendingApprovalRef | null;
}

function fnResponsePart(call: GeminiFunctionCall, output: string): GeminiPart {
  return { functionResponse: { id: call.id, name: call.name, response: { output } } };
}

/**
 * Mutates `contents` in place (appends the model turn and the function-response
 * turn each round) so the caller keeps the full conversation, and returns the
 * terminal assistant text plus any pending approval.
 */
export async function runConversationTurn(
  contents: GeminiContent[],
  tools: unknown[],
  deps: LoopDeps,
): Promise<LoopResult> {
  const maxRounds = deps.maxRounds ?? 5;

  for (let round = 0; round < maxRounds; round++) {
    deps.onPhase?.('thinking');
    const { text, functionCalls } = await deps.generate(contents, tools);

    // Record the model's turn (text + any calls) so the next generate sees it.
    const modelParts: GeminiPart[] = [];
    if (text) modelParts.push({ text });
    for (const fc of functionCalls) modelParts.push({ functionCall: fc });
    contents.push({ role: 'model', parts: modelParts });

    if (functionCalls.length === 0) {
      return { assistantText: text, pending: null };
    }

    // Execute each call; collect the function responses to feed back.
    const responseParts: GeminiPart[] = [];
    let pending: PendingApprovalRef | null = null;
    let pendingSpeak = '';
    for (const call of functionCalls) {
      if (pending) {
        // A write is already awaiting confirmation — refuse anything else this
        // round (mirrors the one-write-at-a-time guard).
        responseParts.push(
          fnResponsePart(call, 'Another action is already waiting for the user to confirm. Ask them to confirm or cancel it first.'),
        );
        continue;
      }
      deps.onPhase?.('reading');
      const outcome = await deps.executeTool(call.name, call.args ?? {});
      if (outcome.kind === 'approval') {
        deps.onPhase?.('preparing');
        pending = { action: outcome.action, call };
        pendingSpeak = outcome.speak;
        responseParts.push(fnResponsePart(call, outcome.speak));
      } else {
        responseParts.push(fnResponsePart(call, outcome.output));
      }
    }
    contents.push({ role: 'user', parts: responseParts });

    if (pending) {
      // The write tool already returns a ready, spoken "prepared — confirm?"
      // line (outcome.speak). Voice it directly instead of spending another full
      // generate round just to phrase it — that round is the single biggest
      // avoidable cost on every create/update/schedule turn.
      contents.push({ role: 'model', parts: pendingSpeak ? [{ text: pendingSpeak }] : [] });
      return { assistantText: pendingSpeak, pending };
    }
    // else: loop again to fold the read results into a spoken reply
  }

  return { assistantText: '', pending: null };
}
