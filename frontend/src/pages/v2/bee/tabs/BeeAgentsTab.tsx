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
  PhoneCall,
  Sparkles,
  ArrowLeft,
  ArrowRight,
} from 'lucide-react';
import {
  JOB_DYNAMIC_VARIABLES,
  CUSTOMER_DYNAMIC_VARIABLES,
  JOB_CONTEXT_VARIABLES,
  CORE_DYNAMIC_VARIABLES,
  ALL_DYNAMIC_VARIABLES,
  validateScriptVariables,
  isVariableUsedInText,
  getUsedJobContextKeys,
  DynamicVariableDefinition,
} from '@/lib/bee/dynamicVariables';
import {
  AgentFlow,
  Step,
  Objection,
  Branch,
  Outcome,
  VARIABLES,
  validateFlow,
  compilePrompt,
} from '@/lib/bee/agentFlow';
import { warrantyFlow as DEFAULT_AGENT_FLOW } from '@/lib/bee/exampleFlow';
import { BeeScriptEditor } from '../components/BeeScriptEditor';
import { BeeFlowStepCard } from '../components/BeeFlowStepCard';
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
    'If the customer asks about past billing or what was included, reference {{total_costs}} and {{line_items}} clearly. If they want time to think, offer to email or text the plan details with no pressure.',
  custom_instructions:
    'Keep responses natural and under 2 sentences at a time. Use the selected Job Info variables naturally when answering customer questions.',
};

const DEFAULT_JOB_CONTEXT_FIELDS = [
  'assigned_team',
  'job_notes',
  'line_items',
  'total_costs',
  'visits',
  'communication_history',
];

type FlowFieldKey = keyof BeeAgentConversationFlow;
type WizardStepId = 'basics' | 'conversation_flow' | 'launch';

const WIZARD_STEPS: Array<{ id: WizardStepId; label: string; number: string }> = [
  { id: 'basics', label: 'Voice & persona', number: '1' },
  { id: 'conversation_flow', label: 'Call flow', number: '2' },
  { id: 'launch', label: 'Test & launch', number: '3' },
];

export const FLOW_SECTIONS: Array<{ key: FlowFieldKey; label: string }> = [
  { key: 'greeting_pitch', label: '1. Greeting' },
  { key: 'checkin_flow', label: '2. Check-In' },
  { key: 'warranty_offer_pitch', label: '3. Warranty Pitch & Packages' },
  { key: 'new_work_pitch', label: '4. New Job' },
  { key: 'objection_handling', label: '5. Objections' },
  { key: 'custom_instructions', label: '6. Rules' },
];

export const FLOW_SECTION_LABELS: Record<FlowFieldKey, string> = {
  greeting_pitch: '1. Greeting',
  checkin_flow: '2. Check-In',
  warranty_offer_pitch: '3. Warranty Pitch & Packages',
  new_work_pitch: '4. New Job',
  objection_handling: '5. Objections',
  custom_instructions: '6. Rules',
};

export interface ElevenLabsVoiceOption {
  id: string; // Vapi 11labs voice ID
  name: string;
  gender: 'Female' | 'Male';
  accent: string;
  description: string;
  previewUrl: string;
}

export const ELEVENLABS_VAPI_VOICES: ElevenLabsVoiceOption[] = [
  // ── Female Voices ──
  {
    id: 'EXAVITQu4vr4xnSDxMaL',
    name: 'Sarah',
    gender: 'Female',
    accent: 'American · Professional',
    description: 'Warm, confident, and reassuring; ideal for warranty customer care',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3',
  },
  {
    id: 'hpp4J3VqNfWAUOO0d1Us',
    name: 'Bella',
    gender: 'Female',
    accent: 'American · Warm & Bright',
    description: 'Polished, articulate, and friendly with crisp diction',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/hpp4J3VqNfWAUOO0d1Us/dab0f5ba-3aa4-48a8-9fad-f138fea1126d.mp3',
  },
  {
    id: 'Xb7hH8MSUJpSbSDYk0k2',
    name: 'Alice',
    gender: 'Female',
    accent: 'British · Sophisticated',
    description: 'Engaging, clear, and professional with a refined British accent',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3',
  },
  {
    id: 'XrExE9yKIg1WjnnlVkGX',
    name: 'Matilda',
    gender: 'Female',
    accent: 'American · Warm Alto',
    description: 'Rich, soothing alto tone with a reassuring consultative feel',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3',
  },
  {
    id: 'pFZP5JQG7iQjIQuC4Bku',
    name: 'Lily',
    gender: 'Female',
    accent: 'British · Velvety',
    description: 'Velvety, calm, and friendly British voice with gentle warmth',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/89b68b35-b3dd-4348-a84a-a3c13a3c2b30.mp3',
  },
  {
    id: 'cgSgspJ2msm6clMCkdW9',
    name: 'Jessica',
    gender: 'Female',
    accent: 'American · Playful & Upbeat',
    description: 'Energetic, approachable, and engaging customer-first delivery',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/cgSgspJ2msm6clMCkdW9/56a97bf8-b69b-448f-846c-c3a11683d45a.mp3',
  },

  // ── Male Voices ──
  {
    id: 'pNInz6obpgDQGcFmaJgB',
    name: 'Adam',
    gender: 'Male',
    accent: 'American · Deep & Confident',
    description: 'Deep, grounded, and narrative with a strong consultative presence',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/d6905d7a-dd26-4187-bfff-1bd3a5ea7cac.mp3',
  },
  {
    id: 'CwhRBWXzGAHq8TQ4Fs17',
    name: 'Roger',
    gender: 'Male',
    accent: 'American · Casual & Classy',
    description: 'Easy-going, resonant, and natural for conversational outreach',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/CwhRBWXzGAHq8TQ4Fs17/58ee3ff5-f6f2-4628-93b8-e38eb31806b0.mp3',
  },
  {
    id: 'cjVigY5qzO86Huf0OWal',
    name: 'Eric',
    gender: 'Male',
    accent: 'American · Smooth Tenor',
    description: 'Polished, authoritative tenor tailored for business service calls',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/cjVigY5qzO86Huf0OWal/d098fda0-6456-4030-b3d8-63aa048c9070.mp3',
  },
  {
    id: 'iP95p4xoKVk53GoZ742B',
    name: 'Chris',
    gender: 'Male',
    accent: 'American · Down-to-Earth',
    description: 'Friendly, relatable, and authentic blue-collar service warmth',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/iP95p4xoKVk53GoZ742B/3f4bde72-cc48-40dd-829f-57fbf906f4d7.mp3',
  },
  {
    id: 'bIHbv24MWmeRgasZH58o',
    name: 'Will',
    gender: 'Male',
    accent: 'American · Relaxed',
    description: 'Chill, approachable, and steady pacing for check-ins',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/bIHbv24MWmeRgasZH58o/8caf8f3d-ad29-4980-af41-53f20c72d7a4.mp3',
  },
  {
    id: 'pqHfZKP75CvOlQylNhV4',
    name: 'Bill',
    gender: 'Male',
    accent: 'American · Mature & Grounded',
    description: 'Experienced, trustworthy, and comforting voice that builds rapport',
    previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/pqHfZKP75CvOlQylNhV4/d782b3ff-84ba-4029-848c-acf01285524d.mp3',
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
    calls_today: 0,
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
    calls_today: 0,
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

  // Dynamic variable selector category & validation states ('job' vs 'customer')
  const [variableCategoryTab, setVariableCategoryTab] = useState<'job' | 'customer'>('job');
  const [sectionErrors, setSectionErrors] = useState<Record<string, string[]>>({});
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cursorPositionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  const updateCursor = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    cursorPositionRef.current = {
      start: e.currentTarget.selectionStart,
      end: e.currentTarget.selectionEnd,
    };
  };

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

  // ── Call Flow Builder State (Step 2) ──
  const [agentFlow, setAgentFlow] = useState<AgentFlow>(DEFAULT_AGENT_FLOW);
  const [flowTab, setFlowTab] = useState<'steps' | 'objections'>('steps');
  const [expandedStepId, setExpandedStepId] = useState<string>(DEFAULT_AGENT_FLOW.steps[0]?.id ?? '');
  const [previewMode, setPreviewMode] = useState<'sounds' | 'prompt'>('sounds');
  const [previewCustomerIdx, setPreviewCustomerIdx] = useState<number>(0);

  // Preview sample customers
  const previewCustomers = useMemo(() => {
    const mockCustomers = [
      { name: 'Umer', jobNum: 'J00187' },
      { name: 'Ayesha', jobNum: 'J00182' },
      { name: 'David', jobNum: 'J00181' },
    ];
    if (sampleJobs.length > 0) {
      return sampleJobs.slice(0, 3).map((j, idx) => ({
        name: j.customer_name?.split(' ')[0] || mockCustomers[idx]?.name || 'Customer',
        jobNum: formatJobNumber(j.job_number) || mockCustomers[idx]?.jobNum || `J0000${idx + 1}`,
      }));
    }
    return mockCustomers;
  }, [sampleJobs]);

  // Per-customer variable values for live preview interpolation
  const previewVarValues = useMemo(() => {
    const mocks: Array<Record<string, string>> = [
      {
        'customer.first_name': 'Umer',
        'customer.last_name': 'Nasir',
        'customer.email': 'umer@example.com',
        'customer.phone': '+1 (555) 234-5678',
        'agent.name': ELEVENLABS_VAPI_VOICES.find((v) => v.id === voiceId)?.name || 'Sarah',
        'company.name': agentCompanyName || 'ServWave',
        'job.number': 'J00187',
        'job.type': 'HVAC Service',
        'job.equipment': 'HVAC split system',
        'job.service_address': '14 Garden Road',
        'job.completed_date': 'March 4',
        'job.assigned_team': 'Dave Tech',
        'warranty.plan_name': 'Basic Parts',
        'warranty.end_date': 'December 2',
        'warranty.days_left': '14',
        'offer.early_discount': '10%',
        'invoice.date': 'March 6',
        'invoice.total': '$240',
      },
      {
        'customer.first_name': 'Ayesha',
        'customer.last_name': 'Khan',
        'customer.email': 'ayesha@example.com',
        'customer.phone': '+1 (555) 345-6789',
        'agent.name': ELEVENLABS_VAPI_VOICES.find((v) => v.id === voiceId)?.name || 'Sarah',
        'company.name': agentCompanyName || 'ServWave',
        'job.number': 'J00182',
        'job.type': 'Plumbing Service',
        'job.equipment': 'tankless water heater',
        'job.service_address': '27 Canal View',
        'job.completed_date': 'April 18',
        'job.assigned_team': 'Team North',
        'warranty.plan_name': 'Full Protection',
        'warranty.end_date': 'December 9',
        'warranty.days_left': '21',
        'offer.early_discount': '10%',
        'invoice.date': 'April 20',
        'invoice.total': '$310',
      },
      {
        'customer.first_name': 'David',
        'customer.last_name': 'Brown',
        'customer.email': 'david@example.com',
        'customer.phone': '+1 (555) 456-7890',
        'agent.name': ELEVENLABS_VAPI_VOICES.find((v) => v.id === voiceId)?.name || 'Sarah',
        'company.name': agentCompanyName || 'ServWave',
        'job.number': 'J00181',
        'job.type': 'Commercial Cooling',
        'job.equipment': 'rooftop AC unit',
        'job.service_address': '3 Harbor Street',
        'job.completed_date': 'May 2',
        'job.assigned_team': 'Team South',
        'warranty.plan_name': 'Premium Annual',
        'warranty.end_date': 'December 15',
        'warranty.days_left': '27',
        'offer.early_discount': '10%',
        'invoice.date': 'May 5',
        'invoice.total': '$420',
      },
    ];

    const idx = previewCustomerIdx;
    const j = sampleJobs[idx];
    if (j) {
      const fallback = mocks[idx] || mocks[0]!;
      return {
        ...fallback,
        'customer.first_name': j.customer_name?.split(' ')[0] || fallback['customer.first_name']!,
        'customer.last_name': j.customer_name?.split(' ').slice(1).join(' ') || fallback['customer.last_name']!,
        'customer.phone': j.customer_phone || fallback['customer.phone']!,
        'job.number': formatJobNumber(j.job_number) || fallback['job.number']!,
        'job.type': j.job_type || fallback['job.type']!,
        'job.equipment': j.job_type || fallback['job.equipment']!,
        'job.service_address': j.service_address || fallback['job.service_address']!,
        'warranty.end_date': j.warranty_end_date
          ? new Date(j.warranty_end_date).toLocaleDateString([], { month: 'long', day: 'numeric' })
          : fallback['warranty.end_date']!,
        'agent.name': ELEVENLABS_VAPI_VOICES.find((v) => v.id === voiceId)?.name || 'Sarah',
        'company.name': agentCompanyName || 'ServWave',
      };
    }
    return mocks[idx] || mocks[0]!;
  }, [previewCustomerIdx, sampleJobs, voiceId, agentCompanyName]);

  // Interpolate line with amber highlights
  const interpolateLine = (line: string): Array<{ text: string; isVar: boolean }> => {
    const segments: Array<{ text: string; isVar: boolean }> = [];
    let last = 0;
    const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (m.index > last) {
        segments.push({ text: line.slice(last, m.index), isVar: false });
      }
      const tokenKey = m[1] || '';
      const val = previewVarValues[tokenKey] || tokenKey;
      segments.push({ text: val, isVar: true });
      last = m.index + m[0].length;
    }
    if (last < line.length) {
      segments.push({ text: line.slice(last), isVar: false });
    }
    return segments;
  };

  // Flow check issues
  const flowIssues = useMemo(() => validateFlow(agentFlow), [agentFlow]);

  // Mutation helpers for agentFlow
  const updateStep = (id: string, updated: Step) => {
    setAgentFlow((prev) => ({
      ...prev,
      steps: prev.steps.map((s) => (s.id === id ? updated : s)),
    }));
  };
  const deleteStep = (id: string) => {
    setAgentFlow((prev) => ({
      ...prev,
      steps: prev.steps.filter((s) => s.id !== id),
    }));
    setExpandedStepId('');
  };
  const moveStep = (id: string, dir: 'up' | 'down') => {
    setAgentFlow((prev) => {
      const steps = [...prev.steps];
      const idx = steps.findIndex((s) => s.id === id);
      if (dir === 'up' && idx > 0) {
        const temp = steps[idx - 1]!;
        steps[idx - 1] = steps[idx]!;
        steps[idx] = temp;
      }
      if (dir === 'down' && idx < steps.length - 1) {
        const temp = steps[idx + 1]!;
        steps[idx + 1] = steps[idx]!;
        steps[idx] = temp;
      }
      return { ...prev, steps };
    });
  };
  const addStep = () => {
    const newId = `step_${Date.now()}`;
    const newStep: Step = {
      id: newId,
      title: 'New step',
      goal: '',
      line: '',
      mode: 'guide',
      branches: [{ id: `b_${Date.now()}`, when: 'Customer responds', outcome: { type: 'end_call' } }],
    };
    setAgentFlow((prev) => ({
      ...prev,
      steps: [...prev.steps, newStep],
    }));
    setExpandedStepId(newId);
  };
  const updateObjection = (id: string, updated: Objection) => {
    setAgentFlow((prev) => ({
      ...prev,
      objections: prev.objections.map((o) => (o.id === id ? updated : o)),
    }));
  };
  const deleteObjection = (id: string) => {
    setAgentFlow((prev) => ({
      ...prev,
      objections: prev.objections.filter((o) => o.id !== id),
    }));
  };

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
      // By default no job is referenced for preview; Bee uses raw variables until user explicitly selects a job
    }
  }, [sampleJobs, testJobId]);

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
          calls_today: a.calls_today ?? 0,
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
    setSectionErrors({});
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
    setAgentFlow(JSON.parse(JSON.stringify(DEFAULT_AGENT_FLOW)));
    setFlowTab('steps');
    setExpandedStepId(DEFAULT_AGENT_FLOW.steps[0]?.id ?? '');
    setIsEditorOpen(true);
  };

  const openEditModal = (agent: BeeAgentItem) => {
    setEditingAgentId(agent.id);
    setEditorError(null);
    setSectionErrors({});
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
    if (agent.flow && agent.flow.steps && agent.flow.steps.length > 0) {
      setAgentFlow(JSON.parse(JSON.stringify(agent.flow)));
      setExpandedStepId(agent.flow.steps[0]?.id ?? '');
    } else {
      setAgentFlow(JSON.parse(JSON.stringify(DEFAULT_AGENT_FLOW)));
      setExpandedStepId(DEFAULT_AGENT_FLOW.steps[0]?.id ?? '');
    }
    setFlowTab('steps');
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

  const validateActiveSection = (): boolean => {
    const text = conversationFlow[activeFlowField] || '';
    const result = validateScriptVariables(text);
    if (!result.isValid) {
      setSectionErrors((prev) => ({
        ...prev,
        [activeFlowField]: result.errors,
      }));
      toast.error(`Invalid dynamic variable in ${FLOW_SECTION_LABELS[activeFlowField]}: ${result.errors[0]}`);
      textareaRef.current?.focus();
      return false;
    }
    setSectionErrors((prev) => ({
      ...prev,
      [activeFlowField]: [],
    }));
    return true;
  };

  const validateAllSections = (): boolean => {
    const flowIssues = validateFlow(agentFlow);
    const flowErrors = flowIssues.filter((i) => i.level === 'error');
    const firstErr = flowErrors[0];
    if (firstErr) {
      const msg = `${firstErr.where ? `${firstErr.where}: ` : ''}${firstErr.message}`;
      toast.error(msg);
      setEditorError(msg);
      return false;
    }
    return true;
  };

  const handleSwitchFlowSection = (targetKey: FlowFieldKey) => {
    if (targetKey === activeFlowField) return;
    if (!validateActiveSection()) return;
    setActiveFlowField(targetKey);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const handleSwitchWizardStep = (targetStep: WizardStepId) => {
    if (targetStep === activeWizardStep) return;
    if (activeWizardStep === 'conversation_flow') {
      if (!validateAllSections()) return;
    }
    setActiveWizardStep(targetStep);
  };

  const handleContinueStep = () => {
    if (activeWizardStep === 'basics') {
      if (!name.trim()) {
        setEditorError('Please enter an Agent Name.');
        return;
      }
      setEditorError(null);
      setActiveWizardStep('conversation_flow');
      return;
    }
    if (activeWizardStep === 'conversation_flow') {
      if (!validateAllSections()) return;
      setActiveWizardStep('launch');
      return;
    }
  };

  const handleSaveAgent = async (forcedActive?: boolean, e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!name.trim()) {
      setEditorError('Please enter an Agent Name.');
      setActiveWizardStep('basics');
      return;
    }

    // Validate all 6 sections
    if (!validateAllSections()) {
      return;
    }

    try {
      setIsSavingAgent(true);
      setEditorError(null);
      const selectedVoiceObj =
        ELEVENLABS_VAPI_VOICES.find((v) => v.id === voiceId) || DEFAULT_ELEVENLABS_VOICE;

      // Automatically aggregate all used job context fields across all sections
      const usedContextFields = getUsedJobContextKeys(conversationFlow);
      const finalJobFields = Array.from(new Set([...selectedJobFields, ...usedContextFields]));

      const targetIsActive = forcedActive !== undefined ? forcedActive : isActive;

      // Derive backward-compatible conversation_flow fields from agentFlow
      const greetingStep = agentFlow.steps.find((s) => s.id === 'step-1' || s.title.toLowerCase().includes('open') || s.title.toLowerCase().includes('greet'));
      const checkinStep = agentFlow.steps.find((s) => s.id === 'step-2' || s.title.toLowerCase().includes('check'));
      const warrantyStep = agentFlow.steps.find((s) => s.id === 'step-3' || s.title.toLowerCase().includes('warrant'));
      const newWorkStep = agentFlow.steps.find((s) => s.id === 'step-4' || s.title.toLowerCase().includes('new work'));

      const derivedConversationFlow: BeeAgentConversationFlow = {
        greeting_pitch: greetingStep ? greetingStep.line : conversationFlow.greeting_pitch,
        checkin_flow: checkinStep ? checkinStep.line : conversationFlow.checkin_flow,
        warranty_offer_pitch: warrantyStep ? warrantyStep.line : conversationFlow.warranty_offer_pitch,
        new_work_pitch: newWorkStep ? newWorkStep.line : conversationFlow.new_work_pitch,
        objection_handling: agentFlow.objections.map((o) => `If customer: ${o.examples.join(', ')} -> Respond: ${o.reply}`).join('\n') || conversationFlow.objection_handling,
        custom_instructions: conversationFlow.custom_instructions,
      };

      const payload: Partial<BeeAgentItem> = {
        name: name.trim(),
        persona_name: selectedVoiceObj.name,
        voice_id: voiceId,
        language: 'English',
        languages: ['English'],
        tone,
        voice_engine: engineProvider || 'vapi',
        is_active: targetIsActive,
        job_context_fields: finalJobFields,
        flow: agentFlow,
        conversation_flow: derivedConversationFlow,
        warranty_offer_pitch: derivedConversationFlow.warranty_offer_pitch,
        new_work_pitch: derivedConversationFlow.new_work_pitch,
      };

      if (editingAgentId && !editingAgentId.startsWith('mock-agent-')) {
        await updateAgent(editingAgentId, payload);
      } else {
        await createAgent(payload);
      }
      setIsEditorOpen(false);
      toast.success(targetIsActive ? 'Agent deployed successfully' : 'Agent saved as draft');
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
        flow: agentFlow,
        conversationFlow,
        selectedJobContextFields: selectedJobFields,
      });
      setTestCallResponse(res);
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
    const currentText = conversationFlow[activeFlowField] || '';
    const textarea = textareaRef.current;
    let start = cursorPositionRef.current.start;
    let end = cursorPositionRef.current.end;

    if (textarea && document.activeElement === textarea) {
      start = textarea.selectionStart;
      end = textarea.selectionEnd;
    }

    if (start > currentText.length) start = currentText.length;
    if (end > currentText.length) end = currentText.length;

    const before = currentText.slice(0, start);
    const after = currentText.slice(end);

    const prefix = before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : '';
    const suffix = after.length > 0 && !after.startsWith(' ') && !after.startsWith('\n') ? ' ' : '';

    const insertion = `${prefix}${token}${suffix}`;
    const newText = before + insertion + after;
    const newCursorPos = start + insertion.length;

    setConversationFlow((prev) => ({
      ...prev,
      [activeFlowField]: newText,
    }));

    cursorPositionRef.current = { start: newCursorPos, end: newCursorPos };
    if (textarea) {
      setTimeout(() => {
        textarea.focus();
        textarea.setSelectionRange(newCursorPos, newCursorPos);
      }, 0);
    }

    // Live validate updated text
    const valResult = validateScriptVariables(newText);
    setSectionErrors((prev) => ({
      ...prev,
      [activeFlowField]: valResult.errors,
    }));

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
    return null;
  }, [activePreviewJob, sampleJobs, previewJobId]);

  const compiledScriptPreview = useMemo(() => {
    if (!selectedPreviewJob) {
      // Default: no job referenced yet, display raw script with variables
      return {
        greeting: conversationFlow.greeting_pitch || '',
        checkin: conversationFlow.checkin_flow || '',
        warranty: conversationFlow.warranty_offer_pitch || '',
        newWork: conversationFlow.new_work_pitch || '',
        objections: conversationFlow.objection_handling || '',
        custom: conversationFlow.custom_instructions || '',
      };
    }
    const j = selectedPreviewJob;
    const rawVars = (j.job_context_variables || {}) as Record<string, string>;

    const formatVar = (key: string, fallback: string) => {
      const isFieldEnabled =
        selectedJobFields.includes(key) ||
        isVariableUsedInText(Object.values(conversationFlow).join(' '), key);
      if (!isFieldEnabled) return `[${key} not enabled]`;
      return rawVars[key] || fallback;
    };

    const vars: Record<string, string> = {
      customer_name: j.customer_name || 'Customer',
      phone: formatPhone(j.customer_phone) || '(555) 000-0000',
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

  const currentSectionText = conversationFlow[activeFlowField] || '';
  const displayedVariables =
    variableCategoryTab === 'job' ? JOB_DYNAMIC_VARIABLES : CUSTOMER_DYNAMIC_VARIABLES;

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
        <DialogContent className="max-w-[1360px] w-full max-h-[94vh] flex flex-col p-0 overflow-hidden bg-white sm:rounded-[20px] border border-[#E2E8F0] shadow-2xl">
          {/* Modal Header */}
          <div className="shrink-0 px-8 pt-6 pb-0 border-b border-[#E2E8F0] bg-white flex flex-col gap-4">
            <div className="pb-4 border-b border-[#E2E8F0] flex items-center gap-3">
              <h1 className="text-[24px] font-extrabold text-[#0F172A] tracking-[-0.01em] m-0">
                {name || 'New agent'}
              </h1>

              <button
                type="button"
                onClick={() => setIsActive(!isActive)}
                title={`Click to set as ${isActive ? 'Draft' : 'Active'}`}
                className="cursor-pointer select-none focus:outline-none focus:ring-2 focus:ring-primary/20 rounded-full transition-transform active:scale-95"
              >
                <Badge
                  tone={isActive ? 'success' : 'neutral'}
                  variant="outline"
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-semibold shrink-0 cursor-pointer select-none border transition-colors inline-flex items-center gap-1.5',
                    isActive
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100/80'
                      : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200/80'
                  )}
                >
                  <span
                    className={cn(
                      'w-2 h-2 rounded-full',
                      isActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'
                    )}
                  />
                  <span>{isActive ? 'Active' : 'Draft'}</span>
                </Badge>
              </button>
            </div>

            {/* Stepper Nav */}
            <nav aria-label="Setup steps" className="flex items-center gap-7 flex-wrap">
              {WIZARD_STEPS.map((step) => {
                const isCurrent = activeWizardStep === step.id;
                const isPast =
                  (activeWizardStep === 'conversation_flow' && step.id === 'basics') ||
                  (activeWizardStep === 'launch' && (step.id === 'basics' || step.id === 'conversation_flow'));

                return (
                  <button
                    key={step.id}
                    type="button"
                    onClick={() => handleSwitchWizardStep(step.id)}
                    className={cn(
                      'flex items-center gap-2 transition-all',
                      isCurrent
                        ? 'pb-3 text-[14px] font-bold text-[#0F172A] border-b-2 border-[#0F172A]'
                        : 'pb-3.5 text-[14px] font-semibold text-[#475569] border-b-2 border-transparent hover:text-[#0F172A]'
                    )}
                  >
                    {isPast ? (
                      <span className="w-[22px] h-[22px] rounded-full bg-[#DCFCE7] text-[#166534] inline-flex items-center justify-center">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                    ) : (
                      <span
                        className={cn(
                          'w-[22px] h-[22px] rounded-full inline-flex items-center justify-center text-[12px] font-bold box-border',
                          isCurrent
                            ? 'bg-[#0F172A] text-white'
                            : 'border border-[#CBD5E1] text-[#475569]'
                        )}
                      >
                        {step.number}
                      </span>
                    )}
                    <span>{step.label}</span>
                  </button>
                );
              })}
            </nav>
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
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Call Flow Builder */}
          {activeWizardStep === 'conversation_flow' && (
            <div className="flex flex-col lg:flex-row gap-0 -mx-6 -my-5 min-h-[620px] bg-white">
              {/* Left Panel: Call Steps / Objections */}
              <div className="flex-[999_1_620px] min-w-0 p-6 lg:p-8 lg:pb-10 overflow-y-auto border-r border-[#E2E8F0] flex flex-col gap-5">
                {/* Tab Bar: Call steps, Objections */}
                <div role="tablist" aria-label="Flow sections" className="flex items-center gap-1.5 p-1 bg-[#F1F5F9] rounded-[12px] w-fit">
                  {([
                    { id: 'steps', label: 'Call steps', count: agentFlow.steps.length },
                    { id: 'objections', label: 'Objections', count: agentFlow.objections.length },
                  ] as const).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={flowTab === tab.id}
                      onClick={() => setFlowTab(tab.id)}
                      className={cn(
                        'h-[38px] px-3.5 rounded-[9px] text-[14px] font-bold inline-flex items-center gap-2 transition-all border-none',
                        flowTab === tab.id
                          ? 'bg-white text-[#0F172A] shadow-xs'
                          : 'bg-transparent text-[#475569] hover:text-[#0F172A]'
                      )}
                    >
                      <span>{tab.label}</span>
                      <span
                        className={cn(
                          'text-[12px] rounded-full px-2 py-0.5 font-bold',
                          flowTab === tab.id
                            ? 'bg-[#0F172A] text-white'
                            : 'bg-[#E2E8F0] text-[#334155]'
                        )}
                      >
                        {tab.count}
                      </span>
                    </button>
                  ))}
                </div>

                {/* Call Steps Tab */}
                {flowTab === 'steps' && (
                  <div className="flex flex-col gap-5">
                    <p className="m-0 text-[14px] text-[#475569] leading-relaxed">
                      Bee moves through these steps in order. Write what Bee should say, then decide where each customer answer leads. Click a step to edit it.
                    </p>

                    {/* Step list with vertical rail */}
                    <div className="relative pl-1">
                      {/* Rail connector */}
                      <div className="absolute left-[15px] top-4 bottom-8 w-[2px] bg-[#E2E8F0] z-0" />

                      <div className="space-y-4 relative z-10">
                        {agentFlow.steps.map((step, idx) => (
                          <div key={step.id} className="flex items-start gap-3.5">
                            {/* Rail circle node */}
                            <div
                              className={cn(
                                'w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-extrabold shrink-0 mt-3.5 box-border transition-all',
                                expandedStepId === step.id
                                  ? 'bg-[#0F172A] text-white shadow-xs'
                                  : 'bg-white text-[#0F172A] border-[1.5px] border-[#CBD5E1]'
                              )}
                            >
                              {idx + 1}
                            </div>

                            {/* Step Card */}
                            <div className="flex-1 min-w-0">
                              <BeeFlowStepCard
                                step={step}
                                index={idx}
                                isExpanded={expandedStepId === step.id}
                                allSteps={agentFlow.steps}
                                objections={agentFlow.objections}
                                onToggle={() =>
                                  setExpandedStepId(expandedStepId === step.id ? '' : step.id)
                                }
                                onUpdate={(updated) => updateStep(step.id, updated)}
                                onDelete={() => deleteStep(step.id)}
                                onMoveUp={() => moveStep(step.id, 'up')}
                                onMoveDown={() => moveStep(step.id, 'down')}
                                canMoveUp={idx > 0}
                                canMoveDown={idx < agentFlow.steps.length - 1}
                              />
                            </div>
                          </div>
                        ))}

                        {/* Add Step Action Row */}
                        <div className="flex items-center gap-3.5 pt-1">
                          <div className="w-7 h-7 rounded-full border-2 border-dashed border-[#94A3B8] shrink-0" />
                          <div className="flex items-center gap-2.5 flex-wrap">
                            <button
                              type="button"
                              onClick={addStep}
                              className="h-[38px] px-3.5 rounded-[10px] border border-dashed border-[#94A3B8] hover:border-[#0F172A] bg-white text-[13px] font-bold text-[#0F172A] inline-flex items-center gap-1.5 transition-colors shadow-2xs"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              <span>Add step</span>
                            </button>
                            <span className="text-[13px] text-[#475569]">
                              or start from a template:
                              {[
                                {
                                  name: 'Renewal',
                                  title: 'Warranty offer',
                                  goal: 'Explain that coverage is ending and offer renewal.',
                                  line: 'Your parts and labor coverage on the {{job.equipment}} ends on {{warranty.end_date}}. If you renew before then, you get {{offer.early_discount}} off. Can I walk you through the options?',
                                },
                                {
                                  name: 'Win-back',
                                  title: 'Win-back',
                                  goal: 'Re-engage a customer who recently passed on coverage.',
                                  line: 'Hi {{customer.first_name}}, following up on your {{job.equipment}} service at {{job.service_address}} — we can still lock in your {{offer.early_discount}} renewal incentive until {{warranty.end_date}}.',
                                },
                                {
                                  name: 'Maintenance reminder',
                                  title: 'Maintenance reminder',
                                  goal: 'Schedule an annual equipment tune-up.',
                                  line: 'It has been a year since our last visit on {{job.completed_date}}. Your {{job.equipment}} is due for its seasonal maintenance inspection. Would you like to schedule that now?',
                                },
                              ].map((t) => (
                                <button
                                  key={t.name}
                                  type="button"
                                  onClick={() => {
                                    const newId = `step_${Date.now()}`;
                                    const newStep: Step = {
                                      id: newId,
                                      title: t.title,
                                      goal: t.goal,
                                      line: t.line,
                                      mode: 'guide',
                                      branches: [
                                        {
                                          id: `b_${Date.now()}`,
                                          when: 'Customer is interested',
                                          outcome: { type: 'next' },
                                        },
                                        {
                                          id: `b_${Date.now() + 1}`,
                                          when: 'Busy right now',
                                          outcome: { type: 'callback' },
                                        },
                                      ],
                                    };
                                    setAgentFlow((prev) => ({
                                      ...prev,
                                      steps: [...prev.steps, newStep],
                                    }));
                                    setExpandedStepId(newId);
                                  }}
                                  className="ml-1.5 font-semibold text-[#0F172A] underline underline-offset-2 hover:text-blue-700"
                                >
                                  {t.name}
                                </button>
                              ))}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Objections Tab */}
                {flowTab === 'objections' && (
                  <div className="flex flex-col gap-3.5">
                    <p className="m-0 mb-1 text-[14px] text-[#475569] leading-relaxed">
                      Objections can come up at any point in the call. Bee answers, then goes back to the step it was on unless you say otherwise.
                    </p>

                    <div className="flex flex-col gap-3">
                      {agentFlow.objections.map((obj) => (
                        <div
                          key={obj.id}
                          className="border border-[#E2E8F0] rounded-[14px] p-4 px-[18px] flex flex-col gap-2.5 bg-white shadow-2xs"
                        >
                          <div className="flex items-center justify-between gap-2.5 flex-wrap">
                            <input
                              value={obj.name}
                              onChange={(e) =>
                                updateObjection(obj.id, { ...obj, name: e.target.value })
                              }
                              placeholder="Objection Name (e.g. Too expensive)"
                              className="text-[15px] font-bold text-[#0F172A] bg-transparent border-0 outline-none p-0 flex-1 min-w-[140px]"
                            />
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[12px] font-semibold text-[#475569] bg-[#F1F5F9] rounded-full px-2.5 py-1">
                                Then:{' '}
                                {obj.after.type === 'goto'
                                  ? obj.after.stepId === '__return__'
                                    ? 'Back to current step'
                                    : `Go to: ${obj.after.stepId}`
                                  : obj.after.type === 'callback'
                                  ? 'Book a callback, end call'
                                  : obj.after.type === 'transfer'
                                  ? 'Transfer to office'
                                  : obj.after.type === 'do_not_call'
                                  ? 'Add to Do Not Call, end call'
                                  : obj.after.type === 'end_call'
                                  ? 'End call'
                                  : (obj.after as any).type}
                              </span>
                              <button
                                type="button"
                                onClick={() => deleteObjection(obj.id)}
                                className="w-7 h-7 rounded-[8px] border border-transparent hover:border-[#E2E8F0] hover:bg-slate-50 text-[#475569] hover:text-rose-600 transition-colors inline-flex items-center justify-center"
                                title="Delete objection"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>

                          <div className="text-[13px] text-[#475569] flex items-center gap-1.5 flex-wrap">
                            <span>Sounds like:</span>
                            <input
                              value={obj.examples.join(', ')}
                              onChange={(e) =>
                                updateObjection(obj.id, {
                                  ...obj,
                                  examples: e.target.value
                                    .split(',')
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                })
                              }
                              placeholder="e.g. that's a lot, can't afford it"
                              className="text-[13px] text-[#0F172A] font-medium bg-transparent border-0 border-b border-dashed border-[#CBD5E1] focus:border-[#0F172A] outline-none px-1 flex-1 min-w-[200px]"
                            />
                          </div>

                          <div className="text-[14px] leading-relaxed bg-[#F8FAFC] rounded-[10px] p-2.5 px-3">
                            <BeeScriptEditor
                              value={obj.reply}
                              onChange={(val) => updateObjection(obj.id, { ...obj, reply: val })}
                              placeholder="Explain how Bee should respond..."
                              rows={2}
                            />
                          </div>
                        </div>
                      ))}

                      <button
                        type="button"
                        onClick={() => {
                          const newObj: Objection = {
                            id: `obj_${Date.now()}`,
                            name: 'New objection',
                            examples: ['I need to think about it'],
                            reply: 'No pressure at all. I can email or text the plan details so you have them in writing.',
                            after: { type: 'goto', stepId: '__return__' },
                          };
                          setAgentFlow((prev) => ({
                            ...prev,
                            objections: [...prev.objections, newObj],
                          }));
                        }}
                        className="self-start h-11 px-4 rounded-[12px] border border-dashed border-[#94A3B8] hover:border-[#0F172A] bg-white text-[14px] font-bold text-[#0F172A] inline-flex items-center gap-1.5 transition-colors shadow-2xs"
                      >
                        <Plus className="h-4 w-4" />
                        <span>Add objection</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Right Panel: Live Preview */}
              <div className="flex-[1_1_400px] min-w-0 lg:min-w-[380px] lg:max-w-[460px] bg-[#F8FAFC] border-l border-[#E2E8F0] p-6 overflow-y-auto flex flex-col gap-4 self-stretch">
                {/* Preview Mode Selector */}
                <div role="tablist" aria-label="Preview mode" className="flex items-center gap-1 p-1 bg-[#E2E8F0] rounded-[10px] w-fit">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={previewMode === 'sounds'}
                    onClick={() => setPreviewMode('sounds')}
                    className={cn(
                      'h-[34px] px-3 rounded-[7px] text-[13px] font-bold transition-all border-none',
                      previewMode === 'sounds'
                        ? 'bg-white text-[#0F172A] shadow-xs'
                        : 'bg-transparent text-[#334155] hover:text-[#0F172A]'
                    )}
                  >
                    How it sounds
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={previewMode === 'prompt'}
                    onClick={() => setPreviewMode('prompt')}
                    className={cn(
                      'h-[34px] px-3 rounded-[7px] text-[13px] font-bold transition-all border-none',
                      previewMode === 'prompt'
                        ? 'bg-white text-[#0F172A] shadow-xs'
                        : 'bg-transparent text-[#334155] hover:text-[#0F172A]'
                    )}
                  >
                    Generated prompt
                  </button>
                </div>

                {previewMode === 'sounds' ? (
                  <>
                    {/* Customer selector pills */}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-[12px] font-bold text-[#475569] uppercase tracking-[0.06em]">
                        Preview with customer
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {previewCustomers.map((cust, ci) => {
                          const isSel = previewCustomerIdx === ci;
                          return (
                            <button
                              key={ci}
                              type="button"
                              aria-pressed={isSel}
                              onClick={() => setPreviewCustomerIdx(ci)}
                              className={cn(
                                'h-[34px] px-3 rounded-full text-[13px] font-semibold transition-all',
                                isSel
                                  ? 'border border-[#0F172A] bg-[#0F172A] text-white shadow-xs'
                                  : 'border border-[#CBD5E1] bg-white text-[#0F172A] hover:bg-slate-50'
                              )}
                            >
                              {cust.name} · {cust.jobNum}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Step Preview Bubbles */}
                    <div className="flex flex-col gap-3.5">
                      {agentFlow.steps.map((step, idx) => {
                        const isStepExpanded = expandedStepId === step.id;
                        return (
                          <div key={step.id} className="flex flex-col gap-1">
                            <span className="text-[11px] font-bold text-[#475569] uppercase tracking-[0.06em]">
                              {idx + 1} · {step.title}
                            </span>
                            <div
                              className={cn(
                                'rounded-tl-[4px] rounded-tr-[14px] rounded-br-[14px] rounded-bl-[14px] p-2.5 px-3.5 text-[14px] leading-relaxed transition-all bg-white border',
                                isStepExpanded
                                  ? 'border-[#0F172A] shadow-xs'
                                  : 'border-[#E2E8F0]'
                              )}
                            >
                              {interpolateLine(step.line || '(No script entered)').map(
                                (seg, si) =>
                                  seg.isVar ? (
                                    <span
                                      key={si}
                                      className="bg-[#FEF3C7] text-[#78350F] rounded-[4px] px-[3px] font-semibold mx-0.5"
                                    >
                                      {seg.text}
                                    </span>
                                  ) : (
                                    <span key={si}>{seg.text}</span>
                                  )
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Flow Check Panel */}
                    <div className="border border-[#E2E8F0] bg-white rounded-[12px] p-3.5 px-4 flex flex-col gap-2.5">
                      <span className="text-[13px] font-extrabold text-[#0F172A]">Flow check</span>
                      {flowIssues.length === 0 ? (
                        <>
                          <div className="flex gap-2.5 items-start text-[13px] leading-[1.45] text-[#0F172A]">
                            <span className="shrink-0 w-5 h-5 rounded-full bg-[#DCFCE7] text-[#166534] text-[12px] font-extrabold inline-flex items-center justify-center">
                              ✓
                            </span>
                            <span>
                              All details used in the script exist in your job and customer data.
                            </span>
                          </div>
                          <div className="flex gap-2.5 items-start text-[13px] leading-[1.45] text-[#0F172A]">
                            <span className="shrink-0 w-5 h-5 rounded-full bg-[#DCFCE7] text-[#166534] text-[12px] font-extrabold inline-flex items-center justify-center">
                              ✓
                            </span>
                            <span>
                              Every answer leads to a step, an action or the end of the call.
                            </span>
                          </div>
                        </>
                      ) : (
                        flowIssues.map((issue, ii) => (
                          <div
                            key={ii}
                            className="flex gap-2.5 items-start text-[13px] leading-[1.45] text-[#0F172A]"
                          >
                            <span
                              className={cn(
                                'shrink-0 w-5 h-5 rounded-full text-[12px] font-extrabold inline-flex items-center justify-center',
                                issue.level === 'error'
                                  ? 'bg-[#FEE2E2] text-[#991B1B]'
                                  : 'bg-[#FEF3C7] text-[#92400E]'
                              )}
                            >
                              !
                            </span>
                            <span>
                              <strong>{issue.where}:</strong> {issue.message}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                ) : (
                  /* Generated Prompt View */
                  <div className="flex flex-col gap-2">
                    <p className="m-0 text-[13px] text-[#475569] leading-relaxed">
                      This is generated from the steps on the left. Users never edit it directly, so the structure stays consistent for every agent.
                    </p>
                    <pre className="m-0 bg-[#0F172A] text-[#E2E8F0] rounded-[12px] p-4 text-[12px] font-mono leading-relaxed whitespace-pre-wrap max-h-[720px] overflow-y-auto">
                      {(() => {
                        try {
                          return compilePrompt(agentFlow, [
                            {
                              name: '1-Year Warranty Extension',
                              price: '$199/yr or $19/mo',
                              term: '12 months',
                              includes: 'parts and labor',
                            },
                            {
                              name: '2-Year Complete Protection',
                              price: '$349',
                              term: '24 months',
                              includes: 'parts, labor and one tune-up per year',
                            },
                          ]);
                        } catch (err: any) {
                          return `Cannot compile prompt yet:\n${err.message}`;
                        }
                      })()}
                    </pre>
                  </div>
                )}
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
                    value={testJobId || ''}
                    onSelect={(job) => {
                      setTestJobId(job ? job.id : '');
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
                    'p-3.5 rounded-xl text-xs border flex items-center gap-2.5',
                    testCallResponse.ok
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-rose-50 border-rose-200 text-rose-800'
                  )}
                >
                  {testCallResponse.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-rose-600 shrink-0" />
                  )}
                  <div>
                    <div className="font-bold">
                      {testCallResponse.ok ? 'Call initiated' : 'Test call failed'}
                    </div>
                    {!testCallResponse.ok && (
                      <div className="mt-0.5">
                        {testCallResponse.error || testCallResponse.message}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
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
                <span className="text-[11px] text-slate-500">
                  Dial your personal phone to preview voice, persona, and conversation flow in real time.
                </span>
              </div>
            </div>
          )}

          </div>

          {/* Modal Footer Navigation (Pinned) */}
          <div className="shrink-0 px-6 py-3.5 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {activeWizardStep !== 'basics' ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    handleSwitchWizardStep(activeWizardStep === 'launch' ? 'conversation_flow' : 'basics')
                  }
                  className="text-xs font-semibold gap-1 text-slate-700"
                >
                  <ArrowLeft className="h-3.5 w-3.5" /> Back
                </Button>
              ) : <div />}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleSaveAgent(false)}
                disabled={isSavingAgent}
                className="text-xs font-semibold text-slate-700"
              >
                Save Draft
              </Button>
              {activeWizardStep !== 'launch' ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={handleContinueStep}
                  className="bg-[#0c192c] hover:bg-slate-800 text-white font-semibold text-xs px-5 shadow-sm gap-1"
                >
                  Continue <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => handleSaveAgent(true)}
                  disabled={isSavingAgent}
                  className="bg-[#0c192c] hover:bg-slate-800 text-white font-semibold text-xs px-5 shadow-sm"
                >
                  {isSavingAgent ? 'Deploying agent...' : 'Deploy Agent'}
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
                  'p-3 rounded-lg text-xs border flex items-center gap-2',
                  testCallResponse.ok
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-rose-50 border-rose-200 text-rose-800'
                )}
              >
                {testCallResponse.ok ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-rose-600 shrink-0" />
                )}
                <div>
                  <div className="font-bold">
                    {testCallResponse.ok ? 'Call initiated' : 'Call failed'}
                  </div>
                  {!testCallResponse.ok && (
                    <div className="mt-0.5">{testCallResponse.error || testCallResponse.message}</div>
                  )}
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
