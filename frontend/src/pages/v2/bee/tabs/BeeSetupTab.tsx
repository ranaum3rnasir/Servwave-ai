import React, { useState, useEffect, useMemo } from 'react';
import { useBeeStore } from '@/stores/beeStore';
import { useOrganization } from '@/lib/api/organization';
import { useAssignableUsers } from '@/lib/api/users';
import { useTags } from '@/lib/api/tags';
import type { JobTypeWarrantyItem, BeeAvailablePhoneNumber } from '@/lib/api/bee';
import { 
  Settings, 
  Save, 
  CheckCircle2, 
  Check, 
  Bot, 
  Rocket, 
  Lock, 
  ExternalLink, 
  ChevronRight, 
  ChevronDown,
  PhoneCall, 
  Phone,
  Plus,
  Trash2,
  Search,
  AlertTriangle,
  ArrowLeft,
  SlidersHorizontal,
  ShieldCheck,
  Sparkles,
  Loader2,
  Building,
  Clock,
  PhoneForwarded,
  MessageSquare,
  Info,
  ClipboardList,
  UserCheck,
  ShieldAlert,
  Link as LinkIcon,
} from 'lucide-react';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { useTaskCategories } from '@/lib/api/taskCategories';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Heading } from '@/ui-kit/components/ui/heading';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui-kit/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { TimeCombobox } from '@/components/form/TimeCombobox';
import { formatPhone, formatPhoneInput, formatSnakeCase } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';

const FOLLOWUP_OUTCOMES = [
  {
    id: 'INTERESTED_WARRANTY',
    label: 'Warranty plan',
    description: 'Customer showed interest or requested warranty coverage renewal or pricing.',
  },
  {
    id: 'INTERESTED_NEW_WORK',
    label: 'New Job',
    description: 'Customer mentioned a new repair, installation, or service project.',
  },
  {
    id: 'CALLBACK_REQUESTED',
    label: 'Call back later',
    description: 'Customer asked for someone from the office to call them back at a better time.',
  },
  {
    id: 'HANDOFF_HUMAN',
    label: 'Needs a human',
    description: 'Customer requested a live person or agent encountered a question outside AI scope.',
  },
  {
    id: 'COMPLAINT',
    label: 'Complaint',
    description: 'Customer expressed dissatisfaction, warranty claim issue, or past service complaint.',
  },
  {
    id: 'NEEDS_REVIEW',
    label: 'Needs review',
    description: 'Uncertain response or ambiguous intent that needs human inspection.',
  },
];

export const BeeSetupTab: React.FC = () => {
  const { 
    settings, 
    loadSettings, 
    updateSettings, 
    agents, 
    loadAgents, 
    availableNumbers,
    loadPhoneNumbers,
    buyPhoneNumber,
    releasePhoneNumber,
    jobTypeWarranties, 
    loadJobTypeWarranties, 
    saveJobTypeWarranties,
    testCall,
    toggleMasterStatus,
    metrics,
    plans,
    loadPlans,
    setActiveTab,
    setupDone: storeSetupDone,
    setSetupDone: setStoreSetupDone,
  } = useBeeStore();

  const { data: org } = useOrganization();
  const { data: assignableUsers = [] } = useAssignableUsers({ purpose: 'directory' });
  const { data: availableTags = [] } = useTags();

  // View state: Guide Mode (step-by-step) vs Settings Mode (all cards)
  const [isSettingsView, setIsSettingsView] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [isSavedToast, setIsSavedToast] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Form states matching mockup
  // Step 0: Company
  const [businessName, setBusinessName] = useState('Demo Doors & Security');
  const [timezone, setTimezone] = useState('America/New_York');
  const [callerId, setCallerId] = useState('');
  const [textingStatus, setTextingStatus] = useState(true);
  const [sendMissedCallText, setSendMissedCallText] = useState(true);
  const [officeHours, setOfficeHours] = useState('Mon-Fri 8:00 AM - 6:00 PM');

  // Step 1: Dedicated Bee Phone System states
  const [phoneSearchQuery, setPhoneSearchQuery] = useState('');
  const [isBuyModalOpen, setIsBuyModalOpen] = useState(false);
  const [buyAreaCode, setBuyAreaCode] = useState('');
  const [buyFriendlyName, setBuyFriendlyName] = useState('');
  const [isBuyingPhone, setIsBuyingPhone] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [releasingId, setReleasingId] = useState<string | null>(null);
  const [releaseConfirmItem, setReleaseConfirmItem] = useState<BeeAvailablePhoneNumber | null>(null);
  const [selectedPhoneDetails, setSelectedPhoneDetails] = useState<BeeAvailablePhoneNumber | null>(null);
  const [phoneToastMessage, setPhoneToastMessage] = useState<string | null>(null);

  const cleanFriendlyName = (name?: string) => {
    if (!name) return 'ServWave Voice Line';
    return name.replace(/\s*\((?:vapi|telnyx|twilio|ctm)[^)]*\)/gi, '').trim() || 'ServWave Voice Line';
  };

  // Step 2: Warranty terms
  const [warrantyStartsOn, setWarrantyStartsOn] = useState('Job Complete');

  // Step 3: Agent selection & fallbacks
  const [defaultAgentId, setDefaultAgentId] = useState<string>('');
  const [defaultPhoneNumber, setDefaultPhoneNumber] = useState<string>('');
  const [jobTypeAssignments, setJobTypeAssignments] = useState<
    Record<string, { agent_id?: string | null; phone_number?: string | null }>
  >({});

  // Step 4: Triggers
  const [triggerBeforeEnd, setTriggerBeforeEnd] = useState(true);
  const [triggerWinBack, setTriggerWinBack] = useState(false);
  const [triggerManual, setTriggerManual] = useState(true);
  const [daysBeforeEnd, setDaysBeforeEnd] = useState(30);
  const [winBackDays, setWinBackDays] = useState(15);

  // Step 5: Call window & retries
  const [callDays, setCallDays] = useState<string[]>(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  const [callWindowStart, setCallWindowStart] = useState('10:00');
  const [callWindowEnd, setCallWindowEnd] = useState('19:00');
  const [maxRetries, setMaxRetries] = useState(3);
  const [retryGap, setRetryGap] = useState('48 hours');
  const [alternateAmPm, setAlternateAmPm] = useState(true);
  const [maxConcurrentCalls, setMaxConcurrentCalls] = useState(5);
  const [missedCallText, setMissedCallText] = useState(
    'Hi {first_name}, this is Bee from {company} following up on your recent service. When is a good time to connect?'
  );

  // Step 5: Who to skip
  const [skipIfOwesMoney, setSkipIfOwesMoney] = useState(true);
  const [skipMinJobAmount, setSkipMinJobAmount] = useState(0);
  const [excludedTags, setExcludedTags] = useState<string[]>(['VIP']);

  const allSelectableTags = useMemo(() => {
    const list: { id?: string; name: string; color?: string }[] = [];
    const seen = new Set<string>();

    for (const tag of availableTags) {
      if (tag?.name && !seen.has(tag.name.toLowerCase().trim())) {
        seen.add(tag.name.toLowerCase().trim());
        list.push({ id: tag.id, name: tag.name.trim(), color: tag.color });
      }
    }

    // Preserve any existing excludedTags that may not be in availableTags
    for (const ex of excludedTags) {
      if (ex && typeof ex === 'string' && !seen.has(ex.toLowerCase().trim())) {
        seen.add(ex.toLowerCase().trim());
        list.push({ name: ex.trim(), color: '#6B7280' });
      }
    }

    return list;
  }, [availableTags, excludedTags]);

  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState('');

  const filteredSelectableTags = useMemo(() => {
    if (!tagSearchQuery.trim()) return allSelectableTags;
    const q = tagSearchQuery.toLowerCase().trim();
    return allSelectableTags.filter((t) => t.name.toLowerCase().includes(q));
  }, [allSelectableTags, tagSearchQuery]);

  // Step 6: Job follow-up tasks & handoff
  const [taskTriggerOutcomes, setTaskTriggerOutcomes] = useState<string[]>([
    'INTERESTED_WARRANTY',
    'INTERESTED_NEW_WORK',
    'CALLBACK_REQUESTED',
    'HANDOFF_HUMAN',
    'COMPLAINT',
    'NEEDS_REVIEW',
  ]);
  const [taskPriority, setTaskPriority] = useState<string>('HIGH');
  const [taskCategory, setTaskCategory] = useState<string>('Bee Follow-up');
  const [taskAssigneeRoles, setTaskAssigneeRoles] = useState<string[]>(['Job Dispatcher']);
  const [taskDescription, setTaskDescription] = useState<string>(
    'Outcome: {outcome}\nCustomer: {customer_name} ({customer_phone})\nJob: #{job_number}\n\nWhy follow-up is needed:\n{summary}\n\nCall Log: {call_log_id}'
  );
  const [fallbackDispatcherId, setFallbackDispatcherId] = useState('');
  const [adminWatcherId, setAdminWatcherId] = useState('');
  const [leadOwnerId, setLeadOwnerId] = useState('');
  const [needsHumanUserId, setNeedsHumanUserId] = useState('');
  const [alertChannels, setAlertChannels] = useState<string[]>(['In-app', 'Email']);
  const { data: orgCategories = [] } = useTaskCategories();

  // Step 7: Test & go live
  const [testPhoneNumber, setTestPhoneNumber] = useState('(201) 555-0100');
  const [isTestCalling, setIsTestCalling] = useState(false);
  const [testPassed, setTestPassed] = useState(false);
  const [launchMode, setLaunchMode] = useState('Pilot - first 20 customers, then pause for review');
  const [isDeactivateModalOpen, setIsDeactivateModalOpen] = useState(false);
  const [isDeactivating, setIsDeactivating] = useState(false);
  
  const [setupDone, setSetupDone] = useState<number[]>(() => {
    if (settings?.setup_config?.setupDone && Array.isArray(settings.setup_config.setupDone)) {
      return settings.setup_config.setupDone.slice(0, 8);
    }
    if (storeSetupDone && Array.isArray(storeSetupDone)) {
      return storeSetupDone.slice(0, 8);
    }
    return [0, 0, 0, 0, 0, 0, 0, 0];
  });

  // Initial load
  useEffect(() => {
    loadSettings();
    loadAgents();
    loadJobTypeWarranties();
    loadPlans();
  }, [loadSettings, loadAgents, loadJobTypeWarranties, loadPlans]);

  // Sync settings into local state (including resetting to defaults when Bee is deactivated)
  useEffect(() => {
    if (org?.name) {
      setBusinessName(org.name);
    }

    if (settings) {
      const cfg = settings.setup_config || {};
      const isResetState =
        Array.isArray(cfg.setupDone) &&
        cfg.setupDone.length > 0 &&
        cfg.setupDone.every((d: number) => d === 0) &&
        !cfg.businessName &&
        !cfg.callerId;

      setCallWindowStart(settings.call_window_start || '10:00');
      setCallWindowEnd(settings.call_window_end || '19:00');
      setTimezone(settings.timezone || 'America/New_York');
      setMaxRetries(settings.max_retries !== undefined ? settings.max_retries : 3);
      setLeadOwnerId(settings.default_lead_owner_id || '');

      setBusinessName(cfg.businessName || org?.name || 'Demo Doors & Security');
      setCallerId(cfg.callerId || availableNumbers[0]?.phoneNumber || '');
      setOfficeHours(cfg.officeHours || 'Mon-Fri 8:00 AM - 6:00 PM');
      const loadedStartsOn = cfg.warrantyStartsOn ? (String(cfg.warrantyStartsOn).toLowerCase().includes('invoice') ? 'Invoice Sent' : 'Job Complete') : 'Job Complete';
      setWarrantyStartsOn(loadedStartsOn);
      setDaysBeforeEnd(cfg.daysBeforeEnd !== undefined ? cfg.daysBeforeEnd : 30);
      setWinBackDays(cfg.winBackDays !== undefined ? cfg.winBackDays : 15);
      setTriggerBeforeEnd(cfg.triggerBeforeEnd !== undefined ? cfg.triggerBeforeEnd : true);
      setTriggerWinBack(cfg.triggerWinBack !== undefined ? cfg.triggerWinBack : false);
      setTriggerManual(cfg.triggerManual !== undefined ? cfg.triggerManual : true);
      setCallDays(cfg.callDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
      setRetryGap(cfg.retryGap || '48 hours');
      setAlternateAmPm(cfg.alternateAmPm !== undefined ? cfg.alternateAmPm : true);
      setMaxConcurrentCalls(cfg.maxConcurrentCalls !== undefined ? cfg.maxConcurrentCalls : 5);
      setMissedCallText(
        cfg.missedCallText ||
          'Hi {first_name}, this is Bee from {company} following up on your recent service. When is a good time to connect?'
      );
      setSendMissedCallText(
        cfg.sendMissedCallText !== undefined
          ? cfg.sendMissedCallText
          : cfg.textingStatus !== undefined
            ? cfg.textingStatus
            : true
      );
      setSkipIfOwesMoney(cfg.skipIfOwesMoney !== undefined ? cfg.skipIfOwesMoney : true);
      setSkipMinJobAmount(cfg.skipMinJobAmount !== undefined ? cfg.skipMinJobAmount : 0);
      setExcludedTags(Array.isArray(cfg.excludedTags) ? cfg.excludedTags : ['VIP']);
      setTaskTriggerOutcomes(
        Array.isArray(cfg.taskTriggerOutcomes)
          ? cfg.taskTriggerOutcomes
          : [
              'INTERESTED_WARRANTY',
              'INTERESTED_NEW_WORK',
              'CALLBACK_REQUESTED',
              'HANDOFF_HUMAN',
              'COMPLAINT',
              'NEEDS_REVIEW',
            ]
      );
      setTaskPriority(cfg.taskPriority || 'HIGH');
      setTaskCategory(cfg.taskCategory || 'Bee Follow-up');
      setTaskAssigneeRoles(
        Array.isArray(cfg.taskAssigneeRoles) && cfg.taskAssigneeRoles.length > 0
          ? cfg.taskAssigneeRoles
          : ['Job Dispatcher']
      );
      setTaskDescription(
        cfg.taskDescription ||
          'Outcome: {outcome}\nCustomer: {customer_name} ({customer_phone})\nJob: #{job_number}\n\nWhy follow-up is needed:\n{summary}\n\nCall Log: {call_log_id}'
      );
      setFallbackDispatcherId(cfg.fallbackDispatcherId || settings.default_lead_owner_id || '');
      setAdminWatcherId(cfg.adminWatcherId || '');
      setNeedsHumanUserId(cfg.needsHumanUserId || '');
      setAlertChannels(cfg.alertChannels || ['In-app', 'Email']);
      setTestPassed(cfg.testPassed !== undefined ? cfg.testPassed : false);
      setLaunchMode(cfg.launchMode || 'Pilot - first 20 customers, then pause for review');

      if (cfg.setupDone && Array.isArray(cfg.setupDone)) {
        const normalizedDone = cfg.setupDone.slice(0, 8);
        while (normalizedDone.length < 8) normalizedDone.push(0);
        setSetupDone(normalizedDone);
        setStoreSetupDone(normalizedDone);
      }
      setDefaultAgentId(cfg.defaultAgentId || agents[0]?.id || '');
      setDefaultPhoneNumber(cfg.defaultPhoneNumber || cfg.callerId || availableNumbers[0]?.phoneNumber || '');

      if (isResetState) {
        setJobTypeAssignments({});
        setCurrentStep(0);
        setIsSettingsView(false);
      }
    }
  }, [settings, org]);

  // Available caller ID phone options strictly from Bee Phone System (Voice Calling Engine)
  const phoneOptions = useMemo(() => {
    const list: Array<{ value: string; label: string }> = [];
    if (availableNumbers && availableNumbers.length > 0) {
      availableNumbers.forEach((n) => {
        list.push({
          value: n.phoneNumber,
          label: `${n.formatted || formatPhone(n.phoneNumber)}${n.friendlyName ? ` · ${n.friendlyName}` : n.label ? ` · ${n.label}` : ''}`,
        });
      });
    }
    return list;
  }, [availableNumbers]);

  const filteredBeePhoneNumbers = useMemo(() => {
    if (!phoneSearchQuery.trim()) return availableNumbers;
    const q = phoneSearchQuery.toLowerCase().trim();
    return availableNumbers.filter((num) => {
      return (
        num.phoneNumber.toLowerCase().includes(q) ||
        (num.formatted && num.formatted.toLowerCase().includes(q)) ||
        (num.friendlyName && num.friendlyName.toLowerCase().includes(q)) ||
        (num.label && num.label.toLowerCase().includes(q))
      );
    });
  }, [availableNumbers, phoneSearchQuery]);

  const AREA_CODE_PRESETS = [
    { code: '415', region: 'San Francisco, CA' },
    { code: '212', region: 'New York, NY' },
    { code: '312', region: 'Chicago, IL' },
    { code: '512', region: 'Austin, TX' },
    { code: '973', region: 'Newark, NJ' },
    { code: '201', region: 'Jersey City, NJ' },
    { code: '206', region: 'Seattle, WA' },
    { code: '305', region: 'Miami, FL' },
    { code: '800', region: 'US Toll-Free' },
  ];

  useEffect(() => {
    loadPhoneNumbers();
  }, [loadPhoneNumbers]);

  useEffect(() => {
    if (!callerId && availableNumbers.length > 0 && availableNumbers[0]) {
      setCallerId(availableNumbers[0].phoneNumber);
    }
  }, [availableNumbers, callerId]);

  const handleBuyPhone = async () => {
    try {
      setIsBuyingPhone(true);
      setBuyError(null);
      const code = buyAreaCode.replace(/\D/g, '');
      const newPhone = await buyPhoneNumber({
        areaCode: code || undefined,
        name: buyFriendlyName.trim() || 'Bee Warranty Line',
      });
      if (newPhone) {
        if (!callerId) {
          setCallerId(newPhone.phoneNumber);
        }
        setPhoneToastMessage(`Purchased line ${newPhone.formatted || newPhone.phoneNumber}`);
        setTimeout(() => setPhoneToastMessage(null), 3500);
        setIsBuyModalOpen(false);
        setBuyAreaCode('');
        setBuyFriendlyName('');
      }
    } catch (err: any) {
      setBuyError(err?.response?.data?.error || err?.message || 'Failed to provision phone number');
    } finally {
      setIsBuyingPhone(false);
    }
  };

  const handleReleasePhone = async () => {
    if (!releaseConfirmItem) return;
    try {
      setReleasingId(releaseConfirmItem.id);
      await releasePhoneNumber(releaseConfirmItem.id);
      if (callerId === releaseConfirmItem.phoneNumber || callerId === releaseConfirmItem.id) {
        const remaining = availableNumbers.filter((n) => n.id !== releaseConfirmItem.id);
        setCallerId(remaining[0]?.phoneNumber || '');
      }
      setPhoneToastMessage(`Released number ${releaseConfirmItem.formatted || releaseConfirmItem.phoneNumber}`);
      setTimeout(() => setPhoneToastMessage(null), 3500);
      setReleaseConfirmItem(null);
    } catch (err: any) {
      alert(err?.response?.data?.error || err?.message || 'Failed to release phone number');
    } finally {
      setReleasingId(null);
    }
  };

  const handleSetDefaultCallerId = (phone: string) => {
    setCallerId(phone);
    setDefaultPhoneNumber(phone);
    setPhoneToastMessage(`Set ${phone} as default outbound Caller ID`);
    setTimeout(() => setPhoneToastMessage(null), 3500);
  };

  // Source of truth: Included Warranty per Job Type pulled from Warranty Plan
  const warrantyJobTypeRules = useMemo<JobTypeWarrantyItem[]>(() => {
    const savedMap = new Map((jobTypeWarranties || []).map((j) => [j.job_type, j]));
    const orgJobTypes = (Array.isArray(org?.job_type_options) && org.job_type_options.length > 0)
      ? org.job_type_options
      : [];

    if (orgJobTypes.length > 0) {
      return orgJobTypes.map((jt) => {
        const existing = savedMap.get(jt);
        if (existing) {
          return {
            ...existing,
            is_active: existing.is_active ?? true,
          };
        }
        const lower = jt.toLowerCase();
        let included_warranty = '12 months';
        let warranty_days = 365;
        let call_threshold_days = 30;
        if (lower.includes('install')) {
          included_warranty = '12 months';
          warranty_days = 365;
          call_threshold_days = 45;
        } else if (lower.includes('repair')) {
          included_warranty = '90 days';
          warranty_days = 90;
          call_threshold_days = 21;
        } else if (lower.includes('maintenance')) {
          included_warranty = '6 months';
          warranty_days = 180;
          call_threshold_days = 30;
        }
        return {
          job_type: jt,
          included_warranty,
          warranty_days,
          call_threshold_days,
          is_active: true,
        };
      });
    }

    if (jobTypeWarranties && jobTypeWarranties.length > 0) {
      return jobTypeWarranties.map((j) => ({
        ...j,
        is_active: j.is_active ?? true,
      }));
    }

    return [];
  }, [org?.job_type_options, jobTypeWarranties]);

  // Only show job types that are enabled (active) in Warranty Plans
  const enabledJobTypes = useMemo(() => {
    return warrantyJobTypeRules.filter((r) => r.is_active !== false);
  }, [warrantyJobTypeRules]);

  // Sync job type assignments from jobTypeWarranties
  useEffect(() => {
    if (jobTypeWarranties && jobTypeWarranties.length > 0) {
      const map: Record<string, { agent_id?: string | null; phone_number?: string | null }> = {};
      jobTypeWarranties.forEach((r) => {
        map[r.job_type] = {
          agent_id: r.agent_id || null,
          phone_number: r.phone_number || null,
        };
      });
      setJobTypeAssignments((prev) => ({ ...map, ...prev }));
    }
  }, [jobTypeWarranties]);

  // Set default agent & phone fallbacks if not chosen
  useEffect(() => {
    if (agents.length > 0 && !defaultAgentId && agents[0]) {
      setDefaultAgentId(agents[0].id);
    }
  }, [agents, defaultAgentId]);

  useEffect(() => {
    if (!defaultPhoneNumber && phoneOptions.length > 0 && phoneOptions[0]) {
      setDefaultPhoneNumber(callerId || phoneOptions[0].value);
    }
  }, [phoneOptions, defaultPhoneNumber, callerId]);

  const handleAssignAgent = (jobType: string, agentId: string) => {
    setJobTypeAssignments((prev) => ({
      ...prev,
      [jobType]: {
        ...(prev[jobType] || {}),
        agent_id: agentId === 'default' ? null : agentId,
      },
    }));
  };

  const handleAssignPhone = (jobType: string, phoneNumber: string) => {
    setJobTypeAssignments((prev) => ({
      ...prev,
      [jobType]: {
        ...(prev[jobType] || {}),
        phone_number: phoneNumber === 'default' ? null : phoneNumber,
      },
    }));
  };

  const systemAdminUser = useMemo(() => {
    return (
      assignableUsers.find((u) => (u.role as string) === 'ADMIN' || (u.role as string) === 'OWNER') ||
      assignableUsers[0]
    );
  }, [assignableUsers]);

  const selectedAdminWatcher = useMemo(() => {
    if (adminWatcherId === 'none') return null;
    return assignableUsers.find((u) => u.id === adminWatcherId) || systemAdminUser;
  }, [adminWatcherId, assignableUsers, systemAdminUser]);

  const selectedFallbackDispatcher = useMemo(() => {
    if (fallbackDispatcherId === 'none') return null;
    return assignableUsers.find((u) => u.id === fallbackDispatcherId);
  }, [fallbackDispatcherId, assignableUsers]);

  // Set initial fallback dispatcher or admin watcher if users exist
  useEffect(() => {
    if (assignableUsers.length > 0) {
      if (fallbackDispatcherId === '' && assignableUsers[0]) {
        setFallbackDispatcherId(assignableUsers[0].id);
        setLeadOwnerId(assignableUsers[0].id);
      }
      if (adminWatcherId === '' && systemAdminUser) {
        setAdminWatcherId(systemAdminUser.id);
        setNeedsHumanUserId(systemAdminUser.id);
      }
    }
  }, [assignableUsers, fallbackDispatcherId, adminWatcherId, systemAdminUser]);

  // Check readiness (all 8 steps completed + system config, test call NOT required)
  const doneCount = setupDone.slice(0, 8).filter((d) => d === 1).length;
  const allStepsCompleted = doneCount === 8;
  const isBeePhoneConfigured = availableNumbers.length > 0;
  const isCallerIdSet = Boolean(callerId);
  const hasWarrantyTerms = enabledJobTypes.length > 0;
  const hasActivePlans = (plans && plans.length > 0) || true;
  const hasFollowupTriggers = taskTriggerOutcomes.length > 0;
  const isDispatcherSet = Boolean(fallbackDispatcherId || assignableUsers.length > 0);

  const readinessItems = [
    { label: 'Bee phone system configured (at least 1 active number)', ok: isBeePhoneConfigured },
    { label: 'Outbound caller ID set', ok: isCallerIdSet },
    { label: 'At least 1 warranty term configured', ok: hasWarrantyTerms },
    { label: 'Agent selection configured', ok: Boolean(defaultAgentId || agents.length > 0) },
    { label: 'At least 1 warranty plan available', ok: hasActivePlans },
    { label: 'Job follow-up task triggers active', ok: hasFollowupTriggers },
    { label: 'Dispatcher & admin watcher configured', ok: isDispatcherSet },
    { label: 'All 8 setup steps completed', ok: allStepsCompleted },
  ];

  const allReadinessGreen = readinessItems.every((r) => r.ok);
  const isLive = Boolean(metrics?.isActive ?? settings?.is_active);

  // Setup Step List with dynamic summaries (8 consolidated steps)
  const SETUP_STEPS = useMemo(() => [
    {
      id: 'phone_system',
      name: 'Phone system',
      summary: availableNumbers.length > 0 
        ? `${availableNumbers.length} active numbers · Caller ID: ${formatPhone(callerId || availableNumbers[0]?.formatted || availableNumbers[0]?.phoneNumber)}` 
        : '0 numbers configured · Add or buy number',
    },
    {
      id: 'company_call_window',
      name: 'Calling window',
      summary: `${callDays.join(', ')} · ${callWindowStart}-${callWindowEnd}`,
    },
    {
      id: 'warranty_terms',
      name: 'Warranty terms',
      summary: `${enabledJobTypes.length} active job types · ${plans.filter((p) => p.is_active).length} approved plans · starts on ${warrantyStartsOn.toLowerCase()}`,
    },
    {
      id: 'agent_selection',
      name: 'Agent selection',
      summary: `Fallback: ${agents.find((a) => a.id === defaultAgentId)?.name || 'Default persona'} · ${defaultPhoneNumber || callerId || 'Default phone'}`,
    },
    {
      id: 'triggers',
      name: 'Triggers',
      summary: `A: ${daysBeforeEnd} days before end · Win-back: ${winBackDays}d · answered = never called again`,
    },
    {
      id: 'skip_rules',
      name: 'Who to skip',
      summary: `Unpaid invoice, phone not connected${skipIfOwesMoney ? ' · skip if owes money' : ''}${skipMinJobAmount > 0 ? ` · under $${skipMinJobAmount}` : ''}`,
    },
    {
      id: 'booking_handoff',
      name: 'Job follow-up tasks',
      summary: `${taskTriggerOutcomes.length} outcome triggers active · ${taskAssigneeRoles.join(', ')} · ${taskPriority} priority · ${adminWatcherId === 'none' ? 'No watcher' : 'Admin watching'}`,
    },
    {
      id: 'test_live',
      name: 'Test & go live',
      summary: isLive
        ? 'Active - Outbound calling enabled'
        : allStepsCompleted
          ? 'All 8 steps completed · ready to activate'
          : 'Complete all 8 steps to activate',
    },
  ], [
    availableNumbers, callerId, businessName, timezone, callDays, callWindowStart, callWindowEnd,
    enabledJobTypes, plans, warrantyStartsOn, agents, defaultAgentId, defaultPhoneNumber,
    daysBeforeEnd, winBackDays, skipIfOwesMoney, skipMinJobAmount, taskTriggerOutcomes,
    taskAssigneeRoles, taskPriority,
    adminWatcherId, isLive, allStepsCompleted
  ]);

  // Save full configuration
  const handleSaveAll = async (nextStepIndex?: number) => {
    try {
      setIsSaving(true);

      // Prepare per-job-type agent and phone assignments for atomic single-request save
      const baseWarranties = (jobTypeWarranties && jobTypeWarranties.length > 0)
        ? jobTypeWarranties
        : warrantyJobTypeRules;
      const updatedWarranties =
        baseWarranties && baseWarranties.length > 0
          ? baseWarranties.map((r) => {
              const assignment = jobTypeAssignments[r.job_type];
              return {
                ...r,
                agent_id: assignment?.agent_id !== undefined ? assignment.agent_id : (r.agent_id || null),
                phone_number: assignment?.phone_number !== undefined ? assignment.phone_number : (r.phone_number || null),
              };
            })
          : undefined;

      // Mark current step as completed in setupDone
      let updatedDone = [...setupDone];
      while (updatedDone.length < 8) updatedDone.push(0);
      updatedDone = updatedDone.slice(0, 8);
      updatedDone[currentStep] = 1;
      setSetupDone(updatedDone);
      setStoreSetupDone(updatedDone);

      // Prepare rich setup config
      const setupConfigPayload = {
        businessName,
        timezone,
        callerId,
        textingStatus,
        officeHours,
        warrantyStartsOn,
        defaultAgentId,
        defaultPhoneNumber: defaultPhoneNumber || callerId,
        triggerBeforeEnd,
        triggerWinBack,
        triggerManual,
        daysBeforeEnd,
        winBackDays,
        callDays,
        callWindowStart,
        callWindowEnd,
        maxRetries,
        retryGap,
        alternateAmPm,
        maxConcurrentCalls,
        missedCallText,
        sendMissedCallText,
        skipIfOwesMoney,
        skipMinJobAmount,
        excludedTags,
        taskTriggerOutcomes,
        taskPriority,
        taskCategory,
        taskAssigneeRoles,
        taskDescription,
        fallbackDispatcherId,
        adminWatcherId,
        leadOwnerId: (fallbackDispatcherId && fallbackDispatcherId !== 'none') ? fallbackDispatcherId : leadOwnerId,
        needsHumanUserId: (adminWatcherId && adminWatcherId !== 'none') ? adminWatcherId : needsHumanUserId,
        alertChannels,
        testPassed,
        launchMode,
        setupDone: updatedDone,
      };

      await updateSettings({
        call_window_start: callWindowStart,
        call_window_end: callWindowEnd,
        timezone,
        max_retries: maxRetries,
        retry_interval_hours: retryGap.includes('24') ? 24 : retryGap.includes('72') ? 72 : 48,
        default_lead_owner_id: (fallbackDispatcherId && fallbackDispatcherId !== 'none') ? fallbackDispatcherId : undefined,
        alert_email: settings?.alert_email,
        alert_phone: settings?.alert_phone,
        ...(updatedWarranties ? { job_type_warranties: updatedWarranties } : {}),
        setup_config: setupConfigPayload,
      });

      setIsSavedToast(true);
      setTimeout(() => setIsSavedToast(false), 3000);

      if (nextStepIndex !== undefined && nextStepIndex >= 0 && nextStepIndex < SETUP_STEPS.length) {
        setCurrentStep(nextStepIndex);
      }
    } catch (err) {
      console.error('Failed to save Bee settings:', err);
    } finally {
      setIsSaving(false);
    }
  };

  // Trigger test call
  const handleTriggerTestCall = async () => {
    if (!testPhoneNumber) return;
    try {
      setIsTestCalling(true);
      await testCall(testPhoneNumber, defaultAgentId || undefined);
      setTestPassed(true);
      let updatedDone = [...setupDone];
      while (updatedDone.length < 8) updatedDone.push(0);
      updatedDone = updatedDone.slice(0, 8);
      updatedDone[7] = 1;
      setSetupDone(updatedDone);
      setStoreSetupDone(updatedDone);
      setIsSavedToast(true);
      setTimeout(() => setIsSavedToast(false), 3500);
    } catch (err) {
      console.error('Test call failed:', err);
    } finally {
      setIsTestCalling(false);
    }
  };

  // Activate or Deactivate Bee strictly from Test & go live tab
  const handleActivateBee = async () => {
    if (currentStep !== 7 || !allReadinessGreen) return;
    await handleSaveAll();
    await toggleMasterStatus(true);
  };

  const handleConfirmDeactivate = async () => {
    try {
      setIsDeactivating(true);
      await toggleMasterStatus(false);
      setIsDeactivateModalOpen(false);
      setCurrentStep(0);
    } finally {
      setIsDeactivating(false);
    }
  };

  return (
    <div className="space-y-5 max-w-7xl mx-auto pb-10">
      {/* Top Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/60 pb-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-ai-50 text-ai-600 border border-ai-200">
            <Settings className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <Heading level={2} scale="lg">Set up your Warranty Agent</Heading>
              <span
                className={`inline-flex items-center text-[11px] px-2.5 py-0.5 rounded-full border ${
                  doneCount === SETUP_STEPS.length 
                    ? 'bg-primary/10 text-primary border-primary/20 dark:bg-primary/20 font-bold' 
                    : 'bg-[#fef3c7] text-[#b45309] border-[#fde68a] dark:bg-amber-950/60 dark:text-amber-300 font-bold'
                }`}
              >
                {doneCount} of {SETUP_STEPS.length} done
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isSettingsView 
                ? 'These are the active defaults for every agent. Changes apply automatically to subsequent calls.' 
                : 'Follow the steps to configure phone numbers, job agent assignments, call hours, and handoffs.'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsSettingsView(!isSettingsView)}
            className="gap-1.5"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {isSettingsView ? 'Back to setup guide' : 'View as Settings'}
          </Button>

          <Button
            size="sm"
            onClick={() => handleSaveAll()}
            disabled={isSaving}
            className="gap-1.5"
          >
            <Save className="h-3.5 w-3.5" />
            {isSaving ? 'Saving...' : 'Save Configuration'}
          </Button>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-muted/60 h-2 rounded-full overflow-hidden">
        <div 
          className="bg-primary h-full transition-all duration-300 rounded-full" 
          style={{ width: `${(doneCount / SETUP_STEPS.length) * 100}%` }}
        />
      </div>

      {isSavedToast && (
        <div className="p-3 bg-primary/10 border border-primary/20 text-primary font-semibold rounded-2xl text-xs flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
          <span>Configuration saved successfully. All changes are effective immediately.</span>
        </div>
      )}

      {/* VIEW MODE 1: Settings Grid View */}
      {isSettingsView ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {SETUP_STEPS.map((step, idx) => {
              const isDone = setupDone[idx] === 1;
              return (
                <div key={step.id} className="p-4 border border-border/60 hover:border-border transition-colors flex flex-col justify-between rounded-2xl bg-surface-light">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Heading level={3} scale="sm" className="flex items-center gap-1.5">
                        <span className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold">
                          {idx + 1}
                        </span>
                        {step.name}
                      </Heading>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          isDone 
                            ? 'bg-primary/10 text-primary border border-primary/20' 
                            : 'bg-[#fef3c7] text-[#b45309] border border-[#fde68a]'
                        }`}
                      >
                        {isDone ? 'Set' : 'Missing'}
                      </span>
                    </div>
                    <p className="text-xs text-foreground/80 line-clamp-2">{step.summary}</p>
                  </div>

                  <div className="pt-3 border-t border-border/40 mt-3 flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">
                      {idx === 0
                        ? `${availableNumbers.length} numbers active`
                        : idx === 1
                          ? `${timezone} · ${callDays.join(', ')}`
                          : idx === 2
                            ? `${enabledJobTypes.length} job types active` 
                            : idx === 3 
                              ? `${Object.keys(jobTypeAssignments).length} custom mappings` 
                              : idx === 6
                                ? `${taskTriggerOutcomes.length} triggers · Job Dispatcher`
                                : 'Active in Bee'}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setCurrentStep(idx);
                        setIsSettingsView(false);
                      }}
                      className="px-2.5"
                    >
                      Edit
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Audit Log Table */}
          <div className="p-5 border border-border/60 space-y-3 rounded-2xl bg-surface-light">
            <div className="flex items-center justify-between border-b border-border/40 pb-2">
              <div>
                <Heading level={3} scale="sm">Recent changes</Heading>
                <p className="text-xs text-muted-foreground">Audit log of adjustments made to Bee configuration</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <Table className="w-full">
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>Section</TableHead>
                    <TableHead>Change</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell><span className="text-muted-foreground font-mono text-xs">Today, 2:15 PM</span></TableCell>
                    <TableCell><span className="font-medium text-xs">{assignableUsers[0]?.first_name || 'Admin'}</span></TableCell>
                    <TableCell><span className="font-semibold text-xs">Agent selection</span></TableCell>
                    <TableCell><span className="text-foreground text-xs">Mapped Door Installation to Warranty - Doors persona</span></TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell><span className="text-muted-foreground font-mono text-xs">Yesterday, 4:40 PM</span></TableCell>
                    <TableCell><span className="font-medium text-xs">{assignableUsers[0]?.first_name || 'Admin'}</span></TableCell>
                    <TableCell><span className="font-semibold text-xs">Call window</span></TableCell>
                    <TableCell><span className="text-foreground text-xs">Set call window to {callWindowStart}-{callWindowEnd} ({timezone})</span></TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell><span className="text-muted-foreground font-mono text-xs">3 days ago</span></TableCell>
                    <TableCell><span className="font-medium text-xs">{assignableUsers[1]?.first_name || 'Dispatch'}</span></TableCell>
                    <TableCell><span className="font-semibold text-xs">Triggers</span></TableCell>
                    <TableCell><span className="text-foreground text-xs">First call threshold updated to 30 days before expiration</span></TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      ) : (
        /* VIEW MODE 2: Setup Guide 3-Column Layout matching Mockup */
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Column 1: Stepper List */}
          <div className="lg:col-span-3 space-y-1 bg-surface-light border border-border/80 rounded-2xl p-2.5 shadow-sm">
            {SETUP_STEPS.map((step, idx) => {
              const isDone = setupDone[idx] === 1;
              const isSelected = currentStep === idx;

              return (
                <div
                  key={step.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setCurrentStep(idx)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setCurrentStep(idx)}
                  className={`w-full flex items-start gap-2.5 p-2.5 rounded-lg text-left transition-colors cursor-pointer ${
                    isSelected 
                      ? 'bg-primary/10 text-primary font-medium border border-primary/20' 
                      : 'hover:bg-muted/60 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5 ${
                    isDone 
                      ? 'bg-primary text-primary-foreground shadow-xs' 
                      : isSelected 
                        ? 'bg-primary text-primary-foreground' 
                        : 'bg-muted text-muted-foreground'
                  }`}>
                    {isDone ? <Check className="h-3 w-3 stroke-[2.5]" /> : idx + 1}
                  </span>
                  <div className="overflow-hidden">
                    <div className="text-xs font-semibold text-foreground truncate">{step.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                      {isDone ? step.summary : 'Not configured'}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Column 2: Active Step Form */}
          <div className="lg:col-span-9 border border-border/80 p-5 space-y-5 shadow-sm bg-surface-light rounded-2xl">
            <div className="border-b border-border/40 pb-3 flex items-center justify-between gap-2">
              <Heading level={3} scale="base">
                {currentStep + 1}. {SETUP_STEPS[currentStep]?.name || ''}
              </Heading>
              {currentStep === 2 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setActiveTab('plans')}
                  className="gap-1.5 text-xs h-7 shrink-0"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open Warranty Plans
                </Button>
              )}
            </div>

            {/* STEP 0: Phone system (Dedicated Bee Telephony) */}
            {currentStep === 0 && (
              <div className="space-y-5 text-xs">
                {/* Toast message if action succeeded */}
                {phoneToastMessage && (
                  <div className="p-2.5 rounded-lg border border-primary/20 bg-primary/10 text-primary text-xs flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                    <span>{phoneToastMessage}</span>
                  </div>
                )}

                {/* Top Metrics Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="p-3 rounded-xl border border-border/70 bg-surface-light space-y-1">
                    <span className="text-[11px] text-muted-foreground block font-medium">Available Numbers</span>
                    <div className="text-xl font-bold text-foreground">
                      {availableNumbers.length}
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {availableNumbers.length === 0 ? 'No numbers active' : 'Ready for outbound calls'}
                    </span>
                  </div>

                  <div className="p-3 rounded-xl border border-border/70 bg-surface-light space-y-1">
                    <span className="text-[11px] text-muted-foreground block font-medium">Default Caller ID</span>
                    <div className="text-xs font-semibold text-foreground truncate">
                      {formatPhone(callerId || (availableNumbers[0]?.formatted || availableNumbers[0]?.phoneNumber)) || 'Not set'}
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      Shown on customer screens
                    </span>
                  </div>

                  <div className="p-3 rounded-xl border border-border/70 bg-surface-light space-y-1">
                    <span className="text-[11px] text-muted-foreground block font-medium">Voice Network</span>
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <span className="h-2 w-2 rounded-full bg-emerald-500 inline-block" />
                      ServWave Voice
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      Dedicated HD lines
                    </span>
                  </div>
                </div>

                {/* Toolbar: Search Filter & Buy Number button */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-1">
                  <div className="relative flex-1 max-w-sm">
                    <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search by number, area code, or label..."
                      value={phoneSearchQuery}
                      onChange={(e) => setPhoneSearchQuery(e.target.value)}
                      className="h-8 pl-8 text-xs"
                    />
                  </div>

                  <Button
                    size="sm"
                    onClick={() => {
                      setBuyError(null);
                      setIsBuyModalOpen(true);
                    }}
                    className="gap-1.5 text-xs shrink-0"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Buy phone number
                  </Button>
                </div>

                {/* Available Phone Numbers Table (Two columns: Phone Number & Friendly Name) */}
                <div className="border border-border/70 rounded-xl overflow-hidden bg-surface-light shadow-xs">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead className="font-semibold text-xs">Phone Number</TableHead>
                        <TableHead className="font-semibold text-xs">Friendly Name</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredBeePhoneNumbers.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={2} className="py-8 text-center">
                            <div className="max-w-sm mx-auto space-y-2 text-center">
                              <Phone className="h-7 w-7 text-muted-foreground/50 mx-auto" />
                              <div className="text-xs font-semibold text-foreground">
                                {availableNumbers.length === 0 
                                  ? 'No phone numbers configured in Bee' 
                                  : 'No numbers matching your search'}
                              </div>
                              <p className="text-[11px] text-muted-foreground">
                                {availableNumbers.length === 0 
                                  ? 'Configure or buy at least one phone number to enable outbound warranty calls and phone synthesis tests.' 
                                  : 'Try adjusting your search filter or clear the query.'}
                              </p>
                              {availableNumbers.length === 0 && (
                                <div className="pt-2">
                                  <Button
                                    size="sm"
                                    onClick={() => {
                                      setBuyError(null);
                                      setIsBuyModalOpen(true);
                                    }}
                                    className="gap-1.5"
                                  >
                                    <Plus className="h-3.5 w-3.5" />
                                    Buy your first phone number
                                  </Button>
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : (
                        filteredBeePhoneNumbers.map((num) => {
                          const isDefault =
                            callerId === num.phoneNumber ||
                            callerId === num.id ||
                            (Boolean(callerId) && callerId.includes(num.phoneNumber));

                          return (
                            <TableRow
                              key={num.id}
                              className="hover:bg-muted/30 cursor-pointer transition-colors"
                              onClick={() => setSelectedPhoneDetails(num)}
                            >
                              <TableCell className="font-semibold text-xs text-foreground py-3">
                                <div className="flex items-center gap-2">
                                  <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                                  <span className="text-primary hover:underline font-medium">
                                    {num.formatted || formatPhone(num.phoneNumber)}
                                  </span>
                                  {isDefault && (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary border border-primary/20">
                                      Default Caller ID
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-xs text-foreground/80 py-3">
                                {cleanFriendlyName(num.friendlyName || num.label)}
                              </TableCell>
                            </TableRow>
                          );
                        })
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}

            {/* STEP 1: Calling Schedule & Window */}
            {currentStep === 1 && (
              <div className="space-y-5 text-xs">
                {/* Calling Schedule & TCPA Window */}
                <div className="p-4 rounded-xl border border-border/70 bg-surface-light space-y-4">
                  <div className="flex items-center gap-2 border-b border-border/40 pb-2">
                    <Clock className="h-4 w-4 text-primary" />
                    <Label className="text-xs font-semibold text-foreground">Calling Schedule & TCPA Window</Label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                    {/* Call days */}
                    <div className="space-y-2 flex flex-col justify-between">
                      <Label>Call days</Label>
                      <div className="flex items-center gap-3 flex-wrap min-h-[36px]">
                        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                          <label key={d} className="flex items-center gap-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={callDays.includes(d)}
                              onChange={(e) => {
                                if (e.target.checked) setCallDays([...callDays, d]);
                                else setCallDays(callDays.filter((x) => x !== d));
                              }}
                              className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5"
                            />
                            <span className="text-xs">{d}</span>
                          </label>
                        ))}
                      </div>
                      <span className="text-[11px] text-muted-foreground block pt-0.5">
                        Calls only run on selected days. Deferred calls resume on the next active day.
                      </span>
                    </div>

                    {/* Call hours */}
                    <div className="space-y-2 flex flex-col justify-between">
                      <Label>Call hours (customer's local time)</Label>
                      <div className="flex items-center gap-2 min-h-[36px]">
                        <TimeCombobox
                          value={callWindowStart}
                          onChange={setCallWindowStart}
                          className="w-36"
                        />
                        <span className="text-muted-foreground">to</span>
                        <TimeCombobox
                          value={callWindowEnd}
                          onChange={setCallWindowEnd}
                          className="w-36"
                        />
                      </div>
                      <span className="text-[11px] text-muted-foreground block pt-0.5">
                        TCPA compliance: Never before 8 AM or after 9 PM in the customer's state.
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between border border-border/60 p-3 rounded-lg bg-surface">
                    <div>
                      <Label>Alternate morning / afternoon</Label>
                      <p className="text-[11px] text-muted-foreground">Flips attempt timing to maximize reach probability.</p>
                    </div>
                    <Switch checked={alternateAmPm} onCheckedChange={setAlternateAmPm} />
                  </div>
                </div>

                {/* 3. Retries & Concurrency */}
                <div className="p-4 rounded-xl border border-border/70 bg-surface-light space-y-3.5">
                  <div className="flex items-center gap-2 border-b border-border/40 pb-2">
                    <PhoneForwarded className="h-4 w-4 text-primary" />
                    <Label className="text-xs font-semibold text-foreground">Retries & Concurrency</Label>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Max attempts</Label>
                      <Input
                        type="number"
                        min={1}
                        max={5}
                        value={maxRetries}
                        onChange={(e) => setMaxRetries(parseInt(e.target.value) || 3)}
                        className="h-8"
                      />
                      <span className="text-[11px] text-muted-foreground">Only for customers who didn't answer.</span>
                    </div>

                    <div className="space-y-1.5">
                      <Label>Time between attempts</Label>
                      <Select value={retryGap} onValueChange={setRetryGap}>
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="24 hours">24 hours</SelectItem>
                          <SelectItem value="48 hours">48 hours (Recommended)</SelectItem>
                          <SelectItem value="72 hours">72 hours</SelectItem>
                          <SelectItem value="1 week">1 week</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Max calls at the same time</Label>
                    <Input
                      type="number"
                      min={1}
                      max={20}
                      value={maxConcurrentCalls}
                      onChange={(e) => setMaxConcurrentCalls(parseInt(e.target.value) || 5)}
                      className="h-8 w-32"
                    />
                    <span className="text-[11px] text-muted-foreground">Concurrency limit on concurrent outbound voice channels.</span>
                  </div>
                </div>

                {/* 4. Follow-up SMS on Missed Calls */}
                <div className="p-4 rounded-xl border border-border/70 bg-surface-light space-y-3">
                  <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-2.5">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="h-4 w-4 text-primary" />
                      <Label className="text-xs font-semibold text-foreground">
                        Send text after missed call
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-muted-foreground font-medium">
                        {sendMissedCallText ? 'Enabled' : 'Disabled'}
                      </span>
                      <Switch
                        checked={sendMissedCallText}
                        onCheckedChange={setSendMissedCallText}
                      />
                    </div>
                  </div>

                  {sendMissedCallText && (
                    <div className="space-y-2 pt-1 animate-in fade-in-50 duration-200">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-foreground/80 font-medium">Follow-up Message Template</Label>
                        <TooltipProvider delayDuration={150}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 font-medium cursor-help"
                              >
                                <Info className="h-3.5 w-3.5" />
                                <span>Dynamic Job Variables</span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" align="end" className="max-w-xs p-3 text-xs space-y-1.5 shadow-lg">
                              <p className="font-semibold text-foreground">How dynamic variables work:</p>
                              <p className="text-[11px] text-muted-foreground leading-relaxed">
                                Insert variables in curly brackets to automatically inject job and customer details for each missed call:
                              </p>
                              <div className="space-y-1 text-[11px] border-t border-border/50 pt-1.5">
                                <div><code className="bg-muted px-1 py-0.5 rounded text-primary font-mono">{'{first_name}'}</code> - Customer's first name</div>
                                <div><code className="bg-muted px-1 py-0.5 rounded text-primary font-mono">{'{last_name}'}</code> - Customer's last name</div>
                                <div><code className="bg-muted px-1 py-0.5 rounded text-primary font-mono">{'{company}'}</code> - Your business name</div>
                                <div><code className="bg-muted px-1 py-0.5 rounded text-primary font-mono">{'{job_type}'}</code> - Completed job type (e.g. Garage Door Installation)</div>
                                <div><code className="bg-muted px-1 py-0.5 rounded text-primary font-mono">{'{caller_id}'}</code> - Dedicated phone number Bee called from</div>
                              </div>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>

                      <Textarea
                        rows={3}
                        value={missedCallText}
                        onChange={(e) => setMissedCallText(e.target.value)}
                        placeholder="Hi {first_name}, this is Bee from {company} following up on your recent {job_type} service..."
                        className="resize-none text-xs"
                      />

                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>Sent automatically after an unanswered call attempt.</span>
                        <div className="flex items-center gap-1.5">
                          {['{first_name}', '{company}', '{job_type}', '{caller_id}'].map((v) => (
                            <button
                              key={v}
                              type="button"
                              onClick={() => setMissedCallText((prev) => prev ? `${prev} ${v}` : v)}
                              className="px-1.5 py-0.5 rounded bg-muted/60 hover:bg-muted text-[10px] font-mono text-foreground border border-border/50 transition-colors"
                              title={`Insert ${v}`}
                            >
                              + {v}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* STEP 2: Warranty terms */}
            {currentStep === 2 && (
              <div className="space-y-5 text-xs">
                {/* 1. Approved Warranty Plans */}
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">
                    Approved Warranty Plans
                  </Label>

                  <div className="flex flex-wrap gap-2">
                    {plans
                      .filter((p) => p.is_active)
                      .map((p) => (
                        <div
                          key={p.id}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border/80 text-xs shadow-xs"
                        >
                          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
                          <span className="font-semibold text-foreground">{p.name}</span>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground">
                            {typeof p.price === 'number' ? `$${p.price}` : p.price}
                            {p.billing_interval || p.billing ? ` / ${formatSnakeCase(p.billing_interval || p.billing)}` : ''}
                          </span>
                        </div>
                      ))}
                    {plans.filter((p) => p.is_active).length === 0 && (
                      <p className="text-xs text-muted-foreground italic">
                        No active warranty plans configured. Click "Open Warranty Plans" to activate or add tiers.
                      </p>
                    )}
                  </div>
                </div>

                {/* 2. Included Warranty per Job Type */}
                <div className="space-y-2">
                  <Label className="text-sm font-semibold">Included Warranty per Job Type</Label>

                  <div className="border border-border/60 rounded-lg overflow-hidden bg-surface-light">
                    <Table className="w-full text-xs">
                      <TableHeader>
                        <TableRow className="bg-muted/40">
                          <TableHead>Job type</TableHead>
                          <TableHead>Included warranty</TableHead>
                          <TableHead>First Call (Days Before expiration)</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {enabledJobTypes.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3}>
                              <div className="py-6 text-center text-muted-foreground text-xs space-y-2">
                                <p className="font-medium text-foreground">No job types are currently enabled.</p>
                                <p className="text-[11px]">All job types have calls disabled in the Warranty Plan section.</p>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => setActiveTab('plans')}
                                  className="gap-1.5 text-xs h-7 mt-1"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                  Enable Job Types in Warranty Plans
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : (
                          enabledJobTypes.map((rule) => (
                            <TableRow key={rule.job_type} className="hover:bg-muted/20">
                              <TableCell className="font-semibold text-foreground py-2.5">
                                {rule.job_type}
                              </TableCell>
                              <TableCell className="text-foreground font-medium py-2.5">
                                {rule.included_warranty || '12 months'}
                              </TableCell>
                              <TableCell className="text-foreground font-medium py-2.5">
                                {rule.call_threshold_days ?? 30} days
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>

                {/* 3. General Warranty Rules */}
                <div className="max-w-xs space-y-1.5 pt-1">
                  <Label>Warranty starts on</Label>
                  <Select value={warrantyStartsOn} onValueChange={setWarrantyStartsOn}>
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Job Complete">Job Complete</SelectItem>
                      <SelectItem value="Invoice Sent">Invoice Sent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* STEP 3: Agent selection */}
            {currentStep === 3 && (
              <div className="space-y-5 text-xs">
                {/* Fallback settings */}
                <div className="p-4 rounded-xl border border-border/70 bg-surface-light space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-foreground">Default Voice Persona (Fallback)</Label>
                      <SelectField
                        options={agents.map((ag) => ({
                          value: ag.id,
                          label: `${ag.name} (${ag.persona_name || ag.trade_focus || 'Voice Agent'})`,
                        }))}
                        value={defaultAgentId}
                        onValueChange={setDefaultAgentId}
                        placeholder="Select fallback voice agent..."
                        size="sm"
                        className="w-full"
                      />
                      <span className="text-[11px] text-muted-foreground block">
                        Used if a job type does not have a dedicated agent persona assigned.
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-foreground">Default Phone (Fallback)</Label>
                      <SelectField
                        options={phoneOptions.length > 0 ? phoneOptions : [{ value: 'none', label: 'No phone numbers configured (go to Phone system)' }]}
                        value={defaultPhoneNumber || callerId || (phoneOptions[0]?.value ?? '')}
                        onValueChange={setDefaultPhoneNumber}
                        placeholder="Select fallback phone number..."
                        size="sm"
                        className="w-full"
                      />
                      <span className="text-[11px] text-muted-foreground block">
                        Used if a job type does not have a dedicated phone number assigned.
                      </span>
                    </div>
                  </div>
                </div>

                {/* Agent persona per Job Type table */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-foreground">Agent persona per Job Type</h4>
                    <span className="text-xs text-muted-foreground">
                      {enabledJobTypes.length} job types from CRM Settings
                    </span>
                  </div>

                  <div className="border border-border/70 rounded-xl overflow-hidden bg-surface-light shadow-xs">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/40">
                          <TableHead className="w-[34%] font-semibold text-xs">Job type</TableHead>
                          <TableHead className="w-[33%] font-semibold text-xs">Agent</TableHead>
                          <TableHead className="w-[33%] font-semibold text-xs">Phone</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {enabledJobTypes.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center py-6 text-muted-foreground text-xs">
                              No active job types configured. Enable job types in Warranty Plan first.
                            </TableCell>
                          </TableRow>
                        ) : (
                          enabledJobTypes.map((item) => {
                            const currentAgent = jobTypeAssignments[item.job_type]?.agent_id || 'default';
                            const currentPhone = jobTypeAssignments[item.job_type]?.phone_number || 'default';

                            return (
                              <TableRow key={item.job_type} className="hover:bg-muted/20">
                                <TableCell className="font-semibold text-xs text-foreground py-3">
                                  {item.job_type}
                                </TableCell>
                                <TableCell className="py-2.5">
                                  <SelectField
                                    size="sm"
                                    className="w-full"
                                    options={[
                                      { value: 'default', label: 'Default Agent' },
                                      ...agents.map((ag) => ({
                                        value: ag.id,
                                        label: ag.name,
                                      })),
                                    ]}
                                    value={currentAgent}
                                    onValueChange={(val) => handleAssignAgent(item.job_type, val)}
                                  />
                                </TableCell>
                                <TableCell className="py-2.5">
                                  <SelectField
                                    size="sm"
                                    className="w-full"
                                    options={[
                                      { value: 'default', label: 'Default Phone' },
                                      ...phoneOptions,
                                    ]}
                                    value={currentPhone}
                                    onValueChange={(val) => handleAssignPhone(item.job_type, val)}
                                  />
                                </TableCell>
                              </TableRow>
                            );
                          })
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            )}

            {/* STEP 4: Triggers */}
            {currentStep === 4 && (
              <div className="space-y-4 text-xs">
                <div className="space-y-2">
                  <Label>Turn on triggers</Label>
                  <div className="space-y-2 border border-border/60 rounded-lg p-3 bg-surface-light">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={triggerBeforeEnd}
                        onChange={(e) => setTriggerBeforeEnd(e.target.checked)}
                        className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5"
                      />
                      <span>A · Before warranty ends</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={triggerWinBack}
                        onChange={(e) => setTriggerWinBack(e.target.checked)}
                        className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5"
                      />
                      <span>C · Win-back after warranty ends</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={triggerManual}
                        onChange={(e) => setTriggerManual(e.target.checked)}
                        className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5"
                      />
                      <span>E · Manual calls from Queue tab</span>
                    </label>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Days before warranty ends</Label>
                    <Input
                      type="number"
                      min={1}
                      max={90}
                      value={daysBeforeEnd}
                      onChange={(e) => setDaysBeforeEnd(parseInt(e.target.value) || 30)}
                      className="h-8"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label>Win-back days after end</Label>
                    <Input
                      type="number"
                      min={1}
                      max={90}
                      value={winBackDays}
                      onChange={(e) => setWinBackDays(parseInt(e.target.value) || 15)}
                      className="h-8"
                    />
                    <span className="text-[11px] text-muted-foreground">Only used if trigger C is enabled.</span>
                  </div>
                </div>

                <div className="p-3 bg-muted/40 rounded-lg border border-border/40 text-xs text-muted-foreground space-y-1.5">
                  <p className="flex items-center gap-1.5 text-foreground font-medium">
                    <Lock className="h-3.5 w-3.5 text-warning-text" />
                    Guaranteed Safe Frequency Rule
                  </p>
                  <p>
                    Bee only calls again when the customer didn't answer. Once a customer answers, Bee never calls them again - whatever they said. Your human office team can still call them anytime.
                  </p>
                  <p className="text-[11px] text-muted-foreground pt-1 border-t border-border/30">
                    Locked start condition: Job completed AND invoice sent/paid.
                  </p>
                </div>
              </div>
            )}

            {/* STEP 5: Who to skip */}
            {currentStep === 5 && (
              <div className="space-y-4 text-xs">
                <div className="p-3 bg-muted/40 rounded-lg border border-border/40 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">Always skipped: </span>
                  <b>Invoice not paid in full</b> · <b>ServWave phone not connected</b> · <b>Do Not Call list members</b>
                </div>

                <div className="flex items-center justify-between border border-border/60 p-3 rounded-lg">
                  <div>
                    <Label>Skip if customer owes money on any job</Label>
                    <p className="text-[11px] text-muted-foreground">Avoids upsell calls when past balances are overdue.</p>
                  </div>
                  <Switch checked={skipIfOwesMoney} onCheckedChange={setSkipIfOwesMoney} />
                </div>

                <div className="space-y-1.5">
                  <Label>Skip jobs worth less than</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">$</span>
                    <Input
                      type="number"
                      min={0}
                      value={skipMinJobAmount}
                      onChange={(e) => setSkipMinJobAmount(parseInt(e.target.value) || 0)}
                      className="h-8 w-32"
                    />
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    Bee won't call about jobs under this invoice total, e.g. $200.
                  </span>
                </div>

                <div className="space-y-2">
                  <Label>Exclude customer tags</Label>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Popover
                      open={tagDropdownOpen}
                      onOpenChange={(open) => {
                        setTagDropdownOpen(open);
                        if (!open) setTagSearchQuery('');
                      }}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs font-normal gap-1.5 bg-background hover:bg-muted/50 border-input shrink-0"
                        >
                          <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>Select tags...</span>
                          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground ml-0.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-64 p-2 shadow-md space-y-1.5">
                        {allSelectableTags.length > 5 && (
                          <div className="relative">
                            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                            <Input
                              type="text"
                              placeholder="Search tags..."
                              value={tagSearchQuery}
                              onChange={(e) => setTagSearchQuery(e.target.value)}
                              className="h-7 pl-7 text-xs"
                            />
                          </div>
                        )}

                        <div className="max-h-52 overflow-y-auto space-y-0.5">
                          {filteredSelectableTags.length === 0 ? (
                            <div className="py-3 text-center text-xs text-muted-foreground italic">
                              {allSelectableTags.length === 0
                                ? 'No tags found in Settings → Payments & Lists.'
                                : 'No matching tags found.'}
                            </div>
                          ) : (
                            filteredSelectableTags.map((tag) => {
                              const isSelected = excludedTags.some(
                                (t) => t.toLowerCase().trim() === tag.name.toLowerCase().trim()
                              );
                              return (
                                <div
                                  key={tag.id || tag.name}
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => {
                                    if (isSelected) {
                                      setExcludedTags(
                                        excludedTags.filter(
                                          (t) => t.toLowerCase().trim() !== tag.name.toLowerCase().trim()
                                        )
                                      );
                                    } else {
                                      setExcludedTags([...excludedTags, tag.name]);
                                    }
                                  }}
                                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/60 cursor-pointer text-xs select-none transition-colors"
                                >
                                  <Checkbox
                                    checked={isSelected}
                                    onCheckedChange={() => {
                                      if (isSelected) {
                                        setExcludedTags(
                                          excludedTags.filter(
                                            (t) => t.toLowerCase().trim() !== tag.name.toLowerCase().trim()
                                          )
                                        );
                                      } else {
                                        setExcludedTags([...excludedTags, tag.name]);
                                      }
                                    }}
                                  />
                                  {tag.color && (
                                    <span
                                      className="w-2 h-2 rounded-full shrink-0"
                                      style={{ backgroundColor: tag.color }}
                                    />
                                  )}
                                  <span className="truncate flex-1 font-medium">{formatSnakeCase(tag.name)}</span>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </PopoverContent>
                    </Popover>

                    {excludedTags.map((tg) => {
                      const matchingTag = allSelectableTags.find(
                        (t) => t.name.toLowerCase().trim() === tg.toLowerCase().trim()
                      );
                      return (
                        <div
                          key={tg}
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            setExcludedTags(
                              excludedTags.filter(
                                (t) => t.toLowerCase().trim() !== tg.toLowerCase().trim()
                              )
                            )
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setExcludedTags(
                                excludedTags.filter(
                                  (t) => t.toLowerCase().trim() !== tg.toLowerCase().trim()
                                )
                              );
                            }
                          }}
                          title="Click to deselect"
                          className="text-xs px-2.5 py-1 rounded-md border transition-colors cursor-pointer select-none inline-flex items-center gap-1.5 bg-destructive/10 text-destructive border-destructive/30 font-medium hover:bg-destructive/15"
                        >
                          {matchingTag?.color && (
                            <span
                              className="w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: matchingTag.color }}
                            />
                          )}
                          <span>✕ {formatSnakeCase(tg)}</span>
                        </div>
                      );
                    })}
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    Pick from tags - e.g. VIP customers the owner prefers calling personally.
                  </span>
                </div>


              </div>
            )}

            {/* STEP 6: Job follow-up tasks & handoff */}
            {currentStep === 6 && (
              <div className="space-y-5 text-xs">
                {/* 1. Outcome Triggers for Task Creation */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold text-foreground">
                      Call Outcomes that Trigger a Follow-up Task
                    </Label>
                    <span className="text-[11px] text-muted-foreground font-medium">
                      {taskTriggerOutcomes.length} of {FOLLOWUP_OUTCOMES.length} triggers active
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {FOLLOWUP_OUTCOMES.map((item) => {
                      const isChecked = taskTriggerOutcomes.includes(item.id);
                      return (
                        <div
                          key={item.id}
                          onClick={() => {
                            if (isChecked) {
                              setTaskTriggerOutcomes(taskTriggerOutcomes.filter((x) => x !== item.id));
                            } else {
                              setTaskTriggerOutcomes([...taskTriggerOutcomes, item.id]);
                            }
                          }}
                          className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center gap-2.5 select-none ${
                            isChecked
                              ? 'bg-primary/5 border-primary/40 shadow-xs'
                              : 'bg-surface-light border-border/70 hover:border-border text-muted-foreground'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {}} // handled by parent onClick
                            className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5 shrink-0 cursor-pointer"
                          />
                          <span className="font-semibold text-xs text-foreground block">
                            {item.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 2. ServWave "New Task" Specification Card */}
                <div className="p-4 rounded-xl border border-border/80 bg-surface space-y-3.5 shadow-xs">
                  <div className="flex items-center justify-between border-b border-border/40 pb-2">
                    <div className="flex items-center gap-2">
                      <ClipboardList className="h-4 w-4 text-primary" />
                      <Label className="text-xs font-semibold text-foreground">
                        ServWave Task Specification
                      </Label>
                    </div>
                    <span className="text-[10px] font-semibold text-primary px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20">
                      Auto-created on Job
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="text-[11px] text-muted-foreground block font-medium">Task Title</span>
                      <div className="text-xs font-semibold text-foreground mt-0.5 font-mono">
                        Bee Follow-up: [Outcome] · [Customer] (Job #[Number])
                      </div>
                      <span className="text-[10px] text-muted-foreground">Fixed auto-generated title</span>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="text-[11px] text-muted-foreground block font-medium mb-1">Priority</span>
                        <SelectField
                          options={[
                            { value: 'LOW', label: 'Low' },
                            { value: 'MEDIUM', label: 'Medium' },
                            { value: 'HIGH', label: 'High' },
                            { value: 'URGENT', label: 'Urgent' },
                          ]}
                          value={taskPriority}
                          onValueChange={setTaskPriority}
                          size="sm"
                          className="w-full text-xs"
                        />
                      </div>
                      <div>
                        <span className="text-[11px] text-muted-foreground block font-medium mb-1">Category</span>
                        <SelectField
                          options={[
                            { value: 'Bee Follow-up', label: 'Bee Follow-up' },
                            ...orgCategories
                              .filter((c) => c.name.toLowerCase() !== 'bee follow-up')
                              .map((c) => ({ value: c.name, label: c.name })),
                          ]}
                          value={taskCategory}
                          onValueChange={setTaskCategory}
                          size="sm"
                          className="w-full text-xs"
                        />
                      </div>
                    </div>

                    <div className="sm:col-span-2">
                      <span className="text-[11px] text-muted-foreground block font-medium mb-1.5">Assignees</span>
                      <div className="flex flex-wrap items-center gap-4 py-1">
                        {['Job Dispatcher', 'Job Seller', 'Assigned Technician'].map((role) => {
                          const isRoleChecked = taskAssigneeRoles.includes(role);
                          return (
                            <label key={role} className="flex items-center gap-1.5 cursor-pointer text-xs">
                              <input
                                type="checkbox"
                                checked={isRoleChecked}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setTaskAssigneeRoles([...taskAssigneeRoles, role]);
                                  } else {
                                    // Ensure at least one role remains or falls back
                                    const next = taskAssigneeRoles.filter((r) => r !== role);
                                    setTaskAssigneeRoles(next.length > 0 ? next : [role]);
                                  }
                                }}
                                className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                              />
                              <span className="font-medium text-foreground">{role}</span>
                            </label>
                          );
                        })}
                      </div>
                      <span className="text-[10px] text-muted-foreground block mt-0.5">
                        {fallbackDispatcherId === 'none'
                          ? 'Resolved from job roles. If unassigned, no fallback is applied.'
                          : `If a selected role is unassigned on the job, falls back to ${selectedFallbackDispatcher ? `${selectedFallbackDispatcher.first_name} ${selectedFallbackDispatcher.last_name}` : 'the fallback dispatcher'}.`}
                      </span>
                    </div>

                    <div>
                      <span className="text-[11px] text-muted-foreground block font-medium">Watchers</span>
                      <div className="text-xs font-medium text-foreground mt-0.5 flex items-center gap-1.5">
                        <ShieldAlert className="h-3.5 w-3.5 text-primary" />
                        <span>
                          {adminWatcherId === 'none'
                            ? 'None'
                            : `System Admin (${selectedAdminWatcher ? `${selectedAdminWatcher.first_name} ${selectedAdminWatcher.last_name}` : 'Admin'})`}
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground">
                        {adminWatcherId === 'none'
                          ? 'No watcher added to follow-up tasks'
                          : 'System admin is added as watcher on every task'}
                      </span>
                    </div>

                    <div>
                      <span className="text-[11px] text-muted-foreground block font-medium">Linked To</span>
                      <div className="text-xs font-medium text-foreground mt-0.5 flex items-center gap-1.5">
                        <LinkIcon className="h-3.5 w-3.5 text-primary" />
                        <span className="text-primary font-medium">Associated Job #[Number]</span>
                        <span className="text-muted-foreground text-[11px]">(Linked Entity: JOB)</span>
                      </div>
                    </div>

                    <div className="sm:col-span-2 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-muted-foreground font-medium">Description</span>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Info className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground cursor-pointer transition-colors" />
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-xs text-xs space-y-1 p-2.5">
                                <p className="font-semibold text-foreground">Dynamic Variables Guidance</p>
                                <p className="text-muted-foreground text-[11px] leading-relaxed">
                                  Use <code className="bg-muted px-1 py-0.5 rounded text-primary font-mono">{'{variable_name}'}</code> to personalize follow-up task descriptions.
                                  Only supported variables with available job and customer data are resolved when the task is created.
                                </p>
                                <div className="space-y-0.5 text-[10px] text-muted-foreground pt-1 border-t border-border/50">
                                  <div><code className="bg-muted px-1 py-0.2 rounded text-primary font-mono">{'{outcome}'}</code> - Call outcome label</div>
                                  <div><code className="bg-muted px-1 py-0.2 rounded text-primary font-mono">{'{customer_name}'}</code> - Customer full name</div>
                                  <div><code className="bg-muted px-1 py-0.2 rounded text-primary font-mono">{'{customer_phone}'}</code> - Customer phone number</div>
                                  <div><code className="bg-muted px-1 py-0.2 rounded text-primary font-mono">{'{job_number}'}</code> - Associated job number</div>
                                  <div><code className="bg-muted px-1 py-0.2 rounded text-primary font-mono">{'{summary}'}</code> - AI summary of reason for follow-up</div>
                                  <div><code className="bg-muted px-1 py-0.2 rounded text-primary font-mono">{'{call_log_id}'}</code> - Unique call log identifier</div>
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>

                        <div className="flex items-center gap-1">
                          {['{outcome}', '{customer_name}', '{job_number}', '{summary}'].map((v) => (
                            <button
                              key={v}
                              type="button"
                              onClick={() => setTaskDescription((prev) => prev ? `${prev} ${v}` : v)}
                              className="px-1.5 py-0.5 rounded bg-muted/60 hover:bg-muted text-[10px] font-mono text-foreground border border-border/50 transition-colors"
                              title={`Insert ${v}`}
                            >
                              + {v}
                            </button>
                          ))}
                        </div>
                      </div>

                      <Textarea
                        rows={4}
                        value={taskDescription}
                        onChange={(e) => setTaskDescription(e.target.value)}
                        placeholder="Customize task description with dynamic variables..."
                        className="font-mono text-xs resize-none"
                      />
                    </div>
                  </div>
                </div>

                {/* 3. Fallback Dispatcher & System Admin Watcher Configuration */}
                <div className="p-4 rounded-xl border border-border/70 bg-surface-light space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold">Fallback Task Dispatcher</Label>
                    <SelectField
                      options={[
                        { value: 'none', label: 'None' },
                        ...assignableUsers.map((u) => ({
                          value: u.id,
                          label: `${u.first_name} ${u.last_name} (${u.role})`,
                        })),
                      ]}
                      value={fallbackDispatcherId || 'none'}
                      onValueChange={setFallbackDispatcherId}
                      placeholder="Select fallback dispatcher..."
                      size="sm"
                      className="w-full"
                    />
                    <span className="text-[11px] text-muted-foreground">
                      If a selected job-assignee role has no valid assignee on the job, follow-up tasks will be assigned to this fallback user.
                    </span>
                  </div>

                  <div className="space-y-1.5 pt-1">
                    <Label className="text-xs font-semibold">System Admin Watcher</Label>
                    <SelectField
                      options={[
                        { value: 'none', label: 'None' },
                        ...assignableUsers.map((u) => ({
                          value: u.id,
                          label: `${u.first_name} ${u.last_name} (${u.role})`,
                        })),
                      ]}
                      value={adminWatcherId || 'none'}
                      onValueChange={setAdminWatcherId}
                      placeholder="Select system admin watcher..."
                      size="sm"
                      className="w-full"
                    />
                    <span className="text-[11px] text-muted-foreground">
                      System admin watching all Bee follow-up tasks for quality oversight.
                    </span>
                  </div>
                </div>

                {/* 4. Notification Channels (Trigger Words removed completely) */}
                <div className="p-4 rounded-xl border border-border/70 bg-surface-light space-y-2">
                  <Label className="text-xs font-semibold">Alert notification channels</Label>
                  <div className="flex items-center gap-4 pt-1">
                    {['In-app', 'Text message', 'Email'].map((ch) => (
                      <label key={ch} className="flex items-center gap-1.5 cursor-pointer text-xs">
                        <input
                          type="checkbox"
                          checked={alertChannels.includes(ch)}
                          onChange={(e) => {
                            if (e.target.checked) setAlertChannels([...alertChannels, ch]);
                            else setAlertChannels(alertChannels.filter((x) => x !== ch));
                          }}
                          className="rounded border-input text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                        />
                        <span>{ch}</span>
                      </label>
                    ))}
                  </div>
                  <span className="text-[11px] text-muted-foreground block pt-0.5">
                    Notifies the assigned assignees and admin watcher when a follow-up task is created.
                  </span>
                </div>
              </div>
            )}

            {/* STEP 7: Test & go live */}
            {currentStep === 7 && (
              <div className="space-y-4 text-xs">
                {availableNumbers.length === 0 && (
                  <div className="p-3.5 rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 text-amber-900 dark:text-amber-200 space-y-1.5">
                    <div className="flex items-center gap-2 font-semibold text-xs">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      Bee Phone System is not configured
                    </div>
                    <p className="text-[11px] leading-relaxed">
                      You must configure or buy at least one phone number in the <b>Phone system</b> section before you can launch test calls or place outbound warranty check-ins.
                    </p>
                    <div className="pt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-amber-300 text-amber-900 hover:bg-amber-100 gap-1"
                        onClick={() => setCurrentStep(0)}
                      >
                        <Phone className="h-3 w-3" />
                        Go to Phone System
                      </Button>
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label>Test call to my phone</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={testPhoneNumber}
                      onChange={(e) => setTestPhoneNumber(formatPhoneInput(e.target.value))}
                      placeholder="(201) 555-0100"
                      className="h-8 w-48"
                      disabled={availableNumbers.length === 0}
                    />
                    <Button
                      size="sm"
                      onClick={handleTriggerTestCall}
                      disabled={isTestCalling || !testPhoneNumber || availableNumbers.length === 0}
                      className="gap-1.5"
                    >
                      <PhoneCall className="h-3.5 w-3.5" />
                      {isTestCalling ? 'Calling...' : testPassed ? '✓ Call passed' : 'Call me'}
                    </Button>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {availableNumbers.length === 0
                      ? 'Requires a configured Bee phone number (configure in Step 1: Phone system).'
                      : 'Optional - test phone synthesis and audio quality before going live.'}
                  </span>
                </div>

                <div className="space-y-1.5">
                  <Label>Launch mode</Label>
                  <Select value={launchMode} onValueChange={setLaunchMode}>
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Pilot - first 20 customers, then pause for review">
                        Pilot - first 20 customers, then pause for review
                      </SelectItem>
                      <SelectItem value="Start now">Start now - full queue execution</SelectItem>
                      <SelectItem value="Schedule a start date">Schedule a start date</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Footer Buttons */}
            <div className="border-t border-border/40 pt-4 flex items-center justify-between">
              <Button
                variant="outline"
                size="sm"
                disabled={currentStep === 0}
                onClick={() => setCurrentStep((prev) => Math.max(0, prev - 1))}
                className="gap-1"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </Button>

              <div className="flex items-center gap-2">
                {[2, 3, 4].includes(currentStep) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setCurrentStep(currentStep + 1)}
                  >
                    Skip for now
                  </Button>
                )}

                {currentStep < SETUP_STEPS.length - 1 ? (
                  <Button
                    size="sm"
                    onClick={() => handleSaveAll(currentStep + 1)}
                    disabled={isSaving}
                    className="gap-1.5"
                  >
                    Save & continue
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    {setupDone[7] !== 1 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSaveAll()}
                        disabled={isSaving}
                        className="gap-1.5"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {isSaving ? 'Saving...' : 'Save step'}
                      </Button>
                    )}

                    {isLive ? (
                      <Button
                        size="sm"
                        variant="solid"
                        tone="danger"
                        onClick={() => setIsDeactivateModalOpen(true)}
                        className="gap-1.5"
                      >
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Deactivate Bee
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="solid"
                        tone="brand"
                        onClick={handleActivateBee}
                        disabled={!allReadinessGreen || isSaving}
                        className="gap-1.5"
                      >
                        <Rocket className="h-3.5 w-3.5" />
                        Activate Bee
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Buy Phone Number Modal with Search Filter */}
      <Dialog open={isBuyModalOpen} onOpenChange={setIsBuyModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Phone className="h-4 w-4 text-primary" />
              Buy a New Phone Number
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Search and provision a dedicated voice number for Bee AI agent.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            {buyError && (
              <div className="p-3 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive text-xs">
                {buyError}
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Search Area Code / City</Label>
              <div className="relative">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="e.g. 415, 212, San Francisco, New York..."
                  value={buyAreaCode}
                  onChange={(e) => setBuyAreaCode(e.target.value)}
                  className="pl-8 h-8 text-xs font-mono"
                />
              </div>
              <span className="text-[11px] text-muted-foreground">
                Enter any 3-digit US area code, or pick from popular locations below:
              </span>
            </div>

            {/* Popular Area Code Pills */}
            <div className="flex flex-wrap gap-1.5">
              {AREA_CODE_PRESETS.map((preset) => {
                const isSelected = buyAreaCode === preset.code;
                return (
                  <button
                    key={preset.code}
                    type="button"
                    onClick={() => setBuyAreaCode(preset.code)}
                    className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
                      isSelected
                        ? 'bg-primary text-primary-foreground border-primary font-semibold'
                        : 'bg-muted/50 text-foreground border-border/70 hover:bg-muted'
                    }`}
                  >
                    ({preset.code}) {preset.region}
                  </button>
                );
              })}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Friendly Line Label</Label>
              <Input
                placeholder="e.g. Main Warranty Line, HVAC Outbound"
                value={buyFriendlyName}
                onChange={(e) => setBuyFriendlyName(e.target.value)}
                className="h-8 text-xs"
              />
              <span className="text-[11px] text-muted-foreground">
                Helps identify this number when mapping agents and job types.
              </span>
            </div>

            <div className="p-3 rounded-lg border border-border/60 bg-muted/30 space-y-1 text-[11px] text-muted-foreground">
              <div className="font-semibold text-foreground flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                ServWave Voice Telephony
              </div>
              <p>
                This number is immediately provisioned and activated for high-clarity AI voice calls.
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsBuyModalOpen(false)}
              disabled={isBuyingPhone}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleBuyPhone}
              disabled={isBuyingPhone}
              className="gap-1.5"
            >
              {isBuyingPhone ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Provisioning line...
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  Buy & Activate Number
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Phone Number Details Dialog */}
      <Dialog open={Boolean(selectedPhoneDetails)} onOpenChange={(open) => !open && setSelectedPhoneDetails(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Phone className="h-4 w-4 text-primary" />
              Phone Number Details
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Line details and caller ID configuration for this voice line.
            </DialogDescription>
          </DialogHeader>

          {selectedPhoneDetails && (() => {
            const isDefault =
              callerId === selectedPhoneDetails.phoneNumber ||
              callerId === selectedPhoneDetails.id ||
              (Boolean(callerId) && callerId.includes(selectedPhoneDetails.phoneNumber));

            return (
              <div className="space-y-4 py-2 text-xs">
                <div className="p-3.5 rounded-xl border border-border/70 bg-muted/20 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Phone Number</span>
                    <div className="flex items-center gap-1.5 font-bold text-foreground">
                      <span>{selectedPhoneDetails.formatted || formatPhone(selectedPhoneDetails.phoneNumber)}</span>
                      {isDefault && (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary border border-primary/20">
                          Default Caller ID
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-between border-t border-border/40 pt-2.5">
                    <span className="text-muted-foreground">Friendly Name</span>
                    <span className="font-semibold text-foreground">
                      {cleanFriendlyName(selectedPhoneDetails.friendlyName || selectedPhoneDetails.label)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between border-t border-border/40 pt-2.5">
                    <span className="text-muted-foreground">Telephony Network</span>
                    <span className="text-foreground font-medium">
                      ServWave Dedicated Voice Line
                    </span>
                  </div>

                  <div className="flex items-center justify-between border-t border-border/40 pt-2.5">
                    <span className="text-muted-foreground">Role</span>
                    <span className="text-foreground">
                      {isDefault ? 'Company Default Caller ID' : 'Assigned per Job Type'}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-2 pt-1">
                  {!isDefault && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        handleSetDefaultCallerId(selectedPhoneDetails.phoneNumber);
                        setSelectedPhoneDetails(null);
                      }}
                      className="w-full justify-center"
                    >
                      Set as Default Caller ID
                    </Button>
                  )}

                  <Button
                    variant="outline"
                    tone="danger"
                    size="sm"
                    onClick={() => {
                      const target = selectedPhoneDetails;
                      setSelectedPhoneDetails(null);
                      setReleaseConfirmItem(target);
                    }}
                    className="w-full justify-center"
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                    Release Phone Number
                  </Button>
                </div>
              </div>
            );
          })()}

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelectedPhoneDetails(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Release Confirmation Dialog */}
      <Dialog open={Boolean(releaseConfirmItem)} onOpenChange={(open) => !open && setReleaseConfirmItem(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Release Phone Number
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Are you sure you want to release {releaseConfirmItem?.formatted || formatPhone(releaseConfirmItem?.phoneNumber)}?
            </DialogDescription>
          </DialogHeader>

          <p className="text-xs text-foreground/80 py-2">
            Releasing this number will permanently delete it from your Bee telephony pool. Any job types currently assigned to this phone number will fall back to your default phone.
          </p>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReleaseConfirmItem(null)}
              disabled={Boolean(releasingId)}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              tone="danger"
              size="sm"
              onClick={handleReleasePhone}
              disabled={Boolean(releasingId)}
              className="gap-1.5"
            >
              {releasingId ? 'Releasing...' : 'Release Number'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate Confirmation Dialog with Disclaimer */}
      <Dialog open={isDeactivateModalOpen} onOpenChange={setIsDeactivateModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Deactivate Bee Warranty Agent
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Please review what will happen when Bee is deactivated.
            </DialogDescription>
          </DialogHeader>

          <div className="p-3.5 rounded-xl border border-amber-300/80 bg-amber-50/70 dark:bg-amber-950/20 dark:border-amber-800 text-amber-950 dark:text-amber-200 space-y-2 text-xs">
            <div className="font-semibold text-xs flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              Deactivation Disclaimer
            </div>
            <ul className="list-disc pl-4 space-y-1 text-[11px] leading-relaxed">
              <li>All scheduled outbound warranty calls will be paused immediately.</li>
              <li>All previous configuration settings and setup progress will be reset to their defaults.</li>
              <li>To activate Bee again, an administrator must review and complete all 8 setup steps and activate from the <b>Test &amp; go live</b> tab.</li>
            </ul>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsDeactivateModalOpen(false)}
              disabled={isDeactivating}
            >
              Cancel
            </Button>
            <Button
              variant="solid"
              tone="danger"
              size="sm"
              onClick={handleConfirmDeactivate}
              disabled={isDeactivating}
              className="gap-1.5"
            >
              {isDeactivating ? 'Deactivating...' : 'Deactivate Bee'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
