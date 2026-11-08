import { prisma } from '../../../lib/prisma';
import { CascadeVoiceEngine } from './cascadeVoiceEngine';
import { SpeechToSpeechVoiceEngine } from './speechToSpeechVoiceEngine';
import { VapiVoiceEngine } from './vapiVoiceEngine';
import {
  IVoiceCallingEngine,
  VoiceEngineContext,
  VoiceEngineType,
} from './voiceEngine.interface';

export class VoiceEngineFactory {
  private static engines: Map<VoiceEngineType, IVoiceCallingEngine> = new Map<
    VoiceEngineType,
    IVoiceCallingEngine
  >([
    ['vapi', new VapiVoiceEngine()],
    ['cascade', new CascadeVoiceEngine()],
    ['speech_to_speech', new SpeechToSpeechVoiceEngine()],
  ]);

  /**
   * Registers or replaces a Voice Calling Engine implementation at runtime.
   */
  static registerEngine(engine: IVoiceCallingEngine): void {
    this.engines.set(engine.engineType, engine);
  }

  /**
   * Returns the engine instance for the given `VoiceEngineType` (defaults to `vapi`).
   */
  static getEngine(type?: string | null): IVoiceCallingEngine {
    const normalized = this.normalizeEngineType(type);
    return this.engines.get(normalized) || this.engines.get('vapi')!;
  }

  /**
   * Normalizes provider strings into canonical `VoiceEngineType`.
   * Defaults to `'vapi'` as the primary Voice Calling Engine.
   */
  static normalizeEngineType(raw?: string | null): VoiceEngineType {
    const val = (raw || process.env.VOICE_ENGINE_PROVIDER || 'vapi').toLowerCase().trim();
    if (val === 'cascade' || val === 'stt_llm_tts') {
      return 'cascade';
    }
    if (val === 'speech_to_speech' || val === 's2s' || val === 'realtime') {
      return 'speech_to_speech';
    }
    if (val === 'retell' || val === 'retell_ai') {
      return 'retell';
    }
    if (val === 'bland' || val === 'bland_ai') {
      return 'bland';
    }
    // Default to Vapi even if DB row still says 'simulated' or is empty
    return 'vapi';
  }

  /**
   * Resolves the active `IVoiceCallingEngine` and `VoiceEngineContext` (including API key)
   * for the specified organization.
   */
  static async resolveForOrganization(
    orgId: string,
    overrideEngineType?: string | null,
    cachedSettings?: any
  ): Promise<{
    engine: IVoiceCallingEngine;
    context: VoiceEngineContext;
    rawProvider: string;
  }> {
    const settings = cachedSettings !== undefined ? cachedSettings : await prisma.beeSetting.findUnique({
      where: { organization_id: orgId },
    });

    const setupCfg = (settings?.setup_config as Record<string, any>) || {};
    const rawProvider =
      overrideEngineType ||
      settings?.voice_provider ||
      setupCfg.voiceEngine ||
      process.env.VOICE_ENGINE_PROVIDER ||
      'vapi';

    const engineType = this.normalizeEngineType(rawProvider);

    // If explicit simulated or unconfigured provider
    if (rawProvider === 'simulated' || rawProvider === 'unconfigured') {
      return {
        engine: {
          engineType: 'simulated' as any,
          async initiateCall() {
            return { callId: '', status: 'failed', error: 'Voice provider is not configured' };
          },
          async listPhoneNumbers() { return []; },
          async createAgent() { return { externalAgentId: '', synced: false }; },
          async updateAgent() { return { externalAgentId: '', synced: false }; },
          async deleteAgent() { return { deleted: true }; },
        } as any,
        context: {
          organizationId: orgId,
          engineType: 'vapi',
        },
        rawProvider: 'simulated',
      };
    }

    // If external third-party provider without API key
    if ((engineType === 'retell' || engineType === 'bland') && !settings?.voice_provider_api_key) {
      return {
        engine: {
          engineType,
          async initiateCall() {
            return { callId: '', status: 'failed', error: `Voice provider API key for '${engineType}' is not configured` };
          },
          async listPhoneNumbers() { return []; },
          async createAgent() { return { externalAgentId: '', synced: false }; },
          async updateAgent() { return { externalAgentId: '', synced: false }; },
          async deleteAgent() { return { deleted: true }; },
        } as any,
        context: {
          organizationId: orgId,
          engineType,
        },
        rawProvider: String(rawProvider),
      };
    }

    const engine = this.getEngine(engineType);

    const apiKey =
      settings?.voice_provider_api_key?.trim() ||
      (typeof setupCfg.vapiApiKey === 'string' ? setupCfg.vapiApiKey.trim() : '') ||
      (typeof setupCfg.voiceApiKey === 'string' ? setupCfg.voiceApiKey.trim() : '') ||
      process.env.VAPI_API_KEY?.trim() ||
      process.env.VAPI_PRIVATE_KEY?.trim() ||
      process.env.VOICE_ENGINE_API_KEY?.trim() ||
      undefined;

    const webhookUrl =
      (typeof setupCfg.webhookUrl === 'string' ? setupCfg.webhookUrl.trim() : '') ||
      process.env.BEE_WEBHOOK_URL?.trim() ||
      undefined;

    const context: VoiceEngineContext = {
      organizationId: orgId,
      engineType,
      apiKey,
      webhookUrl,
      extraConfig: setupCfg,
    };

    return {
      engine,
      context,
      rawProvider: String(rawProvider),
    };
  }
}

