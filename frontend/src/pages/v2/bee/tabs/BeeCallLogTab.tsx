import React, { useState, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ColumnDef, VisibilityState } from '@tanstack/react-table';
import { useBeeStore } from '@/stores/beeStore';
import { BeeCallLogItem } from '@/lib/api/bee';
import { Search, Download, Play, X } from 'lucide-react';
import { toast } from 'sonner';
import { exportCsvFile } from '@/lib/csv';
import { formatPhone, formatSnakeCase } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { BeeTableColumnOptions } from '../components/BeeTableColumnOptions';
import { BeeTableScrollFades } from '../components/BeeTableScrollFades';
import { FilterPopover, facetSelectionCount } from '@/pages/v2/_shared/filterPopover';
import { AppliedFilterBar } from '@/pages/v2/_shared/appliedFilters';
import type { FacetConfig, FacetOption, FilterState } from '@/lib/filters/types';

export const callLogFilterRegistry: FacetConfig[] = [
  {
    key: 'date',
    kind: 'dateRange',
    param: 'date',
    label: 'Date & Time',
    icon: 'M8 2v4 M16 2v4 M5 4H19A2 2 0 0 1 21 6V20A2 2 0 0 1 19 22H5A2 2 0 0 1 3 20V6A2 2 0 0 1 5 4Z M3 10h18',
  },
  {
    key: 'outcome',
    kind: 'multi',
    param: 'outcome',
    label: 'Outcome',
    icon: 'M21.801 10A10 10 0 1 1 17 3.335 M9 11 3 3L22 4',
    options: [
      { value: 'ANSWERED', label: 'Answered' },
      { value: 'NO_ANSWER', label: 'No answer / Machine' },
      { value: 'FAILED', label: 'Technical failure' },
      { value: 'WRONG_NUMBER', label: 'Wrong number' },
      { value: 'NEEDS_REVIEW', label: 'Needs review' },
      { value: 'INTERESTED_WARRANTY', label: 'Warranty plan' },
      { value: 'INTERESTED_NEW_WORK', label: 'New Job' },
      { value: 'human', label: 'Needs a human / Complaint' },
      { value: 'none', label: 'Not interested / DNC' },
    ],
  },
  {
    key: 'agent',
    kind: 'multi',
    param: 'agent',
    label: 'Agent',
    icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3.128a4 4 0 0 1 0 7.744 M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
    optionSource: 'agents',
  },
  {
    key: 'attempt',
    kind: 'multi',
    param: 'attempt',
    label: 'Attempt',
    icon: 'M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    options: [
      { value: '1', label: 'Attempt 1' },
      { value: '2', label: 'Attempt 2' },
      { value: '3', label: 'Attempt 3' },
    ],
  },
  {
    key: 'sentiment',
    kind: 'multi',
    param: 'sentiment',
    label: 'Sentiment',
    icon: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm-3-9a1.5 1.5 0 1 0 1.5-1.5A1.5 1.5 0 0 0 9 11zm6 0a1.5 1.5 0 1 0 1.5-1.5A1.5 1.5 0 0 0 15 11zm-6.5 4.5a5 5 0 0 0 7 0',
    options: [
      { value: 'positive', label: 'Positive' },
      { value: 'neutral', label: 'Neutral' },
      { value: 'negative', label: 'Negative' },
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
];

const OUTCOME_PRIORITY: Record<string, number> = {
  COMPLAINT: 1,
  HANDOFF_HUMAN: 2,
  INTERESTED_WARRANTY: 3,
  INTERESTED_NEW_WORK: 4,
  CALLBACK_REQUESTED: 5,
  NEEDS_REVIEW: 6,
  ALREADY_COVERED: 7,
  NOT_INTERESTED: 8,
  DNC_REQUESTED: 9,
  FAILED: 10,
  WRONG_NUMBER: 11,
  VOICEMAIL: 12,
  NO_ANSWER: 13,
  ANSWERED: 14,
  CALL_INITIATED: 15,
};

export function normalizeCallOutcomeTags(
  outcome?: string | null,
  outcomes?: string[] | null,
  lf?: string | null
): string[] {
  if (Array.isArray(outcomes) && outcomes.length > 0) {
    const set = new Set<string>();
    for (const item of outcomes) {
      if (item === 'INTERESTED_BOTH') {
        set.add('INTERESTED_WARRANTY');
        set.add('INTERESTED_NEW_WORK');
      } else {
        set.add(item);
      }
    }
    const ordered = Array.from(set).sort((a, b) => {
      const pa = OUTCOME_PRIORITY[a] ?? 99;
      const pb = OUTCOME_PRIORITY[b] ?? 99;
      return pa - pb;
    });
    return ordered;
  }
  const rawTokens = String(outcome || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (rawTokens.length === 0) return ['ANSWERED'];

  const set = new Set<string>();
  for (const t of rawTokens) {
    const u = t.toUpperCase().replace(/\s+/g, '_');
    if (u === 'INTERESTED_BOTH') {
      set.add('INTERESTED_WARRANTY');
      set.add('INTERESTED_NEW_WORK');
    } else {
      set.add(u);
    }
  }

  const primary = lf || rawTokens[0];
  const list = Array.from(set);
  list.sort((a, b) => {
    if (a === primary) return -1;
    if (b === primary) return 1;
    const pa = OUTCOME_PRIORITY[a] ?? 99;
    const pb = OUTCOME_PRIORITY[b] ?? 99;
    return pa - pb;
  });

  return list;
}

const SingleOutcomePill: React.FC<{ tag: string }> = ({ tag }) => {
  const o = tag.toUpperCase().replace(/\s+/g, '_');
  if (o === 'INTERESTED_WARRANTY') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-success-surface text-success-text border border-success-border whitespace-nowrap">
        Warranty plan
      </span>
    );
  }
  if (o === 'INTERESTED_NEW_WORK' || o === 'NEW_JOB') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-primary/10 text-primary border border-primary/25 whitespace-nowrap">
        New Job
      </span>
    );
  }
  if (o === 'CALLBACK_REQUESTED' || o === 'CALLBACK') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-warning-surface text-warning-text border border-warning-border whitespace-nowrap">
        Call back later
      </span>
    );
  }
  if (o === 'HANDOFF_HUMAN') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-primary/10 text-primary border border-primary/25 whitespace-nowrap">
        Needs a human
      </span>
    );
  }
  if (o === 'COMPLAINT') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-danger-surface text-danger-text border border-danger-border whitespace-nowrap">
        Complaint
      </span>
    );
  }
  if (o === 'NOT_INTERESTED') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-muted text-text-secondary border border-border whitespace-nowrap">
        Not interested
      </span>
    );
  }
  if (o === 'ALREADY_COVERED') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-muted text-text-secondary border border-border whitespace-nowrap">
        Has other coverage
      </span>
    );
  }
  if (o === 'DNC_REQUESTED') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-danger-surface text-danger-text border border-danger-border whitespace-nowrap">
        Do not call
      </span>
    );
  }
  if (o === 'WRONG_NUMBER') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-warning-surface text-warning-text border border-warning-border whitespace-nowrap">
        Wrong number
      </span>
    );
  }
  if (o === 'VOICEMAIL') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-muted text-text-secondary border border-border whitespace-nowrap">
        Voicemail / machine
      </span>
    );
  }
  if (o === 'NO_ANSWER') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-muted text-text-secondary border border-border whitespace-nowrap">
        No answer / machine
      </span>
    );
  }
  if (o === 'FAILED') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-danger-surface text-danger-text border border-danger-border whitespace-nowrap">
        Technical failure
      </span>
    );
  }
  if (o === 'NEEDS_REVIEW') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-warning-surface text-warning-text border border-warning-border whitespace-nowrap">
        Needs review
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-muted text-text-secondary border border-border whitespace-nowrap">
      {formatSnakeCase(tag)}
    </span>
  );
};

export const OutcomeBadge: React.FC<{
  outcome: string;
  outcomes?: string[] | null;
  lf?: string | null;
}> = ({ outcome, outcomes, lf }) => {
  const tags = normalizeCallOutcomeTags(outcome, outcomes, lf);
  if (!tags || tags.length === 0 || !tags[0]) return null;

  const primaryTag = tags[0];
  const remainingTags = tags.slice(1);

  if (remainingTags.length === 0) {
    return (
      <div className="inline-flex items-center">
        <SingleOutcomePill tag={primaryTag} />
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5 flex-nowrap">
      <SingleOutcomePill tag={primaryTag} />
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[11px] font-semibold bg-muted/90 text-muted-foreground border border-border/70 hover:bg-muted cursor-pointer transition-colors whitespace-nowrap"
            >
              +{remainingTags.length}
            </span>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            align="start"
            className="p-2.5 space-y-1.5 shadow-popover bg-kit-popover text-kit-popover-foreground border border-border text-xs z-50 rounded-lg min-w-[140px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              All Outcomes ({tags.length})
            </div>
            <div className="flex flex-col gap-1">
              {tags.map((tag) => (
                <div key={tag} className="flex items-center">
                  <SingleOutcomePill tag={tag} />
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};

const STORAGE_KEY_CALL_LOGS_COLUMNS = 'bee_call_logs_table_columns_v1';

const DEFAULT_LOGS_VISIBLE_COLUMNS: Record<string, boolean> = {
  called_at: true,
  customer: true,
  phone: true,
  job_id: true,
  job_type: true,
  warranty_ends: true,
  agent: true,
  attempt: true,
  length: true,
  outcome: true,
  actions: true,
};

export const BeeCallLogTab: React.FC = () => {
  const {
    calls,
    callsFilterOutcome,
    callsSearch,
    loadCalls,
    setCallsFilterOutcome,
    setCallsSearch,
    openCallDetail,
  } = useBeeStore();

  const navigate = useNavigate();

  const [callLogFilterState, setCallLogFilterState] = useState<FilterState>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_CALL_LOGS_COLUMNS);
      if (saved) {
        return { ...DEFAULT_LOGS_VISIBLE_COLUMNS, ...JSON.parse(saved) };
      }
    } catch {
      // fallback
    }
    return DEFAULT_LOGS_VISIBLE_COLUMNS;
  });

  const handleColumnVisibilityChange = (updater: any) => {
    setColumnVisibility((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      try {
        localStorage.setItem(STORAGE_KEY_CALL_LOGS_COLUMNS, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const tableContainerRef = useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    loadCalls(1);

    const intervalId = setInterval(() => {
      loadCalls(1);
    }, 4000);

    const handleSync = () => {
      if (document.visibilityState === 'visible') {
        loadCalls(1);
      }
    };

    window.addEventListener('focus', handleSync);
    document.addEventListener('visibilitychange', handleSync);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', handleSync);
      document.removeEventListener('visibilitychange', handleSync);
    };
  }, [loadCalls]);

  const resolveCallLogOptions = useCallback((sourceId: string): FacetOption[] => {
    if (sourceId === 'agents') {
      const agentNames = Array.from(
        new Set(
          calls
            .map((c) => c.agent_name || c.ag)
            .filter(Boolean) as string[]
        )
      );
      if (agentNames.length === 0) {
        return [
          { value: 'doors', label: 'Warranty - Doors' },
          { value: 'security', label: 'Warranty - Security' },
        ];
      }
      return agentNames.map((name) => ({ value: name, label: name }));
    }
    if (sourceId === 'jobTypes') {
      const types = Array.from(
        new Set(
          calls
            .map((c) => c.job_type || c.jt || (c.job_title ? c.job_title.split('·').pop()?.trim() : ''))
            .filter(Boolean) as string[]
        )
      );
      if (types.length === 0) return [{ value: 'General Service', label: 'General Service' }];
      return types.map((t) => ({ value: t, label: formatSnakeCase(t) }));
    }
    return [];
  }, [calls]);

  const hasActiveCallLogFilters = useMemo(
    () => Object.values(callLogFilterState).some((v) => facetSelectionCount(v) > 0),
    [callLogFilterState],
  );

  // Client-side filtering across FilterPopover facets and Search
  const filteredCalls = useMemo(() => {
    return calls.filter((c) => {
      // Search filter
      if (callsSearch.trim()) {
        const q = callsSearch.toLowerCase().trim();
        const custName = (c.customer_name || c.c || '').toLowerCase();
        const phone = (c.customer_phone || c.p || '').toLowerCase();
        const phoneFormatted = formatPhone(c.customer_phone || c.p || '').toLowerCase();
        const phoneDigits = (c.customer_phone || c.p || '').replace(/\D/g, '');
        const qDigits = q.replace(/\D/g, '');
        const jobId = (c.job_id || '').toLowerCase();
        const jobNum = (c.job_number || (c.j && c.j.startsWith('#') ? c.j : '') || '').toLowerCase();
        const agent = (c.agent_name || c.ag || '').toLowerCase();
        const jobType = (c.job_type || c.jt || '').toLowerCase();

        const phoneMatch =
          phone.includes(q) ||
          phoneFormatted.includes(q) ||
          (qDigits.length >= 3 && phoneDigits.includes(qDigits));

        if (
          !custName.includes(q) &&
          !phoneMatch &&
          !jobId.includes(q) &&
          !jobNum.includes(q) &&
          !agent.includes(q) &&
          !jobType.includes(q)
        ) {
          return false;
        }
      }

      // Date Range facet filter
      const dateFilter = callLogFilterState.date;
      if (dateFilter && dateFilter.kind === 'dateRange' && (dateFilter.from || dateFilter.to)) {
        const callDateStr = c.called_at || c.t;
        if (!callDateStr) return false;
        const callDate = new Date(callDateStr);
        if (isNaN(callDate.getTime())) return false;

        if (dateFilter.from) {
          const fromDate = new Date(`${dateFilter.from}T00:00:00`);
          if (callDate < fromDate) return false;
        }
        if (dateFilter.to) {
          const toDate = new Date(`${dateFilter.to}T23:59:59.999`);
          if (callDate > toDate) return false;
        }
      }

      // Outcome facet filter
      const outcomeVal = callLogFilterState.outcome;
      if (outcomeVal && outcomeVal.kind === 'multi' && outcomeVal.values.length > 0) {
        const tags = normalizeCallOutcomeTags(c.o || c.outcome, c.outcomes, c.lf || c.lead_format).map((t) =>
          t.toUpperCase().replace(/\s+/g, '_')
        );
        const matches = outcomeVal.values.some((v) => {
          if (v === 'ANSWERED') return !tags.includes('NO_ANSWER') && !tags.includes('FAILED');
          if (v === 'human') return tags.includes('HANDOFF_HUMAN') || tags.includes('COMPLAINT');
          if (v === 'none') {
            return tags.includes('NOT_INTERESTED') || tags.includes('DNC_REQUESTED') || tags.includes('ALREADY_COVERED');
          }
          return tags.includes(v);
        });
        if (!matches) return false;
      }

      // Agent facet filter
      const agentVal = callLogFilterState.agent;
      if (agentVal && agentVal.kind === 'multi' && agentVal.values.length > 0) {
        const ag = (c.ag || c.agent_name || '').toLowerCase();
        const matches = agentVal.values.some((v) => {
          if (v === 'doors') return ag.includes('door');
          if (v === 'security') return ag.includes('security');
          return ag.includes(v.toLowerCase());
        });
        if (!matches) return false;
      }

      // Attempt facet filter
      const attemptVal = callLogFilterState.attempt;
      if (attemptVal && attemptVal.kind === 'multi' && attemptVal.values.length > 0) {
        const at = c.at || c.attempt || '';
        const matches = attemptVal.values.some((v) => at.startsWith(v));
        if (!matches) return false;
      }

      // Sentiment facet filter
      const sentVal = callLogFilterState.sentiment;
      if (sentVal && sentVal.kind === 'multi' && sentVal.values.length > 0) {
        const sent = (c.sent || c.sentiment || '').toLowerCase();
        if (!sentVal.values.includes(sent)) return false;
      }

      // Job Type facet filter
      const jobTypeVal = callLogFilterState.job_type;
      if (jobTypeVal && jobTypeVal.kind === 'multi' && jobTypeVal.values.length > 0) {
        const jt = c.job_type || c.jt || (c.job_title ? c.job_title.split('·').pop()?.trim() : '') || 'General Service';
        if (!jobTypeVal.values.includes(jt)) return false;
      }

      return true;
    });
  }, [calls, callsSearch, callLogFilterState]);

  const totalPages = Math.max(1, Math.ceil(filteredCalls.length / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  const exportCsv = () => {
    if (filteredCalls.length === 0) {
      toast.error('No call logs to export');
      return;
    }
    const headers = ['Date & time', 'Customer', 'Phone', 'Job #', 'Job Type', 'Warranty ends', 'Agent', 'Attempt', 'Length', 'Outcome'];
    const rows = filteredCalls.map((c) => {
      const jobId = c.job_id;
      const rawJobIdLabel =
        c.job_number ||
        (c.j ? c.j.split('·')[0]?.trim() : '') ||
        (jobId ? jobId.slice(0, 8) : '-');
      const jobIdLabel = rawJobIdLabel.replace(/^#/, '');
      const jobTypeLabel = formatSnakeCase(
        c.job_type ||
        c.jt ||
        (c.job_title ? c.job_title.split('·').pop()?.trim() : '') ||
        'General Service'
      );

      return [
        c.t || (c.called_at ? new Date(c.called_at).toLocaleString() : ''),
        c.customer_name || c.c || '',
        formatPhone(c.customer_phone || c.p || ''),
        jobIdLabel,
        jobTypeLabel,
        c.we || c.warranty_ends || '',
        c.ag || c.agent_name || '',
        c.at || c.attempt || '',
        c.d || `${c.duration_seconds}s`,
        c.o || c.outcome || '',
      ];
    });

    exportCsvFile(`bee-call-logs-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
    toast.success('CSV downloaded');
  };

  const columns = useMemo<ColumnDef<BeeCallLogItem>[]>(() => [
    {
      id: 'called_at',
      accessorKey: 'called_at',
      header: 'Date & time',
      size: 140,
      minSize: 110,
      meta: { label: 'Date & Time', pinned: true },
      cell: ({ row }) => {
        const c = row.original;
        const dateStr = c.t || (c.called_at ? new Date(c.called_at).toLocaleDateString([], {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase()) : '-');
        return <span className="whitespace-nowrap text-text-secondary">{dateStr}</span>;
      },
    },
    {
      id: 'customer',
      accessorKey: 'customer_name',
      header: 'Customer',
      size: 165,
      minSize: 130,
      meta: { label: 'Customer', pinned: true },
      cell: ({ row }) => {
        const c = row.original;
        const custName = c.customer_name || c.c || 'Valued Customer';
        const customerId = c.customer_id;
        return (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (customerId) {
                navigate(`/customers/${customerId}`);
              } else {
                openCallDetail(c);
              }
            }}
            className="hover:text-primary hover:underline font-bold whitespace-nowrap text-text-primary cursor-pointer"
            title={customerId ? 'Go to customer page' : undefined}
          >
            {custName}
          </span>
        );
      },
    },
    {
      id: 'phone',
      accessorKey: 'customer_phone',
      header: 'Phone',
      size: 130,
      minSize: 110,
      meta: { label: 'Phone' },
      cell: ({ row }) => (
        <span className="font-mono text-text-secondary whitespace-nowrap">
          {formatPhone(row.original.customer_phone || row.original.p || '') || '-'}
        </span>
      ),
    },
    {
      id: 'job_id',
      accessorKey: 'job_id',
      header: 'Job #',
      size: 110,
      minSize: 90,
      meta: { label: 'Job #' },
      cell: ({ row }) => {
        const c = row.original;
        const jobId = c.job_id;
        const rawJobIdLabel =
          c.job_number ||
          (c.j ? c.j.split('·')[0]?.trim() : '') ||
          (jobId ? jobId.slice(0, 8) : '-');
        const jobIdLabel = rawJobIdLabel.replace(/^#/, '');
        return (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (jobId) {
                navigate(`/jobs/${jobId}`);
              } else {
                openCallDetail(c);
              }
            }}
            className={`hover:text-primary hover:underline font-medium whitespace-nowrap ${
              jobId ? 'text-primary' : 'text-text-primary'
            } cursor-pointer`}
            title={jobId ? 'Go to job page' : undefined}
          >
            {jobIdLabel}
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
        const c = row.original;
        const jobTypeLabel = formatSnakeCase(
          c.job_type ||
          c.jt ||
          (c.job_title ? c.job_title.split('·').pop()?.trim() : '') ||
          'General Service'
        );
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border border-border text-text-secondary whitespace-nowrap">
            {jobTypeLabel}
          </span>
        );
      },
    },
    {
      id: 'warranty_ends',
      accessorKey: 'warranty_ends',
      header: 'Warranty ends',
      size: 120,
      minSize: 100,
      meta: { label: 'Warranty Ends' },
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-text-secondary">
          {row.original.we || row.original.warranty_ends || '-'}
        </span>
      ),
    },
    {
      id: 'agent',
      accessorKey: 'agent_name',
      header: 'Agent',
      size: 140,
      minSize: 110,
      meta: { label: 'Agent' },
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-text-secondary">
          {row.original.ag || row.original.agent_name || 'Warranty - Doors'}
        </span>
      ),
    },
    {
      id: 'attempt',
      accessorKey: 'attempt',
      header: 'Attempt',
      size: 90,
      minSize: 80,
      meta: { label: 'Attempt' },
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-text-secondary">
          {row.original.at || row.original.attempt || '1 of 3'}
        </span>
      ),
    },
    {
      id: 'length',
      accessorKey: 'duration_seconds',
      header: 'Length',
      size: 80,
      minSize: 70,
      meta: { label: 'Length' },
      cell: ({ row }) => {
        const c = row.original;
        const lengthStr =
          c.d ||
          (c.duration_seconds
            ? `${Math.floor(c.duration_seconds / 60)}:${(c.duration_seconds % 60).toString().padStart(2, '0')}`
            : '0:00');
        return <span className="font-mono text-text-secondary whitespace-nowrap">{lengthStr}</span>;
      },
    },
    {
      id: 'outcome',
      accessorKey: 'outcome',
      header: 'Outcome',
      size: 180,
      minSize: 140,
      meta: { label: 'Outcome' },
      cell: ({ row }) => {
        const c = row.original;
        const outcomeStr = c.o || c.outcome || 'LEAD_CREATED';
        return <OutcomeBadge outcome={outcomeStr} outcomes={c.outcomes} lf={c.lf || c.lead_format} />;
      },
    },
    {
      id: 'actions',
      header: '',
      size: 50,
      minSize: 50,
      enableResizing: false,
      enableHiding: false,
      meta: { label: 'Actions', fixed: true },
      cell: ({ row }) => {
        const c = row.original;
        return (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Button
              size="icon"
              variant="outline"
              onClick={() => openCallDetail(c)}
              className="h-7 w-7 cursor-pointer"
              aria-label="Play recording"
              title="Play call recording"
            >
              <Play className="h-3 w-3 fill-current ml-0.5" />
            </Button>
          </div>
        );
      },
    },
  ], [navigate, openCallDetail]);

  return (
    <div className="space-y-4">
      <div ref={tableContainerRef} className="relative">
        <BeeTableScrollFades
          containerRef={tableContainerRef}
          stickyColId="customer"
          hasStickyCol={Boolean(columnVisibility['customer'] || columnVisibility['called_at'])}
        />
        <DataTable
          columns={columns}
          data={filteredCalls}
          getRowId={(c) => c.id}
          page={safeCurrentPage}
          pageCount={totalPages}
          onPageChange={setCurrentPage}
          pageSize={pageSize}
          onPageSizeChange={(newSize) => {
            setPageSize(newSize);
            setCurrentPage(1);
          }}
          rowCount={filteredCalls.length}
          enableColumnResizing
          columnVisibility={columnVisibility}
          onColumnVisibilityChange={handleColumnVisibilityChange}
          onRowClick={(c) => openCallDetail(c)}
          empty={
            <div className="text-center py-10 text-text-secondary text-xs">
              No call logs match your filter criteria.
            </div>
          }
        >
          {(table) => (
            <>
              <div className="flex flex-wrap items-center gap-2.5 p-3.5 border-b border-border/80 bg-surface-light">
                {/* Search input: 320px */}
                <div className="relative w-[320px] max-w-full">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-text-secondary pointer-events-none" />
                  <input
                    id="q"
                    type="text"
                    placeholder="Search name, phone, job #, words in transcript"
                    value={callsSearch}
                    onChange={(e) => {
                      setCallsSearch(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="w-full pl-9 pr-8 h-9 text-xs bg-surface-light border border-border rounded-lg text-text-primary placeholder:text-text-secondary focus:ring-1 focus:ring-primary focus:outline-none"
                  />
                  {callsSearch && (
                    <button
                      type="button"
                      onClick={() => {
                        setCallsSearch('');
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

                {/* Filter, Export, Columns controls matching Leads / CRM */}
                <div className="flex items-center gap-2">
                  <FilterPopover
                    registry={callLogFilterRegistry}
                    value={callLogFilterState}
                    onChange={(next) => {
                      setCallLogFilterState(next);
                      setCurrentPage(1);
                    }}
                    resolveOptions={resolveCallLogOptions}
                    resolveMax={() => 0}
                    statusDomain="lead"
                  />

                  {/* Export CSV Button */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={exportCsv}
                    className="h-9 gap-1.5 cursor-pointer"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export
                  </Button>

                  {/* Columns Visibility Button */}
                  <BeeTableColumnOptions
                    table={table}
                    storageKey={STORAGE_KEY_CALL_LOGS_COLUMNS}
                    defaultVisibility={DEFAULT_LOGS_VISIBLE_COLUMNS}
                    containerRef={tableContainerRef}
                    stickyColId="customer"
                  />
                </div>
              </div>

              {/* Applied Filter Chips bar */}
              {hasActiveCallLogFilters && (
                <div className="px-4 py-2 border-b border-border/60 bg-muted/20">
                  <AppliedFilterBar
                    registry={callLogFilterRegistry}
                    value={callLogFilterState}
                    onChange={(next) => {
                      setCallLogFilterState(next);
                      setCurrentPage(1);
                    }}
                    resolveOptions={resolveCallLogOptions}
                    resultCount={filteredCalls.length}
                    totalCount={calls.length}
                  />
                </div>
              )}
            </>
          )}
        </DataTable>
      </div>
    </div>
  );
};
