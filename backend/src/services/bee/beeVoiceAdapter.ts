import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { VoiceEngineFactory } from './engines/voiceEngineFactory';
import { VapiVoiceEngine } from './engines/vapiVoiceEngine';
import {
  BuyPhoneNumberOptions,
  VoiceEngineAgentSpec,
  VoiceEngineAgentSyncResult,
  VoiceEngineCallResultPayload,
  VoiceEnginePhoneNumber,
} from './engines/voiceEngine.interface';

export type JobContextFieldKey =
  | 'assigned_team'
  | 'job_notes'
  | 'invoice_sent'
  | 'line_items'
  | 'total_costs'
  | 'internal_costs'
  | 'visits'
  | 'communication_history';

export const ALL_JOB_CONTEXT_FIELDS: JobContextFieldKey[] = [
  'assigned_team',
  'job_notes',
  'invoice_sent',
  'line_items',
  'total_costs',
  'internal_costs',
  'visits',
  'communication_history',
];

export interface AgentConversationFlow {
  greeting_pitch?: string;
  checkin_flow?: string;
  warranty_offer_pitch?: string;
  new_work_pitch?: string;
  objection_handling?: string;
  custom_instructions?: string;
}

export interface JobContextVariablesMap {
  assigned_team?: string;
  job_notes?: string;
  invoice_sent?: string;
  line_items?: string;
  total_costs?: string;
  internal_costs?: string;
  visits?: string;
  communication_history?: string;
}

export const BEE_MASTER_PROMPT_TEMPLATE = `You are {{agent_persona}}, an AI outbound service & warranty specialist calling on behalf of {{company_name}} (Trade Focus: {{trade_focus}}).
Your tone is {{agent_tone}} and you speak {{agent_language}}.
{{tone_rules}}

=== CORE COMPLIANCE & SAFETY GUARDRAILS (MANDATORY) ===
1. RECORDING DISCLOSURE: Always state near the start of the call that you are a virtual assistant calling from {{company_name}} on a recorded line.
2. DO NOT CALL (DNC) RESPECT: If the customer asks to be removed from the call list, says "do not call me again", or opts out, apologize politely, confirm immediate removal, and end the call (Outcome: DNC_REQUESTED).
3. HUMAN HANDOFF & COMPLAINTS: If the customer reports that the recent work is broken, expresses frustration/dissatisfaction, or asks to speak to a manager/human, do NOT pitch a warranty. Empathize, document the issue, and promise an immediate callback from the office team (Outcome: COMPLAINT or HANDOFF_HUMAN).
4. TRUTHFULNESS: Only reference factual job details, line items, pricing, visits, and warranty plans provided below. Never invent prices or coverage terms.

=== CUSTOMER & JOB CORE IDENTIFIERS ===
- Customer Name: {{customer_name}}
- Customer Phone: {{customer_phone}}
- Job Number: {{job_number}}
- Job Type: {{job_type}}
- Service Request: {{service_request}}
- Service Address: {{service_address}}
- Warranty Status: {{warranty_status}} (Ends: {{warranty_end_date}})

=== SELECTED JOB CONTEXT (DYNAMIC VARIABLES) ===
{{dynamic_job_context_section}}

=== AVAILABLE WARRANTY EXTENSION PLANS ===
{{available_plans_summary}}

=== CONVERSATION FLOW & WHAT TO TALK ABOUT ===
Follow this structured conversation flow, adapting naturally to the customer's responses:

1. OPENING & GREETING:
{{flow_greeting}}

2. SERVICE CHECK-IN & JOB REFERENCE:
{{flow_checkin}}

3. WARRANTY EXTENSION PITCH:
{{flow_warranty_pitch}}

4. NEW WORK / ADDITIONAL SERVICE DISCOVERY:
{{flow_new_work_pitch}}

5. OBJECTION HANDLING & CLOSING:
{{flow_objection_handling}}

6. ADDITIONAL AGENT INSTRUCTIONS:
{{flow_custom_instructions}}`;

export interface VoiceCallPayload {
  to: string;
  from?: string;
  phoneNumberId?: string;
  agentId?: string;
  agentName?: string;
  voiceId?: string;
  externalAgentId?: string;
  customerId?: string;
  customerName: string;
  companyName?: string;
  agentPersona: string;
  agentTone?: string;
  agentLanguage?: string;
  tradeFocus: string;
  jobId?: string;
  jobNumber?: string;
  jobType?: string;
  queueItemId?: string;
  voiceEngine?: any;
  isTestCall?: boolean;
  serviceRequest?: string;
  scopeNotes?: string;
  completionNotes?: string;
  serviceAddress?: string;
  completedAt?: string;
  warrantyStartDate?: string;
  warrantyEndDate?: string;
  warrantyStatus?: string;
  lineItemsSummary?: string;
  warrantyOfferPitch?: string;
  newWorkPitch?: string;
  conversationFlow?: AgentConversationFlow;
  selectedJobContextFields?: string[];
  jobContextVariables?: JobContextVariablesMap;
  availablePlans?: Array<{ name: string; price: number; durationMonths: number; description?: string }>;
}

export interface VoiceCallResult {
  callId: string;
  status: 'initiated' | 'completed' | 'failed';
  provider: string;
  engineType?: string;
  fromNumber?: string;
  phoneNumberId?: string;
  assistantId?: string;
  toNumber?: string;
  mergedPrompt?: string;
  dynamicVariables?: Record<string, string>;
  error?: string;
}

const JOB_CONTEXT_LABELS: Record<JobContextFieldKey, string> = {
  assigned_team: 'Assigned Team',
  job_notes: 'Job Notes',
  invoice_sent: 'Invoice Sent',
  line_items: 'Line Items (Qty, Description, Price, Discount)',
  total_costs: 'Total Costs',
  internal_costs: 'Internal Costs (Staff Reference Only)',
  visits: 'Visits & Schedule History',
  communication_history: 'Communication History',
};

export class BeeVoiceAdapter {
  /**
   * Builds the merged Master Prompt and dynamic variables dictionary by combining:
   * 1. The backend Master Prompt template
   * 2. The agent's configured Conversation Flow
   * 3. The agent's selected Job Info dynamic variables (`selectedJobContextFields`)
   */
  static buildMergedMasterPrompt(payload: VoiceCallPayload): {
    mergedPrompt: string;
    firstMessage: string;
    dynamicVariables: Record<string, string>;
  } {
    const companyName = payload.companyName || 'Our Service Team';
    const persona = payload.agentPersona || 'Emma';
    const tone = payload.agentTone || 'Warm, helpful, and consultative';
    const language = payload.agentLanguage || 'English (US)';
    const tradeFocus = payload.tradeFocus || payload.jobType || 'General Service';

    const selectedFields =
      Array.isArray(payload.selectedJobContextFields) && payload.selectedJobContextFields.length > 0
        ? payload.selectedJobContextFields
        : [
            'assigned_team',
            'job_notes',
            'invoice_sent',
            'line_items',
            'total_costs',
            'visits',
            'communication_history',
          ];

    const rawVars: JobContextVariablesMap = payload.jobContextVariables || {};

    // Filter only selected job info variables
    const activeJobContextLines: string[] = [];
    const filteredJobVars: Record<string, string> = {};

    for (const key of ALL_JOB_CONTEXT_FIELDS) {
      const isSelected = selectedFields.includes(key);
      const val = (rawVars[key] || '').trim();
      if (isSelected) {
        const resolvedVal =
          val ||
          (key === 'line_items' && payload.lineItemsSummary
            ? payload.lineItemsSummary
            : key === 'job_notes' && (payload.scopeNotes || payload.completionNotes)
            ? [
                payload.scopeNotes ? `Scope: ${payload.scopeNotes}` : '',
                payload.completionNotes ? `Completion: ${payload.completionNotes}` : '',
              ]
                .filter(Boolean)
                .join(' | ')
            : `{{${key}}}`);
        filteredJobVars[key] = resolvedVal;
        activeJobContextLines.push(`- ${JOB_CONTEXT_LABELS[key]} ({{${key}}}): ${resolvedVal}`);
      } else {
        filteredJobVars[key] = '[Not enabled for this agent]';
      }
    }

    const dynamicJobContextSection =
      activeJobContextLines.length > 0
        ? activeJobContextLines.join('\n')
        : '- Standard job summary only (no extended job context variables enabled).';

    const flow = payload.conversationFlow || {};
    const flowGreeting =
      flow.greeting_pitch?.trim() ||
      `Hi {{customer_name}}, this is ${persona}, a virtual assistant calling from ${companyName} on a recorded line regarding your recent {{job_type}} (Job {{job_number}}). Do you have a quick moment?`;

    const flowCheckin =
      flow.checkin_flow?.trim() ||
      `Check in to make sure the {{job_type}} work performed is operating smoothly. Reference the specific job context enabled above (such as the assigned technician team, line items installed, or recent visit completion) so the customer knows this is a personalized follow-up.`;

    const flowWarrantyPitch =
      flow.warranty_offer_pitch?.trim() ||
      payload.warrantyOfferPitch?.trim() ||
      `Let {{customer_name}} know their current warranty coverage is coming up on {{warranty_end_date}}, and present the best-fitting protection plan so they stay covered for labor and parts without surprise repair bills.`;

    const flowNewWorkPitch =
      flow.new_work_pitch?.trim() ||
      payload.newWorkPitch?.trim() ||
      `While we have them on the line, ask if there are any other ${tradeFocus.toLowerCase()} items, doors, hardware, or upcoming projects at {{service_address}} they would like our team to inspect or quote.`;

    const flowObjectionHandling =
      flow.objection_handling?.trim() ||
      `If the customer asks about what was done or billed on the original job, reference the enabled Job Info variables (Invoice Sent, Line Items, Total Costs, or Visits). If they want time to think or prefer an email quote, offer to have our office send the plan details and schedule a brief follow-up.`;

    const flowCustomInstructions =
      flow.custom_instructions?.trim() ||
      `Keep responses concise (1-2 sentences per turn). Never share internal cost figures with the customer unless internal_costs is used purely to understand job complexity.`;

    const availablePlansSummary =
      payload.availablePlans && payload.availablePlans.length > 0
        ? payload.availablePlans
            .map(
              (p) =>
                `• ${p.name}: $${p.price} for ${p.durationMonths} months${
                  p.description ? ` (${p.description})` : ''
                }`
            )
            .join('\n')
        : '• Standard 12-Month Extended Protection Plan';

    let toneRules = '';
    const lowerTone = tone.toLowerCase();
    if (lowerTone.includes('consultative') || lowerTone.includes('empathetic') || lowerTone.includes('warm')) {
      toneRules = 'TONE RULE: Speak warmly, empathetically, and consultatively. Validate customer comments, never pressure or hurry them, and frame warranty plans as protective peace-of-mind.';
    } else if (lowerTone.includes('direct') || lowerTone.includes('concise') || lowerTone.includes('professional')) {
      toneRules = 'TONE RULE: Maintain a direct, concise, and professional tone. Get straight to key facts and coverage dates, speak clearly, and avoid filler or unnecessary small talk.';
    } else if (lowerTone.includes('energetic') || lowerTone.includes('proactive') || lowerTone.includes('friendly')) {
      toneRules = 'TONE RULE: Use a friendly, upbeat, and proactive energy. Radiate positive enthusiasm, highlight renewal perks and discounts with optimism.';
    } else if (lowerTone.includes('reassuring') || lowerTone.includes('patient') || lowerTone.includes('supportive')) {
      toneRules = 'TONE RULE: Adopt a reassuring, patient, and supportive manner. Explain technical terms simply, speak calmly, and prioritize the customer\'s comfort and reassurance.';
    } else {
      toneRules = `TONE RULE: ${tone}. Adhere strictly to this conversational style throughout the dialogue.`;
    }

    const baseVariables: Record<string, string> = {
      company_name: companyName,
      customer_id: payload.customerId || '',
      customer_name: payload.customerName || '{{customer_name}}',
      customer_phone: payload.to || '{{customer_phone}}',
      agent_persona: persona,
      agent_tone: tone,
      agent_language: language,
      tone_rules: toneRules,
      trade_focus: tradeFocus,
      job_id: payload.jobId || '',
      job_number: payload.jobNumber || '{{job_number}}',
      job_type: payload.jobType || tradeFocus,
      service_request: payload.serviceRequest || payload.jobType || '{{service_request}}',
      scope_notes: payload.scopeNotes || '',
      completion_notes: payload.completionNotes || '',
      service_address: payload.serviceAddress || '{{service_address}}',
      completed_at: payload.completedAt || '',
      warranty_start_date: payload.warrantyStartDate || '',
      warranty_end_date: payload.warrantyEndDate || '{{warranty_end_date}}',
      warranty_status: payload.warrantyStatus || 'active',
      available_plans: payload.availablePlans ? JSON.stringify(payload.availablePlans) : '[]',
      available_plans_summary: availablePlansSummary,
      selected_job_fields: selectedFields.join(', '),
      dynamic_job_context_section: dynamicJobContextSection,
      ...filteredJobVars,
    };

    const interpolate = (text: string): string => {
      return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, varName) => {
        return baseVariables[varName] !== undefined ? baseVariables[varName] : `{{${varName}}}`;
      });
    };

    baseVariables.flow_greeting = interpolate(flowGreeting);
    baseVariables.flow_checkin = interpolate(flowCheckin);
    baseVariables.flow_warranty_pitch = interpolate(flowWarrantyPitch);
    baseVariables.flow_new_work_pitch = interpolate(flowNewWorkPitch);
    baseVariables.flow_objection_handling = interpolate(flowObjectionHandling);
    baseVariables.flow_custom_instructions = interpolate(flowCustomInstructions);
    baseVariables.warranty_pitch = baseVariables.flow_warranty_pitch;
    baseVariables.new_work_pitch = baseVariables.flow_new_work_pitch;

    const mergedPrompt = interpolate(BEE_MASTER_PROMPT_TEMPLATE);
    baseVariables.master_prompt = mergedPrompt;

    return {
      mergedPrompt,
      firstMessage: baseVariables.flow_greeting,
      dynamicVariables: baseVariables,
    };
  }

  /**
   * Builds a `VoiceEngineAgentSpec` from a normalized ServWave `BeeVoiceAgent` record
   * so that creating or updating an agent in ServWave also syncs its Master Prompt,
   * Conversation Flow, Persona, and Voice to the active Voice Calling Engine (Vapi).
   */
  static async buildAgentEngineSpec(
    orgId: string,
    agent: any
  ): Promise<VoiceEngineAgentSpec> {
    const [org, activePlans] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      }),
      prisma.beeWarrantyPlan.findMany({
        where: { organization_id: orgId, is_active: true },
        orderBy: { price: 'asc' },
      }),
    ]);

    const companyName = org?.name || 'Our Service Team';
    const { mergedPrompt, firstMessage } = this.buildMergedMasterPrompt({
      to: '{{customer_phone}}',
      customerName: '{{customer_name}}',
      companyName,
      agentPersona: agent.persona_name || 'Emma',
      agentTone: agent.tone || 'Warm, helpful, and consultative',
      agentLanguage: agent.language || 'English (US)',
      tradeFocus: agent.trade_focus || 'General Service',
      jobNumber: '{{job_number}}',
      jobType: '{{job_type}}',
      serviceRequest: '{{service_request}}',
      serviceAddress: '{{service_address}}',
      warrantyEndDate: '{{warranty_end_date}}',
      warrantyOfferPitch: agent.warranty_offer_pitch,
      newWorkPitch: agent.new_work_pitch,
      conversationFlow: agent.conversation_flow,
      selectedJobContextFields: agent.job_context_fields,
      availablePlans: activePlans.map((p) => ({
        name: p.name,
        price: Number(p.price),
        durationMonths: p.duration_months,
        description: p.description || undefined,
      })),
    });

    return {
      agentId: agent.id,
      name: agent.name || `${agent.persona_name || 'Emma'} - ${agent.trade_focus || 'Agent'}`,
      personaName: agent.persona_name || 'Emma',
      voiceId: agent.voice_id || 'friendly_female_1',
      tradeFocus: agent.trade_focus || 'General Service',
      language: agent.language || 'English (US)',
      tone: agent.tone || 'Warm, helpful, and consultative',
      firstMessage,
      systemPrompt: mergedPrompt,
    };
  }

  /**
   * Lists phone numbers configured in the active Voice Calling Engine (e.g. Vapi `GET /phone-number`).
   */
  static async listEnginePhoneNumbers(orgId: string): Promise<VoiceEnginePhoneNumber[]> {
    const { engine, context } = await VoiceEngineFactory.resolveForOrganization(orgId);
    return engine.listPhoneNumbers(context);
  }

  /**
   * Buys/provisions a new phone number in the active Voice Calling Engine (e.g. Vapi `POST /phone-number`).
   */
  static async buyPhoneNumber(orgId: string, options: BuyPhoneNumberOptions): Promise<VoiceEnginePhoneNumber> {
    const { engine, context } = await VoiceEngineFactory.resolveForOrganization(orgId);
    if (!engine.buyPhoneNumber) {
      throw new Error(`Voice engine ${engine.engineType} does not support buying phone numbers`);
    }
    return engine.buyPhoneNumber(context, options);
  }

  /**
   * Releases/deletes a phone number from the active Voice Calling Engine (e.g. Vapi `DELETE /phone-number/:id`).
   */
  static async releasePhoneNumber(orgId: string, phoneNumberId: string): Promise<{ success: boolean; error?: string }> {
    const { engine, context } = await VoiceEngineFactory.resolveForOrganization(orgId);
    if (!engine.releasePhoneNumber) {
      throw new Error(`Voice engine ${engine.engineType} does not support releasing phone numbers`);
    }
    return engine.releasePhoneNumber(context, phoneNumberId);
  }

  /**
   * Syncs a newly created ServWave agent to the active Voice Calling Engine (e.g. Vapi `POST /assistant`).
   */
  static async syncAgentCreate(
    orgId: string,
    agent: any
  ): Promise<VoiceEngineAgentSyncResult> {
    const { engine, context } = await VoiceEngineFactory.resolveForOrganization(
      orgId,
      agent?.voice_engine
    );
    const spec = await this.buildAgentEngineSpec(orgId, agent);
    return engine.createAgent(context, spec);
  }

  /**
   * Syncs an updated ServWave agent (including updated prompt/conversation flow) to the active
   * Voice Calling Engine (e.g. Vapi `PATCH /assistant/:id`).
   */
  static async syncAgentUpdate(
    orgId: string,
    agent: any,
    existingExternalAgentId?: string
  ): Promise<VoiceEngineAgentSyncResult> {
    const { engine, context } = await VoiceEngineFactory.resolveForOrganization(
      orgId,
      agent?.voice_engine
    );
    const spec = await this.buildAgentEngineSpec(orgId, agent);
    const externalId = existingExternalAgentId || agent?.vapi_assistant_id || '';
    return engine.updateAgent(context, externalId, spec);
  }

  /**
   * Deletes an agent from the active Voice Calling Engine (e.g. Vapi `DELETE /assistant/:id`).
   */
  static async syncAgentDelete(
    orgId: string,
    externalAgentId?: string,
    engineType?: string
  ): Promise<{ deleted: boolean; error?: string }> {
    if (!externalAgentId) {
      return { deleted: true };
    }
    const { engine, context } = await VoiceEngineFactory.resolveForOrganization(orgId, engineType);
    return engine.deleteAgent(context, externalAgentId);
  }

  /**
   * Dispatches an outbound voice call through the active modular Voice Calling Engine
   * (currently `VapiVoiceEngine`, swappable with `CascadeVoiceEngine` or `SpeechToSpeechVoiceEngine`).
   * Passes `assistantId`, `phoneNumberId`, and the complete locally-merged Master Prompt.
   */
  static async initiateCall(orgId: string, payload: VoiceCallPayload): Promise<VoiceCallResult> {
    const [settings, org, defaultPhoneRow] = await Promise.all([
      prisma.beeSetting.findUnique({
        where: { organization_id: orgId },
      }),
      prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, phone: true },
      }),
      prisma.phoneNumber.findFirst({
        where: { organization_id: orgId, status: 'active' },
        orderBy: [{ is_org_default: 'desc' }, { created_at: 'asc' }],
      }),
    ]);

    const setupCfg = (settings?.setup_config as Record<string, any>) || {};
    const resolvedFromNumber =
      payload.from?.trim() ||
      defaultPhoneRow?.e164 ||
      (typeof setupCfg.callerId === 'string' ? setupCfg.callerId.split('·')[0].trim() : '') ||
      org?.phone?.trim() ||
      undefined;

    const enrichedPayload: VoiceCallPayload = {
      ...payload,
      from: resolvedFromNumber,
      companyName: payload.companyName || setupCfg.businessName || org?.name || 'Our Service Team',
      customerName: payload.customerName || 'Valued Customer',
      jobNumber: payload.jobNumber || '—',
      serviceRequest: payload.serviceRequest || payload.jobType || 'Service',
      serviceAddress: payload.serviceAddress || 'Customer Site',
      warrantyEndDate: payload.warrantyEndDate || 'Upcoming',
    };

    const { mergedPrompt, firstMessage, dynamicVariables } =
      this.buildMergedMasterPrompt(enrichedPayload);

    const { engine, context } = await VoiceEngineFactory.resolveForOrganization(
      orgId,
      payload.voiceEngine,
      settings
    );

    logger.info(
      `[BeeVoiceAdapter] Initiating call via Voice Calling Engine '${engine.engineType}' from '${resolvedFromNumber || 'default'}' (phoneNumberId: ${payload.phoneNumberId || 'auto'}) to '${payload.to}' for customer ${payload.customerName} (Job: ${payload.jobNumber || payload.jobId || 'N/A'})`
    );

    const result = await engine.initiateCall(context, {
      toNumber: payload.to,
      fromNumber: resolvedFromNumber,
      phoneNumberId: payload.phoneNumberId,
      externalAgentId: payload.externalAgentId,
      customerName: enrichedPayload.customerName,
      customerId: payload.customerId,
      jobId: payload.jobId,
      jobNumber: payload.jobNumber,
      queueItemId: payload.queueItemId,
      isTestCall: payload.isTestCall,
      agentSpec: {
        agentId: payload.agentId,
        name:
          payload.agentName ||
          `${payload.agentPersona || 'Emma'} - ${payload.tradeFocus || 'Agent'}`,
        personaName: payload.agentPersona || 'Emma',
        voiceId: payload.voiceId || 'friendly_female_1',
        tradeFocus: payload.tradeFocus || 'General Service',
        language: payload.agentLanguage || 'English (US)',
        tone: payload.agentTone || 'Warm, helpful, and consultative',
        firstMessage,
        systemPrompt: mergedPrompt,
      },
      mergedPrompt,
      firstMessage,
      dynamicVariables,
    });

    return {
      callId: result.callId,
      status: result.status,
      provider: result.provider,
      engineType: result.engineType,
      fromNumber: result.fromNumber,
      phoneNumberId: result.phoneNumberId,
      assistantId: result.assistantId,
      toNumber: result.toNumber,
      mergedPrompt: result.mergedPrompt,
      dynamicVariables: result.dynamicVariables,
      error: result.error,
    };
  }

  /**
   * Fetches a single call's full details (status, recording link, timestamped transcript, cost)
   * from the active Voice Calling Engine (`GET /call/:callId`).
   */
  static async getCallDetails(
    orgId: string,
    callId: string
  ): Promise<VoiceEngineCallResultPayload | null> {
    if (!callId) return null;
    const { engine, context } = await VoiceEngineFactory.resolveForOrganization(orgId);
    return engine.getCallDetails(context, callId);
  }

  /**
   * Lists recent completed/active calls from the active Voice Calling Engine.
   */
  static async listRecentEngineCalls(
    orgId: string,
    limit: number = 10
  ): Promise<VoiceEngineCallResultPayload[]> {
    const { engine, context } = await VoiceEngineFactory.resolveForOrganization(orgId);
    if (engine instanceof VapiVoiceEngine) {
      return engine.listRecentCalls(context, limit);
    }
    return [];
  }

  /**
   * Parses an inbound webhook payload from the active Voice Calling Engine (e.g. Vapi `end-of-call-report`).
   */
  static async parseEngineWebhook(
    orgId: string,
    rawBody: any
  ): Promise<VoiceEngineCallResultPayload | null> {
    const { engine } = await VoiceEngineFactory.resolveForOrganization(orgId);
    return engine.parseWebhookPayload(rawBody);
  }

  private static activeCallResultWatchers = new Set<string>();

  /**
   * Background server-side completion listener (Way 2).
   * Once an outbound call is initiated and its initial `CALL_INITIATED` row is created in `bee_call_logs`,
   * the backend monitors the Voice Engine session until the call ends and the recording + timestamped
   * transcript artifact are generated, then posts the result directly back into the same `bee_call_logs` row.
   */
  static schedulePostCallResultDelivery(
    orgId: string,
    callId: string,
    onResultReady: (result: VoiceEngineCallResultPayload) => Promise<void>
  ): void {
    const cleanId = (callId || '').trim();
    if (!cleanId) return;
    if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
    if (this.activeCallResultWatchers.has(cleanId)) return;

    this.activeCallResultWatchers.add(cleanId);

    (async () => {
      try {
        // Check up to 40 times (~6.5 minutes max call duration)
        let endedWithoutRecordingCount = 0;
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise((r) => setTimeout(r, attempt < 6 ? 5000 : 10000));

          const details = await this.getCallDetails(orgId, cleanId);
          if (!details) continue;

          if (details.status === 'failed') {
            await onResultReady(details);
            break;
          }

          if (details.status === 'ended') {
            // Vapi sometimes takes 2-4 seconds after call hangup to finalize the recording WAV URL
            if (!details.recordingUrl && endedWithoutRecordingCount < 2) {
              endedWithoutRecordingCount++;
              continue;
            }
            logger.info(
              `[BeeVoiceAdapter] Call ${cleanId} completed on Voice Engine (${details.durationSeconds}s, ${details.transcript.length} turns). Posting result to BeeCallLog...`
            );
            await onResultReady(details);
            break;
          }
        }
      } catch (err) {
        logger.error(`[BeeVoiceAdapter] Error in post-call result delivery for ${cleanId}:`, err);
      } finally {
        this.activeCallResultWatchers.delete(cleanId);
      }
    })();
  }
}
