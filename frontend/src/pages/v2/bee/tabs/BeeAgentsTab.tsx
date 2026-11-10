import React, { useState, useMemo, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useBeeStore } from '@/stores/beeStore';
import {
  BeeAgentItem,
  BeeAgentConversationFlow,
  BeeTestCallResponse,
  BeeSampleJobContext,
} from '@/lib/api/bee';
import { BeeJobSearchSelect } from '../components/BeeJobSearchSelect';
import {
  Plus,
  Play,
  Square,
  Volume2,
  VolumeX,
  Check,
  CheckCircle2,
  AlertCircle,
  Eye,
  Lock,
  Database,
  Receipt,
  ListOrdered,
  DollarSign,
  CalendarClock,
  MessageSquare,
  StickyNote,
  Trash2,
  Phone,
  Tag,
  PhoneCall,
  Sparkles,
} from 'lucide-react';
import { Heading } from '@/ui-kit/components/ui/heading';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, formatPhone, formatPhoneInput } from '@/lib/utils';

export interface JobContextFieldDefinition {
  key: string;
  label: string;
  token: string;
  shortDesc: string;
  details: string;
  icon: React.ComponentType<{ className?: string }>;
  sensitive?: boolean;
}

export const JOB_CONTEXT_FIELD_DEFINITIONS: JobContextFieldDefinition[] = [
  {
    key: 'assigned_team',
    label: 'Assigned Team',
    token: '{{assigned_team}}',
    shortDesc: 'Technicians, dispatcher & salesperson on the job',
    details:
      'Pulls assigned visit technicians, job dispatcher, and salesperson names so the agent can mention who serviced the property.',
    icon: CalendarClock,
  },
  {
    key: 'job_notes',
    label: 'Job Notes',
    token: '{{job_notes}}',
    shortDesc: 'Scope notes, completion notes & estimate notes',
    details:
      'Includes job scope_notes, technician completion_notes, estimate notes, and visit field notes.',
    icon: StickyNote,
  },
  {
    key: 'invoice_sent',
    label: 'Invoice Sent',
    token: '{{invoice_sent}}',
    shortDesc: 'Invoice #, status, sent/paid dates, billed & balance due',
    details:
      'References all invoices sent for the job including invoice number, payment status, sent date, paid date, total billed, and balance due.',
    icon: Receipt,
  },
  {
    key: 'line_items',
    label: 'Line Items (Qty, Description, Price, Discount)',
    token: '{{line_items}}',
    shortDesc: 'Itemized qty, description, unit price, discount & total',
    details:
      'Itemizes every job line item with quantity, description, unit price, discount amount, and line total.',
    icon: ListOrdered,
  },
  {
    key: 'total_costs',
    label: 'Total Costs',
    token: '{{total_costs}}',
    shortDesc: 'Subtotal, discounts, tax rate/amount & grand total',
    details:
      'Provides full customer-facing job totals including subtotal, discount, tax rate, tax amount, grand total, and invoiced total.',
    icon: DollarSign,
  },
  {
    key: 'internal_costs',
    label: 'Internal Costs',
    token: '{{internal_costs}}',
    shortDesc: 'Internal material cost, labor hours & overhead',
    details:
      'Provides internal unit costs, labor hours, and overhead metrics for margin-aware renewal offers (kept internal unless explicitly referenced).',
    icon: Lock,
    sensitive: true,
  },
  {
    key: 'visits',
    label: 'Visits',
    token: '{{visits}}',
    shortDesc: 'Visit history, dates, status, techs & visit notes',
    details:
      'Lists all scheduled and completed visits on the job with timestamps, assigned technicians, and visit notes.',
    icon: CalendarClock,
  },
  {
    key: 'communication_history',
    label: 'Communication History',
    token: '{{communication_history}}',
    shortDesc: 'Recent SMS, emails, prior call logs & timeline events',
    details:
      'Summarizes recent SMS messages, emails, prior voice call outcomes, manual communication logs, and job timeline events.',
    icon: MessageSquare,
  },
];

const DEFAULT_CONVERSATION_FLOW: Required<BeeAgentConversationFlow> = {
  greeting_pitch:
    'Hi {{customer_name}}, this is {{agent_persona}} calling from {{company_name}} on a recorded line. I am checking in on the {{job_type}} work our team completed for you on Job {{job_number}}.',
  checkin_flow:
    'Before we talk about coverage, I wanted to make sure everything from our visit ({{line_items}}) with {{assigned_team}} is still working smoothly for you. Have you noticed any issues since we wrapped up?',
  warranty_offer_pitch:
    'Because your current warranty coverage on {{job_type}} is coming up for renewal on {{warranty_end_date}}, we can extend full parts and labor protection so you have zero surprise repair bills.',
  new_work_pitch:
    'While I have you on the line, is there any other equipment, maintenance, or new project around the property you would like our technicians to take a look at?',
  objection_handling:
    'If the customer asks about past billing or what was included, reference {{invoice_sent}} and {{total_costs}} clearly. If they want time to think, offer to email or text the plan details with no pressure.',
  custom_instructions:
    'Keep responses natural and under 2 sentences at a time. Use the selected Job Info variables naturally when answering customer questions.',
};

const DEFAULT_JOB_CONTEXT_FIELDS = [
  'assigned_team',
  'job_notes',
  'invoice_sent',
  'line_items',
  'total_costs',
  'visits',
  'communication_history',
];

type FlowFieldKey = keyof BeeAgentConversationFlow;
type WizardStepId = 'basics' | 'conversation_flow' | 'launch';

const WIZARD_STEPS: Array<{ id: WizardStepId; label: string }> = [
  { id: 'basics', label: '1. Basics' },
  { id: 'conversation_flow', label: '2. Conversation flow' },
  { id: 'launch', label: '3. Test & launch' },
];

export interface ElevenLabsVoiceOption {
  id: string; // Vapi 11labs voice ID
  name: string;
  gender: 'Female' | 'Male';
  accent: string;
  description: string;
  previewUrl: string;
}

export const ELEVENLABS_VAPI_VOICES: ElevenLabsVoiceOption[] = [
  {
    id: '21m00Tcm4TlvDq8ikWAM',
    name: 'Rachel',
    gender: 'Female',
    accent: 'American · Calm',
    description: 'Warm, professional, balanced, ideal for customer care',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/previews/voices/21m00Tcm4TlvDq8ikWAM/american_calm_middle-aged.mp3',
  },
  {
    id: 'pNInz6obpgDQGcFmaJgB',
    name: 'Adam',
    gender: 'Male',
    accent: 'American · Deep',
    description: 'Grounded, warm, narrative, consultative',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/previews/voices/pNInz6obpgDQGcFmaJgB/american_deep_middle-aged.mp3',
  },
  {
    id: 'EXAVITQu4vr4xnSDxMaL',
    name: 'Sarah',
    gender: 'Female',
    accent: 'American · Soft',
    description: 'Natural, friendly, reassuring, great for warranties',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/previews/voices/EXAVITQu4vr4xnSDxMaL/american_soft_young.mp3',
  },
  {
    id: '29vD33N1CtxCmqQRPOHJ',
    name: 'Drew',
    gender: 'Male',
    accent: 'American · Confident',
    description: 'Polished, articulate, direct, business-oriented',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/previews/voices/29vD33N1CtxCmqQRPOHJ/american_well-rounded_middle-aged.mp3',
  },
  {
    id: 'XB0fDUnXU5powFXDhCwa',
    name: 'Charlotte',
    gender: 'Female',
    accent: 'Swedish/English · Clear',
    description: 'Conversational, energetic, crisp enunciation',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/previews/voices/XB0fDUnXU5powFXDhCwa/swedish_seductive_young.mp3',
  },
  {
    id: 'N2lVS1w4EtoT3dr4eOWO',
    name: 'Callum',
    gender: 'Male',
    accent: 'Transatlantic · Casual',
    description: 'Conversational, friendly, accessible',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/previews/voices/N2lVS1w4EtoT3dr4eOWO/transatlantic_intense_young.mp3',
  },
  {
    id: 'Xb7hH8MSUJpSbSDYk0k2',
    name: 'Alice',
    gender: 'Female',
    accent: 'British · Confident',
    description: 'Sophisticated, pleasant, clear',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/previews/voices/Xb7hH8MSUJpSbSDYk0k2/british_confident_middle-aged.mp3',
  },
  {
    id: 'nPczCjzI2devNBz1zQrb',
    name: 'Brian',
    gender: 'Male',
    accent: 'American · Resonant',
    description: 'Deep, steady, reassuring, authoritative',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/previews/voices/nPczCjzI2devNBz1zQrb/american_deep_middle-aged.mp3',
  },
  {
    id: 'pFZP5JQG7iQjIQuC4Bku',
    name: 'Lily',
    gender: 'Female',
    accent: 'British · Warm',
    description: 'Gentle, engaging, warm demeanor',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/previews/voices/pFZP5JQG7iQjIQuC4Bku/british_warm_middle-aged.mp3',
  },
  {
    id: 'onwK4e9ZLuTAKqWW03F9',
    name: 'Daniel',
    gender: 'Male',
    accent: 'British · Authoritative',
    description: 'Formal, precise, executive presence',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/previews/voices/onwK4e9ZLuTAKqWW03F9/british_authoritative_middle-aged.mp3',
  },
];

export const DEFAULT_ELEVENLABS_VOICE: ElevenLabsVoiceOption = ELEVENLABS_VAPI_VOICES[0]!;

const TONE_OPTIONS = [
  {
    value: 'Warm, consultative, empathetic',
    label: 'Warm, consultative, empathetic',
    rule: 'Speak with genuine warmth, empathy, and active listening. Validate customer comments, never pressure or hurry them, and frame warranty plans as protective peace-of-mind.',
  },
  {
    value: 'Professional, direct, concise',
    label: 'Professional, direct, concise',
    rule: 'Maintain a direct, concise, and professional tone. Get straight to key facts and coverage dates, speak clearly, and avoid filler or unnecessary small talk.',
  },
  {
    value: 'Friendly, energetic, proactive',
    label: 'Friendly, energetic, proactive',
    rule: 'Use a friendly, upbeat, and proactive energy. Radiate positive enthusiasm, highlight renewal perks and discounts with optimism.',
  },
  {
    value: 'Supportive, reassuring, patient',
    label: 'Supportive, reassuring, patient',
    rule: 'Adopt a reassuring, patient, and supportive manner. Explain technical terms simply, speak calmly, and prioritize the customer’s comfort and reassurance.',
  },
];

const DEFAULT_MOCK_AGENTS: BeeAgentItem[] = [
  {
    id: 'mock-agent-doors',
    name: 'Warranty - Doors',
    persona_name: 'Rachel',
    voice_id: '21m00Tcm4TlvDq8ikWAM',
    trade_focus: 'Doors & Entry Systems',
    trigger_days_before: 30,
    eligible_job_types: ['Installation', 'Service'],
    language: 'English',
    languages: ['English'],
    is_active: true,
    calls_today: 38,
  },
  {
    id: 'mock-agent-security',
    name: 'Warranty - Security',
    persona_name: 'Adam',
    voice_id: 'pNInz6obpgDQGcFmaJgB',
    trade_focus: 'Security Systems',
    trigger_days_before: 30,
    eligible_job_types: ['Installation', 'Service'],
    language: 'English',
    languages: ['English'],
    is_active: true,
    calls_today: 9,
  },
  {
    id: 'mock-agent-fire-doors',
    name: 'Commercial Care - Fire Doors',
    persona_name: 'Sarah',
    voice_id: 'EXAVITQu4vr4xnSDxMaL',
    trade_focus: 'Fire Doors',
    trigger_days_before: 30,
    eligible_job_types: ['Inspection', 'Service'],
    language: 'English',
    languages: ['English'],
    is_active: false,
    calls_today: 0,
  },
];

export const resolveVoiceForAgent = (agent: BeeAgentItem): ElevenLabsVoiceOption => {
  return (
    ELEVENLABS_VAPI_VOICES.find(
      (v) =>
        v.id === agent.voice_id ||
        v.name.toLowerCase() === agent.voice_id?.toLowerCase() ||
        v.name.toLowerCase() === agent.persona_name?.toLowerCase()
    ) || DEFAULT_ELEVENLABS_VOICE
  );
};

export const formatJobNumber = (num?: string): string => {
  if (!num) return '';
  const clean = num.replace(/^#+/, '');
  return clean ? `#${clean}` : '';
};

export const BeeAgentsTab: React.FC = () => {
  const {
    agents,
    availableNumbers,
    sampleJobs,
    agentCompanyName,
    settings,
    loadAgents,
    loadSettings,
    updateSettings,
    createAgent,
    updateAgent,
    deleteAgent,
    triggerTestCallFull,
  } = useBeeStore();

  // Wizard / Editor Panel State
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [activeWizardStep, setActiveWizardStep] = useState<WizardStepId>('basics');
  const [isSavingAgent, setIsSavingAgent] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // Agent Form Fields (Step 1: Basics - only Agent Name, Voice, Language, Tone)
  const [name, setName] = useState('Commercial Care - Fire Doors');
  const [voiceId, setVoiceId] = useState('21m00Tcm4TlvDq8ikWAM');
  const [tone, setTone] = useState('Warm, consultative, empathetic');
  const [isActive, setIsActive] = useState(true);

  // Voice Preview State
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  // Step 2: Conversation flow (merged with What to offer + Script & rules)
  const [selectedJobFields, setSelectedJobFields] = useState<string[]>(
    DEFAULT_JOB_CONTEXT_FIELDS
  );
  const [conversationFlow, setConversationFlow] =
    useState<Required<BeeAgentConversationFlow>>(DEFAULT_CONVERSATION_FLOW);
  const [activeFlowField, setActiveFlowField] =
    useState<FlowFieldKey>('greeting_pitch');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  // Early renewal packages pitched in Section 3 (Warranty Pitch)
  const [selectedPlans, setSelectedPlans] = useState<string[]>([
    '1-Year Warranty Extension ($199/yr or $19/mo)',
    '2-Year Complete Protection ($349/2yr)',
  ]);
  const [discountOffer, setDiscountOffer] = useState('10% early renewal discount');
  const [crossSellOffer, setCrossSellOffer] = useState(
    'Annual tune-up inspection ($89 special)'
  );

  // Script Preview with Referenced Existing Job
  const [previewJobId, setPreviewJobId] = useState<string>('');

  // Step 3: Test & launch
  const [testToNumber, setTestToNumber] = useState('');
  const [testFromNumber, setTestFromNumber] = useState('');
  const [testJobId, setTestJobId] = useState('');
  const [isTriggeringTestCall, setIsTriggeringTestCall] = useState(false);
  const [testCallResponse, setTestCallResponse] =
    useState<BeeTestCallResponse | null>(null);

  // Delete modal state
  const [agentToDelete, setAgentToDelete] = useState<BeeAgentItem | null>(null);
  const [isDeletingAgent, setIsDeletingAgent] = useState(false);

  // Voice Engine (Vapi / API Key) Modal State
  const [isEngineModalOpen, setIsEngineModalOpen] = useState(false);
  const [engineProvider, setEngineProvider] = useState<string>('vapi');
  const [vapiApiKeyInput, setVapiApiKeyInput] = useState<string>('');
  const [isSavingEngine, setIsSavingEngine] = useState(false);
  const [engineSaveFeedback, setEngineSaveFeedback] = useState<string | null>(null);

  // Standalone quick Test Call modal state
  const [isQuickTestOpen, setIsQuickTestOpen] = useState(false);
  const [quickTestAgent, setQuickTestAgent] = useState<BeeAgentItem | null>(null);

  useEffect(() => {
    loadAgents();
    loadSettings();
  }, [loadAgents, loadSettings]);

  useEffect(() => {
    if (settings) {
      const prov = (settings.voice_provider || 'vapi').toLowerCase();
      setEngineProvider(
        prov === 'cascade' || prov === 'speech_to_speech' ? prov : 'vapi'
      );
      if (settings.voice_provider_api_key) {
        setVapiApiKeyInput(settings.voice_provider_api_key);
      }
    }
  }, [settings]);

  useEffect(() => {
    if (sampleJobs.length > 0 && !testJobId && sampleJobs[0]?.id) {
      setTestJobId(sampleJobs[0].id);
      if (!previewJobId) setPreviewJobId(sampleJobs[0].id);
    }
  }, [sampleJobs, testJobId, previewJobId]);

  useEffect(() => {
    if (availableNumbers.length > 0) {
      const def =
        availableNumbers.find((n) => n.source === 'vapi') ||
        availableNumbers.find((n) => n.isDefault) ||
        availableNumbers[0];
      if (def && !testFromNumber) {
        setTestFromNumber(def.phoneNumber || def.friendlyName);
      }
    }
  }, [availableNumbers, testFromNumber]);

  // Display agents list: merge real agents with mock fallback if empty
  const displayAgents = useMemo(() => {
    if (agents && agents.length > 0) {
      return agents.map((a, idx) => {
        const fallback =
          DEFAULT_MOCK_AGENTS[idx % DEFAULT_MOCK_AGENTS.length] ??
          DEFAULT_MOCK_AGENTS[0]!;
        return {
          ...a,
          calls_today:
            a.calls_today ?? (a.is_active ? (idx === 0 ? 38 : idx === 1 ? 9 : 12) : 0),
          persona_name: a.persona_name || fallback.persona_name,
        };
      });
    }
    return DEFAULT_MOCK_AGENTS;
  }, [agents]);

  // Voice Preview Playback (ElevenLabs sample + browser speech fallback)
  const handlePlayVoicePreview = (voice: ElevenLabsVoiceOption) => {
    if (playingVoiceId === voice.id) {
      if (audioPreviewRef.current) {
        audioPreviewRef.current.pause();
        audioPreviewRef.current.currentTime = 0;
      }
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
      setPlayingVoiceId(null);
      return;
    }

    if (audioPreviewRef.current) {
      audioPreviewRef.current.pause();
      audioPreviewRef.current.currentTime = 0;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    if (voice.previewUrl) {
      let fallbackTriggered = false;
      const triggerFallback = () => {
        if (!fallbackTriggered) {
          fallbackTriggered = true;
          playFallbackSpeech(voice);
        }
      };

      const audio = new Audio(voice.previewUrl);
      audioPreviewRef.current = audio;
      setPlayingVoiceId(voice.id);
      audio.onended = () => {
        setPlayingVoiceId(null);
      };
      audio.onerror = () => {
        triggerFallback();
      };
      audio.play().catch(() => {
        triggerFallback();
      });
    } else {
      playFallbackSpeech(voice);
    }
  };

  const playFallbackSpeech = (voice: ElevenLabsVoiceOption) => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const text = `Hi, this is ${voice.name} calling on behalf of ${
        agentCompanyName || 'our company'
      }. I am checking in on your recent warranty service.`;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.pitch = voice.gender === 'Female' ? 1.15 : 0.92;
      utterance.rate = 1.0;
      setPlayingVoiceId(voice.id);
      utterance.onend = () => setPlayingVoiceId(null);
      utterance.onerror = (e) => {
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
          setPlayingVoiceId(null);
        }
      };
      window.speechSynthesis.speak(utterance);
    }
  };

  const openCreateModal = () => {
    setEditingAgentId(null);
    setEditorError(null);
    setName('Warranty Care Specialist');
    setVoiceId(DEFAULT_ELEVENLABS_VOICE.id);
    setTone('Warm, consultative, empathetic');
    setIsActive(true);
    setSelectedJobFields([...DEFAULT_JOB_CONTEXT_FIELDS]);
    setConversationFlow({ ...DEFAULT_CONVERSATION_FLOW });
    setSelectedPlans([
      '1-Year Warranty Extension ($199/yr or $19/mo)',
      '2-Year Complete Protection ($349/2yr)',
    ]);
    setDiscountOffer('10% early renewal discount');
    setCrossSellOffer('Annual tune-up inspection ($89 special)');
    setActiveWizardStep('basics');
    setIsEditorOpen(true);
  };

  const openEditModal = (agent: BeeAgentItem) => {
    setEditingAgentId(agent.id);
    setEditorError(null);
    setName(agent.name || '');
    const matchedVoice = ELEVENLABS_VAPI_VOICES.find(
      (v) =>
        v.id === agent.voice_id ||
        v.name.toLowerCase() === (agent.persona_name || '').toLowerCase()
    );
    setVoiceId(matchedVoice ? matchedVoice.id : DEFAULT_ELEVENLABS_VOICE.id);
    setTone(agent.tone || 'Warm, consultative, empathetic');
    setIsActive(agent.is_active ?? true);
    setSelectedJobFields(
      Array.isArray(agent.job_context_fields) && agent.job_context_fields.length > 0
        ? agent.job_context_fields
        : [...DEFAULT_JOB_CONTEXT_FIELDS]
    );
    setConversationFlow({
      ...DEFAULT_CONVERSATION_FLOW,
      ...(agent.conversation_flow || {}),
    });
    setActiveWizardStep('basics');
    setIsEditorOpen(true);
  };

  const handleDuplicate = async (agent: BeeAgentItem) => {
    try {
      const payload: Partial<BeeAgentItem> = {
        name: `${agent.name} (Copy)`,
        persona_name: agent.persona_name || 'Rachel',
        voice_id: agent.voice_id || DEFAULT_ELEVENLABS_VOICE.id,
        language: 'English',
        languages: ['English'],
        tone: agent.tone || 'Warm, consultative, empathetic',
        is_active: false,
        version: '0',
        job_context_fields: agent.job_context_fields || DEFAULT_JOB_CONTEXT_FIELDS,
        conversation_flow: agent.conversation_flow || DEFAULT_CONVERSATION_FLOW,
      };
      await createAgent(payload);
    } catch {
      // handled in store
    }
  };

  const handleToggleAgentStatus = async (agent: BeeAgentItem) => {
    try {
      const nextActive = !agent.is_active;
      await updateAgent(agent.id, { is_active: nextActive });
      toast.success(nextActive ? `${agent.name} is now Active` : `${agent.name} set to Draft`);
    } catch {
      toast.error('Failed to update agent status');
    }
  };

  const openQuickTestCall = (agent: BeeAgentItem) => {
    setQuickTestAgent(agent);
    setTestCallResponse(null);
    if (availableNumbers.length > 0) {
      const matched =
        availableNumbers.find((n) => n.phoneNumber === agent.default_from_number) ||
        availableNumbers[0];
      if (matched) setTestFromNumber(matched.phoneNumber);
    }
    setIsQuickTestOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!agentToDelete) return;
    try {
      setIsDeletingAgent(true);
      if (!agentToDelete.id.startsWith('mock-agent-')) {
        await deleteAgent(agentToDelete.id);
      }
      setAgentToDelete(null);
    } catch {
      // handled in store
    } finally {
      setIsDeletingAgent(false);
    }
  };

  const handleSaveAgent = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!name.trim()) {
      setEditorError('Please enter an Agent Name.');
      setActiveWizardStep('basics');
      return;
    }

    try {
      setIsSavingAgent(true);
      setEditorError(null);
      const selectedVoiceObj =
        ELEVENLABS_VAPI_VOICES.find((v) => v.id === voiceId) || DEFAULT_ELEVENLABS_VOICE;

      const payload: Partial<BeeAgentItem> = {
        name: name.trim(),
        persona_name: selectedVoiceObj.name,
        voice_id: voiceId,
        language: 'English',
        languages: ['English'],
        tone,
        voice_engine: engineProvider || 'vapi',
        is_active: isActive,
        job_context_fields: selectedJobFields,
        conversation_flow: conversationFlow,
        warranty_offer_pitch: conversationFlow.warranty_offer_pitch,
        new_work_pitch: conversationFlow.new_work_pitch,
      };

      if (editingAgentId && !editingAgentId.startsWith('mock-agent-')) {
        await updateAgent(editingAgentId, payload);
      } else {
        await createAgent(payload);
      }
      setIsEditorOpen(false);
    } catch (err: any) {
      setEditorError(
        err.response?.data?.error || err.message || 'Failed to save agent'
      );
    } finally {
      setIsSavingAgent(false);
    }
  };

  const handleTriggerTestCall = async (targetPhone: string, fromPhone: string, agentId?: string) => {
    if (!targetPhone.trim()) return;
    try {
      setIsTriggeringTestCall(true);
      setTestCallResponse(null);
      const matchedNum = availableNumbers.find(
        (n) => n.phoneNumber === fromPhone || n.e164 === fromPhone || n.id === fromPhone
      );
      // Explicitly include latest conversationFlow and selectedJobFields
      const res = await triggerTestCallFull({
        toNumber: targetPhone.trim(),
        phoneNumber: targetPhone.trim(),
        fromNumber: fromPhone.trim() || undefined,
        phoneNumberId: matchedNum?.vapiPhoneNumberId || matchedNum?.id || undefined,
        agentId: agentId || (editingAgentId && !editingAgentId.startsWith('mock-agent-') ? editingAgentId : undefined),
        jobId: testJobId || undefined,
        conversationFlow,
        selectedJobContextFields: selectedJobFields,
      });
      setTestCallResponse(res);
      if (res.ok) {
        useBeeStore.getState().loadCalls(1);
      }
    } catch (err: any) {
      setTestCallResponse({
        ok: false,
        error: err.message || 'Failed to trigger test call.',
      });
    } finally {
      setIsTriggeringTestCall(false);
    }
  };

  const insertVariableIntoFlow = (token: string) => {
    setConversationFlow((prev) => {
      const current = prev[activeFlowField] || '';
      const needsSpace =
        current.length > 0 && !current.endsWith(' ') && !current.endsWith('\n');
      return {
        ...prev,
        [activeFlowField]: `${current}${needsSpace ? ' ' : ''}${token}`,
      };
    });
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 1400);
  };

  const toggleJobContextField = (key: string) => {
    setSelectedJobFields((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const [activePreviewJob, setActivePreviewJob] = useState<BeeSampleJobContext | null>(null);

  // Referenced Job calculation for live conversation script preview
  const selectedPreviewJob = useMemo(() => {
    if (activePreviewJob && activePreviewJob.id === previewJobId) return activePreviewJob;
    if (previewJobId && sampleJobs.length) {
      const found = sampleJobs.find((j) => j.id === previewJobId);
      if (found) return found;
    }
    return activePreviewJob || sampleJobs[0] || null;
  }, [activePreviewJob, sampleJobs, previewJobId]);

  const compiledScriptPreview = useMemo(() => {
    if (!selectedPreviewJob) return null;
    const j = selectedPreviewJob;
    const rawVars = (j.job_context_variables || {}) as Record<string, string>;

    const formatVar = (key: string, fallback: string) => {
      if (!selectedJobFields.includes(key)) return `[${key} not enabled]`;
      return rawVars[key] || fallback;
    };

    const vars: Record<string, string> = {
      customer_name: j.customer_name || 'Customer',
      customer_phone: formatPhone(j.customer_phone) || '(555) 000-0000',
      company_name: agentCompanyName || 'ServWave',
      agent_persona: ELEVENLABS_VAPI_VOICES.find((v) => v.id === voiceId)?.name || 'Rachel',
      agent_tone: tone,
      agent_language: 'English',
      job_number: formatJobNumber(j.job_number) || 'JOB-1001',
      job_type: j.job_type || 'General Service',
      service_request: j.service_request || j.job_type || 'Warranty service inspection',
      service_address: j.service_address || '123 Main Street',
      warranty_end_date: j.warranty_end_date
        ? new Date(j.warranty_end_date).toLocaleDateString([], {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
        : 'within 30 days',
      assigned_team: formatVar('assigned_team', 'Dave Tech (Senior Technician)'),
      job_notes: formatVar('job_notes', 'All equipment tested and verified operating correctly.'),
      invoice_sent: formatVar('invoice_sent', 'Invoice #INV-2041 sent on completion, paid in full ($480).'),
      line_items: formatVar('line_items', '1x Standard Unit, 2x Hardware Assemblies'),
      total_costs: formatVar('total_costs', '$480.00 total'),
      internal_costs: formatVar('internal_costs', '[Confidential Internal Costs]'),
      visits: formatVar('visits', '1 completed visit on record'),
      communication_history: formatVar('communication_history', 'Completion confirmation SMS delivered'),
      renewal_plans: selectedPlans.join(', '),
      renewal_discount: discountOffer,
    };

    const renderText = (template: string) => {
      return (template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
        return vars[k] !== undefined ? vars[k] : `{{${k}}}`;
      });
    };

    return {
      greeting: renderText(conversationFlow.greeting_pitch),
      checkin: renderText(conversationFlow.checkin_flow),
      warranty: renderText(conversationFlow.warranty_offer_pitch),
      newWork: renderText(conversationFlow.new_work_pitch),
      objections: renderText(conversationFlow.objection_handling),
      rules: renderText(conversationFlow.custom_instructions),
    };
  }, [
    selectedPreviewJob,
    selectedJobFields,
    agentCompanyName,
    voiceId,
    tone,
    conversationFlow,
    selectedPlans,
    discountOffer,
  ]);

  const handleSaveEngineConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSavingEngine(true);
      setEngineSaveFeedback(null);
      await updateSettings({
        voice_provider: engineProvider,
        ...(vapiApiKeyInput.trim()
          ? { voice_provider_api_key: vapiApiKeyInput.trim() }
          : {}),
      });
      await loadAgents();
      setEngineSaveFeedback(
        'Voice Calling Engine configuration saved and phone lines synchronized!'
      );
    } catch (err: any) {
      setEngineSaveFeedback(
        err.message || 'Failed to update Voice Engine configuration.'
      );
    } finally {
      setIsSavingEngine(false);
    }
  };

  const selectedVoice: ElevenLabsVoiceOption =
    ELEVENLABS_VAPI_VOICES.find((v) => v.id === voiceId) || DEFAULT_ELEVENLABS_VOICE;

  return (
    <div className="space-y-6 text-slate-900 font-sans">
      {/* Top Header */}
      <div className="flex items-center justify-between">
        <Heading level={1} scale="xl" className="font-bold text-slate-900 tracking-tight">
          Agents
        </Heading>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={openCreateModal}
            className="h-9 bg-[#0c192c] hover:bg-slate-800 text-white font-semibold text-xs px-4 rounded-lg flex items-center gap-1.5 shadow-sm transition-all"
          >
            <Plus className="h-3.5 w-3.5" />
            Deploy new agent
          </Button>
        </div>
      </div>

      {/* Agents Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {displayAgents.map((agent) => {
          const isRunning = Boolean(agent.is_active);
          const agentVoice = resolveVoiceForAgent(agent);
          const isVoicePlaying = playingVoiceId === agentVoice.id;

          return (
            <div
              key={agent.id}
              className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs flex flex-col justify-between hover:border-slate-300 transition-all"
            >
              <div>
                {/* Title and Status Badge */}
                <div className="flex items-start justify-between gap-3">
                  <h3
                    className="font-bold text-base text-slate-900 break-words whitespace-normal leading-snug flex-1"
                    title={agent.name}
                  >
                    {agent.name}
                  </h3>

                  <button
                    type="button"
                    onClick={() => handleToggleAgentStatus(agent)}
                    title={`Click to set as ${isRunning ? 'Draft' : 'Active'}`}
                    className="cursor-pointer select-none focus:outline-none focus:ring-2 focus:ring-primary/20 rounded-full transition-transform active:scale-95"
                  >
                    <Badge
                      tone={isRunning ? 'success' : 'neutral'}
                      variant="outline"
                      className={cn(
                        'rounded-full px-3 py-0.5 text-xs font-semibold shrink-0 cursor-pointer select-none border transition-colors',
                        isRunning
                          ? 'bg-success-surface text-success-text border-success-border hover:bg-success-surface/80'
                          : 'bg-neutral-surface text-neutral-text border-neutral-border hover:bg-neutral-surface/80'
                      )}
                    >
                      {isRunning ? 'Active' : 'Draft'}
                    </Badge>
                  </button>
                </div>

                {/* Subtitle Line (Version removed) */}
                <p className="text-xs text-slate-500 font-normal mt-1 truncate">
                  {agent.persona_name || agentVoice.name} · {agent.language || 'English'}
                </p>

                {/* Redesigned Metrics & One-click Voice Preview (Lead rate & Version removed) */}
                <div className="flex items-center justify-between my-4 p-3.5 rounded-xl bg-slate-50/80 border border-slate-100">
                  <div>
                    <div className="text-2xl font-bold text-slate-900 leading-tight">
                      {agent.calls_today ?? 0}
                    </div>
                    <div className="text-xs text-slate-500 font-normal mt-0.5">
                      calls today
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handlePlayVoicePreview(agentVoice)}
                    className={cn(
                      'h-9 px-3 flex items-center gap-1.5 rounded-lg border text-xs font-semibold transition-all shadow-2xs',
                      isVoicePlaying
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-800 animate-pulse'
                        : 'border-slate-200 bg-white hover:bg-slate-100/80 text-slate-700'
                    )}
                    title={
                      isVoicePlaying
                        ? `Stop ${agentVoice.name} voice preview`
                        : `Listen to ${agentVoice.name}'s voice (${agentVoice.gender} · ${agentVoice.accent})`
                    }
                  >
                    {isVoicePlaying ? (
                      <>
                        <VolumeX className="h-3.5 w-3.5 text-emerald-700" />
                        <span>Stop voice</span>
                      </>
                    ) : (
                      <>
                        <Volume2 className="h-3.5 w-3.5 text-slate-600" />
                        <span>Play voice</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Action Buttons Row: Edit, Duplicate, Test call, Delete */}
              <div className="grid grid-cols-4 gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => openEditModal(agent)}
                  className="w-full py-1.5 px-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs text-center transition-colors"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleDuplicate(agent)}
                  className="w-full py-1.5 px-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs text-center transition-colors"
                >
                  Duplicate
                </button>
                <button
                  type="button"
                  onClick={() => openQuickTestCall(agent)}
                  className="w-full py-1.5 px-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs text-center transition-colors"
                >
                  Test call
                </button>
                <button
                  type="button"
                  onClick={() => setAgentToDelete(agent)}
                  className="w-full py-1.5 px-2 rounded-lg border border-rose-200 bg-white hover:bg-rose-50 text-rose-700 font-semibold text-xs text-center transition-colors flex items-center justify-center gap-1"
                  title="Delete from ServWave and Vapi"
                >
                  <Trash2 className="h-3 w-3" />
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Deploy new agent / Edit agent Modal */}
      <Dialog open={isEditorOpen} onOpenChange={setIsEditorOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-0 overflow-hidden bg-white sm:rounded-2xl border border-slate-200 shadow-2xl">
          {/* Modal Header (Pinned) */}
          <div className="shrink-0 px-6 pt-6 pb-3 border-b border-slate-100 bg-white">
            <DialogHeader className="space-y-1">
              <DialogTitle className="text-base font-bold text-slate-900">
                {editingAgentId && !editingAgentId.startsWith('mock-agent-')
                  ? `Edit agent - ${name}`
                  : 'Deploy new agent'}
              </DialogTitle>
              <DialogDescription className="text-xs text-slate-500">
                Configure your AI agent’s voice persona, tone rules, customized conversation flow, and test live calls.
              </DialogDescription>
            </DialogHeader>

            {/* Wizard Steps Tabs (3 Clean Steps) */}
            <div className="flex items-center gap-2 overflow-x-auto pb-1 mt-3 scrollbar-none">
              {WIZARD_STEPS.map((step) => {
                const isCurrent = activeWizardStep === step.id;
                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => setActiveWizardStep(step.id)}
                    className={cn(
                      'px-4 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors',
                      isCurrent
                        ? 'bg-[#0c192c] text-white shadow-xs'
                        : 'bg-slate-100 hover:bg-slate-200/80 text-slate-700'
                    )}
                  >
                    {step.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Modal Body (Scrollable) */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {editorError && (
              <div className="mb-5 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{editorError}</span>
              </div>
            )}

          {/* Step 1: Basics (Only Agent Name, Voice, Language, Tone) */}
          {activeWizardStep === 'basics' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
                {/* Agent Name */}
                <div>
                  <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                    Agent Name
                  </Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Commercial Care - Fire Doors"
                    className="h-10 text-xs rounded-lg border-slate-200"
                  />
                  <p className="text-xs text-slate-400 mt-1">
                    Internal name used on reports, call logs, and queue assignments.
                  </p>
                </div>

                {/* Voice Selection */}
                <div>
                  <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                    Voice
                  </Label>
                  <div className="flex items-center gap-2">
                    <Select value={voiceId} onValueChange={setVoiceId}>
                      <SelectTrigger className="h-10 text-xs rounded-lg border-slate-200 flex-1">
                        <SelectValue placeholder="Select voice" />
                      </SelectTrigger>
                      <SelectContent className="z-[160] max-h-72">
                        {ELEVENLABS_VAPI_VOICES.map((v) => (
                          <SelectItem key={v.id} value={v.id} className="text-xs">
                            <span className="font-semibold text-slate-900">{v.name}</span>
                            <span className="text-slate-500 ml-1.5">({v.gender} · {v.accent})</span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button
                      type="button"
                      onClick={() => handlePlayVoicePreview(selectedVoice)}
                      className={cn(
                        'h-10 px-3 flex items-center justify-center gap-1.5 rounded-lg border text-xs font-semibold transition-all shrink-0',
                        playingVoiceId === selectedVoice.id
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-800 animate-pulse'
                          : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'
                      )}
                      title={playingVoiceId === selectedVoice.id ? 'Stop voice sample' : 'Play voice sample'}
                    >
                      {playingVoiceId === selectedVoice.id ? (
                        <>
                          <Square className="h-3 w-3 fill-current" />
                          <span>Stop</span>
                        </>
                      ) : (
                        <>
                          <Play className="h-3 w-3 fill-current" />
                          <span>Preview</span>
                        </>
                      )}
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5">
                    {selectedVoice.description} ({selectedVoice.accent})
                  </p>
                </div>

                {/* Language Selection (English only) */}
                <div>
                  <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                    Language
                  </Label>
                  <Select value="English" onValueChange={() => {}}>
                    <SelectTrigger className="h-10 text-xs rounded-lg border-slate-200 w-full bg-slate-50/50">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="z-[160]">
                      <SelectItem value="English" className="text-xs">
                        English (United States)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-400 mt-1">
                    Currently supported language for automated voice calls.
                  </p>
                </div>

                {/* Tone Selection */}
                <div>
                  <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                    Tone
                  </Label>
                  <Select value={tone} onValueChange={setTone}>
                    <SelectTrigger className="h-10 text-xs rounded-lg border-slate-200">
                      <SelectValue placeholder="Select tone" />
                    </SelectTrigger>
                    <SelectContent className="z-[160]">
                      {TONE_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} className="text-xs">
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="mt-2 p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 text-[11px] text-slate-600 leading-relaxed flex items-start gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-brand shrink-0 mt-0.5" />
                    <span>
                      <strong className="text-slate-900">Injected Tone Rule: </strong>
                      {TONE_OPTIONS.find((t) => t.value === tone)?.rule || tone}
                    </span>
                  </div>
                </div>


              </div>
            </div>
          )}

          {/* Step 2: Conversation flow (Merged: Variables, Script Sections, Early Renewal Packages in Warranty Pitch, and Live Preview) */}
          {activeWizardStep === 'conversation_flow' && (
            <div className="space-y-6">
              {/* Job Info Dynamic Variables Bar */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <Database className="h-3.5 w-3.5 text-slate-700" />
                    Selected Job Info Dynamic Variables ({selectedJobFields.length}/8 enabled)
                  </span>
                  <span className="text-[11px] text-slate-500">
                    Click to toggle inclusion or insert token into active script section
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {JOB_CONTEXT_FIELD_DEFINITIONS.map((def) => {
                    const isEnabled = selectedJobFields.includes(def.key);
                    return (
                      <button
                        key={def.key}
                        type="button"
                        onClick={() => {
                          toggleJobContextField(def.key);
                          insertVariableIntoFlow(def.token);
                        }}
                        className={cn(
                          'p-2.5 rounded-lg text-xs transition-all flex flex-col justify-between text-left border',
                          isEnabled
                            ? 'bg-emerald-50/90 border-emerald-300 ring-1 ring-emerald-200 text-emerald-950 shadow-2xs font-semibold'
                            : 'bg-white/80 border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300'
                        )}
                        title={`Click to insert ${def.token} into active script stage`}
                      >
                        <div className="flex items-center justify-between w-full mb-1">
                          <span className="font-semibold text-xs truncate">
                            {def.label.split(' (')[0]}
                          </span>
                          {isEnabled ? (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-600 text-white uppercase tracking-wider">
                              Used
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-400">Available</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 font-mono text-[10px] text-slate-500">
                          <Tag className="h-2.5 w-2.5 text-slate-400 shrink-0" />
                          <span className="truncate">{def.token}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Conversation Flow Stages Tabs */}
              <div className="space-y-4">
                <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
                  {[
                    { key: 'greeting_pitch', label: '1. Greeting' },
                    { key: 'checkin_flow', label: '2. Check-In' },
                    { key: 'warranty_offer_pitch', label: '3. Warranty Pitch & Packages' },
                    { key: 'new_work_pitch', label: '4. New Job' },
                    { key: 'objection_handling', label: '5. Objections' },
                    { key: 'custom_instructions', label: '6. Rules' },
                  ].map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setActiveFlowField(tab.key as FlowFieldKey)}
                      className={cn(
                        'px-3.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors',
                        activeFlowField === tab.key
                          ? 'bg-[#0c192c] text-white shadow-xs'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                      )}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <Textarea
                  value={conversationFlow[activeFlowField] || ''}
                  onChange={(e) =>
                    setConversationFlow({
                      ...conversationFlow,
                      [activeFlowField]: e.target.value,
                    })
                  }
                  rows={4}
                  className="text-xs font-mono rounded-lg border-slate-200 leading-relaxed"
                />

                {/* Section 3: Warranty Pitch - Early Renewal Packages & Offer Integration */}
                {activeFlowField === 'warranty_offer_pitch' && (
                  <div className="rounded-xl border border-emerald-200/90 bg-emerald-50/40 p-4 space-y-4 animate-in fade-in duration-200">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-bold text-slate-900 block">
                        Early Renewal Packages & Offer Selection
                      </Label>
                      <span className="text-[11px] text-slate-500">
                        Pitched to customer when offering coverage extension
                      </span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Renewal Packages */}
                      <div className="space-y-2">
                        <span className="text-xs font-semibold text-slate-700 block">
                          Packages Pitched:
                        </span>
                        {[
                          '1-Year Warranty Extension ($199/yr or $19/mo)',
                          '2-Year Complete Protection ($349/2yr)',
                          'Monthly VIP Maintenance ($29/mo)',
                        ].map((plan) => {
                          const isSel = selectedPlans.includes(plan);
                          return (
                            <label
                              key={plan}
                              className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer"
                            >
                              <Checkbox
                                checked={isSel}
                                onCheckedChange={(c) => {
                                  if (c) setSelectedPlans([...selectedPlans, plan]);
                                  else setSelectedPlans(selectedPlans.filter((p) => p !== plan));
                                }}
                              />
                              <span>{plan}</span>
                            </label>
                          );
                        })}
                      </div>

                      {/* Early Renewal Incentive & Cross-sell */}
                      <div className="space-y-3">
                        <div>
                          <Label className="text-xs font-semibold text-slate-700 block mb-1">
                            Early renewal incentive discount:
                          </Label>
                          <Input
                            value={discountOffer}
                            onChange={(e) => setDiscountOffer(e.target.value)}
                            placeholder="e.g. 10% early renewal discount"
                            className="h-8 text-xs rounded-lg border-slate-200 bg-white"
                          />
                        </div>

                        <div>
                          <Label className="text-xs font-semibold text-slate-700 block mb-1">
                            Secondary cross-sell offer:
                          </Label>
                          <Input
                            value={crossSellOffer}
                            onChange={(e) => setCrossSellOffer(e.target.value)}
                            placeholder="e.g. Annual tune-up inspection ($89 special)"
                            className="h-8 text-xs rounded-lg border-slate-200 bg-white"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Live Conversation Script Preview using referenced existing job */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Eye className="h-4 w-4 text-brand" />
                    <span className="text-xs font-bold text-slate-900">
                      Live Conversation Script Preview
                    </span>
                    <span className="text-[11px] text-slate-500">
                      (Interpolated with actual job context variables)
                    </span>
                  </div>

                  {/* Job selector for live preview */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-600 font-medium shrink-0">Referenced job:</span>
                    <BeeJobSearchSelect
                      value={previewJobId || selectedPreviewJob?.id || ''}
                      onSelect={(job) => {
                        setPreviewJobId(job.id);
                        setActivePreviewJob(job);
                      }}
                      initialJobs={sampleJobs}
                      triggerClassName="h-8 text-xs w-[240px] bg-white border-slate-200"
                    />
                  </div>
                </div>

                {/* Simulated Script Cards */}
                <div className="space-y-3 text-xs">
                  {/* 1. Greeting */}
                  <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-2xs">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-bold text-slate-800 text-[11px] uppercase tracking-wider">
                        1. Greeting
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">Agent Opening</span>
                    </div>
                    <p className="text-slate-700 leading-relaxed font-sans">
                      &ldquo;{compiledScriptPreview?.greeting}&rdquo;
                    </p>
                  </div>

                  {/* Combined Framed Card: Check-In, Warranty Pitch & Packages */}
                  <div className="p-4 rounded-xl border-2 border-slate-200/90 bg-slate-50/60 shadow-xs space-y-3">
                    <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900 text-xs uppercase tracking-wide">
                          Check-In & Warranty Renewal Funnel
                        </span>
                        <span className="text-[10px] font-semibold text-slate-500 bg-white border border-slate-200 px-2 py-0.5 rounded-full">
                          Connected Flow
                        </span>
                      </div>
                      <span className="text-[10px] text-slate-400 font-mono">Check-in · Pitch · Packages</span>
                    </div>

                    {/* Stage A: Check-In */}
                    <div className="p-3 rounded-lg bg-white border border-slate-200/80 shadow-2xs">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-bold text-slate-800 text-[11px] uppercase tracking-wider">
                          2. Check-In
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono">Quality Assurance</span>
                      </div>
                      <p className="text-slate-700 leading-relaxed font-sans">
                        &ldquo;{compiledScriptPreview?.checkin}&rdquo;
                      </p>
                    </div>

                    {/* Stage B: Warranty Pitch & Packages */}
                    <div className="p-3 rounded-lg bg-white border border-slate-200/80 shadow-2xs space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800 text-[11px] uppercase tracking-wider">
                          3. Warranty Pitch & Early Renewal Offer
                        </span>
                        <span className="text-[10px] text-slate-400 font-mono">Renewal Pitch</span>
                      </div>
                      <p className="text-slate-700 leading-relaxed font-sans">
                        &ldquo;{compiledScriptPreview?.warranty}&rdquo;
                      </p>

                      {/* Packages & Incentives */}
                      <div className="pt-2.5 border-t border-slate-100">
                        <div className="text-[11px] font-semibold text-slate-700 mb-1.5 flex items-center justify-between">
                          <span>Offered Renewal Packages & Incentives</span>
                          {discountOffer && (
                            <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                              Incentive: {discountOffer}
                            </span>
                          )}
                        </div>
                        {selectedPlans.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5 items-center">
                            {selectedPlans.map((p) => (
                              <span
                                key={p}
                                className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"
                              >
                                {p}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400 italic">
                            No specific package selected (agent presents standard plan terms).
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 4. New Job */}
                  <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-2xs">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="font-bold text-slate-800 text-[11px] uppercase tracking-wider">
                        4. New Job Discovery
                      </span>
                      <span className="text-[10px] text-slate-400 font-mono">Cross-sell & Inquiries</span>
                    </div>
                    <p className="text-slate-700 leading-relaxed font-sans">
                      &ldquo;{compiledScriptPreview?.newWork}&rdquo;
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Test & launch */}
          {activeWizardStep === 'launch' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                    Phone number to test
                  </Label>
                  <Input
                    value={testToNumber}
                    onChange={(e) => setTestToNumber(formatPhoneInput(e.target.value))}
                    placeholder="(555) 000-0000"
                    className="h-10 text-xs rounded-lg border-slate-200"
                  />
                </div>

                <div>
                  <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                    Outbound line
                  </Label>
                  <Select value={testFromNumber} onValueChange={setTestFromNumber}>
                    <SelectTrigger className="h-10 text-xs rounded-lg border-slate-200">
                      <SelectValue placeholder="Select caller ID" />
                    </SelectTrigger>
                    <SelectContent>
                      {availableNumbers.length > 0 ? (
                        availableNumbers.map((num) => (
                          <SelectItem
                            key={num.id}
                            value={num.phoneNumber}
                            className="text-xs"
                          >
                            {num.friendlyName || formatPhone(num.phoneNumber)}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="none" disabled className="text-xs text-muted-foreground">
                          No phone numbers configured (Setup &rarr; Phone system)
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                    Sample job context
                  </Label>
                  <BeeJobSearchSelect
                    value={testJobId || selectedPreviewJob?.id || ''}
                    onSelect={(job) => {
                      setTestJobId(job.id);
                      setActivePreviewJob(job);
                    }}
                    initialJobs={sampleJobs}
                    triggerClassName="h-10 text-xs w-full rounded-lg border-slate-200"
                    placeholder="Select sample job"
                  />
                </div>
              </div>

              {availableNumbers.length === 0 && (
                <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-xs flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                  <span>
                    Bee Phone system is not configured. Please configure or buy a phone number in <b>Setup &rarr; Phone system</b> before testing calls.
                  </span>
                </div>
              )}

              {testCallResponse && (
                <div
                  className={cn(
                    'p-4 rounded-xl text-xs border flex items-start gap-2.5',
                    testCallResponse.ok
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-rose-50 border-rose-200 text-rose-800'
                  )}
                >
                  {testCallResponse.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                  )}
                  <div>
                    <div className="font-bold">
                      {testCallResponse.ok ? 'Test call initiated' : 'Test call failed'}
                    </div>
                    <div className="mt-0.5">
                      {testCallResponse.message || testCallResponse.error}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-4 border-t border-slate-100">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleTriggerTestCall(testToNumber, testFromNumber, editingAgentId || undefined)
                  }
                  disabled={isTriggeringTestCall || !testToNumber.trim() || availableNumbers.length === 0}
                  className="gap-1.5 text-xs font-semibold"
                >
                  <Phone className="h-3.5 w-3.5 text-slate-600" />
                  {isTriggeringTestCall ? 'Dialing test call...' : 'Trigger Test Call'}
                </Button>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsEditorOpen(false)}
                    className="text-xs font-semibold"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={() => handleSaveAgent()}
                    disabled={isSavingAgent}
                    className="bg-[#0c192c] hover:bg-slate-800 text-white font-semibold text-xs px-5 shadow-sm"
                  >
                    {isSavingAgent ? 'Saving agent...' : 'Save & Deploy Agent'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          </div>

          {/* Modal Footer Navigation (Pinned) */}
          <div className="shrink-0 px-6 py-3.5 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setIsEditorOpen(false)}
              className="text-xs font-semibold text-slate-600 hover:text-slate-900"
            >
              Cancel
            </button>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleSaveAgent()}
                disabled={isSavingAgent}
                className="text-xs font-semibold"
              >
                Save Draft
              </Button>
              {activeWizardStep !== 'launch' ? (
                <Button
                  type="button"
                  onClick={() => {
                    const currentIndex = WIZARD_STEPS.findIndex(
                      (s) => s.id === activeWizardStep
                    );
                    if (currentIndex < WIZARD_STEPS.length - 1) {
                      const nextStep = WIZARD_STEPS[currentIndex + 1];
                      if (nextStep) setActiveWizardStep(nextStep.id);
                    }
                  }}
                  className="bg-[#0c192c] hover:bg-slate-800 text-white font-semibold text-xs px-4 shadow-sm"
                >
                  Continue
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => handleSaveAgent()}
                  disabled={isSavingAgent}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs px-5 shadow-sm"
                >
                  {isSavingAgent ? 'Saving agent...' : 'Save & Deploy Agent'}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Agent Confirmation Dialog */}
      <Dialog open={Boolean(agentToDelete)} onOpenChange={(open) => !open && setAgentToDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-rose-600" />
              Delete Agent
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              Are you sure you want to delete <strong className="text-slate-900">{agentToDelete?.name}</strong>?
            </DialogDescription>
          </DialogHeader>

          <p className="text-xs text-slate-600 leading-relaxed">
            This will permanently remove the agent persona from ServWave as well as delete the assistant from Vapi. Any queued calls assigned to this agent will be unassigned.
          </p>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setAgentToDelete(null)}
              disabled={isDeletingAgent}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleConfirmDelete}
              disabled={isDeletingAgent}
              className="bg-rose-600 hover:bg-rose-700 text-white font-semibold"
            >
              {isDeletingAgent ? 'Deleting...' : 'Delete Agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Standalone Quick Test Call Dialog */}
      <Dialog open={isQuickTestOpen} onOpenChange={setIsQuickTestOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
              <PhoneCall className="h-4 w-4 text-brand" />
              Test Call - {quickTestAgent?.name || 'Bee Voice Agent'}
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              Place a live outbound test call to verify audio, greeting, and conversation logic.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                Phone number to dial
              </Label>
              <Input
                value={testToNumber}
                onChange={(e) => setTestToNumber(formatPhoneInput(e.target.value))}
                placeholder="(555) 000-0000"
                className="h-10 text-xs rounded-lg border-slate-200"
              />
            </div>

            <div>
              <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                Outbound line (Caller ID)
              </Label>
              <Select value={testFromNumber} onValueChange={setTestFromNumber}>
                <SelectTrigger className="h-10 text-xs rounded-lg border-slate-200">
                  <SelectValue placeholder="Select caller ID" />
                </SelectTrigger>
                <SelectContent>
                  {availableNumbers.length > 0 ? (
                    availableNumbers.map((num) => (
                      <SelectItem
                        key={num.id}
                        value={num.phoneNumber}
                        className="text-xs"
                      >
                        {num.friendlyName || formatPhone(num.phoneNumber)}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="none" disabled className="text-xs text-muted-foreground">
                      No phone numbers configured (Setup &rarr; Phone system)
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            {availableNumbers.length === 0 && (
              <div className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-xs flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                <span>
                  Bee Phone system is not configured. Please configure or buy a phone number in <b>Setup &rarr; Phone system</b> before testing calls.
                </span>
              </div>
            )}

            {testCallResponse && (
              <div
                className={cn(
                  'p-3 rounded-lg text-xs border flex items-start gap-2',
                  testCallResponse.ok
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-rose-50 border-rose-200 text-rose-800'
                )}
              >
                {testCallResponse.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                )}
                <div>
                  <div className="font-bold">
                    {testCallResponse.ok ? 'Call initiated' : 'Call failed'}
                  </div>
                  <div>{testCallResponse.message || testCallResponse.error}</div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsQuickTestOpen(false)}
            >
              Close
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() =>
                handleTriggerTestCall(
                  testToNumber,
                  testFromNumber,
                  quickTestAgent?.id && !quickTestAgent.id.startsWith('mock-agent-')
                    ? quickTestAgent.id
                    : undefined
                )
              }
              disabled={isTriggeringTestCall || !testToNumber.trim() || availableNumbers.length === 0}
              className="bg-[#0c192c] hover:bg-slate-800 text-white font-semibold"
            >
              {isTriggeringTestCall ? 'Calling...' : 'Call Now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Voice Engine Setup Modal */}
      <Dialog open={isEngineModalOpen} onOpenChange={setIsEngineModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-brand" />
              Configure Voice Calling Engine
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              Manage API keys and active telephony providers for Bee automated voice calls.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSaveEngineConfig} className="space-y-4 py-2">
            <div>
              <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                Active Telephony Engine
              </Label>
              <Select value={engineProvider} onValueChange={setEngineProvider}>
                <SelectTrigger className="h-10 text-xs rounded-lg border-slate-200">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="vapi" className="text-xs">
                    Vapi (Recommended Production Engine)
                  </SelectItem>
                  <SelectItem value="cascade" className="text-xs">
                    Cascade Engine
                  </SelectItem>
                  <SelectItem value="speech_to_speech" className="text-xs">
                    Speech-to-Speech Streaming
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs font-bold text-slate-900 block mb-1.5">
                Vapi Private API Key
              </Label>
              <Input
                type="password"
                value={vapiApiKeyInput}
                onChange={(e) => setVapiApiKeyInput(e.target.value)}
                placeholder="sk_vapi_..."
                className="h-10 text-xs font-mono rounded-lg border-slate-200"
              />
              <p className="text-xs text-slate-400 mt-1">
                Used to trigger outbound calls and query active phone lines.
              </p>
            </div>

            {engineSaveFeedback && (
              <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-600 shrink-0" />
                <span>{engineSaveFeedback}</span>
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsEngineModalOpen(false)}
              >
                Close
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={isSavingEngine}
                className="bg-[#0c192c] hover:bg-slate-800 text-white font-semibold"
              >
                {isSavingEngine ? 'Saving...' : 'Save Settings'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Watermark badge as seen in bottom right of mockup */}
      <div className="fixed bottom-3 right-5 pointer-events-none z-10 select-none">
        <span className="text-[10px] font-bold tracking-wider text-amber-900 bg-amber-100/90 border border-amber-300 px-2.5 py-1 rounded shadow-xs uppercase">
          PREVIEW · DEMO DATA
        </span>
      </div>
    </div>
  );
};
