import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef, VisibilityState } from '@tanstack/react-table';
import { useBeeStore } from '@/stores/beeStore';
import { BeeQueueItem } from '@/lib/api/bee';
import {
  ListOrdered,
  PhoneForwarded,
  SkipForward,
  Search,
  X,
  AlertTriangle,
  Ban,
  Clock,
  Calendar,
} from 'lucide-react';
import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { Button } from '@/components/ui/button';
import { Heading } from '@/ui-kit/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { formatPhone, formatSnakeCase } from '@/lib/utils';
import { BeeTableColumnOptions } from '../components/BeeTableColumnOptions';
import { BeeTableScrollFades } from '../components/BeeTableScrollFades';
import { FilterPopover, facetSelectionCount } from '@/pages/v2/_shared/filterPopover';
import { AppliedFilterBar } from '@/pages/v2/_shared/appliedFilters';
import type { FacetConfig, FacetOption, FilterState } from '@/lib/filters/types';

export const queueFilterRegistry: FacetConfig[] = [
  {
    key: 'scheduled_date',
    kind: 'dateRange',
    param: 'scheduled_date',
    label: 'Scheduled Time',
    icon: 'M8 2v4 M16 2v4 M5 4H19A2 2 0 0 1 21 6V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V6A2 2 0 0 1 5 4Z M3 10h18',
  },
  {
    key: 'attempt',
    kind: 'multi',
    param: 'attempt',
    label: 'Attempt',
    icon: 'M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    options: [
      { value: '1st', label: '1st Dial' },
      { value: 'retries', label: 'Retries' },
    ],
  },
  {
    key: 'job_type',
    kind: 'multi',
    param: 'job_type',
    label: 'Job Type',
    icon: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z',
    optionSource: 'jobTypes',
  },
  {
    key: 'rescheduled',
    kind: 'multi',
    param: 'rescheduled',
    label: 'Schedule Status',
    icon: 'M12 8v4l3 3 M22 12A10 10 0 1 1 12 2',
    options: [
      { value: 'rescheduled', label: 'Rescheduled' },
      { value: 'original', label: 'Original Schedule' },
    ],
  },
];

export const skippedFilterRegistry: FacetConfig[] = [
  {
    key: 'scheduled_date',
    kind: 'dateRange',
    param: 'scheduled_date',
    label: 'Date',
    icon: 'M8 2v4 M16 2v4 M5 4H19A2 2 0 0 1 21 6V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V6A2 2 0 0 1 5 4Z M3 10h18',
  },
  {
    key: 'skip_reason',
    kind: 'multi',
    param: 'skip_reason',
    label: 'Skip Reason',
    icon: 'M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636',
    options: [
      { value: 'job_type_disabled', label: 'Job type disabled' },
      { value: 'dnc', label: 'Do Not Call' },
      { value: 'other', label: 'Other reasons' },
    ],
  },
  {
    key: 'job_type',
    kind: 'multi',
    param: 'job_type',
    label: 'Job Type',
    icon: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z',
    optionSource: 'skippedJobTypes',
  },
];

export const ALL_QUEUE_COLUMNS = [
  { id: 'scheduled_time', label: 'Scheduled Time' },
  { id: 'customer_name', label: 'Customer Name' },
  { id: 'customer_phone', label: 'Phone Number' },
  { id: 'job_number', label: 'Job #' },
  { id: 'job_type', label: 'Job Type' },
  { id: 'service_request', label: 'Service Request' },
  { id: 'warranty_started_on', label: 'Warranty Started On' },
  { id: 'warranty_expiry', label: 'Warranty Expiry' },
  { id: 'attempt', label: 'Attempt' },
  { id: 'actions', label: 'Actions' },
];

const STORAGE_KEY_COLUMNS = 'bee_queue_table_columns_v1';

export const DEFAULT_VISIBLE_COLUMNS: Record<string, boolean> = {
  scheduled_time: true,
  customer_name: true,
  customer_phone: true,
  job_number: true,
  job_type: true,
  service_request: true,
  warranty_started_on: true,
  warranty_expiry: true,
  attempt: true,
  actions: true,
};

export function formatQueueScheduledTime(item: BeeQueueItem, defaultTz: string = 'America/New_York') {
  const customerTz = item.customer_timezone || defaultTz;
  const isEstimated = Boolean(item.is_timezone_estimated);
  const source = item.timezone_source || 'system_default';
  const isDefaultTz = source === 'system_default';

  // The logged-in user's local timezone
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const dateObj = new Date(item.scheduled_for);

  // Date & Time in the logged-in user's timezone with AM/PM (e.g. "6 Nov, 10:36 AM")
  let formattedDateTime = '';
  let timeStr = '';
  let dateStr = '';
  let userTzAbbr = '';

  try {
    formattedDateTime = dateObj.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: userTz,
    }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());

    timeStr = dateObj.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: userTz,
    }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());

    dateStr = dateObj.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: userTz,
    });

    const parts = new Intl.DateTimeFormat([], { timeZone: userTz, timeZoneName: 'short' }).formatToParts(dateObj);
    userTzAbbr = parts.find((p) => p.type === 'timeZoneName')?.value || '';
  } catch {
    formattedDateTime = dateObj.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());

    timeStr = dateObj.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());

    dateStr = dateObj.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Also format customer's local time for context/tooltip
  let customerTimeStr = '';
  let customerFormattedDateTime = '';
  try {
    customerFormattedDateTime = dateObj.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: customerTz,
    }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());

    customerTimeStr = dateObj.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: customerTz,
    }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());
  } catch {
    // fallback
  }

  const badgeLabel = isDefaultTz
    ? 'Default Timezone'
    : isEstimated
    ? 'Customer Timezone · Estimated'
    : 'Customer Timezone';

  return {
    formattedDateTime,
    timeStr,
    dateStr,
    badgeLabel,
    isDefaultTz,
    isEstimated,
    timezone: userTz,
    userTimezone: userTz,
    userTzAbbr,
    customerTimezone: customerTz,
    customerTimeStr,
    customerFormattedDateTime,
  };
}

export const BeeQueueTab: React.FC = () => {
  const navigate = useNavigate();
  const { queueItems, skippedItems, loadQueue, callNow, skipQueueItem, rescheduleQueueItem } = useBeeStore();
  const [actingId, setActingId] = useState<string | null>(null);

  // Manual Reschedule state
  const [rescheduleTarget, setRescheduleTarget] = useState<BeeQueueItem | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('');
  const [isRescheduling, setIsRescheduling] = useState(false);

  // Filters and Pagination for Active Outbound Queue
  const [searchQuery, setSearchQuery] = useState('');
  const [queueFilterState, setQueueFilterState] = useState<FilterState>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Filters and Pagination for Skipped Jobs
  const [skippedSearchQuery, setSkippedSearchQuery] = useState('');
  const [skippedFilterState, setSkippedFilterState] = useState<FilterState>({});
  const [skippedPage, setSkippedPage] = useState(1);
  const [skippedPageSize, setSkippedPageSize] = useState(25);

  const queueContainerRef = useRef<HTMLDivElement>(null);
  const skippedContainerRef = useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    loadQueue();

    // Live update polling so queue and skipped items are updated live without manual refresh
    const intervalId = setInterval(() => {
      loadQueue();
    }, 4000);

    const handleSync = () => {
      if (document.visibilityState === 'visible') {
        loadQueue();
      }
    };

    window.addEventListener('focus', handleSync);
    document.addEventListener('visibilitychange', handleSync);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', handleSync);
      document.removeEventListener('visibilitychange', handleSync);
    };
  }, [loadQueue]);

  // Column Visibility state (persisted to localStorage)
  const [visibleColumns, setVisibleColumns] = useState<VisibilityState>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_COLUMNS);
      if (saved) {
        return { ...DEFAULT_VISIBLE_COLUMNS, ...JSON.parse(saved) };
      }
    } catch {
      // fallback
    }
    return DEFAULT_VISIBLE_COLUMNS;
  });

  const handleColumnVisibilityChange = (updater: any) => {
    setVisibleColumns((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      try {
        localStorage.setItem(STORAGE_KEY_COLUMNS, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const handleCallNow = async (id: string) => {
    try {
      setActingId(id);
      await callNow(id);
    } catch {
      // handled in store
    } finally {
      setActingId(null);
    }
  };

  const handleSkip = async (id: string) => {
    try {
      setActingId(id);
      await skipQueueItem(id, 'Admin manually skipped');
    } finally {
      setActingId(null);
    }
  };

  const handleOpenReschedule = (item: BeeQueueItem) => {
    setRescheduleTarget(item);
    const d = new Date(item.scheduled_for);
    if (!isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      setRescheduleDate(`${yyyy}-${mm}-${dd}`);
      setRescheduleTime(`${hh}:${min}`);
    } else {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      setRescheduleDate(`${yyyy}-${mm}-${dd}`);
      setRescheduleTime('14:00');
    }
  };

  const handleConfirmReschedule = async () => {
    if (!rescheduleTarget || !rescheduleDate || !rescheduleTime) return;
    try {
      setIsRescheduling(true);
      const targetDate = new Date(`${rescheduleDate}T${rescheduleTime}`);
      if (isNaN(targetDate.getTime())) {
        toast.error('Invalid date or time format');
        return;
      }
      await rescheduleQueueItem(rescheduleTarget.id, targetDate.toISOString());
      toast.success(
        `Call for ${rescheduleTarget.customer_name} rescheduled to ${targetDate.toLocaleDateString([], {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })} at ${targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      );
      setRescheduleTarget(null);
    } catch (err: any) {
      toast.error(err.message || 'Failed to reschedule call');
    } finally {
      setIsRescheduling(false);
    }
  };

  const resolveQueueOptions = useCallback((sourceId: string): FacetOption[] => {
    if (sourceId === 'jobTypes') {
      const types = Array.from(
        new Set(
          (queueItems || [])
            .map((item) => item.job_type || item.warranty_record?.job_type || 'General Service')
            .filter(Boolean)
        )
      );
      if (types.length === 0) return [{ value: 'General Service', label: 'General Service' }];
      return types.map((t) => ({ value: t, label: formatSnakeCase(t) }));
    }
    return [];
  }, [queueItems]);

  const resolveSkippedOptions = useCallback((sourceId: string): FacetOption[] => {
    if (sourceId === 'skippedJobTypes') {
      const types = Array.from(
        new Set(
          (skippedItems || [])
            .map((item) => item.job_type || item.warranty_record?.job_type || 'General Service')
            .filter(Boolean)
        )
      );
      if (types.length === 0) return [{ value: 'General Service', label: 'General Service' }];
      return types.map((t) => ({ value: t, label: formatSnakeCase(t) }));
    }
    return [];
  }, [skippedItems]);

  const hasActiveQueueFilters = useMemo(
    () => Object.values(queueFilterState).some((v) => facetSelectionCount(v) > 0),
    [queueFilterState],
  );

  const hasActiveSkippedFilters = useMemo(
    () => Object.values(skippedFilterState).some((v) => facetSelectionCount(v) > 0),
    [skippedFilterState],
  );

  // Filter queue items by search and FilterPopover facets
  const filteredQueueItems = useMemo(() => {
    return (queueItems || []).filter((item) => {
      // Search filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const custName = (item.customer_name || '').toLowerCase();
        const phone = (item.customer_phone || '').toLowerCase();
        const phoneFormatted = formatPhone(item.customer_phone).toLowerCase();
        const phoneDigits = (item.customer_phone || '').replace(/\D/g, '');
        const qDigits = q.replace(/\D/g, '');
        const jobNum = (item.job_number || item.job_id || '').toLowerCase();
        const address = (item.service_address || '').toLowerCase();
        const serviceReq = (
          item.service_request ||
          item.job_info?.service_request ||
          item.scope_notes ||
          ''
        ).toLowerCase();

        const phoneMatch =
          phone.includes(q) ||
          phoneFormatted.includes(q) ||
          (qDigits.length >= 3 && phoneDigits.includes(qDigits));

        if (
          !custName.includes(q) &&
          !phoneMatch &&
          !jobNum.includes(q) &&
          !address.includes(q) &&
          !serviceReq.includes(q)
        ) {
          return false;
        }
      }

      // Scheduled Date Range filter
      const dateFilter = queueFilterState.scheduled_date;
      if (dateFilter && dateFilter.kind === 'dateRange' && (dateFilter.from || dateFilter.to)) {
        const itemDateStr = item.scheduled_for || item.warranty_record?.warranty_end_date;
        if (!itemDateStr) return false;
        const itemDate = new Date(itemDateStr);
        if (isNaN(itemDate.getTime())) return false;

        if (dateFilter.from) {
          const fromDate = new Date(`${dateFilter.from}T00:00:00`);
          if (itemDate < fromDate) return false;
        }
        if (dateFilter.to) {
          const toDate = new Date(`${dateFilter.to}T23:59:59.999`);
          if (itemDate > toDate) return false;
        }
      }

      // Attempt filter
      const attemptVal = queueFilterState.attempt;
      if (attemptVal && attemptVal.kind === 'multi' && attemptVal.values.length > 0) {
        const is1st = item.attempt_count === 0;
        const isRetry = item.attempt_count > 0;
        const match =
          (attemptVal.values.includes('1st') && is1st) ||
          (attemptVal.values.includes('retries') && isRetry);
        if (!match) return false;
      }

      // Job Type filter
      const jobTypeVal = queueFilterState.job_type;
      if (jobTypeVal && jobTypeVal.kind === 'multi' && jobTypeVal.values.length > 0) {
        const itemJobType = item.job_type || item.warranty_record?.job_type || 'General Service';
        if (!jobTypeVal.values.includes(itemJobType)) return false;
      }

      // Schedule Status (Rescheduled) filter
      const reschedVal = queueFilterState.rescheduled;
      if (reschedVal && reschedVal.kind === 'multi' && reschedVal.values.length > 0) {
        const isResched = Boolean(item.is_rescheduled);
        const match =
          (reschedVal.values.includes('rescheduled') && isResched) ||
          (reschedVal.values.includes('original') && !isResched);
        if (!match) return false;
      }

      return true;
    });
  }, [queueItems, searchQuery, queueFilterState]);

  const totalPages = Math.max(1, Math.ceil(filteredQueueItems.length / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  // Filter skipped items
  const filteredSkippedItems = useMemo(() => {
    return (skippedItems || []).filter((item) => {
      if (skippedSearchQuery.trim()) {
        const q = skippedSearchQuery.toLowerCase().trim();
        const custName = (item.customer_name || '').toLowerCase();
        const phone = (item.customer_phone || '').toLowerCase();
        const phoneDigits = (item.customer_phone || '').replace(/\D/g, '');
        const qDigits = q.replace(/\D/g, '');
        const jobNum = (item.job_number || item.job_id || '').toLowerCase();
        const reason = (item.skip_reason || '').toLowerCase();
        const address = (item.service_address || '').toLowerCase();

        const phoneMatch = phone.includes(q) || (qDigits.length >= 3 && phoneDigits.includes(qDigits));

        if (!custName.includes(q) && !phoneMatch && !jobNum.includes(q) && !reason.includes(q) && !address.includes(q)) {
          return false;
        }
      }

      // Skipped Date Range filter
      const dateFilter = skippedFilterState.scheduled_date;
      if (dateFilter && dateFilter.kind === 'dateRange' && (dateFilter.from || dateFilter.to)) {
        const itemDateStr = item.scheduled_for || item.warranty_record?.warranty_end_date;
        if (!itemDateStr) return false;
        const itemDate = new Date(itemDateStr);
        if (isNaN(itemDate.getTime())) return false;

        if (dateFilter.from) {
          const fromDate = new Date(`${dateFilter.from}T00:00:00`);
          if (itemDate < fromDate) return false;
        }
        if (dateFilter.to) {
          const toDate = new Date(`${dateFilter.to}T23:59:59.999`);
          if (itemDate > toDate) return false;
        }
      }

      // Skip reason filter
      const reasonVal = skippedFilterState.skip_reason;
      if (reasonVal && reasonVal.kind === 'multi' && reasonVal.values.length > 0) {
        const lower = (item.skip_reason || '').toLowerCase();
        const isJobTypeDisabled = lower.includes('job type disabled');
        const isDnc = lower.includes('do not call');
        const isOther = !isJobTypeDisabled && !isDnc;

        const match =
          (reasonVal.values.includes('job_type_disabled') && isJobTypeDisabled) ||
          (reasonVal.values.includes('dnc') && isDnc) ||
          (reasonVal.values.includes('other') && isOther);
        if (!match) return false;
      }

      // Job Type filter
      const jobTypeVal = skippedFilterState.job_type;
      if (jobTypeVal && jobTypeVal.kind === 'multi' && jobTypeVal.values.length > 0) {
        const itemJobType = item.job_type || item.warranty_record?.job_type || 'General Service';
        if (!jobTypeVal.values.includes(itemJobType)) return false;
      }

      return true;
    });
  }, [skippedItems, skippedSearchQuery, skippedFilterState]);

  const skippedTotalPages = Math.max(1, Math.ceil(filteredSkippedItems.length / skippedPageSize));
  const safeSkippedPage = Math.min(Math.max(1, skippedPage), skippedTotalPages);

  // Queue Table Columns
  const queueColumns = useMemo<ColumnDef<BeeQueueItem>[]>(() => [
    {
      id: 'scheduled_time',
      accessorKey: 'scheduled_for',
      header: 'Scheduled Time',
      size: 175,
      minSize: 150,
      meta: { label: 'Scheduled Time', pinned: true },
      cell: ({ row }) => {
        const item = row.original;
        const {
          formattedDateTime,
          badgeLabel,
          userTimezone,
          customerTimezone,
          customerFormattedDateTime,
        } = formatQueueScheduledTime(item);

        return (
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span
              className="text-text-primary font-medium text-xs cursor-default"
              title={`Your time: ${formattedDateTime} (${userTimezone})${
                customerFormattedDateTime
                  ? `\nCustomer time: ${customerFormattedDateTime} (${customerTimezone})`
                  : ''
              }${badgeLabel ? ` · ${badgeLabel}` : ''}`}
            >
              {formattedDateTime}
            </span>
            {item.is_rescheduled && (
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-800 border border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800 shrink-0"
                title={
                  item.original_scheduled_for
                    ? `Originally: ${new Date(item.original_scheduled_for).toLocaleDateString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                        timeZone: userTimezone,
                      }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase())}`
                    : 'Manually rescheduled'
                }
              >
                Rescheduled
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: 'customer_name',
      accessorKey: 'customer_name',
      header: 'Customer Name',
      size: 190,
      minSize: 150,
      meta: { label: 'Customer Name', pinned: true },
      cell: ({ row }) => {
        const item = row.original;
        const customerId = item.customer_id || item.warranty_record?.customer_id;
        return (
          <div className="flex flex-col">
            <span
              onClick={(e) => {
                e.stopPropagation();
                if (customerId) navigate(`/customers/${customerId}`);
              }}
              className={`font-bold truncate ${
                customerId ? 'text-primary hover:underline cursor-pointer' : 'text-text-primary'
              }`}
              title={customerId ? 'Go to customer page' : undefined}
            >
              {item.customer_name}
            </span>
            {item.service_address && (
              <span className="text-[11px] text-text-secondary truncate" title={item.service_address}>
                {item.service_address}
              </span>
            )}
          </div>
        );
      },
    },
    {
      id: 'customer_phone',
      accessorKey: 'customer_phone',
      header: 'Phone Number',
      size: 140,
      minSize: 120,
      meta: { label: 'Phone Number' },
      cell: ({ row }) => (
        <span className="font-mono text-text-secondary whitespace-nowrap">
          {formatPhone(row.original.customer_phone) || '-'}
        </span>
      ),
    },
    {
      id: 'job_number',
      accessorKey: 'job_number',
      header: 'Job #',
      size: 110,
      minSize: 90,
      meta: { label: 'Job #' },
      cell: ({ row }) => {
        const item = row.original;
        const jobId = item.job_id || item.warranty_record?.job_id;
        const rawJobLabel = item.job_number || (jobId ? jobId.slice(0, 8) : '-');
        const jobLabel = rawJobLabel.replace(/^#/, '');
        return (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (jobId) navigate(`/jobs/${jobId}`);
            }}
            className={`font-medium whitespace-nowrap ${
              jobId ? 'text-primary hover:underline cursor-pointer' : 'text-text-secondary'
            }`}
            title={jobId ? 'Go to job page' : undefined}
          >
            {jobLabel}
          </span>
        );
      },
    },
    {
      id: 'job_type',
      accessorKey: 'job_type',
      header: 'Job Type',
      size: 140,
      minSize: 110,
      meta: { label: 'Job Type' },
      cell: ({ row }) => {
        const item = row.original;
        const jobType = item.job_type || item.warranty_record?.job_type || 'General Service';
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border border-border text-text-secondary whitespace-nowrap">
            {formatSnakeCase(jobType)}
          </span>
        );
      },
    },
    {
      id: 'service_request',
      accessorKey: 'service_request',
      header: 'Service Request',
      size: 220,
      minSize: 160,
      meta: { label: 'Service Request' },
      cell: ({ row }) => {
        const item = row.original;
        const serviceRequest =
          item.service_request ||
          item.job_info?.service_request ||
          item.scope_notes ||
          item.job_info?.line_items_summary ||
          '-';
        return (
          <span className="truncate block max-w-[280px] text-text-primary font-medium" title={serviceRequest}>
            {serviceRequest}
          </span>
        );
      },
    },
    {
      id: 'warranty_started_on',
      accessorKey: 'warranty_started_on',
      header: 'Warranty Started On',
      size: 165,
      minSize: 135,
      meta: { label: 'Warranty Started On' },
      cell: ({ row }) => {
        const item = row.original;
        const origin = item.warranty_started_on === 'Invoice Sent' ? 'Invoice Sent' : 'Job Complete';
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border border-border bg-surface-light text-text-primary whitespace-nowrap">
            {origin}
          </span>
        );
      },
    },
    {
      id: 'warranty_expiry',
      accessorKey: 'warranty_expiry',
      header: 'Warranty Expiry',
      size: 140,
      minSize: 110,
      meta: { label: 'Warranty Expiry' },
      cell: ({ row }) => {
        const item = row.original;
        const expiry = item.warranty_record?.warranty_end_date;
        return (
          <span className="text-text-secondary whitespace-nowrap">
            {expiry
              ? new Date(expiry).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : 'Within 30 Days'}
          </span>
        );
      },
    },
    {
      id: 'attempt',
      accessorKey: 'attempt_count',
      header: 'Attempt',
      size: 100,
      minSize: 85,
      meta: { label: 'Attempt' },
      cell: ({ row }) => {
        const item = row.original;
        return item.attempt_count === 0 ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-info-surface text-info-text border border-info-border whitespace-nowrap">
            1st Dial
          </span>
        ) : (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-warning-surface text-warning-text border border-warning-border whitespace-nowrap">
            Retry #{item.attempt_count + 1}
          </span>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      size: 320,
      minSize: 310,
      enableResizing: false,
      enableHiding: false,
      meta: { label: 'Actions', fixed: true },
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="flex items-center justify-end gap-1.5 whitespace-nowrap shrink-0" onClick={(e) => e.stopPropagation()}>
            <Button
              size="sm"
              className="h-7 px-2.5 text-xs gap-1 shrink-0 cursor-pointer"
              onClick={() => handleCallNow(item.id)}
              disabled={actingId === item.id}
            >
              <PhoneForwarded className="h-3 w-3" />
              Call Now
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs gap-1 shrink-0 cursor-pointer"
              onClick={() => handleOpenReschedule(item)}
              disabled={actingId === item.id}
              title="Manually reschedule call time"
            >
              <Clock className="h-3 w-3" />
              Reschedule
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-xs gap-1 shrink-0 cursor-pointer"
              onClick={() => handleSkip(item.id)}
              disabled={actingId === item.id}
            >
              <SkipForward className="h-3 w-3" />
              Skip
            </Button>
          </div>
        );
      },
    },
  ], [navigate, actingId]);

  // Skipped Jobs Columns
  const skippedColumns = useMemo<ColumnDef<BeeQueueItem>[]>(() => [
    {
      id: 'customer_name',
      accessorKey: 'customer_name',
      header: 'Customer Name',
      size: 190,
      minSize: 150,
      meta: { label: 'Customer Name', pinned: true },
      cell: ({ row }) => {
        const item = row.original;
        const customerId = item.customer_id || item.warranty_record?.customer_id;
        return (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (customerId) navigate(`/customers/${customerId}`);
            }}
            className={`font-bold whitespace-nowrap ${
              customerId
                ? 'text-text-primary hover:text-primary hover:underline cursor-pointer'
                : 'text-text-primary'
            }`}
            title={customerId ? 'Go to customer page' : undefined}
          >
            {item.customer_name}
          </span>
        );
      },
    },
    {
      id: 'customer_phone',
      accessorKey: 'customer_phone',
      header: 'Phone Number',
      size: 140,
      minSize: 120,
      meta: { label: 'Phone Number' },
      cell: ({ row }) => (
        <span className="font-mono text-text-secondary whitespace-nowrap">
          {formatPhone(row.original.customer_phone) || '-'}
        </span>
      ),
    },
    {
      id: 'job_number',
      accessorKey: 'job_number',
      header: 'Job #',
      size: 110,
      minSize: 90,
      meta: { label: 'Job #' },
      cell: ({ row }) => {
        const item = row.original;
        const jobId = item.job_id || item.warranty_record?.job_id;
        const rawJobLabel = item.job_number || (jobId ? jobId.slice(0, 8) : '-');
        const jobLabel = rawJobLabel.replace(/^#/, '');
        return (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (jobId) navigate(`/jobs/${jobId}`);
            }}
            className={`font-medium whitespace-nowrap ${
              jobId
                ? 'text-primary hover:text-primary hover:underline cursor-pointer'
                : 'text-text-secondary'
            }`}
            title={jobId ? 'Go to job page' : undefined}
          >
            {jobLabel}
          </span>
        );
      },
    },
    {
      id: 'job_type',
      accessorKey: 'job_type',
      header: 'Job Type',
      size: 140,
      minSize: 110,
      meta: { label: 'Job Type' },
      cell: ({ row }) => {
        const item = row.original;
        const jobType = item.job_type || item.warranty_record?.job_type || 'General Service';
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border border-border text-text-secondary whitespace-nowrap">
            {formatSnakeCase(jobType)}
          </span>
        );
      },
    },
    {
      id: 'skip_reason',
      accessorKey: 'skip_reason',
      header: 'Skip Reason',
      size: 180,
      minSize: 140,
      meta: { label: 'Skip Reason' },
      cell: ({ row }) => {
        const item = row.original;
        const skipReason = item.skip_reason || 'Job type disabled';
        const isJobTypeDisabled = skipReason.toLowerCase().includes('job type disabled');
        return (
          <span
            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${
              isJobTypeDisabled
                ? 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900'
                : 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900'
            }`}
          >
            {isJobTypeDisabled ? (
              <AlertTriangle className="h-3 w-3 shrink-0" />
            ) : (
              <Ban className="h-3 w-3 shrink-0" />
            )}
            {formatSnakeCase(skipReason)}
          </span>
        );
      },
    },
    {
      id: 'service_request',
      accessorKey: 'service_request',
      header: 'Service Request',
      size: 220,
      minSize: 160,
      meta: { label: 'Service Request' },
      cell: ({ row }) => {
        const item = row.original;
        const serviceRequest =
          item.service_request ||
          item.job_info?.service_request ||
          item.scope_notes ||
          item.job_info?.line_items_summary ||
          '-';
        return (
          <div className="truncate text-text-primary font-medium max-w-[220px]" title={serviceRequest}>
            {serviceRequest}
          </div>
        );
      },
    },
    {
      id: 'warranty_expiry',
      accessorKey: 'warranty_expiry',
      header: 'Warranty Expiry',
      size: 140,
      minSize: 110,
      meta: { label: 'Warranty Expiry' },
      cell: ({ row }) => {
        const item = row.original;
        return (
          <span className="text-text-secondary whitespace-nowrap">
            {item.warranty_record?.warranty_end_date
              ? new Date(item.warranty_record.warranty_end_date).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : '-'}
          </span>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      size: 130,
      minSize: 110,
      enableResizing: false,
      enableHiding: false,
      meta: { label: 'Actions', fixed: true },
      cell: ({ row }) => {
        const item = row.original;
        return (
          <div className="flex items-center justify-end" onClick={(e) => e.stopPropagation()}>
            <Button
              size="sm"
              className="h-7 px-2.5 text-xs gap-1 shrink-0 cursor-pointer"
              onClick={() => handleCallNow(item.id)}
              disabled={actingId === item.id}
              title="Manually trigger call for this skipped job"
            >
              <PhoneForwarded className="h-3 w-3" />
              Call Now
            </Button>
          </div>
        );
      },
    },
  ], [navigate, actingId]);

  return (
    <div className="space-y-4">
      {/* Queue Header Summary */}
      <div className="flex items-center justify-between">
        <div>
          <Heading level={3} scale="sm" className="font-bold flex items-center gap-2 text-text-primary">
            <ListOrdered className="h-4 w-4 text-brand" />
            Outbound Call Queue ({queueItems.length})
          </Heading>
          <p className="text-xs text-text-secondary mt-0.5">
            Customers queued for warranty renewal calls within the active TCPA window. Once answered, customers are permanently removed from the retry queue.
          </p>
        </div>
      </div>

      {/* Main Queue DataTable */}
      <div ref={queueContainerRef} className="relative">
        <BeeTableScrollFades
          containerRef={queueContainerRef}
          stickyColId="customer_name"
          hasStickyCol={Boolean(visibleColumns['customer_name'] || visibleColumns['scheduled_time'])}
        />
        <DataTable
          columns={queueColumns}
          data={filteredQueueItems}
          getRowId={(item) => item.id}
          page={safeCurrentPage}
          pageCount={totalPages}
          onPageChange={setCurrentPage}
          pageSize={pageSize}
          onPageSizeChange={(newSize) => {
            setPageSize(newSize);
            setCurrentPage(1);
          }}
          rowCount={filteredQueueItems.length}
          enableColumnResizing
          columnVisibility={visibleColumns}
          onColumnVisibilityChange={handleColumnVisibilityChange}
          empty={
            <div className="text-center py-12 text-text-secondary text-xs">
              {queueItems.length === 0
                ? 'The call queue is currently empty. Customers with expiring warranties will automatically appear here.'
                : 'No queue items match your filter criteria.'}
            </div>
          }
        >
          {(table) => (
            <>
              <div className="flex flex-wrap items-center gap-2.5 p-3.5 border-b border-border/80 bg-surface-light">
                <div className="relative w-[320px] max-w-full">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-text-secondary pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search customer, phone, job #, address..."
                    value={searchQuery}
                    onChange={(e) => {
                      setSearchQuery(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="w-full pl-9 pr-8 h-9 text-xs bg-surface-light border border-border rounded-lg text-text-primary placeholder:text-text-secondary focus:ring-1 focus:ring-primary focus:outline-none"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchQuery('');
                        setCurrentPage(1);
                      }}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary p-0.5 cursor-pointer"
                      title="Clear search"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="grow" />

                <div className="flex items-center gap-2">
                  <FilterPopover
                    registry={queueFilterRegistry}
                    value={queueFilterState}
                    onChange={(next) => {
                      setQueueFilterState(next);
                      setCurrentPage(1);
                    }}
                    resolveOptions={resolveQueueOptions}
                    resolveMax={() => 0}
                    statusDomain="lead"
                  />

                  {/* Columns Visibility Button with Hidden Count */}
                  <BeeTableColumnOptions
                    table={table}
                    storageKey={STORAGE_KEY_COLUMNS}
                    defaultVisibility={DEFAULT_VISIBLE_COLUMNS}
                    containerRef={queueContainerRef}
                    stickyColId="scheduled_time"
                  />
                </div>
              </div>

              {/* Applied Filter Chips bar */}
              {hasActiveQueueFilters && (
                <div className="px-4 py-2 border-b border-border/60 bg-muted/20">
                  <AppliedFilterBar
                    registry={queueFilterRegistry}
                    value={queueFilterState}
                    onChange={(next) => {
                      setQueueFilterState(next);
                      setCurrentPage(1);
                    }}
                    resolveOptions={resolveQueueOptions}
                    resultCount={filteredQueueItems.length}
                    totalCount={queueItems.length}
                  />
                </div>
              )}
            </>
          )}
        </DataTable>
      </div>

      {/* Skipped Jobs Section */}
      <div className="pt-6 space-y-4 border-t border-border/80">
        <div className="flex items-center justify-between">
          <div>
            <Heading level={3} scale="sm" className="font-bold flex items-center gap-2 text-text-primary">
              <Ban className="h-4 w-4 text-warning-text" />
              Skipped Jobs ({(skippedItems || []).length})
            </Heading>
            <p className="text-xs text-text-secondary mt-0.5">
              Jobs excluded from automated calls because their job type is disabled or the customer is on the Do Not Call list. You can manually call any skipped job below.
            </p>
          </div>
        </div>

        {/* Skipped Jobs DataTable */}
        <div ref={skippedContainerRef} className="relative">
          <BeeTableScrollFades
            containerRef={skippedContainerRef}
            stickyColId="customer_name"
            hasStickyCol={true}
          />
          <DataTable
            columns={skippedColumns}
            data={filteredSkippedItems}
            getRowId={(item) => item.id}
            page={safeSkippedPage}
            pageCount={skippedTotalPages}
            onPageChange={setSkippedPage}
            pageSize={skippedPageSize}
            onPageSizeChange={(newSize) => {
              setSkippedPageSize(newSize);
              setSkippedPage(1);
            }}
            rowCount={filteredSkippedItems.length}
            enableColumnResizing
            empty={
              <div className="text-center py-10 text-text-secondary text-xs">
                {(skippedItems || []).length === 0
                  ? 'No skipped jobs found. All completed jobs have enabled job types and eligible call status.'
                  : 'No skipped jobs match your filter criteria.'}
              </div>
            }
          >
            {() => (
              <>
                <div className="flex flex-wrap items-center gap-2.5 p-3.5 border-b border-border/80 bg-surface-light">
                  <div className="relative w-[320px] max-w-full">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-text-secondary pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search skipped customer, job #, reason..."
                      value={skippedSearchQuery}
                      onChange={(e) => {
                        setSkippedSearchQuery(e.target.value);
                        setSkippedPage(1);
                      }}
                      className="w-full pl-9 pr-8 h-9 text-xs bg-surface-light border border-border rounded-lg text-text-primary placeholder:text-text-secondary focus:ring-1 focus:ring-primary focus:outline-none"
                    />
                    {skippedSearchQuery && (
                      <button
                        type="button"
                        onClick={() => {
                          setSkippedSearchQuery('');
                          setSkippedPage(1);
                        }}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary p-0.5 cursor-pointer"
                        title="Clear search"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="grow" />

                  <div className="flex items-center gap-2">
                    <FilterPopover
                      registry={skippedFilterRegistry}
                      value={skippedFilterState}
                      onChange={(next) => {
                        setSkippedFilterState(next);
                        setSkippedPage(1);
                      }}
                      resolveOptions={resolveSkippedOptions}
                      resolveMax={() => 0}
                      statusDomain="lead"
                    />
                  </div>
                </div>

                {/* Applied Filter Chips bar for Skipped Jobs */}
                {hasActiveSkippedFilters && (
                  <div className="px-4 py-2 border-b border-border/60 bg-muted/20">
                    <AppliedFilterBar
                      registry={skippedFilterRegistry}
                      value={skippedFilterState}
                      onChange={(next) => {
                        setSkippedFilterState(next);
                        setSkippedPage(1);
                      }}
                      resolveOptions={resolveSkippedOptions}
                      resultCount={filteredSkippedItems.length}
                      totalCount={(skippedItems || []).length}
                    />
                  </div>
                )}
              </>
            )}
          </DataTable>
        </div>
      </div>

      {/* Manual Reschedule Modal */}
      <Dialog open={Boolean(rescheduleTarget)} onOpenChange={(open) => !open && setRescheduleTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />
              Reschedule Outbound Warranty Call
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Select a new date and time for Bee to call {rescheduleTarget?.customer_name}.
            </DialogDescription>
          </DialogHeader>

          {rescheduleTarget && (
            <div className="space-y-4 py-2 text-xs">
              <div className="p-3 bg-muted/40 rounded-xl border border-border/80 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Customer:</span>
                  <span className="font-semibold text-foreground">{rescheduleTarget.customer_name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Phone Number:</span>
                  <span className="font-mono text-foreground">{formatPhone(rescheduleTarget.customer_phone) || '-'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Warranty Started On:</span>
                  <span className="font-medium text-foreground">
                    {rescheduleTarget.warranty_started_on === 'Invoice Sent' ? 'Invoice Sent' : 'Job Complete'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Current Schedule:</span>
                  <span className="font-medium text-foreground">
                    {new Date(rescheduleTarget.scheduled_for).toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                      hour12: true,
                    }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase())}
                  </span>
                </div>
                {rescheduleTarget.is_rescheduled && rescheduleTarget.original_scheduled_for && (
                  <div className="flex justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/50">
                    <span>Original Schedule:</span>
                    <span className="font-medium">
                      {new Date(rescheduleTarget.original_scheduled_for).toLocaleDateString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true,
                      }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase())}
                    </span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">New Call Date</Label>
                  <Input
                    type="date"
                    value={rescheduleDate}
                    onChange={(e) => setRescheduleDate(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">New Call Time</Label>
                  <Input
                    type="time"
                    value={rescheduleTime}
                    onChange={(e) => setRescheduleTime(e.target.value)}
                    className="h-8 text-xs font-mono"
                  />
                </div>
              </div>

              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Bee will call at the rescheduled time within your configured calling window. The job's original warranty start calculation is preserved.
              </p>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRescheduleTarget(null)}
              disabled={isRescheduling}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleConfirmReschedule}
              disabled={isRescheduling || !rescheduleDate || !rescheduleTime}
              className="gap-1.5"
            >
              {isRescheduling ? 'Rescheduling...' : 'Save New Schedule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
