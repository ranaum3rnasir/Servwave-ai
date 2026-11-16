export type VoiceEngineType =
  | 'vapi'
  | 'cascade'
  | 'speech_to_speech'
  | 'retell'
  | 'bland';

export interface VoiceEngineContext {
  organizationId: string;
  engineType: VoiceEngineType;
  apiKey?: string;
  baseUrl?: string;
  webhookUrl?: string;
  extraConfig?: Record<string, any>;
}

export interface VoiceEnginePhoneNumber {
  /** Provider-side unique ID (e.g., Vapi phoneNumberId UUID) */
  id: string;
  /** E.164 phone number (e.g., +19735550100) */
  e164: string;
  /** Human-readable formatted number */
  formatted: string;
  /** Label / friendly name configured in provider */
  label: string;
  /** Friendly name without provider decorations */
  friendlyName?: string;
  /** Telephony provider or engine source (e.g., 'vapi', 'twilio', 'vonage') */
  source: string;
  /** Whether this is the default outbound number */
  isDefault: boolean;
  /** Assigned assistant ID on the provider, if any */
  assistantId?: string | null;
  /** Provider status ('active', etc.) */
  status?: string;
  /** Creation timestamp if available */
  createdAt?: string;
}

export interface BuyPhoneNumberOptions {
  areaCode?: string;
  name?: string;
  provider?: string;
  number?: string;
}

export interface VoiceEngineAgentSpec {
  /** Internal ServWave BeeVoiceAgent ID */
  agentId?: string;
  /** Display name of the agent in ServWave */
  name: string;
  /** Persona name (e.g., Emma, Marcus, Chloe, David) */
  personaName: string;
  /** Internal voice preset or external voice ID */
  voiceId: string;
  /** Trade focus (e.g., Doors & Locks, HVAC, Plumbing) */
  tradeFocus: string;
  /** Language (e.g., English (US)) */
  language?: string;
  /** Tone description */
  tone?: string;
  /** Opening greeting message (`firstMessage` in Vapi) */
  firstMessage: string;
  /** Complete system prompt / master prompt template for this agent */
  systemPrompt: string;
  /** Optional metadata to attach on the voice engine */
  metadata?: Record<string, any>;
}

export interface VoiceEngineAgentSyncResult {
  synced: boolean;
  engineType: VoiceEngineType;
  /** Provider-side assistant/agent ID (e.g., Vapi assistant.id) */
  externalAgentId?: string;
  error?: string;
  raw?: any;
}

export interface VoiceEngineCallRequest {
  /** Destination phone number (customer / test recipient) */
  toNumber: string;
  /** Outbound caller ID number (E.164 or formatted) */
  fromNumber?: string;
  /** Provider-specific phone number ID (e.g., Vapi `phoneNumberId` UUID) */
  phoneNumberId?: string;
  /** Provider-specific assistant ID (e.g., Vapi `assistantId` UUID) */
  externalAgentId?: string;
  /** Customer display name */
  customerName: string;
  /** Customer ID in ServWave */
  customerId?: string;
  /** Job ID in ServWave */
  jobId?: string;
  /** Job Number in ServWave */
  jobNumber?: string;
  /** Queue Item ID in ServWave */
  queueItemId?: string;
  /** Whether this call was triggered as a Test Call */
  isTestCall?: boolean;
  /** Agent specification (used for inline fallback or overrides) */
  agentSpec: VoiceEngineAgentSpec;
  /** Complete locally-merged Master Prompt from ServWave DB (with Job Info & Conversation Flow) */
  mergedPrompt: string;
  /** Interpolated opening greeting for this specific call */
  firstMessage: string;
  /** All resolved Job Info & customer dynamic variables */
  dynamicVariables: Record<string, string>;
}

export interface VoiceEngineCallResult {
  callId: string;
  status: 'initiated' | 'completed' | 'failed';
  engineType: VoiceEngineType;
  provider: string;
  fromNumber?: string;
  phoneNumberId?: string;
  assistantId?: string;
  toNumber: string;
  mergedPrompt: string;
  dynamicVariables: Record<string, string>;
  error?: string;
  raw?: any;
}

export interface VoiceEngineTranscriptTurn {
  speaker: 'bee' | 'customer';
  text: string;
  /** Seconds from the start of the call (e.g. 3, 17, 32) */
  timestamp: number;
  /** Optional end timestamp in seconds */
  endTimestamp?: number;
}

export interface VoiceEngineCallResultPayload {
  callId: string;
  status: 'in_progress' | 'ended' | 'failed';
  endedReason?: string;
  endedMessage?: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds: number;
  recordingUrl?: string;
  stereoRecordingUrl?: string;
  transcript: VoiceEngineTranscriptTurn[];
  rawTranscriptText?: string;
  summary?: string;
  cost?: number;
  customerPhone?: string;
  customerName?: string;
  assistantId?: string;
  phoneNumberId?: string;
  metadata?: {
    organizationId?: string;
    agentId?: string;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    jobId?: string;
    jobNumber?: string;
    queueItemId?: string;
    callLogId?: string;
    isTestCall?: boolean;
  };
  raw?: any;
}

/**
 * Pluggable Voice Calling Engine contract.
 * Currently implemented by `VapiVoiceEngine` and designed to be swapped seamlessly
 * with `CascadeVoiceEngine` (STT -> LLM -> TTS) or `SpeechToSpeechVoiceEngine` (Realtime S2S).
 */
export interface IVoiceCallingEngine {
  readonly engineType: VoiceEngineType;

  /**
   * Lists available outbound phone numbers configured on the voice engine.
   */
  listPhoneNumbers(ctx: VoiceEngineContext): Promise<VoiceEnginePhoneNumber[]>;

  /**
   * Buys / provisions a new phone number on the voice engine provider (e.g. Vapi `POST /phone-number`).
   */
  buyPhoneNumber?(
    ctx: VoiceEngineContext,
    options: BuyPhoneNumberOptions
  ): Promise<VoiceEnginePhoneNumber>;

  /**
   * Deletes / releases a phone number on the voice engine provider (e.g. Vapi `DELETE /phone-number/:id`).
   */
  releasePhoneNumber?(
    ctx: VoiceEngineContext,
    phoneNumberId: string
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Creates an assistant/agent on the external voice engine when created in ServWave.
   */
  createAgent(
    ctx: VoiceEngineContext,
    spec: VoiceEngineAgentSpec
  ): Promise<VoiceEngineAgentSyncResult>;

  /**
   * Updates an existing assistant/agent on the external voice engine (name, voice, prompt, flow).
   */
  updateAgent(
    ctx: VoiceEngineContext,
    externalAgentId: string,
    spec: VoiceEngineAgentSpec
  ): Promise<VoiceEngineAgentSyncResult>;

  /**
   * Deletes an assistant/agent from the external voice engine when deleted in ServWave.
   */
  deleteAgent(
    ctx: VoiceEngineContext,
    externalAgentId: string
  ): Promise<{ deleted: boolean; error?: string }>;

  /**
   * Triggers an outbound phone call using the engine's Call API, passing:
   * - `assistantId` (`externalAgentId`)
   * - `phoneNumberId`
   * - The complete locally-merged Master Prompt & dynamic variables
   */
  initiateCall(
    ctx: VoiceEngineContext,
    request: VoiceEngineCallRequest
  ): Promise<VoiceEngineCallResult>;

  /**
   * Fetches the current status, recording URL, timestamped transcript, and metadata for a call ID
   * from the external voice engine (`GET /call/:callId`).
   */
  getCallDetails(
    ctx: VoiceEngineContext,
    callId: string
  ): Promise<VoiceEngineCallResultPayload | null>;

  /**
   * Parses an inbound webhook payload from the voice engine (e.g., Vapi `end-of-call-report`)
   * into a standardized `VoiceEngineCallResultPayload` for Stage 1 call log ingestion.
   */
  parseWebhookPayload(rawBody: any): VoiceEngineCallResultPayload | null;
}

/**
 * Normalizes a US or international phone string into strict E.164 format (+1XXXXXXXXXX).
 */
export function normalizePhoneToE164(rawPhone?: string | null): string {
  if (!rawPhone) return '';
  const trimmed = rawPhone.split('·')[0].trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return hasPlus ? `+${digits}` : `+${digits}`;
}

/**
 * Formats an E.164 US phone number into (XXX) XXX-XXXX for display.
 */
export function formatPhoneDisplay(e164OrRaw: string): string {
  const digits = (e164OrRaw || '').replace(/\D/g, '');
  const ten =
    digits.length === 11 && digits.startsWith('1')
      ? digits.slice(1)
      : digits.length === 10
      ? digits
      : null;
  if (ten) {
    return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  }
  return e164OrRaw;
}

