import { logger } from '../../../lib/logger';
import {
  BuyPhoneNumberOptions,
  IVoiceCallingEngine,
  VoiceEngineAgentSpec,
  VoiceEngineAgentSyncResult,
  VoiceEngineCallRequest,
  VoiceEngineCallResult,
  VoiceEngineCallResultPayload,
  VoiceEngineContext,
  VoiceEnginePhoneNumber,
  VoiceEngineTranscriptTurn,
  formatPhoneDisplay,
  normalizePhoneToE164,
} from './voiceEngine.interface';

const VAPI_DEFAULT_BASE_URL = 'https://api.vapi.ai';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalizes a Vapi Call object or Vapi `end-of-call-report` webhook payload into
 * a standardized `VoiceEngineCallResultPayload` with recording URL and timestamped transcript turns.
 */
export function normalizeVapiCallObject(
  callObj: any,
  artifactOverride?: any
): VoiceEngineCallResultPayload | null {
  if (!callObj || typeof callObj !== 'object') return null;

  const callId = String(callObj.id || callObj.callId || callObj.call_id || '').trim();
  if (!callId) return null;

  const artifact = artifactOverride || callObj.artifact || {};
  const vars =
    artifact.variableValues ||
    callObj.assistantOverrides?.variableValues ||
    {};
  const rawMeta = callObj.metadata || {};

  // 1. Recording URLs (prefer Vapi's presignedMonoUrl / presignedStereoUrl because raw R2 bucket URLs are unsigned and return 400)
  const recordingUrl =
    artifact.presignedMonoUrl ||
    callObj.presignedMonoUrl ||
    artifact.recording?.mono?.presignedUrl ||
    artifact.presignedStereoUrl ||
    callObj.presignedStereoUrl ||
    artifact.recordingUrl ||
    artifact.recording?.mono?.combinedUrl ||
    callObj.recordingUrl ||
    artifact.stereoRecordingUrl ||
    artifact.recording?.stereoUrl ||
    callObj.stereoRecordingUrl ||
    undefined;

  const stereoRecordingUrl =
    artifact.presignedStereoUrl ||
    callObj.presignedStereoUrl ||
    artifact.stereoRecordingUrl ||
    artifact.recording?.stereoUrl ||
    callObj.stereoRecordingUrl ||
    undefined;

  // 2. Timestamped Transcript from `artifact.messages` (with exact `secondsFromStart`)
  const rawMessages: any[] = Array.isArray(artifact.messages)
    ? artifact.messages
    : Array.isArray(callObj.messages)
    ? callObj.messages
    : [];

  const startedAtMs = callObj.startedAt ? new Date(callObj.startedAt).getTime() : 0;
  const transcriptTurns: VoiceEngineTranscriptTurn[] = [];

  for (const msg of rawMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || '').toLowerCase();
    if (role === 'system' || role === 'tool' || role === 'function') continue;

    const text = String(msg.message || msg.content || '').trim();
    if (!text) continue;

    const isBee = role === 'bot' || role === 'assistant' || role === 'ai' || role === 'model';
    let timestamp = 0;
    if (typeof msg.secondsFromStart === 'number' && !Number.isNaN(msg.secondsFromStart)) {
      timestamp = Math.max(0, Math.round(msg.secondsFromStart));
    } else if (typeof msg.time === 'number' && startedAtMs > 0 && msg.time >= startedAtMs) {
      timestamp = Math.max(0, Math.round((msg.time - startedAtMs) / 1000));
    } else {
      timestamp = transcriptTurns.length * 6;
    }

    const endTimestamp =
      typeof msg.secondsFromStart === 'number' && typeof msg.duration === 'number'
        ? Math.max(timestamp, Math.round(msg.secondsFromStart + msg.duration / 1000))
        : undefined;

    transcriptTurns.push({
      speaker: isBee ? 'bee' : 'customer',
      text,
      timestamp,
      ...(endTimestamp !== undefined ? { endTimestamp } : {}),
    });
  }

  // Fallback to parsing `artifact.transcript` string if `messages` array was not populated
  const rawTranscriptText =
    typeof artifact.transcript === 'string'
      ? artifact.transcript
      : typeof callObj.transcript === 'string'
      ? callObj.transcript
      : undefined;

  if (transcriptTurns.length === 0 && rawTranscriptText) {
    const lines = rawTranscriptText
      .split('\n')
      .map((l: string) => l.trim())
      .filter(Boolean);
    lines.forEach((line: string, idx: number) => {
      const m = line.match(/^(AI|Bot|Assistant|Bee|User|Customer|Caller)\s*:\s*(.*)$/i);
      if (m && m[2]) {
        const isBee = ['ai', 'bot', 'assistant', 'bee'].includes(m[1].toLowerCase());
        transcriptTurns.push({
          speaker: isBee ? 'bee' : 'customer',
          text: m[2].trim(),
          timestamp: idx * 6,
        });
      }
    });
  }

  // 3. Duration calculation
  let durationSeconds = 0;
  if (typeof callObj.durationSeconds === 'number') {
    durationSeconds = Math.round(callObj.durationSeconds);
  } else if (callObj.startedAt && callObj.endedAt) {
    const diff = (new Date(callObj.endedAt).getTime() - new Date(callObj.startedAt).getTime()) / 1000;
    if (diff > 0 && Number.isFinite(diff)) {
      durationSeconds = Math.round(diff);
    }
  }
  if (durationSeconds === 0 && transcriptTurns.length > 0) {
    const lastTurn = transcriptTurns[transcriptTurns.length - 1];
    durationSeconds = lastTurn.endTimestamp || lastTurn.timestamp + 5;
  }

  // 4. Status & Ended Reason
  const rawStatus = String(callObj.status || '').toLowerCase();
  const endedReason = String(callObj.endedReason || '').trim() || undefined;
  const endedMessage = String(callObj.ended_message || callObj.endedMessage || '').trim() || undefined;

  let status: 'in_progress' | 'ended' | 'failed' = 'in_progress';
  if (rawStatus === 'ended' || rawStatus === 'completed' || Boolean(callObj.endedAt)) {
    if (
      endedReason &&
      (endedReason.startsWith('call.start.error') || endedReason.startsWith('pipeline-error'))
    ) {
      status = 'failed';
    } else {
      status = 'ended';
    }
  } else if (rawStatus === 'failed') {
    status = 'failed';
  }

  // 5. Summary & Cost
  const summary =
    callObj.analysis?.summary ||
    callObj.summary ||
    artifact.summary ||
    undefined;

  const cost =
    typeof callObj.cost === 'number' && !Number.isNaN(callObj.cost)
      ? callObj.cost
      : undefined;

  // 6. Customer & Metadata correlation
  const customerPhone =
    callObj.customer?.number ||
    rawMeta.customerPhone ||
    vars.customer_phone ||
    undefined;

  const customerName =
    callObj.customer?.name ||
    rawMeta.customerName ||
    vars.customer_name ||
    undefined;

  return {
    callId,
    status,
    endedReason,
    endedMessage,
    startedAt: callObj.startedAt || undefined,
    endedAt: callObj.endedAt || undefined,
    durationSeconds,
    recordingUrl,
    stereoRecordingUrl,
    transcript: transcriptTurns,
    rawTranscriptText,
    summary,
    cost,
    customerPhone,
    customerName,
    assistantId: callObj.assistantId || undefined,
    phoneNumberId: callObj.phoneNumberId || undefined,
    metadata: {
      organizationId: rawMeta.organizationId || rawMeta.servwaveOrgId || undefined,
      agentId: rawMeta.agentId || rawMeta.servwaveAgentId || undefined,
      customerId: rawMeta.customerId || undefined,
      customerName,
      customerPhone,
      jobId: rawMeta.jobId || vars.job_id || undefined,
      jobNumber: rawMeta.jobNumber || vars.job_number || undefined,
      queueItemId: rawMeta.queueItemId || undefined,
      callLogId: rawMeta.callLogId || callId,
      isTestCall: rawMeta.isTestCall,
    },
    raw: callObj,
  };
}

/**
 * Maps ServWave agent voice presets or persona names to Vapi-compatible voice configurations.
 * Uses Vapi/OpenAI voices by default so Assistant creation works out-of-the-box without requiring
 * external ElevenLabs credentials, while also supporting custom 11labs voice IDs if supplied.
 */
function resolveVapiVoiceConfig(voiceId?: string, personaName?: string): {
  provider: string;
  voiceId: string;
  model?: string;
} {
  const rawVoice = (voiceId || '').trim();
  const persona = (personaName || '').toLowerCase().trim();

  // If user passed an explicit provider:voiceId pair (e.g. "11labs:21m00Tcm4TlvDq8ikWAM" or "vapi:Paige")
  if (rawVoice.includes(':')) {
    const [prov, vid] = rawVoice.split(':');
    if (prov && vid) {
      const cleanProv = prov.trim();
      return {
        provider: cleanProv,
        voiceId: vid.trim(),
        ...(cleanProv === '11labs' ? { model: 'eleven_turbo_v2_5' } : {}),
      };
    }
  }

  // Native Vapi voice names
  const vapiVoices = [
    'Elliot',
    'Kylie',
    'Rohan',
    'Lily',
    'Savannah',
    'Hana',
    'Neha',
    'Cole',
    'Harry',
    'Paige',
    'Spencer',
  ];
  const matchedVapiVoice = vapiVoices.find((v) => v.toLowerCase() === rawVoice.toLowerCase());
  if (matchedVapiVoice) {
    return { provider: 'vapi', voiceId: matchedVapiVoice };
  }

  // Native OpenAI voice names
  const openAiVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
  if (openAiVoices.includes(rawVoice.toLowerCase())) {
    return { provider: 'openai', voiceId: rawVoice.toLowerCase() };
  }

  // Preset mappings from ServWave UI
  if (rawVoice === 'friendly_female_1' || persona.includes('emma') || persona.includes('bee')) {
    return { provider: 'openai', voiceId: 'nova' };
  }
  if (rawVoice === 'calm_male_1' || persona.includes('marcus')) {
    return { provider: 'openai', voiceId: 'onyx' };
  }
  if (rawVoice === 'upbeat_female_2' || persona.includes('chloe')) {
    return { provider: 'openai', voiceId: 'shimmer' };
  }
  if (rawVoice === 'authoritative_male_2' || persona.includes('david')) {
    return { provider: 'openai', voiceId: 'echo' };
  }

  // If a 20+ alphanumeric string is provided, treat as an ElevenLabs voice ID (ElevenLabs Turbo v2.5 model)
  if (/^[a-zA-Z0-9]{18,32}$/.test(rawVoice)) {
    return { provider: '11labs', voiceId: rawVoice, model: 'eleven_turbo_v2_5' };
  }

  return { provider: 'openai', voiceId: 'nova' };
}

/**
 * Builds the Vapi Assistant payload (`CreateAssistantDto` / `UpdateAssistantDto`)
 * from ServWave's `VoiceEngineAgentSpec`.
 */
function buildVapiAssistantPayload(
  ctx: VoiceEngineContext,
  spec: VoiceEngineAgentSpec
): Record<string, any> {
  // Vapi enforces max 40 chars on assistant.name
  const safeName = (spec.name || `${spec.personaName || 'Bee'} - ${spec.tradeFocus || 'Agent'}`)
    .trim()
    .slice(0, 40);

  const voice = resolveVapiVoiceConfig(spec.voiceId, spec.personaName);

  const payload: Record<string, any> = {
    name: safeName,
    firstMessage:
      spec.firstMessage ||
      `Hi, this is ${spec.personaName || 'Emma'} calling on a recorded line regarding your recent service. Do you have a quick moment?`,
    firstMessageMode: 'assistant-speaks-first',
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content: spec.systemPrompt,
        },
      ],
    },
    voice,
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: spec.language?.toLowerCase().includes('spanish') ? 'es' : 'en',
    },
    metadata: {
      servwaveOrgId: ctx.organizationId,
      servwaveAgentId: spec.agentId || '',
      personaName: spec.personaName,
      tradeFocus: spec.tradeFocus,
      ...(spec.metadata || {}),
    },
  };

  if (ctx.webhookUrl) {
    payload.server = {
      url: ctx.webhookUrl,
    };
  }

  return payload;
}

export class VapiVoiceEngine implements IVoiceCallingEngine {
  readonly engineType = 'vapi' as const;

  private getBaseUrl(ctx: VoiceEngineContext): string {
    return (ctx.baseUrl || process.env.VAPI_BASE_URL || VAPI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private getHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private static phoneNumberCache = new Map<
    string,
    { numbers: VoiceEnginePhoneNumber[]; expiresAt: number }
  >();

  /**
   * Returns Vapi phone numbers from a 5-minute in-memory cache (keyed by API key),
   * so placing a call doesn't require an extra GET /phone-number round-trip each time.
   */
  private async getCachedPhoneNumbers(ctx: VoiceEngineContext): Promise<VoiceEnginePhoneNumber[]> {
    const key = ctx.apiKey?.trim() || '';
    if (!key) return [];
    const cached = VapiVoiceEngine.phoneNumberCache.get(key);
    if (cached && cached.expiresAt > Date.now() && cached.numbers.length > 0) {
      return cached.numbers;
    }
    const numbers = await this.listPhoneNumbers(ctx);
    if (numbers.length > 0) {
      VapiVoiceEngine.phoneNumberCache.set(key, {
        numbers,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
    }
    return numbers;
  }

  /**
   * Fetches all configured phone numbers from Vapi (`GET /phone-number`).
   */
  async listPhoneNumbers(ctx: VoiceEngineContext): Promise<VoiceEnginePhoneNumber[]> {
    const apiKey = ctx.apiKey?.trim();
    if (!apiKey) {
      return [];
    }

    const url = `${this.getBaseUrl(ctx)}/phone-number`;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(apiKey),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        logger.warn(
          `[VapiVoiceEngine] Failed to list Vapi phone numbers (${resp.status}): ${errText.slice(0, 200)}`
        );
        return [];
      }

      const data: any = await resp.json();
      const rawList: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.results)
        ? data.results
        : [];

      const filtered = rawList.filter((item) => item && item.id && (item.number || item.sipUri));

      // Sort active Vapi telephony numbers first
      filtered.sort((a, b) => {
        const aIsVapi = String(a.provider || '').toLowerCase() === 'vapi' ? 0 : 1;
        const bIsVapi = String(b.provider || '').toLowerCase() === 'vapi' ? 0 : 1;
        return aIsVapi - bIsVapi;
      });

      return filtered.map((item, idx) => {
        const e164 = normalizePhoneToE164(item.number || '') || item.number || item.id;
        const formatted = formatPhoneDisplay(e164);
        const friendlyName = item.name ? String(item.name).trim() : 'ServWave Voice Line';
        return {
          id: String(item.id),
          e164,
          formatted,
          friendlyName,
          label: `${formatted} · ${friendlyName}`,
          source: 'servwave',
          isDefault: idx === 0,
          assistantId: item.assistantId || null,
          status: item.status || 'active',
          createdAt: item.createdAt,
        };
      });
    } catch (err: any) {
      logger.error('[VapiVoiceEngine] Error fetching phone numbers from Vapi:', err);
      return [];
    }
  }

  /**
   * Provisions / buys a phone number on Vapi (`POST /phone-number`).
   */
  async buyPhoneNumber(
    ctx: VoiceEngineContext,
    options: BuyPhoneNumberOptions
  ): Promise<VoiceEnginePhoneNumber> {
    const apiKey = ctx.apiKey?.trim();
    if (!apiKey) {
      throw new Error('Vapi API key is not configured. Cannot buy phone number.');
    }

    const url = `${this.getBaseUrl(ctx)}/phone-number`;
    const provider = options.provider || 'vapi';
    const payload: any = {
      provider,
      name: options.name || 'Bee Telephony Line',
    };
    if (provider === 'vapi') {
      const desiredAreaCode =
        (options as any).numberDesiredAreaCode ||
        (options.areaCode ? String(options.areaCode).replace(/\D/g, '').trim() : '') ||
        '415';
      payload.numberDesiredAreaCode = desiredAreaCode;
    } else {
      if (options.number?.trim()) {
        payload.number = options.number.trim();
      }
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(apiKey),
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      logger.error(`[VapiVoiceEngine] Failed to buy phone number (${resp.status}): ${errText}`);
      let parsedMessage = errText;
      try {
        const parsed = JSON.parse(errText);
        parsedMessage = parsed.message || parsed.error || errText;
      } catch {}
      throw new Error(`Vapi phone provisioning failed (${resp.status}): ${parsedMessage}`);
    }

    const data: any = await resp.json();
    // Invalidate cached phone numbers
    const cacheKey = apiKey;
    VapiVoiceEngine.phoneNumberCache.delete(cacheKey);

    const e164 = normalizePhoneToE164(data.number || '') || data.number || data.id;
    const formatted = formatPhoneDisplay(e164);
    const friendlyName = data.name ? String(data.name).trim() : 'ServWave Voice Line';

    return {
      id: String(data.id),
      e164,
      formatted,
      friendlyName,
      label: `${formatted} · ${friendlyName}`,
      source: 'servwave',
      isDefault: true,
      assistantId: data.assistantId || null,
      status: data.status || 'active',
      createdAt: data.createdAt,
    };
  }

  /**
   * Releases / deletes a phone number from Vapi (`DELETE /phone-number/:id`).
   */
  async releasePhoneNumber(
    ctx: VoiceEngineContext,
    phoneNumberId: string
  ): Promise<{ success: boolean; error?: string }> {
    const apiKey = ctx.apiKey?.trim();
    if (!apiKey) {
      throw new Error('Vapi API key is not configured. Cannot release phone number.');
    }

    const url = `${this.getBaseUrl(ctx)}/phone-number/${encodeURIComponent(phoneNumberId)}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: this.getHeaders(apiKey),
    });

    // Invalidate cached phone numbers
    const cacheKey = apiKey;
    VapiVoiceEngine.phoneNumberCache.delete(cacheKey);

    if (!resp.ok && resp.status !== 404) {
      const errText = await resp.text().catch(() => '');
      logger.warn(`[VapiVoiceEngine] Failed to release phone number (${resp.status}): ${errText}`);
      return { success: false, error: errText || `Failed with status ${resp.status}` };
    }

    return { success: true };
  }

  /**
   * Creates an Assistant on Vapi (`POST /assistant`).
   */
  async createAgent(
    ctx: VoiceEngineContext,
    spec: VoiceEngineAgentSpec
  ): Promise<VoiceEngineAgentSyncResult> {
    const apiKey = ctx.apiKey?.trim();
    if (!apiKey) {
      return {
        synced: false,
        engineType: 'vapi',
        error: 'Vapi API key is not configured yet. Agent saved locally in ServWave.',
      };
    }

    const url = `${this.getBaseUrl(ctx)}/assistant`;
    const body = buildVapiAssistantPayload(ctx, spec);

    try {
      logger.info(`[VapiVoiceEngine] Creating assistant '${body.name}' on Vapi for org ${ctx.organizationId}`);
      const resp = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(apiKey),
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        logger.error(`[VapiVoiceEngine] POST /assistant failed (${resp.status}): ${errText}`);
        return {
          synced: false,
          engineType: 'vapi',
          error: `Vapi assistant creation failed (${resp.status}): ${errText.slice(0, 200)}`,
        };
      }

      const data: any = await resp.json();
      logger.info(`[VapiVoiceEngine] Created Vapi assistant ${data.id} for agent '${spec.name}'`);
      return {
        synced: true,
        engineType: 'vapi',
        externalAgentId: data.id,
        raw: data,
      };
    } catch (err: any) {
      logger.error('[VapiVoiceEngine] Exception during POST /assistant:', err);
      return {
        synced: false,
        engineType: 'vapi',
        error: err instanceof Error ? err.message : 'Unknown Vapi assistant creation error',
      };
    }
  }

  /**
   * Updates an Assistant on Vapi (`PATCH /assistant/:id`).
   * If `externalAgentId` is missing or returns 404 on Vapi, automatically creates a new Assistant on Vapi.
   */
  async updateAgent(
    ctx: VoiceEngineContext,
    externalAgentId: string,
    spec: VoiceEngineAgentSpec
  ): Promise<VoiceEngineAgentSyncResult> {
    const apiKey = ctx.apiKey?.trim();
    if (!apiKey) {
      return {
        synced: false,
        engineType: 'vapi',
        externalAgentId: externalAgentId || undefined,
        error: 'Vapi API key is not configured yet. Agent updated locally in ServWave.',
      };
    }

    if (!externalAgentId || !UUID_REGEX.test(externalAgentId.trim())) {
      return this.createAgent(ctx, spec);
    }

    const cleanId = externalAgentId.trim();
    const url = `${this.getBaseUrl(ctx)}/assistant/${cleanId}`;
    const body = buildVapiAssistantPayload(ctx, spec);

    try {
      logger.info(`[VapiVoiceEngine] Updating Vapi assistant ${cleanId} ('${body.name}')`);
      const resp = await fetch(url, {
        method: 'PATCH',
        headers: this.getHeaders(apiKey),
        body: JSON.stringify(body),
      });

      if (resp.status === 404) {
        logger.warn(
          `[VapiVoiceEngine] Assistant ${cleanId} not found on Vapi (404). Recreating assistant on Vapi...`
        );
        return this.createAgent(ctx, spec);
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        logger.error(`[VapiVoiceEngine] PATCH /assistant/${cleanId} failed (${resp.status}): ${errText}`);
        return {
          synced: false,
          engineType: 'vapi',
          externalAgentId: cleanId,
          error: `Vapi assistant update failed (${resp.status}): ${errText.slice(0, 200)}`,
        };
      }

      const data: any = await resp.json();
      logger.info(`[VapiVoiceEngine] Updated Vapi assistant ${data.id || cleanId}`);
      return {
        synced: true,
        engineType: 'vapi',
        externalAgentId: data.id || cleanId,
        raw: data,
      };
    } catch (err: any) {
      logger.error(`[VapiVoiceEngine] Exception during PATCH /assistant/${cleanId}:`, err);
      return {
        synced: false,
        engineType: 'vapi',
        externalAgentId: cleanId,
        error: err instanceof Error ? err.message : 'Unknown Vapi assistant update error',
      };
    }
  }

  /**
   * Deletes an Assistant from Vapi (`DELETE /assistant/:id`).
   */
  async deleteAgent(
    ctx: VoiceEngineContext,
    externalAgentId: string
  ): Promise<{ deleted: boolean; error?: string }> {
    const apiKey = ctx.apiKey?.trim();
    if (!apiKey || !externalAgentId || !UUID_REGEX.test(externalAgentId.trim())) {
      return { deleted: true };
    }

    const cleanId = externalAgentId.trim();
    const url = `${this.getBaseUrl(ctx)}/assistant/${cleanId}`;

    try {
      logger.info(`[VapiVoiceEngine] Deleting Vapi assistant ${cleanId}`);
      const resp = await fetch(url, {
        method: 'DELETE',
        headers: this.getHeaders(apiKey),
      });

      if (resp.ok || resp.status === 404) {
        return { deleted: true };
      }

      const errText = await resp.text().catch(() => '');
      logger.warn(`[VapiVoiceEngine] DELETE /assistant/${cleanId} returned ${resp.status}: ${errText}`);
      return {
        deleted: false,
        error: `Vapi assistant deletion failed (${resp.status}): ${errText.slice(0, 200)}`,
      };
    } catch (err: any) {
      logger.error(`[VapiVoiceEngine] Exception during DELETE /assistant/${cleanId}:`, err);
      return {
        deleted: false,
        error: err instanceof Error ? err.message : 'Unknown Vapi deletion error',
      };
    }
  }

  /**
   * Triggers an outbound phone call on Vapi (`POST /call`) using:
   * - `assistantId` (or auto-synced assistant / inline assistant fallback)
   * - `phoneNumberId` (resolved from Vapi's configured phone numbers)
   * - `assistantOverrides` carrying the complete locally-merged Master Prompt (`model.messages`),
   *   `firstMessage`, and `variableValues` (all Job Info dynamic variables).
   */
  async initiateCall(
    ctx: VoiceEngineContext,
    request: VoiceEngineCallRequest
  ): Promise<VoiceEngineCallResult> {
    const apiKey = ctx.apiKey?.trim();
    const normalizedTo = normalizePhoneToE164(request.toNumber);

    if (!apiKey) {
      const msg =
        'Vapi API key is not configured. Set VAPI_API_KEY in backend/.env or configure your Vapi Private API Key in Bee Settings.';
      logger.warn(`[VapiVoiceEngine] ${msg}`);
      return {
        callId: '',
        status: 'failed',
        engineType: 'vapi',
        provider: 'vapi',
        fromNumber: request.fromNumber,
        phoneNumberId: request.phoneNumberId,
        assistantId: request.externalAgentId,
        toNumber: normalizedTo || request.toNumber,
        mergedPrompt: request.mergedPrompt,
        dynamicVariables: request.dynamicVariables,
        error: msg,
      };
    }

    if (!normalizedTo) {
      return {
        callId: '',
        status: 'failed',
        engineType: 'vapi',
        provider: 'vapi',
        fromNumber: request.fromNumber,
        toNumber: request.toNumber,
        mergedPrompt: request.mergedPrompt,
        dynamicVariables: request.dynamicVariables,
        error: `Invalid destination phone number: '${request.toNumber}'. Must be a valid E.164 phone number.`,
      };
    }

    try {
      // 1. Resolve Vapi phoneNumberId (UUID) and fromNumber
      let resolvedPhoneNumberId =
        request.phoneNumberId && UUID_REGEX.test(request.phoneNumberId.trim())
          ? request.phoneNumberId.trim()
          : undefined;

      // Also check if request.fromNumber itself was passed as a Vapi phoneNumberId UUID
      if (!resolvedPhoneNumberId && request.fromNumber && UUID_REGEX.test(request.fromNumber.trim())) {
        resolvedPhoneNumberId = request.fromNumber.trim();
      }

      let resolvedFromE164 = request.fromNumber ? normalizePhoneToE164(request.fromNumber) : undefined;

      // Performance: fetch Vapi phone numbers (cached for 5 minutes per API key)
      const vapiNumbers = await this.getCachedPhoneNumbers(ctx);
      if (vapiNumbers.length > 0) {
        if (resolvedPhoneNumberId) {
          const matchedById = vapiNumbers.find((n) => n.id === resolvedPhoneNumberId);
          if (matchedById) {
            resolvedFromE164 = matchedById.e164;
          } else {
            // Provided ID does not exist in Vapi account! Invalidate and try matching by phone number or fallback
            logger.warn(
              `[VapiVoiceEngine] Configured phoneNumberId '${resolvedPhoneNumberId}' does not exist in Vapi account. Falling back to active Vapi line.`
            );
            resolvedPhoneNumberId = undefined;
          }
        }

        if (!resolvedPhoneNumberId && resolvedFromE164) {
          const matchedByNum = vapiNumbers.find(
            (n) => normalizePhoneToE164(n.e164) === resolvedFromE164
          );
          if (matchedByNum) {
            resolvedPhoneNumberId = matchedByNum.id;
            resolvedFromE164 = matchedByNum.e164;
          }
        }

        // Fallback to first configured Vapi number if none matched
        if (!resolvedPhoneNumberId) {
          resolvedPhoneNumberId = vapiNumbers[0].id;
          resolvedFromE164 = vapiNumbers[0].e164;
        }
      }

      if (!resolvedPhoneNumberId) {
        const msg =
          'No configured phone numbers found in your Vapi account. Please add or import a phone number in your Vapi dashboard (Phone Numbers) before placing calls.';
        logger.warn(`[VapiVoiceEngine] ${msg}`);
        return {
          callId: '',
          status: 'failed',
          engineType: 'vapi',
          provider: 'vapi',
          fromNumber: resolvedFromE164 || request.fromNumber,
          toNumber: normalizedTo,
          mergedPrompt: request.mergedPrompt,
          dynamicVariables: request.dynamicVariables,
          error: msg,
        };
      }

      // 2. Ensure we have an assistantId on Vapi (auto-sync if not created yet)
      let resolvedAssistantId =
        request.externalAgentId && UUID_REGEX.test(request.externalAgentId.trim())
          ? request.externalAgentId.trim()
          : undefined;

      if (!resolvedAssistantId) {
        const syncRes = await this.createAgent(ctx, request.agentSpec);
        if (syncRes.synced && syncRes.externalAgentId) {
          resolvedAssistantId = syncRes.externalAgentId;
        }
      }

      const voiceConfig = resolveVapiVoiceConfig(
        request.agentSpec.voiceId,
        request.agentSpec.personaName
      );

      const callMetadata: Record<string, any> = {
        organizationId: ctx.organizationId,
        agentId: request.agentSpec.agentId || '',
        customerId: request.customerId || '',
        customerName: request.customerName || 'Valued Customer',
        customerPhone: normalizedTo,
        jobId: request.jobId || '',
        jobNumber: request.jobNumber || '',
        queueItemId: request.queueItemId || '',
        isTestCall: Boolean(request.isTestCall),
      };

      // 3. Build POST https://api.vapi.ai/call payload
      // Uses assistantId + phoneNumberId + complete locally-merged prompt via assistantOverrides
      const assistantOverrides: Record<string, any> = {
        firstMessage: request.firstMessage,
        firstMessageMode: 'assistant-speaks-first',
        variableValues: request.dynamicVariables,
        voice: voiceConfig,
        metadata: callMetadata,
        model: {
          provider: 'openai',
          model: 'gpt-4o-mini',
          temperature: 0.5,
          messages: [
            {
              role: 'system',
              content: request.mergedPrompt,
            },
          ],
        },
      };

      if (ctx.webhookUrl) {
        assistantOverrides.server = {
          url: ctx.webhookUrl,
        };
      }

      const callPayload: Record<string, any> = {
        name: `Bee Call - ${request.customerName || 'Customer'}`.slice(0, 40),
        phoneNumberId: resolvedPhoneNumberId,
        customer: {
          number: normalizedTo,
          name: (request.customerName || 'Valued Customer').slice(0, 40),
        },
        metadata: callMetadata,
      };

      if (resolvedAssistantId) {
        callPayload.assistantId = resolvedAssistantId;
        callPayload.assistantOverrides = assistantOverrides;
      } else {
        callPayload.assistant = {
          ...buildVapiAssistantPayload(ctx, {
            ...request.agentSpec,
            firstMessage: request.firstMessage,
            systemPrompt: request.mergedPrompt,
            metadata: callMetadata,
          }),
        };
        callPayload.assistantOverrides = {
          variableValues: request.dynamicVariables,
          metadata: callMetadata,
        };
      }

      const url = `${this.getBaseUrl(ctx)}/call`;
      logger.info(
        `[VapiVoiceEngine] POST /call -> to='${normalizedTo}', phoneNumberId='${resolvedPhoneNumberId}', assistantId='${resolvedAssistantId || 'inline'}'`
      );

      const resp = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(apiKey),
        body: JSON.stringify(callPayload),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        logger.error(`[VapiVoiceEngine] POST /call failed (${resp.status}): ${errText}`);

        let cleanMsg = '';
        try {
          const parsed = JSON.parse(errText);
          if (Array.isArray(parsed?.message)) {
            cleanMsg = parsed.message
              .filter(Boolean)
              .map((m: any) => String(m).trim())
              .join(' ');
          } else if (typeof parsed?.message === 'string' && parsed.message.trim()) {
            cleanMsg = parsed.message.trim();
          } else if (typeof parsed?.error === 'string' && parsed.error.trim() && parsed.error.toLowerCase() !== 'bad request') {
            cleanMsg = parsed.error.trim();
          } else if (parsed?.error && typeof parsed.error === 'object') {
            cleanMsg = parsed.error.message || parsed.error.detail || parsed.error.description;
          }
        } catch {
          cleanMsg = errText.trim();
        }

        return {
          callId: '',
          status: 'failed',
          engineType: 'vapi',
          provider: 'vapi',
          fromNumber: resolvedFromE164 || request.fromNumber,
          phoneNumberId: resolvedPhoneNumberId,
          assistantId: resolvedAssistantId,
          toNumber: normalizedTo,
          mergedPrompt: request.mergedPrompt,
          dynamicVariables: request.dynamicVariables,
          error: cleanMsg || `Vapi rejected call (${resp.status}): ${errText.slice(0, 250)}`,
        };
      }

      const data: any = await resp.json();
      const createdCallId = data.id || data.call_id || '';

      // 4. Test calls only: verify initial transport creation after 2.2s so immediate transport errors
      // (such as `call.start.error-get-transport` from an unverified Twilio number) are surfaced
      // in the Test Call modal. Queue calls skip this blocking wait — any transport failure is
      // posted back to the same call log as FAILED by the Stage 1 post-call pipeline.
      if (createdCallId && request.isTestCall) {
        await new Promise((r) => setTimeout(r, 2200));
        const checkResp = await fetch(`${this.getBaseUrl(ctx)}/call/${createdCallId}`, {
          method: 'GET',
          headers: this.getHeaders(apiKey),
        }).catch(() => null);

        if (checkResp && checkResp.ok) {
          const callCheck: any = await checkResp.json().catch(() => null);
          const endedReason = callCheck?.endedReason || '';
          const endedMessage = callCheck?.ended_message || callCheck?.endedMessage || '';
          if (
            callCheck?.status === 'ended' &&
            (endedReason.startsWith('call.start.error') || endedReason.includes('error'))
          ) {
            const detailedErr = endedMessage
              ? `Vapi Call Failed (${endedReason}): ${endedMessage}`
              : `Vapi Call Failed (${endedReason}): Telephony transport could not be initialized for ${resolvedFromE164 || resolvedPhoneNumberId}.`;
            logger.error(`[VapiVoiceEngine] ${detailedErr}`);
            return {
              callId: createdCallId,
              status: 'failed',
              engineType: 'vapi',
              provider: 'vapi',
              fromNumber: resolvedFromE164 || request.fromNumber,
              phoneNumberId: resolvedPhoneNumberId,
              assistantId: resolvedAssistantId || data.assistantId,
              toNumber: normalizedTo,
              mergedPrompt: request.mergedPrompt,
              dynamicVariables: request.dynamicVariables,
              error: detailedErr,
              raw: callCheck,
            };
          }
        }
      }

      return {
        callId: createdCallId,
        status: 'initiated',
        engineType: 'vapi',
        provider: 'vapi',
        fromNumber: resolvedFromE164 || request.fromNumber,
        phoneNumberId: resolvedPhoneNumberId,
        assistantId: resolvedAssistantId || data.assistantId,
        toNumber: normalizedTo,
        mergedPrompt: request.mergedPrompt,
        dynamicVariables: request.dynamicVariables,
        raw: data,
      };
    } catch (err: any) {
      logger.error('[VapiVoiceEngine] Exception initiating call on Vapi:', err);
      return {
        callId: '',
        status: 'failed',
        engineType: 'vapi',
        provider: 'vapi',
        fromNumber: request.fromNumber,
        phoneNumberId: request.phoneNumberId,
        assistantId: request.externalAgentId,
        toNumber: normalizedTo,
        mergedPrompt: request.mergedPrompt,
        dynamicVariables: request.dynamicVariables,
        error: err instanceof Error ? err.message : 'Unknown Vapi telephony error',
      };
    }
  }

  /**
   * Fetches a single call's full details (status, recordingUrl, timestamped messages, cost)
   * from Vapi (`GET /call/:callId`).
   */
  async getCallDetails(
    ctx: VoiceEngineContext,
    callId: string
  ): Promise<VoiceEngineCallResultPayload | null> {
    const apiKey = ctx.apiKey?.trim();
    const cleanId = (callId || '').trim();
    if (!apiKey || !cleanId || !UUID_REGEX.test(cleanId)) {
      return null;
    }

    const url = `${this.getBaseUrl(ctx)}/call/${cleanId}`;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(apiKey),
      });

      if (!resp.ok) {
        return null;
      }

      const data: any = await resp.json();
      return normalizeVapiCallObject(data);
    } catch (err) {
      logger.error(`[VapiVoiceEngine] Error fetching call details for ${cleanId}:`, err);
      return null;
    }
  }

  /**
   * Lists recent calls from Vapi (`GET /call?limit=N`) to reconcile completed calls.
   */
  async listRecentCalls(
    ctx: VoiceEngineContext,
    limit: number = 10
  ): Promise<VoiceEngineCallResultPayload[]> {
    const apiKey = ctx.apiKey?.trim();
    if (!apiKey) return [];

    const url = `${this.getBaseUrl(ctx)}/call?limit=${Math.min(50, Math.max(1, limit))}`;
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(apiKey),
      });
      if (!resp.ok) return [];

      const data: any = await resp.json();
      const rawList: any[] = Array.isArray(data) ? data : [];
      return rawList
        .map((c) => normalizeVapiCallObject(c))
        .filter((c): c is VoiceEngineCallResultPayload => c !== null);
    } catch (err) {
      logger.error('[VapiVoiceEngine] Error listing recent calls:', err);
      return [];
    }
  }

  /**
   * Parses Vapi Server URL webhook payloads (`message.type === 'end-of-call-report'`)
   * or direct Vapi Call objects into `VoiceEngineCallResultPayload`.
   */
  parseWebhookPayload(rawBody: any): VoiceEngineCallResultPayload | null {
    if (!rawBody || typeof rawBody !== 'object') return null;

    // 1. Standard Vapi Server URL envelope: { message: { type: 'end-of-call-report', call: {...}, artifact: {...}, ... } }
    if (rawBody.message && typeof rawBody.message === 'object') {
      const msg = rawBody.message;
      const msgType = String(msg.type || '').toLowerCase();

      // Only ingest when the call has ended (`end-of-call-report` or `status-update` with status === 'ended')
      if (
        msgType &&
        msgType !== 'end-of-call-report' &&
        !(msgType === 'status-update' && String(msg.status || '').toLowerCase() === 'ended')
      ) {
        return null;
      }

      const callObj = {
        ...(msg.call || {}),
        id: msg.call?.id || msg.callId || msg.id,
        status: msg.call?.status || msg.status || 'ended',
        endedReason: msg.endedReason || msg.call?.endedReason,
        startedAt: msg.startedAt || msg.call?.startedAt,
        endedAt: msg.endedAt || msg.call?.endedAt,
        cost: msg.cost ?? msg.call?.cost,
        summary: msg.summary || msg.analysis?.summary || msg.call?.summary,
        analysis: msg.analysis || msg.call?.analysis,
        customer: msg.customer || msg.call?.customer,
        metadata: msg.call?.metadata || msg.metadata,
        recordingUrl: msg.recordingUrl || msg.artifact?.recordingUrl || msg.call?.recordingUrl,
        stereoRecordingUrl:
          msg.stereoRecordingUrl || msg.artifact?.stereoRecordingUrl || msg.call?.stereoRecordingUrl,
        transcript: msg.transcript || msg.artifact?.transcript || msg.call?.transcript,
        messages: msg.messages || msg.artifact?.messages || msg.call?.messages,
      };

      return normalizeVapiCallObject(callObj, msg.artifact);
    }

    // 2. Direct Vapi Call object: { id: '...', status: 'ended', artifact: {...} }
    if ((rawBody.id || rawBody.callId) && (rawBody.artifact || rawBody.messages || rawBody.endedReason)) {
      return normalizeVapiCallObject(rawBody, rawBody.artifact);
    }

    return null;
  }
}

