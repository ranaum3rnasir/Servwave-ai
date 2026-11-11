import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { useBeeStore } from '@/stores/beeStore';
import { BeeQueueItem } from '@/lib/api/bee';
import {
  Ban,
  PhoneForwarded,
  Search,
  X,
  AlertTriangle,
  Clock,
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
import { BeeTableScrollFades } from '../components/BeeTableScrollFades';
import { FilterPopover, facetSelectionCount } from '@/pages/v2/_shared/filterPopover';
import { AppliedFilterBar } from '@/pages/v2/_shared/appliedFilters';
import type { FacetConfig, FacetOption, FilterState } from '@/lib/filters/types';

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
      { value: 'customer_tag', label: 'Customer to Skip Tag' },
      { value: 'min_amount', label: 'Job Below Minimum Amount' },
      { value: 'dnc', label: 'Do Not Call (DNC)' },
      { value: 'job_type_disabled', label: 'Job Type Disabled' },
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

export const archivedFilterRegistry: FacetConfig[] = [
  {
    key: 'scheduled_date',
    kind: 'dateRange',
    param: 'scheduled_date',
    label: 'Date',
    icon: 'M8 2v4 M16 2v4 M5 4H19A2 2 0 0 1 21 6V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V6A2 2 0 0 1 5 4Z M3 10h18',
  },
  {
    key: 'attempts',
    kind: 'multi',
    param: 'attempts',
    label: 'Dials Made',
    icon: 'M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    options: [
      { value: '2', label: '2 Dials' },
      { value: '3', label: '3 Dials' },
      { value: '4_plus', label: '4+ Dials' },
    ],
  },
  {
    key: 'job_type',
    kind: 'multi',
    param: 'job_type',
    label: 'Job Type',
    icon: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z',
    optionSource: 'archivedJobTypes',
  },
];

export const BeeSkippedArchivedTab: React.FC = () => {
  const navigate = useNavigate();
  const { skippedItems, archivedItems, loadQueue, callNow, rescheduleQueueItem } = useBeeStore();
  const [actingId, setActingId] = useState<string | null>(null);

  // Toggle between 'skipped' and 'archived'
  const [subView, setSubView] = useState<'skipped' | 'archived'>('skipped');

  // Manual Reschedule state
  const [rescheduleTarget, setRescheduleTarget] = useState<BeeQueueItem | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('');
  const [isRescheduling, setIsRescheduling] = useState(false);

  // Filters and Pagination for Skipped Jobs
  const [skippedSearchQuery, setSkippedSearchQuery] = useState('');
  const [skippedFilterState, setSkippedFilterState] = useState<FilterState>({});
  const [skippedPage, setSkippedPage] = useState(1);
  const [skippedPageSize, setSkippedPageSize] = useState(25);

  // Filters and Pagination for Archived Jobs
  const [archivedSearchQuery, setArchivedSearchQuery] = useState('');
  const [archivedFilterState, setArchivedFilterState] = useState<FilterState>({});
  const [archivedPage, setArchivedPage] = useState(1);
  const [archivedPageSize, setArchivedPageSize] = useState(25);

  const skippedContainerRef = useRef<HTMLDivElement>(null);
  const archivedContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadQueue();

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

  const resolveArchivedOptions = useCallback((sourceId: string): FacetOption[] => {
    if (sourceId === 'archivedJobTypes') {
      const types = Array.from(
        new Set(
          (archivedItems || [])
            .map((item) => item.job_type || item.warranty_record?.job_type || 'General Service')
            .filter(Boolean)
        )
      );
      if (types.length === 0) return [{ value: 'General Service', label: 'General Service' }];
      return types.map((t) => ({ value: t, label: formatSnakeCase(t) }));
    }
    return [];
  }, [archivedItems]);

  const hasActiveSkippedFilters = useMemo(
    () => Object.values(skippedFilterState).some((v) => facetSelectionCount(v) > 0),
    [skippedFilterState],
  );

  const hasActiveArchivedFilters = useMemo(
    () => Object.values(archivedFilterState).some((v) => facetSelectionCount(v) > 0),
    [archivedFilterState],
  );

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
        const isCustTag = lower.includes('tag');
        const isBelowMin = lower.includes('minimum') || lower.includes('amount') || lower.includes('below');
        const isDnc = lower.includes('do not call') || lower.includes('dnc');
        const isJobTypeDisabled = lower.includes('disabled');

        const match =
          (reasonVal.values.includes('customer_tag') && isCustTag) ||
          (reasonVal.values.includes('min_amount') && isBelowMin) ||
          (reasonVal.values.includes('dnc') && isDnc) ||
          (reasonVal.values.includes('job_type_disabled') && isJobTypeDisabled);
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

  // Filter archived items
  const filteredArchivedItems = useMemo(() => {
    return (archivedItems || []).filter((item) => {
      if (archivedSearchQuery.trim()) {
        const q = archivedSearchQuery.toLowerCase().trim();
        const custName = (item.customer_name || '').toLowerCase();
        const phone = (item.customer_phone || '').toLowerCase();
        const phoneDigits = (item.customer_phone || '').replace(/\D/g, '');
        const qDigits = q.replace(/\D/g, '');
        const jobNum = (item.job_number || item.job_id || '').toLowerCase();
        const address = (item.service_address || '').toLowerCase();

        const phoneMatch = phone.includes(q) || (qDigits.length >= 3 && phoneDigits.includes(qDigits));

        if (!custName.includes(q) && !phoneMatch && !jobNum.includes(q) && !address.includes(q)) {
          return false;
        }
      }

      // Archived Date Range filter
      const dateFilter = archivedFilterState.scheduled_date;
      if (dateFilter && dateFilter.kind === 'dateRange' && (dateFilter.from || dateFilter.to)) {
        const itemDateStr = item.archived_at || item.last_attempted_at || item.scheduled_for;
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

      // Attempts filter
      const attemptVal = archivedFilterState.attempts;
      if (attemptVal && attemptVal.kind === 'multi' && attemptVal.values.length > 0) {
        const count = item.attempt_count || 0;
        const match =
          (attemptVal.values.includes('2') && count === 2) ||
          (attemptVal.values.includes('3') && count === 3) ||
          (attemptVal.values.includes('4_plus') && count >= 4);
        if (!match) return false;
      }

      // Job Type filter
      const jobTypeVal = archivedFilterState.job_type;
      if (jobTypeVal && jobTypeVal.kind === 'multi' && jobTypeVal.values.length > 0) {
        const itemJobType = item.job_type || item.warranty_record?.job_type || 'General Service';
        if (!jobTypeVal.values.includes(itemJobType)) return false;
      }

      return true;
    });
  }, [archivedItems, archivedSearchQuery, archivedFilterState]);

  const archivedTotalPages = Math.max(1, Math.ceil(filteredArchivedItems.length / archivedPageSize));
  const safeArchivedPage = Math.min(Math.max(1, archivedPage), archivedTotalPages);

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
      id: 'total_amount',
      accessorKey: 'total_amount',
      header: 'Job Amount',
      size: 110,
      minSize: 90,
      meta: { label: 'Job Amount' },
      cell: ({ row }) => {
        const amount = row.original.total_amount;
        return (
          <span className="font-mono text-xs text-text-primary whitespace-nowrap">
            {amount !== undefined && amount !== null && amount > 0
              ? `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : '-'}
          </span>
        );
      },
    },
    {
      id: 'skip_reason',
      accessorKey: 'skip_reason',
      header: 'Skip Reason',
      size: 260,
      minSize: 180,
      meta: { label: 'Skip Reason' },
      cell: ({ row }) => {
        const item = row.original;
        const skipReasonRaw = item.skip_reason || 'Job Type Disabled';
        const reasonsList = skipReasonRaw.split(',').map((s) => s.trim()).filter(Boolean);

        return (
          <div className="flex flex-wrap items-center gap-1.5 py-0.5">
            {reasonsList.map((reason, idx) => {
              const lower = reason.toLowerCase();
              const isCustTag = lower.includes('tag');
              const isBelowMin = lower.includes('minimum') || lower.includes('amount') || lower.includes('below');
              const isDnc = lower.includes('dnc') || lower.includes('not call');
              const isTypeDisabled = lower.includes('disabled');

              let badgeClass = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900';
              let Icon = AlertTriangle;

              if (isCustTag) {
                badgeClass = 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-900';
              } else if (isBelowMin) {
                badgeClass = 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-900';
              } else if (isDnc) {
                badgeClass = 'bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900';
                Icon = Ban;
              } else if (isTypeDisabled) {
                badgeClass = 'bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800';
                Icon = Ban;
              }

              return (
                <span
                  key={idx}
                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap ${badgeClass}`}
                >
                  <Icon className="h-3 w-3 shrink-0" />
                  {reason}
                </span>
              );
            })}
          </div>
        );
      },
    },
    {
      id: 'service_request',
      accessorKey: 'service_request',
      header: 'Service Request',
      size: 200,
      minSize: 150,
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
          <div className="truncate text-text-primary font-medium max-w-[200px]" title={serviceRequest}>
            {serviceRequest}
          </div>
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

  // Archived Jobs Columns
  const archivedColumns = useMemo<ColumnDef<BeeQueueItem>[]>(() => [
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
      id: 'total_amount',
      accessorKey: 'total_amount',
      header: 'Job Amount',
      size: 110,
      minSize: 90,
      meta: { label: 'Job Amount' },
      cell: ({ row }) => {
        const amount = row.original.total_amount;
        return (
          <span className="font-mono text-xs text-text-primary whitespace-nowrap">
            {amount !== undefined && amount !== null && amount > 0
              ? `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : '-'}
          </span>
        );
      },
    },
    {
      id: 'attempts',
      accessorKey: 'attempt_count',
      header: 'Retry Attempts',
      size: 140,
      minSize: 120,
      meta: { label: 'Retry Attempts' },
      cell: ({ row }) => {
        const item = row.original;
        const count = item.attempt_count || 0;
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-900">
            <Clock className="h-3 w-3 shrink-0" />
            {count} {count === 1 ? 'dial' : 'dials'} made
          </span>
        );
      },
    },
    {
      id: 'archive_reason',
      header: 'Archive Reason',
      size: 170,
      minSize: 150,
      meta: { label: 'Archive Reason' },
      cell: () => (
        <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold border whitespace-nowrap bg-rose-50 text-rose-800 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-900">
          <Ban className="h-3 w-3 shrink-0" />
          Retry limit reached
        </span>
      ),
    },
    {
      id: 'archived_at',
      accessorKey: 'archived_at',
      header: 'Archived At',
      size: 160,
      minSize: 140,
      meta: { label: 'Archived At' },
      cell: ({ row }) => {
        const item = row.original;
        const ts = item.archived_at || item.last_attempted_at || item.updated_at || item.scheduled_for;
        if (!ts) return <span className="text-text-secondary text-xs">-</span>;
        const d = new Date(ts);
        if (isNaN(d.getTime())) return <span className="text-text-secondary text-xs">-</span>;
        return (
          <span className="text-xs text-text-secondary whitespace-nowrap">
            {d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}{' '}
            {d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </span>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      size: 220,
      minSize: 200,
      enableResizing: false,
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
              title="Reschedule into active queue"
            >
              <Clock className="h-3 w-3" />
              Reschedule
            </Button>
          </div>
        );
      },
    },
  ], [navigate, actingId]);

  return (
    <div className="space-y-4">
      {/* Table Heading (Info about current table) & Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        {subView === 'skipped' ? (
          <div>
            <Heading level={3} scale="sm" className="font-bold flex items-center gap-2 text-text-primary">
              <Ban className="h-4 w-4 text-warning-text" />
              Skipped Jobs ({(skippedItems || []).length})
            </Heading>
            <p className="text-xs text-text-secondary mt-0.5">
              Jobs excluded from call processing due to eligibility conditions (Customer to Skip Tag, below minimum amount, DNC list, or disabled job type). Operators can manually call any skipped job.
            </p>
          </div>
        ) : (
          <div>
            <Heading level={3} scale="sm" className="font-bold flex items-center gap-2 text-text-primary">
              <Clock className="h-4 w-4 text-rose-500" />
              Archived Jobs ({(archivedItems || []).length})
            </Heading>
            <p className="text-xs text-text-secondary mt-0.5">
              Jobs that permanently stopped receiving automated calls after reaching their configured retry limit. Operators can review retry history or manually re-trigger a call.
            </p>
          </div>
        )}

        <div className="flex items-center bg-muted/60 p-1 rounded-lg border border-border/60 self-start sm:self-auto shrink-0">
          <button
            type="button"
            onClick={() => setSubView('skipped')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer ${
              subView === 'skipped'
                ? 'bg-surface-light text-text-primary shadow-xs font-semibold'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Skipped Jobs ({(skippedItems || []).length})
          </button>
          <button
            type="button"
            onClick={() => setSubView('archived')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer ${
              subView === 'archived'
                ? 'bg-surface-light text-text-primary shadow-xs font-semibold'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Archived Jobs ({(archivedItems || []).length})
          </button>
        </div>
      </div>

      {/* 1. Skipped Jobs Table */}
      {subView === 'skipped' && (
        <div className="space-y-3">
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
      )}

      {/* 2. Archived Jobs Table */}
      {subView === 'archived' && (
        <div className="space-y-3">
          <div ref={archivedContainerRef} className="relative">
            <BeeTableScrollFades
              containerRef={archivedContainerRef}
              stickyColId="customer_name"
              hasStickyCol={true}
            />
            <DataTable
              columns={archivedColumns}
              data={filteredArchivedItems}
              getRowId={(item) => item.id}
              page={safeArchivedPage}
              pageCount={archivedTotalPages}
              onPageChange={setArchivedPage}
              pageSize={archivedPageSize}
              onPageSizeChange={(newSize) => {
                setArchivedPageSize(newSize);
                setArchivedPage(1);
              }}
              rowCount={filteredArchivedItems.length}
              enableColumnResizing
              empty={
                <div className="text-center py-10 text-text-secondary text-xs">
                  {(archivedItems || []).length === 0
                    ? 'No archived jobs found. Jobs that exhaust their retry attempts will appear here.'
                    : 'No archived jobs match your filter criteria.'}
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
                        placeholder="Search archived customer, phone, job #..."
                        value={archivedSearchQuery}
                        onChange={(e) => {
                          setArchivedSearchQuery(e.target.value);
                          setArchivedPage(1);
                        }}
                        className="w-full pl-9 pr-8 h-9 text-xs bg-surface-light border border-border rounded-lg text-text-primary placeholder:text-text-secondary focus:ring-1 focus:ring-primary focus:outline-none"
                      />
                      {archivedSearchQuery && (
                        <button
                          type="button"
                          onClick={() => {
                            setArchivedSearchQuery('');
                            setArchivedPage(1);
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
                        registry={archivedFilterRegistry}
                        value={archivedFilterState}
                        onChange={(next) => {
                          setArchivedFilterState(next);
                          setArchivedPage(1);
                        }}
                        resolveOptions={resolveArchivedOptions}
                        resolveMax={() => 0}
                        statusDomain="lead"
                      />
                    </div>
                  </div>

                  {hasActiveArchivedFilters && (
                    <div className="px-4 py-2 border-b border-border/60 bg-muted/20">
                      <AppliedFilterBar
                        registry={archivedFilterRegistry}
                        value={archivedFilterState}
                        onChange={(next) => {
                          setArchivedFilterState(next);
                          setArchivedPage(1);
                        }}
                        resolveOptions={resolveArchivedOptions}
                        resultCount={filteredArchivedItems.length}
                        totalCount={(archivedItems || []).length}
                      />
                    </div>
                  )}
                </>
              )}
            </DataTable>
          </div>
        </div>
      )}

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
