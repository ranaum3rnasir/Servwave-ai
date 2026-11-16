import { logger } from '../../../lib/logger';
import {
  IVoiceCallingEngine,
  VoiceEngineAgentSpec,
  VoiceEngineAgentSyncResult,
  VoiceEngineCallRequest,
  VoiceEngineCallResult,
  VoiceEngineCallResultPayload,
  VoiceEngineContext,
  VoiceEnginePhoneNumber,
  normalizePhoneToE164,
} from './voiceEngine.interface';
import { normalizeVapiCallObject } from './vapiVoiceEngine';

/**
 * Modular Speech-to-Speech Voice Calling Engine (e.g. Gemini Live / OpenAI Realtime S2S).
 * Designed as a drop-in replacement for `VapiVoiceEngine` when switching `voice_provider` to `'speech_to_speech'`.
 */
export class SpeechToSpeechVoiceEngine implements IVoiceCallingEngine {
  readonly engineType = 'speech_to_speech' as const;

  async listPhoneNumbers(_ctx: VoiceEngineContext): Promise<VoiceEnginePhoneNumber[]> {
    return [];
  }

  async createAgent(
    ctx: VoiceEngineContext,
    spec: VoiceEngineAgentSpec
  ): Promise<VoiceEngineAgentSyncResult> {
    const externalAgentId = `s2s_${spec.agentId || Date.now()}`;
    logger.info(
      `[SpeechToSpeechVoiceEngine] Registered Speech-to-Speech agent '${spec.name}' (${externalAgentId}) for org ${ctx.organizationId}`
    );
    return {
      synced: true,
      engineType: 'speech_to_speech',
      externalAgentId,
    };
  }

  async updateAgent(
    ctx: VoiceEngineContext,
    externalAgentId: string,
    spec: VoiceEngineAgentSpec
  ): Promise<VoiceEngineAgentSyncResult> {
    const resolvedId = externalAgentId || `s2s_${spec.agentId || Date.now()}`;
    logger.info(
      `[SpeechToSpeechVoiceEngine] Updated Speech-to-Speech agent '${spec.name}' (${resolvedId}) for org ${ctx.organizationId}`
    );
    return {
      synced: true,
      engineType: 'speech_to_speech',
      externalAgentId: resolvedId,
    };
  }

  async deleteAgent(
    _ctx: VoiceEngineContext,
    externalAgentId: string
  ): Promise<{ deleted: boolean; error?: string }> {
    logger.info(`[SpeechToSpeechVoiceEngine] Removed Speech-to-Speech agent ${externalAgentId}`);
    return { deleted: true };
  }

  async initiateCall(
    ctx: VoiceEngineContext,
    request: VoiceEngineCallRequest
  ): Promise<VoiceEngineCallResult> {
    const endpoint = ctx.baseUrl || process.env.S2S_VOICE_ENGINE_URL;
    const normalizedTo = normalizePhoneToE164(request.toNumber);

    if (!endpoint) {
      return {
        callId: '',
        status: 'failed',
        engineType: 'speech_to_speech',
        provider: 'speech_to_speech',
        fromNumber: request.fromNumber,
        phoneNumberId: request.phoneNumberId,
        assistantId: request.externalAgentId,
        toNumber: normalizedTo || request.toNumber,
        mergedPrompt: request.mergedPrompt,
        dynamicVariables: request.dynamicVariables,
        error:
          'Speech-to-Speech Voice Engine gateway URL is not configured yet (S2S_VOICE_ENGINE_URL).',
      };
    }

    try {
      const resp = await fetch(`${endpoint.replace(/\/+$/, '')}/calls`, {
        method: 'POST',
        headers: {
          ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          organizationId: ctx.organizationId,
          assistantId: request.externalAgentId,
          phoneNumberId: request.phoneNumberId,
          fromNumber: request.fromNumber,
          toNumber: normalizedTo,
          customerName: request.customerName,
          firstMessage: request.firstMessage,
          systemPrompt: request.mergedPrompt,
          dynamicVariables: request.dynamicVariables,
          voiceId: request.agentSpec.voiceId,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        return {
          callId: '',
          status: 'failed',
          engineType: 'speech_to_speech',
          provider: 'speech_to_speech',
          fromNumber: request.fromNumber,
          toNumber: normalizedTo,
          mergedPrompt: request.mergedPrompt,
          dynamicVariables: request.dynamicVariables,
          error: `Speech-to-Speech Engine call failed (${resp.status}): ${errText.slice(0, 200)}`,
        };
      }

      const data: any = await resp.json();
      return {
        callId: data.callId || data.id || `s2s_${Date.now()}`,
        status: 'initiated',
        engineType: 'speech_to_speech',
        provider: 'speech_to_speech',
        fromNumber: request.fromNumber,
        phoneNumberId: request.phoneNumberId,
        assistantId: request.externalAgentId,
        toNumber: normalizedTo,
        mergedPrompt: request.mergedPrompt,
        dynamicVariables: request.dynamicVariables,
        raw: data,
      };
    } catch (err: any) {
      return {
        callId: '',
        status: 'failed',
        engineType: 'speech_to_speech',
        provider: 'speech_to_speech',
        fromNumber: request.fromNumber,
        toNumber: normalizedTo,
        mergedPrompt: request.mergedPrompt,
        dynamicVariables: request.dynamicVariables,
        error: err instanceof Error ? err.message : 'Speech-to-Speech Engine connection error',
      };
    }
  }

  async getCallDetails(
    ctx: VoiceEngineContext,
    callId: string
  ): Promise<VoiceEngineCallResultPayload | null> {
    const endpoint = ctx.baseUrl || process.env.S2S_VOICE_ENGINE_URL;
    if (!endpoint || !callId) return null;
    try {
      const resp = await fetch(`${endpoint.replace(/\/+$/, '')}/calls/${callId}`, {
        headers: ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {},
      });
      if (!resp.ok) return null;
      const data: any = await resp.json();
      return normalizeVapiCallObject(data);
    } catch {
      return null;
    }
  }

  parseWebhookPayload(rawBody: any): VoiceEngineCallResultPayload | null {
    return normalizeVapiCallObject(rawBody?.call || rawBody, rawBody?.artifact);
  }
}

