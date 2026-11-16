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
 * Modular Cascade Voice Calling Engine (STT -> LLM -> TTS pipeline).
 * Designed as a drop-in replacement for `VapiVoiceEngine` when switching `voice_provider` to `'cascade'`.
 */
export class CascadeVoiceEngine implements IVoiceCallingEngine {
  readonly engineType = 'cascade' as const;

  async listPhoneNumbers(_ctx: VoiceEngineContext): Promise<VoiceEnginePhoneNumber[]> {
    // Cascade engine relies on organization's configured SIP / Twilio / CTM trunks in ServWave DB
    return [];
  }

  async createAgent(
    ctx: VoiceEngineContext,
    spec: VoiceEngineAgentSpec
  ): Promise<VoiceEngineAgentSyncResult> {
    const externalAgentId = `cascade_${spec.agentId || Date.now()}`;
    logger.info(
      `[CascadeVoiceEngine] Registered Cascade STT->LLM->TTS agent profile '${spec.name}' (${externalAgentId}) for org ${ctx.organizationId}`
    );
    return {
      synced: true,
      engineType: 'cascade',
      externalAgentId,
    };
  }

  async updateAgent(
    ctx: VoiceEngineContext,
    externalAgentId: string,
    spec: VoiceEngineAgentSpec
  ): Promise<VoiceEngineAgentSyncResult> {
    const resolvedId = externalAgentId || `cascade_${spec.agentId || Date.now()}`;
    logger.info(
      `[CascadeVoiceEngine] Updated Cascade STT->LLM->TTS agent profile '${spec.name}' (${resolvedId}) for org ${ctx.organizationId}`
    );
    return {
      synced: true,
      engineType: 'cascade',
      externalAgentId: resolvedId,
    };
  }

  async deleteAgent(
    _ctx: VoiceEngineContext,
    externalAgentId: string
  ): Promise<{ deleted: boolean; error?: string }> {
    logger.info(`[CascadeVoiceEngine] Removed Cascade agent profile ${externalAgentId}`);
    return { deleted: true };
  }

  async initiateCall(
    ctx: VoiceEngineContext,
    request: VoiceEngineCallRequest
  ): Promise<VoiceEngineCallResult> {
    const endpoint = ctx.baseUrl || process.env.CASCADE_VOICE_ENGINE_URL;
    const normalizedTo = normalizePhoneToE164(request.toNumber);

    if (!endpoint) {
      return {
        callId: '',
        status: 'failed',
        engineType: 'cascade',
        provider: 'cascade',
        fromNumber: request.fromNumber,
        phoneNumberId: request.phoneNumberId,
        assistantId: request.externalAgentId,
        toNumber: normalizedTo || request.toNumber,
        mergedPrompt: request.mergedPrompt,
        dynamicVariables: request.dynamicVariables,
        error:
          'Cascade Voice Engine (STT -> LLM -> TTS) media gateway URL is not configured yet (CASCADE_VOICE_ENGINE_URL).',
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
          engineType: 'cascade',
          provider: 'cascade',
          fromNumber: request.fromNumber,
          toNumber: normalizedTo,
          mergedPrompt: request.mergedPrompt,
          dynamicVariables: request.dynamicVariables,
          error: `Cascade Engine call failed (${resp.status}): ${errText.slice(0, 200)}`,
        };
      }

      const data: any = await resp.json();
      return {
        callId: data.callId || data.id || `cascade_${Date.now()}`,
        status: 'initiated',
        engineType: 'cascade',
        provider: 'cascade',
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
        engineType: 'cascade',
        provider: 'cascade',
        fromNumber: request.fromNumber,
        toNumber: normalizedTo,
        mergedPrompt: request.mergedPrompt,
        dynamicVariables: request.dynamicVariables,
        error: err instanceof Error ? err.message : 'Cascade Engine connection error',
      };
    }
  }

  async getCallDetails(
    ctx: VoiceEngineContext,
    callId: string
  ): Promise<VoiceEngineCallResultPayload | null> {
    const endpoint = ctx.baseUrl || process.env.CASCADE_VOICE_ENGINE_URL;
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

