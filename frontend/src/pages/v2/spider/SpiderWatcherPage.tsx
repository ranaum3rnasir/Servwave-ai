import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CheckCircle2,
  Check,
  Power,
  Save,
  SlidersHorizontal,
  History,
  Bell,
  Mail,
  MessageSquare,
  Search,
  Users,
  Clock,
  ExternalLink,
  MapPin,
  User,
  Shield,
  AlertTriangle,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  X,
  FileText,
  Send,
  Calendar,
  Sparkles,
  Building2,
  Filter,
  RotateCcw,
  Hash,
  Eye,
  Download,
  ListFilter,
  Columns,
} from 'lucide-react';

import { useToast } from '@/components/ui/use-toast';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/ui-kit/components/ui/dropdownMenu';
import { FilterPopover, facetSelectionCount } from '../_shared/filterPopover';
import type { FacetOption, FilterState, FacetConfig } from '@/lib/filters/types';
import { cn } from '@/lib/utils';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { useRoles } from '@/lib/api/roles';
import { useUsers } from '@/lib/api/users';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import {
  useSpiderWatcherStore,
  type TimeUnit,
  type SpiderNotificationsConfig,
  type LeadStageConfig,
  type SpiderAssignmentsConfig,
  type SystemRoleItem,
  type AssignmentUserItem,
  type InAppNotification,
  DEFAULT_LEAD_STAGES,
  DEFAULT_SYSTEM_ROLES,
  DEFAULT_ASSIGNMENT_USERS,
  normalizeAssignments,
  DEFAULT_WATCHER_CUSTOMERS,
  buildWatcherCustomersFromLive,
  formatCurrentStageName,
  formatLastCommunicationTimestamp,
  formatLeadServiceLocation,
  formatAddressParts,
  getSpiderLeadOwnerName,
  resolveSpiderAlertRecipients,
} from '@/stores/spiderWatcherStore';
import {
  SpiderWatcherConfig,
  SpiderSaveConfirmDialog,
} from '@/components/ai-center/SpiderConfigPanel';
import {
  getSpiderAlertLogsApi,
  useSpiderServerConfig,
  SPIDER_CONFIG_QUERY_KEY,
  SPIDER_LEADS_QUERY_KEY,
  SPIDER_CUSTOMERS_QUERY_KEY,
  fetchSpiderLeadsApi,
  fetchSpiderCustomersApi,
  type SpiderAlertLogDbRecord,
} from '@/lib/api/spider';
import { useRecordVisit } from '../pageBreadcrumbs';
import { StatusChip } from '../_shared/statusChip';
import { Badge } from '@/ui-kit/components/ui/badge';
import { exportCsvFile } from '@/lib/csv';

function LeadStageChip({ stage }: { stage: string }) {
  const normalized = formatCurrentStageName(stage);
  const s = normalized.toLowerCase().trim();
  if (s.includes('walkthrough completed') || s.includes('walkthrough-completed')) {
    return (
      <Badge variant="amber" size="sm">
        Walkthrough Completed
      </Badge>
    );
  }
  if (s.includes('walkthrough scheduled') || s.includes('walkthrough-scheduled')) {
    return (
      <Badge variant="amber" size="sm">
        Walkthrough Scheduled
      </Badge>
    );
  }
  if (s.includes('walkthrough')) {
    return (
      <Badge variant="amber" size="sm">
        Walkthrough Completed
      </Badge>
    );
  }
  if (s === 'estimate' || s === 'estimated') {
    return <StatusChip domain="lead" status="ESTIMATED" />;
  }
  if (s.includes('contact') || s === 'contacted') {
    return <StatusChip domain="lead" status="CONTACTED" />;
  }
  if (s.includes('new')) {
    return <StatusChip domain="lead" status="NEW" />;
  }
  if (s.includes('won')) {
    return <StatusChip domain="lead" status="WON" />;
  }
  if (s.includes('lost')) {
    return <StatusChip domain="lead" status="LOST" />;
  }
  if (s.includes('cancel')) {
    return <StatusChip domain="lead" status="CANCELLED" />;
  }
  return <Badge variant="slate" size="sm">{normalized || 'New'}</Badge>;
}

export interface ChannelDeliveryInfo {
  enabled: boolean;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  sentCount: number;
  failedCount: number;
  error?: string | null;
}

export function parseChannelDeliveryInfo(
  rawChannel: any,
  defaultEnabled: boolean = false
): ChannelDeliveryInfo {
  if (rawChannel === undefined || rawChannel === null) {
    return {
      enabled: defaultEnabled,
      status: defaultEnabled ? 'SENT' : 'SKIPPED',
      sentCount: defaultEnabled ? 1 : 0,
      failedCount: 0,
      error: null,
    };
  }
  if (typeof rawChannel === 'boolean') {
    return {
      enabled: rawChannel,
      status: rawChannel ? 'SENT' : 'SKIPPED',
      sentCount: rawChannel ? 1 : 0,
      failedCount: 0,
      error: null,
    };
  }
  const enabled = rawChannel.enabled !== undefined ? !!rawChannel.enabled : true;
  let status: 'SENT' | 'FAILED' | 'SKIPPED' = 'SKIPPED';
  if (!enabled) {
    status = 'SKIPPED';
  } else if (rawChannel.status === 'FAILED' || (rawChannel.failed > 0 && (!rawChannel.sent || rawChannel.sent === 0))) {
    status = 'FAILED';
  } else if (rawChannel.status === 'SENT' || rawChannel.status === 'SUCCESS' || rawChannel.sent > 0) {
    status = 'SENT';
  } else {
    status = 'SENT';
  }

  return {
    enabled,
    status,
    sentCount: typeof rawChannel.sent === 'number' ? rawChannel.sent : (status === 'SENT' ? 1 : 0),
    failedCount: typeof rawChannel.failed === 'number' ? rawChannel.failed : (status === 'FAILED' ? 1 : 0),
    error: rawChannel.error || (status === 'FAILED' ? 'Delivery rejected or recipient unreachable' : null),
  };
}

export interface SpiderNotificationLogItem {
  id: string;
  leadId: string;
  leadNumber: string;
  customerId: string;
  customerName: string;
  companyName?: string;
  serviceRequest?: string;
  serviceLocation?: string;
  stageName: string;
  inactiveDays: number;
  timeStr: string;
  dateStr: string;
  timestampMs?: number;
  overallStatus: 'SENT' | 'FAILED' | 'PARTIAL';
  channels: {
    email: ChannelDeliveryInfo;
    sms: ChannelDeliveryInfo;
    inApp: ChannelDeliveryInfo;
  };
  recipients: Array<{
    id: string;
    name: string;
    email?: string;
    phone?: string;
    role?: string;
    type: 'admin' | 'owner' | 'user';
  }>;
  emailPreview: {
    from?: string;
    subject: string;
    body: string;
    to: string[];
    status: 'SENT' | 'FAILED' | 'SKIPPED';
    error?: string | null;
  };
  smsPreview: {
    message: string;
    to: string[];
    status: 'SENT' | 'FAILED' | 'SKIPPED';
    error?: string | null;
  };
  inAppPreview: {
    title: string;
    message: string;
    status: 'SENT' | 'FAILED' | 'SKIPPED';
  };
}

export const spiderHistoryRegistry: FacetConfig[] = [
  {
    key: 'stage',
    kind: 'multi',
    param: 'stage',
    label: 'Stage',
    icon: 'M21.801 10A10 10 0 1 1 17 3.335 M9 11 3 3L22 4',
    options: [
      { value: 'NEW', label: 'New' },
      { value: 'CONTACTED', label: 'Contacted' },
      { value: 'WALKTHROUGH', label: 'Walkthrough' },
      { value: 'ESTIMATED', label: 'Estimate Sent' },
      { value: 'WON', label: 'Won' },
      { value: 'LOST', label: 'Lost' },
      { value: 'CANCELLED', label: 'Cancelled' },
    ],
  },
  {
    key: 'dateTime',
    kind: 'multi',
    param: 'dateTime',
    label: 'Date / Time',
    icon: 'M8 2v4 M16 2v4 M5 4H19A2 2 0 0 1 21 6V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V6A2 2 0 0 1 5 4Z M3 10h18',
    options: [
      { value: 'today', label: 'Today' },
      { value: 'this_week', label: 'This week' },
      { value: 'this_month', label: 'This month' },
      { value: 'last_7_days', label: 'Last 7 days' },
      { value: 'last_30_days', label: 'Last 30 days' },
      { value: 'last_90_days', label: 'Last 90 days' },
      { value: 'this_year', label: 'This year' },
      { value: 'custom_date', label: 'Custom Date' },
    ],
  },
  {
    key: 'recipients',
    kind: 'multi',
    param: 'recipients',
    label: 'Recipients',
    icon: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2 M16 7A4 4 0 1 1 8 7A4 4 0 1 1 16 7Z',
    optionSource: 'recipients',
  },
  {
    key: 'customers',
    kind: 'multi',
    param: 'customers',
    label: 'Customers',
    icon: 'M3 21h18 M3 7v14 M21 7v14 M4 10h4 M4 14h4 M4 18h4 M9 4h6a2 2 0 0 1 2 2v15H7V6a2 2 0 0 1 2-2z',
    optionSource: 'customers',
  },
  {
    key: 'role',
    kind: 'multi',
    param: 'role',
    label: 'Role',
    icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    options: [
      { value: 'admin', label: 'Administrator (Owner)' },
      { value: 'sales', label: 'Sales' },
      { value: 'dispatcher', label: 'Dispatcher' },
      { value: 'technician', label: 'Technician' },
    ],
  },
];

export default function SpiderWatcherPage() {
  useRecordVisit('spider', 'Spider Watcher');
  const navigate = useNavigate();
  const { toast } = useToast();
  const setAiCenterOpen = useAiCenterStore((s) => s.setOpen);

  // Tab State: 'config' | 'history'
  const [activeTab, setActiveTab] = useState<'config' | 'history'>('config');

  // Dedicated Search & Filter state for History Logs
  const [filterLead, setFilterLead] = useState('');
  const [historyFilterState, setHistoryFilterState] = useState<FilterState>({});
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [previewTab, setPreviewTab] = useState<'email' | 'sms' | 'inApp'>('email');

  // Focus trap & focus restoration refs for History preview drawer (ACC-10)
  const drawerRef = useRef<HTMLDivElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);

  // Pagination for History Logs
  const [pageSize, setPageSize] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);

  // Reset pagination to page 1 whenever search or filter state changes
  useEffect(() => {
    setCurrentPage(1);
  }, [filterLead, historyFilterState]);

  const [isSaved, setIsSaved] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);

  // Authoritative server-persisted Spider config from database (ARCH-1, SEC-8)
  const queryClient = useQueryClient();
  const {
    data: serverSpiderConfig,
    isError: isConfigError,
    error: configError,
    refetch: refetchConfig,
  } = useSpiderServerConfig();
  const storeIsActive = useSpiderWatcherStore((s) => s.isActive);
  const isSpiderActive = serverSpiderConfig !== undefined ? Boolean(serverSpiderConfig?.isActive) : storeIsActive;
  const setIsSpiderActive = useSpiderWatcherStore((s) => s.setIsActive);

  // Sender email address for Spider alerts
  const defaultSenderEmail = 'ServWave Spider Alerts <alerts@spider.servwave.com>';

  // System roles
  const { data: apiRoles } = useRoles();
  const availableRoles: SystemRoleItem[] = useMemo(() => {
    if (Array.isArray(apiRoles) && apiRoles.length > 0) {
      return apiRoles.map((r) => ({
        id: r.role,
        label: r.label,
        description:
          r.description ||
          (DEFAULT_SYSTEM_ROLES.find((d) => d.id === r.role)?.description ?? `${r.label} role`),
      }));
    }
    return DEFAULT_SYSTEM_ROLES;
  }, [apiRoles]);

  // System users
  const { data: apiUsers } = useUsers();
  const availableUsers: AssignmentUserItem[] = useMemo(() => {
    if (Array.isArray(apiUsers) && apiUsers.length > 0) {
      return apiUsers.map((u) => {
        const roleMatch = availableRoles.find((r) => r.id === u.role);
        return {
          id: u.id,
          name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
          email: u.email,
          role: u.role,
          roleLabel: roleMatch?.label || u.role,
          avatar_url: u.avatar_url,
        };
      });
    }
    return DEFAULT_ASSIGNMENT_USERS;
  }, [apiUsers, availableRoles]);



  const handleExportLogs = (logs: SpiderNotificationLogItem[], label: string) => {
    const headers = ['Date', 'Time', 'Lead ID', 'Lead Address', 'Customer', 'Stage', 'Recipients', 'Status'];

    const rows = logs.map((l) => {
      // Use timestampMs for precise date/time; fall back to parsing dateStr + timeStr
      const ts = l.timestampMs ?? null;
      const dateObj = ts ? new Date(ts) : null;

      // Date formatted as MM/DD/YYYY — Excel auto-detects this as a Date type cell
      const excelDate = dateObj
        ? `${String(dateObj.getMonth() + 1).padStart(2, '0')}/${String(dateObj.getDate()).padStart(2, '0')}/${dateObj.getFullYear()}`
        : l.dateStr.replace(/^Today\s*-\s*/i, '').trim();

      // Time formatted in 12-hour format with AM/PM (e.g. 07:55 PM)
      let excelTime = l.timeStr.trim();
      if (dateObj) {
        let hours = dateObj.getHours();
        const minutes = String(dateObj.getMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        const hoursStr = String(hours).padStart(2, '0');
        excelTime = `${hoursStr}:${minutes} ${ampm}`;
      }

      return [
        excelDate,
        excelTime,
        l.leadNumber,
        l.serviceLocation || '',
        l.customerName || '',
        l.stageName || '',
        l.recipients.map((r) => r.name).join(', '),
        l.overallStatus,
      ];
    });

    const filename = `spider_notification_history_${label.toLowerCase().replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
    exportCsvFile(filename, headers, rows);
    toast({
      title: 'Export Complete',
      description: `Successfully exported ${logs.length} notification history records to CSV.`,
    });
  };

  // Store references
  const storeNotifications = useSpiderWatcherStore((s) => s.notifications);
  const storeAssignments = useSpiderWatcherStore((s) => s.assignments);
  const storeAutoEnrollAllLeads = useSpiderWatcherStore((s) => s.autoEnrollAllLeads);
  const storeLeadStages = useSpiderWatcherStore((s) => s.leadStages);
  const storeCustomers = useSpiderWatcherStore((s) => s.customers);
  const storeSelectedCustomerIds = useSpiderWatcherStore((s) => s.selectedCustomerIds);
  const storeSelectedLeadIds = useSpiderWatcherStore((s) => s.selectedLeadIds);
  const storeActivatedAt = useSpiderWatcherStore((s) => s.activatedAt);
  const setStoreCustomers = useSpiderWatcherStore((s) => s.setCustomers);

  // Local draft state for Spider Watcher settings
  const [draftNotifications, setDraftNotifications] = useState<SpiderNotificationsConfig>(storeNotifications);
  const [draftAssignments, setDraftAssignments] = useState<SpiderAssignmentsConfig>(normalizeAssignments(storeAssignments));
  const [draftLeadStages, setDraftLeadStages] = useState<LeadStageConfig[]>(storeLeadStages);
  const [draftAutoEnrollAllLeads, setDraftAutoEnrollAllLeads] = useState<boolean>(storeAutoEnrollAllLeads ?? true);
  const [draftSelectedCustomerIds, setDraftSelectedCustomerIds] = useState<string[]>(
    isSpiderActive ? storeSelectedCustomerIds : []
  );
  const [draftSelectedLeadIds, setDraftSelectedLeadIds] = useState<string[]>(
    isSpiderActive ? storeSelectedLeadIds : []
  );
  const [hasDraftModifiedSelection, setHasDraftModifiedSelection] = useState<boolean>(false);

  // Sync draft state whenever Spider becomes inactive: reset thresholds to none, clear assignments & notifications & selections
  useEffect(() => {
    if (!isSpiderActive) {
      setDraftLeadStages(
        DEFAULT_LEAD_STAGES.map((s) => ({ ...s, duration: undefined, enabled: false }))
      );
      setDraftNotifications({
        email: false,
        sms: false,
        inApp: false,
        redFrame: false,
      });
      setDraftAssignments({
        adminRoles: [],
        owner: false,
        users: [],
      });
      setDraftSelectedCustomerIds([]);
      setDraftSelectedLeadIds([]);
      setHasDraftModifiedSelection(true);
    }
  }, [isSpiderActive]);

  // Fetch real notification logs from database table spider_alert_logs (all historical records)
  const {
    data: dbLogsResponse,
    isLoading: isLogsLoading,
    isFetching: isLogsFetching,
    isError: isLogsError,
    error: logsError,
    refetch: refetchDbLogs,
  } = useQuery({
    queryKey: ['spider-alert-db-logs', currentPage, pageSize],
    queryFn: () => getSpiderAlertLogsApi({ page: currentPage, limit: pageSize }),
    staleTime: 30_000,
    refetchInterval: activeTab === 'history' ? 10_000 : false,
  });

  // Track last viewed timestamp for unread history logs count
  const [lastViewedHistoryAt, setLastViewedHistoryAt] = useState<number | null>(() => {
    const saved = localStorage.getItem('servwave_spider_last_viewed_history_at');
    return saved ? Number(saved) : null;
  });

  // Clear unread badge whenever user is active on the History tab
  useEffect(() => {
    if (activeTab === 'history') {
      const now = Date.now();
      setLastViewedHistoryAt(now);
      localStorage.setItem('servwave_spider_last_viewed_history_at', String(now));
    }
  }, [activeTab]);

  // Fetch real leads from API with real-time invalidation
  const {
    data: apiLeads,
    isLoading: isLeadsLoading,
    isError: isLeadsError,
    error: leadsError,
    refetch: refetchLeads,
  } = useQuery({
    queryKey: SPIDER_LEADS_QUERY_KEY,
    queryFn: fetchSpiderLeadsApi,
    staleTime: 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  // Fetch real customers from API
  const {
    data: apiCustomers,
    isLoading: isCustomersLoading,
    isError: isCustomersError,
    error: customersError,
    refetch: refetchCustomers,
  } = useQuery({
    queryKey: SPIDER_CUSTOMERS_QUERY_KEY,
    queryFn: fetchSpiderCustomersApi,
    staleTime: 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
  });

  // Synchronize server-persisted Spider config to local drafts & store on load/change
  useEffect(() => {
    if (serverSpiderConfig) {
      useSpiderWatcherStore.getState().syncServerConfig?.(serverSpiderConfig);
      if (serverSpiderConfig.isActive) {
        if (serverSpiderConfig.stageThresholds) {
          setDraftLeadStages((prev) =>
            prev.map((stage) => {
              const serverVal = serverSpiderConfig.stageThresholds?.[stage.id];
              if (serverVal !== undefined) {
                if (typeof serverVal === 'number') {
                  return { ...stage, duration: serverVal, enabled: serverVal > 0 };
                }
                if (typeof serverVal === 'object' && serverVal !== null) {
                  const dur = (serverVal as any).value ?? (serverVal as any).duration ?? (serverVal as any).days;
                  const validUnits: TimeUnit[] = ['Second', 'Minute', 'Hour', 'Day'];
                  return {
                    ...stage,
                    duration: dur !== undefined ? Number(dur) : stage.duration,
                    unit: (serverVal as any).unit && validUnits.includes((serverVal as any).unit as TimeUnit) ? ((serverVal as any).unit as TimeUnit) : stage.unit,
                    enabled: (serverVal as any).enabled ?? (dur !== undefined && Number(dur) > 0),
                  };
                }
              }
              return stage;
            })
          );
        }
        if (serverSpiderConfig.notifications) {
          setDraftNotifications((prev) => ({ ...prev, ...serverSpiderConfig.notifications }));
        }
        if (serverSpiderConfig.assignments) {
          setDraftAssignments(normalizeAssignments(serverSpiderConfig.assignments));
        }
        if (serverSpiderConfig.autoEnrollAllLeads !== undefined) {
          setDraftAutoEnrollAllLeads(serverSpiderConfig.autoEnrollAllLeads);
        }
        if (serverSpiderConfig.selectedLeadIds) {
          setDraftSelectedLeadIds(serverSpiderConfig.selectedLeadIds);
        }
      }
    }
  }, [serverSpiderConfig]);

  // Sync store when real API leads arrive
  useEffect(() => {
    if (
      (Array.isArray(apiLeads) && apiLeads.length > 0) ||
      (Array.isArray(apiCustomers) && apiCustomers.length > 0)
    ) {
      const live = buildWatcherCustomersFromLive(apiLeads || [], apiCustomers || [], useSpiderWatcherStore.getState().activatedAt);
      setStoreCustomers(live);
    }
  }, [apiLeads, apiCustomers, setStoreCustomers]);

  // Automatically synchronize newly enrolled leads/customers from store when Spider is active
  useEffect(() => {
    if (!isSpiderActive) return;
    setDraftSelectedCustomerIds((prev) => {
      const merged = Array.from(new Set([...prev, ...storeSelectedCustomerIds]));
      return merged.length !== prev.length ? merged : prev;
    });
    setDraftSelectedLeadIds((prev) => {
      const merged = Array.from(new Set([...prev, ...storeSelectedLeadIds]));
      return merged.length !== prev.length ? merged : prev;
    });
  }, [storeSelectedCustomerIds, storeSelectedLeadIds, isSpiderActive]);

  // Focus management and keyboard trap for History slide-over preview drawer (ACC-10)
  useEffect(() => {
    if (!selectedLogId) {
      if (lastFocusedElementRef.current) {
        lastFocusedElementRef.current.focus?.();
        lastFocusedElementRef.current = null;
      }
      return;
    }

    // Save previous focus before moving into drawer
    lastFocusedElementRef.current = document.activeElement as HTMLElement | null;

    // Move initial focus into the drawer once rendered
    const focusTimer = setTimeout(() => {
      if (!drawerRef.current) return;
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length > 0 && focusable[0]) {
        focusable[0].focus();
      } else {
        drawerRef.current.focus();
      }
    }, 20);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSelectedLogId(null);
        return;
      }

      if (e.key === 'Tab') {
        if (!drawerRef.current) return;
        const focusable = Array.from(
          drawerRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter((el) => !el.hasAttribute('hidden') && el.style.display !== 'none' && el.style.visibility !== 'hidden');

        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusable[0];
        const lastElement = focusable[focusable.length - 1];
        if (firstElement && lastElement && drawerRef.current) {
          if (e.shiftKey) {
            if (document.activeElement === firstElement || !drawerRef.current.contains(document.activeElement)) {
              e.preventDefault();
              lastElement.focus();
            }
          } else {
            if (document.activeElement === lastElement || !drawerRef.current.contains(document.activeElement)) {
              e.preventDefault();
              firstElement.focus();
            }
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedLogId]);

  // Computed Overdue Notifications for Alert Log generation (demo / baseline fallback)
  const computedNotifications = useMemo(() => {
    return useSpiderWatcherStore.getState().getComputedNotifications();
  }, [storeCustomers, storeLeadStages, storeNotifications, storeAssignments, storeSelectedLeadIds, isSpiderActive]);

  // Build structured history log items matching user's requested layout: Date -> Time | Lead ID | Lead Address | Customer (id) | Notification Types | Recipients (Descending by latest first)
  const historyLogs: SpiderNotificationLogItem[] = useMemo(() => {
    // Helper to resolve the best lead address from apiLeads, storeCustomers (Sidebar targets), or apiCustomers
    const resolveLeadAddress = (
      rawLocation: string | undefined | null,
      leadId?: string,
      leadNumber?: string,
      customerId?: string,
      customerName?: string
    ): string => {
      // 1. Check live apiLeads
      if (Array.isArray(apiLeads) && apiLeads.length > 0) {
        const matchedLead = apiLeads.find(
          (l: any) =>
            (leadId && (l.id === leadId || String(l.id) === String(leadId))) ||
            (leadNumber && (l.lead_number === leadNumber || String(l.lead_number).toLowerCase() === String(leadNumber).toLowerCase()))
        );
        if (matchedLead) {
          const matchedCust = Array.isArray(apiCustomers)
            ? apiCustomers.find((c: any) => c.id === matchedLead.customer_id || c.id === matchedLead.customer?.id)
            : matchedLead.customer;
          const formatted = formatLeadServiceLocation(matchedLead, matchedCust);
          if (
            formatted &&
            formatted !== 'Service location not specified' &&
            formatted !== 'No service location specified'
          ) {
            return formatted;
          }
        }
      }

      // 2. Check storeCustomers (where sidebar leads with Service Locations are kept)
      if (Array.isArray(storeCustomers) && storeCustomers.length > 0) {
        for (const c of storeCustomers) {
          const matchedWatcherLead = c.leads?.find(
            (l) =>
              (leadId && (l.id === leadId || String(l.id) === String(leadId))) ||
              (leadNumber && (l.leadNumber === leadNumber || String(l.leadNumber).toLowerCase() === String(leadNumber).toLowerCase()))
          );
          if (
            matchedWatcherLead?.serviceLocation &&
            matchedWatcherLead.serviceLocation !== 'Service location not specified' &&
            matchedWatcherLead.serviceLocation !== 'No service location specified' &&
            matchedWatcherLead.serviceLocation !== 'Service Location on File'
          ) {
            return matchedWatcherLead.serviceLocation;
          }
        }

        // Customer level search in storeCustomers
        const matchedCust = storeCustomers.find(
          (c) =>
            (customerId && (c.id === customerId || String(c.id).includes(customerId) || customerId.includes(c.id))) ||
            (customerName && c.name?.toLowerCase().trim() === customerName.toLowerCase().trim())
        );
        const leadWithLoc = matchedCust?.leads?.find(
          (l) =>
            l.serviceLocation &&
            l.serviceLocation !== 'Service location not specified' &&
            l.serviceLocation !== 'No service location specified' &&
            l.serviceLocation !== 'Service Location on File'
        );
        if (leadWithLoc?.serviceLocation) {
          return leadWithLoc.serviceLocation;
        }
      }

      // 3. Check apiCustomers for service_locations
      if (Array.isArray(apiCustomers) && apiCustomers.length > 0) {
        const matchedCust = apiCustomers.find(
          (c: any) =>
            (customerId && (c.id === customerId || String(c.id).includes(customerId) || customerId.includes(c.id))) ||
            (customerName && (
              `${c.first_name || ''} ${c.last_name || ''}`.trim().toLowerCase() === customerName.toLowerCase().trim() ||
              c.company_name?.toLowerCase().trim() === customerName.toLowerCase().trim()
            ))
        );
        if (matchedCust) {
          const locs = matchedCust.service_locations;
          if (Array.isArray(locs) && locs.length > 0) {
            const primary = locs.find((l: any) => l.is_primary) || locs[0];
            const formatted = formatAddressParts(
              primary.address_line1,
              primary.address_line2,
              primary.city,
              primary.state,
              primary.zip
            );
            if (formatted) return formatted;
          } else if (matchedCust.billing_address_line1) {
            const formatted = formatAddressParts(
              matchedCust.billing_address_line1,
              matchedCust.billing_address_line2,
              matchedCust.billing_city,
              matchedCust.billing_state,
              matchedCust.billing_zip
            );
            if (formatted) return formatted;
          }
        }
      }

      // 4. If raw location from log record is valid
      if (
        rawLocation &&
        rawLocation.trim() &&
        rawLocation !== 'Service location not specified' &&
        rawLocation !== 'No service location specified' &&
        rawLocation !== 'Service Location on File'
      ) {
        return rawLocation.trim();
      }

      return 'Service location on file';
    };

    // 1. If database logs exist in spider_alert_logs table, map and display them sorted descending (newest first)
    if (dbLogsResponse?.records && Array.isArray(dbLogsResponse.records) && dbLogsResponse.records.length > 0) {
      const sortedRecords = [...dbLogsResponse.records].sort((a, b) => {
        const timeA = new Date(a.created_at || 0).getTime();
        const timeB = new Date(b.created_at || 0).getTime();
        return timeB - timeA; // Descending: newest first
      });

      return sortedRecords.map((rec: SpiderAlertLogDbRecord, index: number) => {
        const dateObj = new Date(rec.created_at);
        const isValidDate = !isNaN(dateObj.getTime());
        const isToday = isValidDate && dateObj.toDateString() === new Date().toDateString();
        const timestampMs = isValidDate ? dateObj.getTime() : Date.now();

        const dateStr = isValidDate
          ? (isToday ? 'Today - ' : '') +
          new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(dateObj)
          : 'Today - ' +
          new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date());

        const timeStr = isValidDate
          ? new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).format(dateObj)
          : new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date());

        const leadId = rec.lead_id || rec.id;
        const leadNumber = rec.lead_number || `LD-${100 + index + 1}`;
        const customerName = rec.customer_name || 'Customer';
        const companyName = rec.company_name || '';
        const customerId = rec.customer_id ? (rec.customer_id.length > 10 ? rec.customer_id.substring(0, 8) : rec.customer_id) : `c${index + 1}`;
        const serviceRequest = rec.service_request || 'Pipeline Lead Inquiry';
        const serviceLocation = resolveLeadAddress(rec.service_location, leadId, leadNumber, customerId, customerName);
        const stageName = formatCurrentStageName(rec.stage_name || 'New');
        const inactiveDays = rec.inactive_days || 0;

        const emailInfo = parseChannelDeliveryInfo(rec.channels?.email, true);
        const smsInfo = parseChannelDeliveryInfo(rec.channels?.sms, true);
        const inAppInfo = parseChannelDeliveryInfo(rec.channels?.inApp, true);

        const recipientItems: Array<{ id: string; name: string; email?: string; phone?: string; role?: string; type: 'admin' | 'owner' | 'user' }> =
          rec.recipients && Array.isArray(rec.recipients) && rec.recipients.length > 0
            ? rec.recipients.map((r: any) => {
              const matchedUser = availableUsers.find((u) => u.id === r.id || (r.email && u.email?.toLowerCase() === r.email.toLowerCase()));
              return {
                id: r.id || r.email || r.name,
                name: r.name || matchedUser?.name || r.email || 'Team Member',
                email: r.email || matchedUser?.email || (r.name && r.name.includes('@') ? r.name : undefined),
                phone: r.phone || matchedUser?.phone,
                role: r.role || matchedUser?.role || 'Member',
                type: (r.type as any) || (r.role?.toLowerCase().includes('admin') ? 'admin' : 'user'),
              };
            })
            : [
              {
                id: 'default',
                name: 'Assigned Lead Specialist',
                email: availableUsers.find((u) => u.role === 'ADMIN')?.email || undefined,
                role: 'Team Member',
                type: 'owner',
              },
            ];

        const recipientNames = recipientItems.map((r) => r.name);
        const recipientEmails = recipientItems
          .map((r) => r.email)
          .filter(Boolean) as string[];

        const emailRecipients = recipientEmails.length > 0
          ? recipientEmails
          : (Array.isArray((rec as any).channels?.email?.to) ? (rec as any).channels.email.to : recipientNames);

        const overallStatus =
          rec.status === 'FAILED' || (emailInfo.status === 'FAILED' && smsInfo.status === 'FAILED')
            ? 'FAILED'
            : rec.status === 'PARTIAL' || emailInfo.status === 'FAILED' || smsInfo.status === 'FAILED'
              ? 'PARTIAL'
              : 'SENT';

        return {
          id: rec.id,
          leadId,
          leadNumber,
          customerId,
          customerName,
          companyName,
          serviceRequest,
          serviceLocation,
          stageName,
          inactiveDays,
          timeStr,
          dateStr,
          timestampMs,
          overallStatus,
          channels: {
            email: emailInfo,
            sms: smsInfo,
            inApp: inAppInfo,
          },
          recipients: recipientItems,
          emailPreview: {
            from: (rec as any).channels?.email?.from || (rec as any).from_email || (rec as any).sender_email || defaultSenderEmail,
            subject: rec.email_subject || `[Spider Alert] Lead #${leadNumber} (${customerName}) Overdue in ${stageName}`,
            to: emailRecipients,
            status: emailInfo.status,
            error: emailInfo.error,
            body:
              rec.email_body ||
              `Spider AI Lead Manager has detected that Lead #${leadNumber} for customer ${customerName}${companyName ? ` (${companyName})` : ''} has been in the "${stageName}" stage for ${inactiveDays} ${inactiveDays === 1 ? 'day' : 'days'} without customer communication.\n\nService Request: ${serviceRequest}\nLocation: ${serviceLocation}\n\nPlease review and advance or contact the lead immediately.`,
          },
          smsPreview: {
            to: recipientNames,
            status: smsInfo.status,
            error: smsInfo.error,
            message:
              rec.sms_message ||
              `[Spider Alert] Lead #${leadNumber} (${customerName}) is overdue in ${stageName} (${inactiveDays}d inactive).`,
          },
          inAppPreview: {
            title: `Overdue Lead: #${leadNumber} - ${customerName}`,
            status: inAppInfo.status,
            message:
              rec.in_app_message ||
              `Lead #${leadNumber} for customer ${customerName} has been in the "${stageName}" stage for ${inactiveDays} days without customer communication.`,
          },
        };
      });
    }

    return [];
  }, [
    dbLogsResponse?.records,
    defaultSenderEmail,
    availableUsers,
  ]);

  // Selected log item (null by default so table is full width until user opens preview)
  const selectedLog = useMemo(() => {
    if (!selectedLogId) return null;
    return historyLogs.find((l) => l.id === selectedLogId) || null;
  }, [historyLogs, selectedLogId]);

  const updateDraftLeadStage = (id: string, updates: Partial<LeadStageConfig>) => {
    setDraftLeadStages((prev) =>
      prev.map((stage) => (stage.id === id ? { ...stage, ...updates } : stage))
    );
  };

  const toggleCustomerSelection = (customerId: string, leadIdsForCustomer: string[]) => {
    setHasDraftModifiedSelection(true);
    const allLeadsSelected =
      leadIdsForCustomer.length > 0 &&
      leadIdsForCustomer.every((id) => draftSelectedLeadIds.includes(id));
    const isSelected =
      draftSelectedCustomerIds.includes(customerId) &&
      (leadIdsForCustomer.length === 0 || allLeadsSelected);

    let newCustomerIds: string[];
    let newLeadIds: string[];

    if (isSelected) {
      newCustomerIds = draftSelectedCustomerIds.filter((id) => id !== customerId);
      newLeadIds = draftSelectedLeadIds.filter((id) => !leadIdsForCustomer.includes(id));
    } else {
      newCustomerIds = Array.from(new Set([...draftSelectedCustomerIds, customerId]));
      newLeadIds = Array.from(new Set([...draftSelectedLeadIds, ...leadIdsForCustomer]));
    }

    setDraftSelectedCustomerIds(newCustomerIds);
    setDraftSelectedLeadIds(newLeadIds);
  };

  const toggleLeadSelection = (
    leadId: string,
    customerId: string,
    allLeadIdsForCustomer: string[]
  ) => {
    setHasDraftModifiedSelection(true);
    const isLeadSelected = draftSelectedLeadIds.includes(leadId);
    let newLeadIds: string[];

    if (isLeadSelected) {
      newLeadIds = draftSelectedLeadIds.filter((id) => id !== leadId);
    } else {
      newLeadIds = [...draftSelectedLeadIds, leadId];
    }

    const hasAnySelectedLead = allLeadIdsForCustomer.some((id) => newLeadIds.includes(id));
    let newCustomerIds = draftSelectedCustomerIds;

    if (hasAnySelectedLead && !draftSelectedCustomerIds.includes(customerId)) {
      newCustomerIds = [...draftSelectedCustomerIds, customerId];
    } else if (!hasAnySelectedLead && draftSelectedCustomerIds.includes(customerId)) {
      newCustomerIds = draftSelectedCustomerIds.filter((id) => id !== customerId);
    }

    setDraftSelectedLeadIds(newLeadIds);
    setDraftSelectedCustomerIds(newCustomerIds);
  };

  const selectAllCustomers = () => {
    setHasDraftModifiedSelection(true);
    setDraftSelectedCustomerIds(storeCustomers.map((c) => c.id));
    setDraftSelectedLeadIds(storeCustomers.flatMap((c) => c.leads.map((l) => l.id)));
  };

  const deselectAllCustomers = () => {
    setHasDraftModifiedSelection(true);
    setDraftSelectedCustomerIds([]);
    setDraftSelectedLeadIds([]);
  };

  const handleSaveClick = () => {
    setIsConfirmModalOpen(true);
  };

  const handleConfirmSave = async () => {
    // Clicking Save ALWAYS activates the Spider and resets the activation timer to NOW.
    // This is the exact moment from which thresholds are measured.
    const nowIso = new Date().toISOString();

    const stageThresholdsMap: Record<string, any> = {};
    draftLeadStages.forEach((s) => {
      stageThresholdsMap[s.id] = {
        value: s.duration,
        unit: s.unit,
        enabled: s.enabled,
      };
    });

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: nowIso,
      autoEnrollAllLeads: draftAutoEnrollAllLeads,
      notifications: draftNotifications,
      assignments: draftAssignments,
      leadStages: draftLeadStages,
      selectedCustomerIds: draftSelectedCustomerIds,
      selectedLeadIds: draftSelectedLeadIds,
      hasUserModifiedSelection: true,
      readNotificationIds: [],
      dispatchedAlertKeys: [],
      days:
        draftLeadStages[0]?.duration !== undefined
          ? String(draftLeadStages[0].duration)
          : '',
    });

    setIsSaved(true);
    setIsConfirmModalOpen(false);
    toast({
      title: 'Spider Agent Settings Saved',
      description:
        'Notification preferences, assignments, stage thresholds, and lead watchers have been successfully applied.',
      duration: 3000,
    });
    setTimeout(() => setIsSaved(false), 2500);

    // Save to database backend (ARCH-1, B-3)
    try {
      const res = await api.put('/api/ai-farm/spider/config', {
        isActive: true,
        autoEnrollAllLeads: draftAutoEnrollAllLeads,
        selectedLeadIds: draftSelectedLeadIds,
        stageThresholds: stageThresholdsMap,
        notifications: draftNotifications,
        assignments: draftAssignments,
      });

      if (res?.data?.config) {
        queryClient.setQueryData(SPIDER_CONFIG_QUERY_KEY, res.data.config);
      }
      await queryClient.invalidateQueries({ queryKey: SPIDER_CONFIG_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ['spider-alert-db-logs'] });
    } catch (err: any) {
      console.error('[Spider Watcher] Failed to persist config to server:', err);
      toast({
        title: 'Failed to Save Settings',
        description: err?.response?.data?.error || 'Could not save Spider settings to the server.',
        variant: 'destructive' as any,
        duration: 4000,
      });
    }
  };

  const handleBackToFarm = () => {
    setAiCenterOpen(true);
  };

  // Unique users derived from history logs and available system users
  const uniqueLogUsers = useMemo(() => {
    const map = new Map<string, string>();
    historyLogs.forEach((item) => {
      item.recipients.forEach((r) => {
        if (r.name) map.set(r.name.toLowerCase(), r.name);
      });
    });
    availableUsers.forEach((u) => {
      if (u.name) map.set(u.name.toLowerCase(), u.name);
    });
    return Array.from(map.values()).sort();
  }, [historyLogs, availableUsers]);

  // Unique customers derived from history logs and store
  const uniqueLogCustomers = useMemo(() => {
    const map = new Map<string, string>();
    historyLogs.forEach((item) => {
      if (item.customerName) map.set(item.customerName.toLowerCase(), item.customerName);
    });
    storeCustomers.forEach((c) => {
      if (c.name) map.set(c.name.toLowerCase(), c.name);
    });
    return Array.from(map.values()).sort();
  }, [historyLogs, storeCustomers]);

  // Unique stages derived from history logs and standard stages
  const uniqueLogStages = useMemo(() => {
    const defaultStages = [
      'New',
      'Contacted',
      'Walkthrough Scheduled',
      'Estimate Sent',
      'Won',
      'Lost',
      'Cancelled',
    ];
    const map = new Map<string, string>();
    defaultStages.forEach((s) => map.set(s.toLowerCase(), s));
    historyLogs.forEach((item) => {
      if (item.stageName) {
        map.set(item.stageName.toLowerCase(), item.stageName);
      }
    });
    return Array.from(map.values());
  }, [historyLogs]);

  // Options resolution for Spider Notification History FilterPopover
  const recipientOptions = useMemo<FacetOption[]>(() => {
    const map = new Map<string, string>();
    availableUsers.forEach((u) => {
      if (u.name) map.set(u.id, u.name);
    });
    uniqueLogUsers.forEach((name) => {
      if (!Array.from(map.values()).some((val) => val.toLowerCase() === name.toLowerCase())) {
        map.set(name, name);
      }
    });
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
  }, [availableUsers, uniqueLogUsers]);

  const customerOptions = useMemo<FacetOption[]>(() => {
    const map = new Map<string, string>();
    storeCustomers.forEach((c) => {
      if (c.name) map.set(c.id, c.name);
    });
    uniqueLogCustomers.forEach((name) => {
      if (!Array.from(map.values()).some((val) => val.toLowerCase() === name.toLowerCase())) {
        map.set(name, name);
      }
    });
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
  }, [storeCustomers, uniqueLogCustomers]);

  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => {
      if (sourceId === 'recipients') return recipientOptions;
      if (sourceId === 'customers') return customerOptions;
      return [];
    },
    [recipientOptions, customerOptions],
  );

  const resolveMax = useCallback((_sourceId: string): number => 0, []);

  // Filtered history list based on FilterPopover facets and Search Input
  const filteredLogs = useMemo(() => {
    return historyLogs.filter((item) => {
      // 1. Filter by Stage (multi)
      const stageFilter = historyFilterState.stage || historyFilterState.status;
      if (stageFilter?.kind === 'multi' && stageFilter.values.length > 0) {
        const selected = stageFilter.values.map((s) => s.toLowerCase());
        const stage = (item.stageName || '').toLowerCase();
        const matchesStage = selected.some((s) => {
          if (s === 'new') return stage.includes('new');
          if (s === 'contacted') return stage.includes('contact');
          if (s === 'walkthrough') return stage.includes('walkthrough');
          if (s === 'estimated') return stage.includes('estimate') || stage === 'estimated';
          if (s === 'won') return stage.includes('won');
          if (s === 'lost') return stage.includes('lost');
          if (s === 'cancelled') return stage.includes('cancel');
          return stage.includes(s);
        });
        if (!matchesStage) return false;
      }

      // 2. Filter by Date / Time (multi checkboxes with preset ranges)
      const dateFilter = historyFilterState.dateTime || historyFilterState.created || historyFilterState.date_time;
      if (dateFilter?.kind === 'multi' && dateFilter.values.length > 0) {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const startOfTomorrow = startOfToday + 24 * 60 * 60 * 1000;
        const dayOfWeek = now.getDay();
        const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek).getTime();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const startOfYear = new Date(now.getFullYear(), 0, 1).getTime();
        const last7Days = now.getTime() - 7 * 24 * 60 * 60 * 1000;
        const last30Days = now.getTime() - 30 * 24 * 60 * 60 * 1000;
        const last90Days = now.getTime() - 90 * 24 * 60 * 60 * 1000;

        const itemTime = item.timestampMs || new Date(
          item.dateStr.toLowerCase().includes('today')
            ? new Date().toISOString().slice(0, 10)
            : item.dateStr.replace(/^Date:\s*/i, '').replace(/^Today\s*-\s*/i, '')
        ).getTime();

        const isMatch = dateFilter.values.some((val) => {
          const v = val.toLowerCase();
          if (v === 'today') {
            return item.dateStr.toLowerCase().includes('today') || (itemTime >= startOfToday && itemTime < startOfTomorrow);
          }
          if (v === 'this_week' || v === 'this week') {
            return itemTime >= startOfWeek;
          }
          if (v === 'this_month' || v === 'this month') {
            return itemTime >= startOfMonth;
          }
          if (v === 'last_7_days' || v === 'last 7 days') {
            return itemTime >= last7Days;
          }
          if (v === 'last_30_days' || v === 'last 30 days') {
            return itemTime >= last30Days;
          }
          if (v === 'last_90_days' || v === 'last 90 days') {
            return itemTime >= last90Days;
          }
          if (v === 'this_year' || v === 'this year') {
            return itemTime >= startOfYear;
          }
          if (v === 'custom_date' || v === 'custom date' || v === 'custom') {
            const customDate = (dateFilter as any)?.customDate || (dateFilter as any)?.customFrom;
            if (customDate) {
              const itemDateObj = new Date(itemTime);
              const itemIso = !isNaN(itemDateObj.getTime())
                ? itemDateObj.toISOString().slice(0, 10)
                : '';
              const rawDateStr = item.dateStr.replace(/^Date:\s*/i, '').replace(/^Today\s*-\s*/i, '').trim();
              const parsedRaw = new Date(rawDateStr);
              const parsedRawIso = !isNaN(parsedRaw.getTime()) ? parsedRaw.toISOString().slice(0, 10) : '';

              return itemIso === customDate || parsedRawIso === customDate;
            }
            return true;
          }
          return true;
        });

        if (!isMatch) return false;
      } else if (dateFilter?.kind === 'dateRange' && (dateFilter.from || dateFilter.to)) {
        const itemDate = new Date(
          item.timestampMs ||
          (item.dateStr.toLowerCase().includes('today')
            ? new Date().toISOString().slice(0, 10)
            : item.dateStr.replace(/^Date:\s*/i, '').replace(/^Today\s*-\s*/i, ''))
        );
        if (!isNaN(itemDate.getTime())) {
          const itemIso = itemDate.toISOString().slice(0, 10);
          if (dateFilter.from && itemIso < dateFilter.from) return false;
          if (dateFilter.to && itemIso > dateFilter.to) return false;
        }
      }

      // 3. Filter by Recipients (multi)
      const recipientsFilter = historyFilterState.recipients || historyFilterState.assigned_to;
      if (recipientsFilter?.kind === 'multi' && recipientsFilter.values.length > 0) {
        const selected = recipientsFilter.values;
        const matchesRecipient = item.recipients.some((r) =>
          selected.includes(r.id) ||
          selected.some((val) =>
            r.name.toLowerCase().includes(val.toLowerCase()) ||
            (r.email && r.email.toLowerCase().includes(val.toLowerCase()))
          )
        );
        if (!matchesRecipient) return false;
      }

      // 4. Filter by Customers (multi)
      const customersFilter = historyFilterState.customers;
      if (customersFilter?.kind === 'multi' && customersFilter.values.length > 0) {
        const selected = customersFilter.values;
        const matchesCustomer =
          selected.includes(item.customerId) ||
          selected.some((val) => item.customerName.toLowerCase().includes(val.toLowerCase()));
        if (!matchesCustomer) return false;
      }

      // 5. Filter by Role (multi)
      const roleFilter = historyFilterState.role;
      if (roleFilter?.kind === 'multi' && roleFilter.values.length > 0) {
        const selected = roleFilter.values.map((v) => v.toLowerCase());
        const matchesRole = item.recipients.some((r) => {
          const rRole = (r.role || '').toLowerCase();
          const rType = (r.type || '').toLowerCase();
          return selected.some((sel) => {
            if (sel === 'admin') return rRole.includes('admin') || rRole.includes('owner') || rType === 'admin' || rType === 'owner';
            if (sel === 'sales') return rRole.includes('sales');
            if (sel === 'dispatcher') return rRole.includes('dispatch');
            if (sel === 'technician') return rRole.includes('tech');
            return rRole.includes(sel);
          });
        });
        if (!matchesRole) return false;
      }

      // 6. Search Filter (Lead ID, leadNumber, address, customer, serviceRequest)
      if (filterLead.trim()) {
        const q = filterLead.toLowerCase().trim();
        const matchesLead =
          item.leadNumber?.toLowerCase().includes(q) ||
          item.leadId?.toLowerCase().includes(q) ||
          item.serviceLocation?.toLowerCase().includes(q) ||
          item.customerName?.toLowerCase().includes(q) ||
          item.stageName?.toLowerCase().includes(q) ||
          item.serviceRequest?.toLowerCase().includes(q);
        if (!matchesLead) return false;
      }

      return true;
    });
  }, [
    historyLogs,
    historyFilterState,
    filterLead,
  ]);

  // Calculate count of unread/new logs since user last visited History tab
  const unreadLogsCount = useMemo(() => {
    if (activeTab === 'history') return 0;
    if (lastViewedHistoryAt === null) {
      // User hasn't visited History tab yet: all logs are considered new
      return typeof dbLogsResponse?.total === 'number' ? dbLogsResponse.total : historyLogs.length;
    }
    return historyLogs.filter((log) => (log.timestampMs || 0) > lastViewedHistoryAt).length;
  }, [historyLogs, lastViewedHistoryAt, activeTab, dbLogsResponse]);

  // History logs pagination calculations: use real database total count unless client-side search/filter is active
  const isFiltered = Boolean(
    filterLead.trim() ||
    Object.keys(historyFilterState).some((k) => {
      const v = historyFilterState[k];
      return v && (v.kind === 'multi' ? v.values.length > 0 : v.kind === 'dateRange' ? Boolean(v.from || v.to) : false);
    })
  );

  const totalLogs = isFiltered
    ? filteredLogs.length
    : typeof dbLogsResponse?.total === 'number'
      ? dbLogsResponse.total
      : filteredLogs.length;

  const totalPages = isFiltered
    ? (Math.ceil(totalLogs / pageSize) || 1)
    : (dbLogsResponse?.totalPages ?? (Math.ceil(totalLogs / pageSize) || 1));

  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  const paginatedLogs = filteredLogs;

  return (
    <div className="w-full space-y-4 -mt-2">
      {/* Back to AI Agentic Farm Action Button placed directly below Dashboard > Spider */}
      <div className="flex items-center">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleBackToFarm}
          className="gap-1.5"
        >
          <ArrowLeft className="h-4 w-4" />
          AI Agentic Farm
        </Button>
      </div>

      {/* Top Header Card */}
      <div className="rounded-2xl border border-border/80 bg-surface-light p-5 sm:p-6 shadow-sm">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          {/* Left info */}
          <div className="flex items-start gap-4">
            <Avatar ring="ai" className="h-16 w-16 shrink-0">
              <AvatarImage src="/ai-center/agents/spider.png" alt="Spider Agent" className="object-contain" />
              <AvatarFallback tone="solid">🕷️</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight text-text-primary">
                  Spider
                </h1>
                <span className="rounded-full border border-ai-200 bg-ai-50 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-ai-600">
                  AI Lead Manager
                </span>
                <span className="rounded-full border border-ai-200 bg-ai-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ai-600">
                  New
                </span>
              </div>
              <p className="text-xs text-text-secondary mt-1">
                Proactively monitor pipeline progression, prevent lead stagnation, and trigger automated multi-channel escalation alerts.
              </p>
            </div>
          </div>

          {/* Right Status & Actions */}
          <div className="flex items-center gap-3 shrink-0">
            {isSpiderActive ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label="Spider Status"
                    className="h-9 w-36 transition-all px-3 flex items-center justify-between cursor-pointer select-none"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span
                        className="h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0 bg-success"
                      />
                      <span
                        className="font-bold truncate text-success-text"
                      >
                        Active
                      </span>
                    </div>
                    <ChevronDown
                      className="h-4 w-4 opacity-75 shrink-0 text-success-text"
                    />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  sideOffset={6}
                  pad={1}
                  className="z-[160] w-36 overflow-hidden p-1"
                >
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={async () => {
                      useSpiderWatcherStore.getState().deactivateSpider();
                      setDraftLeadStages(
                        DEFAULT_LEAD_STAGES.map((s) => ({ ...s, duration: undefined, enabled: false }))
                      );
                      setDraftNotifications({
                        email: false,
                        sms: false,
                        inApp: false,
                        redFrame: false,
                      });
                      setDraftAssignments({
                        adminRoles: [],
                        owner: false,
                        users: [],
                      });
                      setDraftSelectedCustomerIds([]);
                      setDraftSelectedLeadIds([]);
                      setHasDraftModifiedSelection(false);

                      try {
                        const res = await api.put('/api/ai-farm/spider/config', { isActive: false });
                        if (res?.data?.config) {
                          queryClient.setQueryData(SPIDER_CONFIG_QUERY_KEY, res.data.config);
                        }
                        await queryClient.invalidateQueries({ queryKey: SPIDER_CONFIG_QUERY_KEY });
                        await queryClient.invalidateQueries({ queryKey: ['spider-alert-db-logs'] });
                      } catch (e: unknown) {
                        console.error('[Spider Watcher] Deactivate API error:', e);
                      }
                    }}
                    onKeyDown={async (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        useSpiderWatcherStore.getState().deactivateSpider();
                        setDraftLeadStages(
                          DEFAULT_LEAD_STAGES.map((s) => ({ ...s, duration: undefined, enabled: false }))
                        );
                        setDraftNotifications({
                          email: false,
                          sms: false,
                          inApp: false,
                          redFrame: false,
                        });
                        setDraftAssignments({
                          adminRoles: [],
                          owner: false,
                          users: [],
                        });
                        setDraftSelectedCustomerIds([]);
                        setDraftSelectedLeadIds([]);
                        setHasDraftModifiedSelection(false);

                        try {
                          const res = await api.put('/api/ai-farm/spider/config', { isActive: false });
                          if (res?.data?.config) {
                            queryClient.setQueryData(SPIDER_CONFIG_QUERY_KEY, res.data.config);
                          }
                          await queryClient.invalidateQueries({ queryKey: SPIDER_CONFIG_QUERY_KEY });
                          await queryClient.invalidateQueries({ queryKey: ['spider-alert-db-logs'] });
                        } catch (err: unknown) {
                          console.error('[Spider Watcher] Deactivate API error:', err);
                        }
                      }
                    }}
                    className="w-full flex items-center justify-start gap-2 px-3 py-2 text-xs font-semibold text-danger-text hover:bg-danger-surface hover:text-danger-strong rounded-lg transition-colors cursor-pointer select-none"
                  >
                    <span
                      className="h-2 w-2 min-w-[8px] min-h-[8px] rounded-full bg-danger shrink-0"
                    />
                    <span>Deactivate</span>
                  </div>
                </PopoverContent>
              </Popover>
            ) : (
              <div
                aria-label="Spider Status"
                className="h-9 w-36 border font-bold text-xs rounded-xl transition-all shadow-xs px-3 flex items-center gap-2 bg-danger-surface border-danger-border text-danger-text select-none"
              >
                <span
                  className="h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0 bg-danger"
                />
                <span
                  className="font-bold truncate text-danger-text"
                >
                  Deactivated
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Navigation Tabs: Configuration | History */}
      <div className="flex items-center justify-between border-b border-border px-1">
        <div role="tablist" className="flex items-center gap-6">
          <div
            role="tab"
            tabIndex={0}
            aria-selected={activeTab === 'config'}
            aria-label="Configuration Tab"
            onClick={() => setActiveTab('config')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveTab('config');
              }
            }}
            className={cn(
              '-mb-px flex items-center gap-2 pb-2.5 pt-1 px-1 text-sm font-semibold transition-colors border-b-2 cursor-pointer select-none',
              activeTab === 'config'
                ? 'border-brand text-text-primary font-bold'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            )}
          >
            <span>Configuration</span>
          </div>
          <div
            role="tab"
            tabIndex={0}
            aria-selected={activeTab === 'history'}
            aria-label="History Tab"
            onClick={() => {
              setActiveTab('history');
              const now = Date.now();
              setLastViewedHistoryAt(now);
              localStorage.setItem('servwave_spider_last_viewed_history_at', String(now));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setActiveTab('history');
                const now = Date.now();
                setLastViewedHistoryAt(now);
                localStorage.setItem('servwave_spider_last_viewed_history_at', String(now));
              }
            }}
            className={cn(
              '-mb-px flex items-center gap-2 pb-2.5 pt-1 px-1 text-sm font-semibold transition-colors border-b-2 cursor-pointer select-none',
              activeTab === 'history'
                ? 'border-brand text-text-primary font-bold'
                : 'border-transparent text-text-secondary hover:text-text-primary'
            )}
          >
            <span>History</span>
            {unreadLogsCount > 0 && (
              <span className="rounded-full bg-ai-600 px-2 py-0.5 text-[10px] font-bold text-on-fill shadow-xs animate-in fade-in-0 duration-200">
                {unreadLogsCount}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Tab 1: Configuration */}
      {activeTab === 'config' && (
        <div className="rounded-2xl border border-border/80 bg-surface-light p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2 border-b border-border pb-4">
            <SlidersHorizontal className="h-5 w-5 text-ai-600" />
            <div>
              <h2 className="text-base font-bold text-text-primary">Configuration & Alert Rules</h2>
              <p className="text-xs text-text-secondary">
                Configure communication channels, assignees, stage thresholds, and monitored pipeline targets.
              </p>
            </div>
          </div>

          {/* Configuration Error State Banner */}
          {isConfigError && (
            <div className="mb-4 rounded-xl border border-danger-border bg-danger-surface p-4 text-xs text-danger-text flex items-center justify-between gap-3 shadow-xs">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
                <span>Failed to load Spider configuration: {(configError as any)?.message || 'Server error'}</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => refetchConfig()}>
                Retry
              </Button>
            </div>
          )}

          <SpiderWatcherConfig
            notifications={draftNotifications}
            setNotifications={setDraftNotifications}
            assignments={draftAssignments}
            setAssignments={setDraftAssignments}
            leadStages={draftLeadStages}
            updateLeadStage={updateDraftLeadStage}
            selectedCustomerIds={draftSelectedCustomerIds}
            selectedLeadIds={draftSelectedLeadIds}
            toggleCustomerSelection={toggleCustomerSelection}
            toggleLeadSelection={toggleLeadSelection}
            selectAllCustomers={selectAllCustomers}
            deselectAllCustomers={deselectAllCustomers}
            storeCustomers={storeCustomers}
            availableRoles={availableRoles}
            availableUsers={availableUsers}
            isLoading={isLeadsLoading || isCustomersLoading}
            isError={isLeadsError || isCustomersError}
            errorMessage={
              isLeadsError && isCustomersError
                ? 'Failed to load leads and customers from database.'
                : isLeadsError
                ? 'Failed to load leads from database.'
                : isCustomersError
                ? 'Failed to load customers from database.'
                : undefined
            }
            onRetry={() => {
              if (isLeadsError) refetchLeads();
              if (isCustomersError) refetchCustomers();
            }}
            autoEnrollNewLeads={draftAutoEnrollAllLeads}
            onAutoEnrollChange={(enabled: boolean) => {
              setDraftAutoEnrollAllLeads(enabled);
              useSpiderWatcherStore.getState().setAutoEnrollAllLeads(enabled);
            }}
            isActive={isSpiderActive}
            activatedAt={storeActivatedAt}
          />

          {/* Bottom Save bar */}
          <div className="mt-8 pt-5 border-t border-border flex items-center justify-between">
            <p className="text-xs text-text-secondary">
              Make sure to save changes before leaving the page.
            </p>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="solid"
                tone={isSaved ? 'business' : 'ai'}
                onClick={handleSaveClick}
                className="gap-2 min-w-[120px]"
              >
                {isSaved ? (
                  <>
                    <Check className="h-4 w-4" />
                    Saved
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    Save
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: History (Structured Notification Logs matching sketch) */}
      {activeTab === 'history' && (
        <div className="space-y-6">
          {/* History Logs Toolbar matching v2 reference image: Search leads... | Filter | Export | Refresh */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/80 bg-surface-light p-3 shadow-sm">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-soft" />
              <Input
                value={filterLead}
                onChange={(e) => setFilterLead(e.target.value)}
                placeholder="Search leads..."
                className="pl-9 pr-8 h-9 w-full"
              />
              {filterLead && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setFilterLead('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                  title="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <FilterPopover
                registry={spiderHistoryRegistry}
                value={historyFilterState}
                onChange={(next) => {
                  setHistoryFilterState(next);
                  setCurrentPage(1);
                }}
                resolveOptions={resolveOptions}
                resolveMax={resolveMax}
                statusDomain="lead"
              />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-1.5">
                    <Download className="h-4 w-4" />
                    <span>Export</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-[150]">
                  <DropdownMenuLabel>Export Notification History</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleExportLogs(paginatedLogs, 'Current Page')}>
                    Current page ({paginatedLogs.length} logs)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handleExportLogs(filteredLogs, 'All Logs')}>
                    All filtered ({filteredLogs.length} logs)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                variant="outline"
                size="sm"
                onClick={() => refetchDbLogs()}
                disabled={isLogsFetching}
                className="h-9 px-3 gap-1.5"
                title="Refresh notification logs from database"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", isLogsFetching && "animate-spin text-ai-600")} />
                <span>Refresh</span>
              </Button>
            </div>
          </div>

          {/* Main Log View: Full Width Table + Slide-over Side Drawer on Corner */}
          {isLogsError ? (
            <div className="rounded-2xl border border-danger-border bg-danger-surface/40 p-12 text-center shadow-sm">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-danger-surface border border-danger-border text-danger mb-4">
                <AlertTriangle className="h-7 w-7 text-danger" />
              </div>
              <h3 className="text-base font-bold text-danger-text">
                Failed to load notification history
              </h3>
              <p className="text-xs text-text-secondary max-w-md mx-auto mt-1">
                {(logsError as any)?.message || 'A network error occurred while retrieving notification logs from the database.'}
              </p>
              <div className="mt-4">
                <Button variant="outline" size="sm" onClick={() => refetchDbLogs()} className="gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Retry</span>
                </Button>
              </div>
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="rounded-2xl border border-border/80 bg-surface-light p-12 text-center shadow-sm">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-ai-50 border border-ai-200 text-ai-600 mb-4">
                <CheckCircle2 className="h-7 w-7 text-success" />
              </div>
              <h3 className="text-base font-bold text-text-primary">
                {historyLogs.length === 0
                  ? isSpiderActive
                    ? 'All Monitored Stage Leads are Healthy'
                    : 'No Historical Alert Logs'
                  : 'No notification logs matched your search filter.'}
              </h3>
              <p className="text-xs text-text-secondary max-w-md mx-auto mt-1">
                {historyLogs.length === 0
                  ? isSpiderActive
                    ? `Spider is actively monitoring ${storeSelectedLeadIds.length} lead targets in the background. When overdue alerts trigger, notification logs and message previews will appear here.`
                    : 'Spider is currently deactivated. Historical logs from past alert sweeps will remain visible here whenever available.'
                  : 'Try adjusting your search criteria or stage filter.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Full Width Notification Logs Table */}
              <div className="rounded-2xl border border-border/80 bg-surface-light shadow-sm overflow-hidden w-full">
                {/* Table */}
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-border/80 bg-surface-light font-bold text-text-secondary">
                        <th className="py-3 px-4 min-w-[140px]">Date & Time</th>
                        <th className="py-3 px-4 w-28">Lead ID</th>
                        <th className="py-3 px-4 min-w-[120px]">Stage</th>
                        <th className="py-3 px-4 min-w-[150px]">Lead Address</th>
                        <th className="py-3 px-4 min-w-[140px]">Customer Name</th>
                        <th className="py-3 px-4 min-w-[130px]">Notification Types</th>
                        <th className="py-3 px-4 min-w-[140px]">Recipients</th>
                        <th className="py-3 px-4 text-center w-24">Preview</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {paginatedLogs.map((log) => {
                        const isSelected = selectedLog?.id === log.id;
                        const firstRecipient = log.recipients[0];
                        const hasMultipleRecipients = log.recipients.length > 1;

                        return (
                          <tr
                            key={log.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`View notification details for lead ${log.leadNumber}`}
                            onClick={() => setSelectedLogId((prev) => (prev === log.id ? null : log.id))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setSelectedLogId((prev) => (prev === log.id ? null : log.id));
                              }
                            }}
                            className={cn(
                              'cursor-pointer transition-colors group',
                              isSelected
                                ? 'bg-ai-50/60'
                                : 'hover:bg-background-light/70'
                            )}
                          >
                            {/* Date & Time */}
                            <td className="py-3.5 px-4 whitespace-nowrap">
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-1.5 font-mono font-bold text-text-primary">
                                  <Clock className="h-3 w-3 text-ai-600 shrink-0" />
                                  <span>{log.timeStr}</span>
                                </div>
                                <div className="flex items-center gap-1 text-[11px] text-text-soft">
                                  <Calendar className="h-3 w-3 text-text-soft shrink-0" />
                                  <span>{log.dateStr.replace(/^Today\s*-\s*/i, '')}</span>
                                </div>
                              </div>
                            </td>

                            {/* Lead ID */}
                            <td className="py-3.5 px-4 whitespace-nowrap">
                              <span className="font-mono font-medium text-text-primary text-xs">
                                {log.leadNumber}
                              </span>
                            </td>

                            {/* Stage */}
                            <td className="py-3.5 px-4 whitespace-nowrap">
                              <LeadStageChip stage={log.stageName} />
                            </td>

                            {/* Lead Address */}
                            <td className="py-3.5 px-4">
                              <div className="flex items-center gap-1.5 text-xs text-text-secondary max-w-[200px]" title={log.serviceLocation}>
                                <MapPin className="h-3.5 w-3.5 text-text-soft shrink-0" />
                                <span className="truncate">{log.serviceLocation || 'Service location on file'}</span>
                              </div>
                            </td>

                            {/* Customer Name */}
                            <td className="py-3.5 px-4">
                              <div className="min-w-0">
                                <p className="font-bold text-text-primary truncate">
                                  {log.customerName}
                                </p>
                                {log.companyName && (
                                  <p className="text-[10px] text-text-soft truncate max-w-[140px]">
                                    {log.companyName}
                                  </p>
                                )}
                              </div>
                            </td>

                            {/* Notification Types: clean badges with dot indicators and channel names only */}
                            <td className="py-3.5 px-4">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                {log.channels.email.enabled && (
                                  <span
                                    title={
                                      log.channels.email.status === 'SENT'
                                        ? `Email: Successfully Sent${log.channels.email.sentCount ? ` to ${log.channels.email.sentCount} recipient(s)` : ''}`
                                        : log.channels.email.status === 'FAILED'
                                          ? `Email: Delivery Failed — ${log.channels.email.error || 'Provider rejected email'}`
                                          : 'Email: Skipped (no email address)'
                                    }
                                    className={cn(
                                      'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border shadow-xs',
                                      log.channels.email.status === 'SENT'
                                        ? 'bg-success-surface border-success-border text-success-text'
                                        : log.channels.email.status === 'FAILED'
                                          ? 'bg-danger-surface border-danger-border text-danger-text'
                                          : 'bg-warning-surface border-warning-border text-warning-text'
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        'inline-block h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0',
                                        log.channels.email.status === 'SENT'
                                          ? 'bg-success'
                                          : log.channels.email.status === 'FAILED'
                                            ? 'bg-danger'
                                            : 'bg-warning'
                                      )}
                                    />
                                    <span>Email</span>
                                  </span>
                                )}
                                {log.channels.sms.enabled && (
                                  <span
                                    title={
                                      log.channels.sms.status === 'SENT'
                                        ? `SMS: Successfully Sent${log.channels.sms.sentCount ? ` to ${log.channels.sms.sentCount} recipient(s)` : ''}`
                                        : log.channels.sms.status === 'FAILED'
                                          ? `SMS: Delivery Failed — ${log.channels.sms.error || 'Carrier delivery failure'}`
                                          : 'SMS: Skipped (no phone number)'
                                    }
                                    className={cn(
                                      'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border shadow-xs',
                                      log.channels.sms.status === 'SENT'
                                        ? 'bg-success-surface border-success-border text-success-text'
                                        : log.channels.sms.status === 'FAILED'
                                          ? 'bg-danger-surface border-danger-border text-danger-text'
                                          : 'bg-warning-surface border-warning-border text-warning-text'
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        'inline-block h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0',
                                        log.channels.sms.status === 'SENT'
                                          ? 'bg-success'
                                          : log.channels.sms.status === 'FAILED'
                                            ? 'bg-danger'
                                            : 'bg-warning'
                                      )}
                                    />
                                    <span>SMS</span>
                                  </span>
                                )}
                                {log.channels.inApp.enabled && (
                                  <span
                                    title={
                                      log.channels.inApp.status === 'FAILED'
                                        ? 'In-App: Notification Delivery Failed'
                                        : 'In-App: Notification Delivered'
                                    }
                                    className={cn(
                                      'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border shadow-xs',
                                      log.channels.inApp.status === 'FAILED'
                                        ? 'bg-danger-surface border-danger-border text-danger-text'
                                        : 'bg-success-surface border-success-border text-success-text'
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        'inline-block h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0',
                                        log.channels.inApp.status === 'FAILED'
                                          ? 'bg-danger'
                                          : 'bg-success'
                                      )}
                                    />
                                    <span>In-App</span>
                                  </span>
                                )}
                              </div>
                            </td>

                            {/* Recipients: show only one name and clickable +N dropdown for multiple */}
                            <td className="py-3.5 px-4">
                              <div className="flex items-center gap-1.5 flex-nowrap">
                                {firstRecipient && (
                                  <span
                                    className="inline-flex items-center gap-1.5 rounded-md bg-surface-light border border-border px-2 py-0.5 text-[11px] font-medium text-text-primary max-w-[130px] truncate shadow-xs"
                                    title={firstRecipient.name}
                                  >
                                    <User className="h-3 w-3 text-text-soft shrink-0" />
                                    <span className="truncate">{firstRecipient.name}</span>
                                  </span>
                                )}

                                {hasMultipleRecipients && (
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={(e) => e.stopPropagation()}
                                        className="h-5 px-1.5 transition-colors cursor-pointer"
                                        title={`Click to view all ${log.recipients.length} recipients`}
                                        aria-label="View all recipients"
                                      >
                                        <span className="text-[10px] font-bold">+{log.recipients.length - 1}</span>
                                      </Button>
                                    </PopoverTrigger>
                                    <PopoverContent
                                      align="start"
                                      sideOffset={4}
                                      className="z-[160] w-60 p-2.5"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <div className="flex items-center justify-between pb-2 mb-2 border-b border-border">
                                        <span className="font-bold text-text-primary text-xs">
                                          All Assigned Recipients
                                        </span>
                                        <span className="text-[10px] font-semibold text-text-soft bg-background-light px-1.5 py-0.5 rounded-md border border-border">
                                          {log.recipients.length} total
                                        </span>
                                      </div>
                                      <div className="space-y-1 max-h-48 overflow-y-auto">
                                        {log.recipients.map((r, i) => (
                                          <div
                                            key={i}
                                            className="flex items-center justify-between gap-2 p-1.5 rounded-lg hover:bg-background-light transition-colors text-[11px]"
                                          >
                                            <div className="flex items-center gap-2 min-w-0">
                                              <div className="h-5 w-5 rounded-full bg-ai-50 text-ai-600 border border-ai-200 flex items-center justify-center text-[10px] font-bold shrink-0">
                                                {r.name.charAt(0).toUpperCase()}
                                              </div>
                                              <div className="min-w-0">
                                                <p className="font-medium text-text-primary truncate">
                                                  {r.name}
                                                </p>
                                                {r.email && (
                                                  <p className="text-[10px] text-text-soft truncate">
                                                    {r.email}
                                                  </p>
                                                )}
                                              </div>
                                            </div>
                                            {r.role && (
                                              <span className="text-[10px] text-text-soft bg-background-light px-1.5 py-0.5 rounded border border-border/60 shrink-0">
                                                {r.role}
                                              </span>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                )}
                              </div>
                            </td>

                            {/* Action Preview Button */}
                            <td className="py-3.5 px-4 text-center whitespace-nowrap">
                              <Button
                                type="button"
                                size="sm"
                                variant={isSelected ? "solid" : "outline"}
                                tone={isSelected ? "ai" : "neutral"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedLogId((prev) => (prev === log.id ? null : log.id));
                                }}
                                className="h-7 px-2.5 text-[11px] gap-1"
                              >
                                <Eye className="h-3 w-3" />
                                <span>{isSelected ? 'Close' : 'Preview'}</span>
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Pagination Footer */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 bg-surface-light">
                  <div className="text-text-secondary text-[12.5px]">
                    Showing <span className="text-text-primary font-bold">
                      {totalLogs === 0 ? 0 : (safeCurrentPage - 1) * pageSize + 1}-{Math.min(safeCurrentPage * pageSize, totalLogs)}
                    </span> of <span className="text-text-primary font-bold">{totalLogs}</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-text-secondary text-[12.5px] font-medium hidden sm:inline">Rows</span>
                      <Select
                        value={String(pageSize)}
                        onValueChange={(value) => {
                          setPageSize(Number(value));
                          setCurrentPage(1);
                        }}
                      >
                        <SelectTrigger className="h-8 w-[4.5rem]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="z-[150]">
                          <SelectItem value="25">25</SelectItem>
                          <SelectItem value="50">50</SelectItem>
                          <SelectItem value="100">100</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <span className="text-text-secondary text-[12.5px] font-medium">
                      Page {totalPages === 0 ? 0 : safeCurrentPage} of {totalPages}
                    </span>

                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 w-8 p-0 hidden sm:inline-flex"
                        onClick={() => setCurrentPage(1)}
                        disabled={safeCurrentPage <= 1}
                        title="First page"
                      >
                        <ChevronsLeft className="h-4 w-4" />
                        <span className="sr-only">First page</span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                        disabled={safeCurrentPage <= 1}
                        title="Previous page"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        <span className="sr-only">Previous page</span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                        disabled={safeCurrentPage >= totalPages}
                        title="Next page"
                      >
                        <ChevronRight className="h-4 w-4" />
                        <span className="sr-only">Next page</span>
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 w-8 p-0 hidden sm:inline-flex"
                        onClick={() => setCurrentPage(totalPages)}
                        disabled={safeCurrentPage >= totalPages}
                        title="Last page"
                      >
                        <ChevronsRight className="h-4 w-4" />
                        <span className="sr-only">Last page</span>
                      </Button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Slide-over Right Drawer for Delivered Message Preview (Opens from side/corner) */}
              {selectedLog && (
                <div
                  ref={drawerRef}
                  tabIndex={-1}
                  className="fixed inset-0 z-[200] overflow-hidden outline-none"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Delivered Message Preview"
                >
                  {/* Backdrop */}
                  <div
                    className="fixed inset-0 bg-scrim/40 backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
                    onClick={() => setSelectedLogId(null)}
                    aria-hidden="true"
                  />

                  {/* Slide-over Drawer Panel */}
                  <div className="fixed inset-y-0 right-0 max-w-full flex pl-10 pointer-events-none">
                    <div className="w-screen max-w-md sm:max-w-lg bg-surface-light border-l border-border shadow-2xl flex flex-col pointer-events-auto animate-in slide-in-from-right duration-250">
                      {/* Drawer Header */}
                      <div className="px-6 py-4 border-b border-border bg-background-light/60 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-ai-600" />
                            <h3 className="text-xs font-bold text-text-primary uppercase tracking-wider">
                              Delivered Message Preview
                            </h3>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            tone="subtle"
                            size="sm"
                            onClick={() => setSelectedLogId(null)}
                            className="h-7 w-7 p-0"
                            title="Close preview"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>

                        {/* Stacked Details: 1. Customer Name, 2. Lead ID, 3. Lead Address */}
                        <div className="space-y-1">
                          {/* 1. Customer Name */}
                          <div className="text-sm font-bold text-text-primary truncate">
                            {selectedLog.customerName || 'Customer'}
                            {selectedLog.companyName && (
                              <span className="text-xs font-normal text-text-soft ml-1.5">
                                ({selectedLog.companyName})
                              </span>
                            )}
                          </div>

                          {/* 2. Lead ID */}
                          <div className="text-xs font-mono font-medium text-text-secondary">
                            {selectedLog.leadNumber}
                          </div>

                          {/* 3. Lead Address */}
                          <div className="flex items-center gap-1.5 text-xs text-text-secondary truncate" title={selectedLog.serviceLocation}>
                            <MapPin className="h-3.5 w-3.5 text-text-soft shrink-0" />
                            <span className="truncate">{selectedLog.serviceLocation || 'Service location on file'}</span>
                          </div>
                        </div>
                      </div>

                      {/* Delivery Status Summary Banner */}
                      <div className="mx-6 mt-4 p-3.5 rounded-xl border border-border bg-background-light/60 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-text-secondary">
                            Delivery Outcomes
                          </span>
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                          {/* Email status pill */}
                          <div className={cn(
                            "p-2 rounded-lg border flex flex-col gap-0.5",
                            selectedLog.channels.email.status === 'SENT'
                              ? "bg-success-surface border-success-border text-success-text"
                              : selectedLog.channels.email.status === 'FAILED'
                                ? "bg-danger-surface border-danger-border text-danger-text"
                                : "bg-surface-light border-border text-text-secondary"
                          )}>
                            <div className="flex items-center gap-1 font-bold text-[11px]">
                              <Mail className="h-3 w-3 shrink-0" />
                              <span>Email</span>
                            </div>
                            <span className="text-[10px] font-medium">
                              {selectedLog.channels.email.status === 'SENT'
                                ? 'Sent'
                                : selectedLog.channels.email.status === 'FAILED'
                                  ? 'Failed'
                                  : 'Skipped'}
                            </span>
                          </div>

                          {/* SMS status pill */}
                          <div className={cn(
                            "p-2 rounded-lg border flex flex-col gap-0.5",
                            selectedLog.channels.sms.status === 'SENT'
                              ? "bg-success-surface border-success-border text-success-text"
                              : selectedLog.channels.sms.status === 'FAILED'
                                ? "bg-danger-surface border-danger-border text-danger-text"
                                : "bg-surface-light border-border text-text-secondary"
                          )}>
                            <div className="flex items-center gap-1 font-bold text-[11px]">
                              <MessageSquare className="h-3 w-3 shrink-0" />
                              <span>SMS</span>
                            </div>
                            <span className="text-[10px] font-medium">
                              {selectedLog.channels.sms.status === 'SENT'
                                ? 'Sent'
                                : selectedLog.channels.sms.status === 'FAILED'
                                  ? 'Failed'
                                  : 'Skipped'}
                            </span>
                          </div>

                          {/* In-App status pill */}
                          <div className="p-2 rounded-lg border bg-ai-50 border-ai-200 text-ai-600 flex flex-col gap-0.5">
                            <div className="flex items-center gap-1 font-bold text-[11px]">
                              <Bell className="h-3 w-3 text-ai-600 shrink-0" />
                              <span>In-App</span>
                            </div>
                            <span className="text-[10px] font-medium">Delivered</span>
                          </div>
                        </div>
                      </div>

                      {/* Channel Switcher Tabs (Email | SMS | In-App) */}
                      <div role="tablist" aria-label="Notification Channel Previews" className="flex items-center border-b border-border bg-surface-light px-4 pt-2 gap-2">
                        <div
                          role="tab"
                          tabIndex={0}
                          aria-selected={previewTab === 'email'}
                          onClick={() => setPreviewTab('email')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setPreviewTab('email');
                            }
                          }}
                          className={cn(
                            'h-auto -mb-px flex items-center gap-1.5 px-3 py-2 text-xs font-bold border-b-2 transition-all cursor-pointer select-none',
                            previewTab === 'email'
                              ? 'border-ai-600 text-ai-600'
                              : 'border-transparent text-text-secondary hover:text-text-primary'
                          )}
                        >
                          <Mail className="h-3.5 w-3.5" />
                          <span>Email</span>
                        </div>
                        <div
                          role="tab"
                          tabIndex={0}
                          aria-selected={previewTab === 'sms'}
                          onClick={() => setPreviewTab('sms')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setPreviewTab('sms');
                            }
                          }}
                          className={cn(
                            'h-auto -mb-px flex items-center gap-1.5 px-3 py-2 text-xs font-bold border-b-2 transition-all cursor-pointer select-none',
                            previewTab === 'sms'
                              ? 'border-ai-600 text-ai-600'
                              : 'border-transparent text-text-secondary hover:text-text-primary'
                          )}
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          <span>SMS</span>
                        </div>
                        <div
                          role="tab"
                          tabIndex={0}
                          aria-selected={previewTab === 'inApp'}
                          onClick={() => setPreviewTab('inApp')}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setPreviewTab('inApp');
                            }
                          }}
                          className={cn(
                            'h-auto -mb-px flex items-center gap-1.5 px-3 py-2 text-xs font-bold border-b-2 transition-all cursor-pointer select-none',
                            previewTab === 'inApp'
                              ? 'border-ai-600 text-ai-600'
                              : 'border-transparent text-text-secondary hover:text-text-primary'
                          )}
                        >
                          <Bell className="h-3.5 w-3.5" />
                          <span>In-App</span>
                        </div>
                      </div>

                      {/* Scrollable Preview Body */}
                      <div className="p-5 space-y-4 flex-1 overflow-y-auto">
                        {/* 1. Email Preview */}
                        {previewTab === 'email' && (() => {
                          const isEmailSkipped = selectedLog.channels.email.status === 'SKIPPED' || selectedLog.emailPreview.status === 'SKIPPED';
                          const senderDisplay = selectedLog.emailPreview.from || defaultSenderEmail;

                          return (
                            <div className="space-y-3">
                              <div className="rounded-xl border border-border/70 bg-background-light/40 p-3 text-xs space-y-1.5">
                                {!isEmailSkipped ? (
                                  <>
                                    <div className="flex items-center justify-between text-text-secondary">
                                      <span>From: <strong>{senderDisplay}</strong></span>
                                      <span className="font-mono text-[10px]">{selectedLog.timeStr}</span>
                                    </div>
                                    <p className="text-text-secondary truncate">
                                      To: <strong>{selectedLog.emailPreview.to.join(', ')}</strong>
                                    </p>
                                  </>
                                ) : (
                                  <div className="flex items-center justify-between text-text-secondary">
                                    <p className="text-text-secondary truncate">
                                      To: <strong>{selectedLog.emailPreview.to.join(', ')}</strong>
                                    </p>
                                    <span className="font-mono text-[10px]">{selectedLog.timeStr}</span>
                                  </div>
                                )}
                              </div>

                              <div className="rounded-xl border border-border/80 bg-surface-light p-4 text-xs space-y-3 shadow-xs">
                                <div className="flex items-center gap-2 pb-2 border-b border-border/60">
                                  <Avatar ring="ai" className="h-8 w-8 shrink-0">
                                    <AvatarImage src="/ai-center/agents/spider.png" alt="Spider" className="object-contain" />
                                    <AvatarFallback tone="solid">🕷️</AvatarFallback>
                                  </Avatar>
                                  <div>
                                    <p className="font-bold text-text-primary">Spider Lead Alert</p>
                                  </div>
                                </div>

                                <div className="rounded-lg bg-danger-surface border border-danger-border p-2.5 text-danger-text font-semibold text-[11px] flex items-center gap-2">
                                  <AlertTriangle className="h-4 w-4 shrink-0" />
                                  <span>Action Required: Lead has been inactive for {selectedLog.inactiveDays} {selectedLog.inactiveDays === 1 ? 'day' : 'days'} in {selectedLog.stageName} stage.</span>
                                </div>

                                <div className="space-y-1.5 text-text-secondary leading-relaxed whitespace-pre-line text-[11px]">
                                  {selectedLog.emailPreview.body}
                                </div>

                                <div className="pt-2">
                                  <Button
                                    type="button"
                                    variant="solid"
                                    tone="ai"
                                    size="sm"
                                    onClick={() => {
                                      setSelectedLogId(null);
                                      if (selectedLog.leadId) {
                                        navigate(`/leads/${selectedLog.leadId}`);
                                      } else {
                                        navigate('/leads');
                                      }
                                    }}
                                    className="w-full gap-1.5"
                                  >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                    Open Lead #{selectedLog.leadNumber} in Pipeline
                                  </Button>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {/* 2. SMS Preview */}
                        {previewTab === 'sms' && (() => {
                          const isSmsSkipped = selectedLog.channels.sms.status === 'SKIPPED' || selectedLog.smsPreview.status === 'SKIPPED';

                          return (
                            <div className="space-y-3">
                              {!isSmsSkipped && (
                                <div className="rounded-xl border border-border/70 bg-background-light/40 p-3 text-xs">
                                  <p className="text-text-secondary">
                                    SMS Target Recipients: <strong>{selectedLog.smsPreview.to.join(', ')}</strong>
                                  </p>
                                </div>
                              )}

                              {/* Phone chat bubble style */}
                              <div className="rounded-2xl border border-border/80 bg-background-light/30 p-4 space-y-2">
                                <div className="text-center text-[10px] text-text-soft font-mono">
                                  SMS Message • {selectedLog.timeStr}
                                </div>
                                <div className="max-w-[90%] rounded-2xl rounded-tl-sm bg-ai-600 text-on-fill p-3.5 text-xs leading-relaxed shadow-sm">
                                  <p className="font-semibold text-[11px] mb-1 opacity-90">🕷️ Spider AI Alert:</p>
                                  <p>{selectedLog.smsPreview.message}</p>
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {/* 3. In-App Preview */}
                        {previewTab === 'inApp' && (
                          <div className="space-y-3">
                            <div className="rounded-2xl border border-ai-200 bg-ai-50/50 p-4 shadow-sm flex items-start gap-3">
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ai-50 border border-ai-200 text-ai-600">
                                <Bell className="h-4 w-4" />
                              </div>
                              <div className="space-y-1 flex-1">
                                <p className="text-xs font-bold text-text-primary">
                                  {selectedLog.inAppPreview.title}
                                </p>
                                <p className="text-xs text-text-secondary leading-relaxed">
                                  {selectedLog.inAppPreview.message}
                                </p>
                                <div className="pt-2 flex items-center gap-2">
                                  <span className="text-[10px] font-mono text-ai-600 font-bold">
                                    {selectedLog.timeStr}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Spider Save Confirmation Overview Modal */}
      <SpiderSaveConfirmDialog
        open={isConfirmModalOpen}
        onOpenChange={setIsConfirmModalOpen}
        notifications={draftNotifications}
        assignments={draftAssignments}
        leadStages={draftLeadStages}
        selectedLeadIds={draftSelectedLeadIds}
        selectedCustomerIds={draftSelectedCustomerIds}
        storeCustomers={storeCustomers}
        availableRoles={availableRoles}
        availableUsers={availableUsers}
        autoEnrollAllLeads={draftAutoEnrollAllLeads}
        onConfirm={handleConfirmSave}
      />
    </div>
  );
}
