/**
 * Typed client for the copilot backend (/api/copilot/*). Reuses the shared axios
 * instance so the Supabase Bearer token + refresh are automatic.
 */
import api from '@/lib/axios';

// ─── Gemini conversation shapes (mirror the server `generate` proxy) ───
export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}
export interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { id?: string; name: string; response: { output: string } };
}
export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
export interface GenerateResult {
  text: string;
  functionCalls: GeminiFunctionCall[];
  fallback: boolean;
}

/**
 * Ask Servy for the next turn. The browser sends the running conversation plus
 * the CASL-filtered tool declarations; the server adds the API key + persona +
 * the contradiction-safety check and returns the reply text and any function
 * calls for the browser to execute. The key never reaches the client.
 */
export async function generateReply(
  contents: GeminiContent[],
  tools?: unknown[],
  locale?: string,
): Promise<GenerateResult> {
  const { data } = await api.post('/api/copilot/generate', { contents, tools, locale });
  return {
    text: data?.text ?? '',
    functionCalls: Array.isArray(data?.functionCalls) ? data.functionCalls : [],
    fallback: Boolean(data?.fallback),
  };
}

/**
 * Speech-to-text: the recorder's WAV clip goes to the server, Gemini transcribes
 * it with the server-side key. Replaces the browser SpeechRecognition engine
 * (which silently fails behind VPNs / privacy browsers).
 */
export async function transcribeAudio(audioBase64: string, mimeType: string, locale?: string): Promise<string> {
  const { data } = await api.post('/api/copilot/transcribe', {
    audio: audioBase64,
    mime_type: mimeType,
    locale,
  });
  return String(data?.text ?? '').trim();
}

// ─── Real-time voice (Gemini Live) ───
export interface LiveTokenResult {
  /** Ephemeral token string — passed as the apiKey to ai.live.connect. */
  token: string;
  expireTime: string;
  model: string;
  voiceName: string;
  /** Slim voice persona built server-side (key + full persona stay on the server). */
  systemInstruction: string;
}

export interface RecentTurnInput {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Mint a single-use ephemeral token for a Gemini Live voice session. The browser
 * connects to Gemini Live directly with it; the GEMINI_API_KEY never reaches the
 * client. Recent transcript turns are re-injected so the stateless Live session
 * has cross-reconnect memory. Throws (axios) with status 503 when voice is not
 * configured — the caller falls back to the record-then-transcribe path.
 */
export async function mintLiveToken(recentTurns?: RecentTurnInput[], locale?: string): Promise<LiveTokenResult> {
  const { data } = await api.post('/api/copilot/token', { recent_turns: recentTurns, locale });
  return {
    token: String(data?.token ?? ''),
    expireTime: String(data?.expireTime ?? ''),
    model: String(data?.model ?? ''),
    voiceName: String(data?.voiceName ?? 'Puck'),
    systemInstruction: String(data?.systemInstruction ?? ''),
  };
}

export interface CopilotConversationSummary {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export async function createConversation(title?: string): Promise<CopilotConversationSummary> {
  const { data } = await api.post('/api/copilot/conversations', { title });
  return data.conversation;
}

export async function listConversations(): Promise<CopilotConversationSummary[]> {
  const { data } = await api.get('/api/copilot/conversations');
  return data.conversations ?? [];
}

export async function deleteConversation(id: string): Promise<void> {
  await api.delete(`/api/copilot/conversations/${id}`);
}

export interface PersistTurnInput {
  conversation_id: string;
  role: 'USER' | 'ASSISTANT';
  modality: 'TEXT' | 'VOICE';
  content: string;
  status?: 'FINAL' | 'STOPPED' | 'FALLBACK';
  label_key?: string;
  capability_id?: string;
  execution_mode?: string;
  meta?: Record<string, unknown>;
}

export interface PersistTurnResult {
  message: { id: string; content: string; status: string };
  fallback: boolean;
  reason?: string;
}

export async function persistTurn(input: PersistTurnInput): Promise<PersistTurnResult> {
  const { data } = await api.post('/api/copilot/turns', input);
  return data;
}

export async function sendFeedback(message_id: string, value: 'UP' | 'DOWN'): Promise<void> {
  await api.post('/api/copilot/feedback', { message_id, value });
}
