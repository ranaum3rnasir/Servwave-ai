import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Bell,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Download,
  ExternalLink,
  Eye,
  Mail,
  MapPin,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
  User,
  X,
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
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { DateField } from '@/ui-kit/components/form/dateField';
import { Badge } from '@/ui-kit/components/ui/badge';
import { CheckboxFacet, FilterPopover, type FacetControlContext } from '../_shared/filterPopover';
import type { FacetConfig, FacetOption, FilterState } from '@/lib/filters/types';
import { cn, extractApiError } from '@/lib/utils';
import { exportCsvFile } from '@/lib/csv';
import { AI_AGENTS } from '@/lib/ai-center/agents';
import { formatCurrentStageName } from '@/lib/spider/watcher';
import {
  CUSTOM_DATE,
  HISTORY_CSV_HEADERS,
  elapsedText,
  historyCsvRows,
  historyDateStr,
  historyQueryParams,
  historyTimeStr,
  isHistoryFiltered,
  spiderHistoryRegistry,
} from '@/lib/spider/history';
import {
  fetchSpiderHistoryExport,
  useSpiderHistory,
  useSpiderHistoryFilters,
  type SpiderHistoryChannel,
  type SpiderHistoryItem,
} from '@/lib/api/spider';
import { StatusChip } from '../_shared/statusChip';

/*
 * Spider's History tab: the contractor's History tab as it is (his SpiderWatcherPage.tsx at
 * 3bb6606, lines 1713-2530) - toolbar, error and empty states, table, pagination footer and the
 * "Delivered Message Preview" drawer - fed by our server (Ran, 15 Oct). His markup, classes, icons
 * and words are kept; what feeds them changed:
 *   - search and every filter run on the server, so they reach every page (his filtered only the
 *     page on screen), and "All filtered" exports every matching row, not just that page;
 *   - each row shows what the server stored when the alert went out: the lead number, address,
 *     outcomes, people and messages - never his invented fallbacks (made-up lead numbers, a fake
 *     "Assigned Lead Specialist", a missing outcome shown as "Sent", an In-App tile that always read
 *     "Delivered", made-up failure reasons, made-up message texts). What an older alert never stored
 *     reads "—";
 *   - no 10-second polling: read when the tab opens and on Refresh;
 *   - a skeleton while the first page loads (his showed "All Monitored Stage Leads are Healthy"
 *     before anything had loaded);
 *   - his Custom Date had no way to pick a date; here it opens a date field, and matches that day;
 *   - a lead reported in the starting summary (#2794) is tagged "In starting summary" under its date.
 */

const SPIDER = AI_AGENTS.find((a) => a.id === 'spider')!;

// Sender email address for Spider alerts
const defaultSenderEmail = 'ServWave Spider Alerts <alerts@spider.servwave.com>';

const SEARCH_DELAY_MS = 300;

export function LeadStageChip({ stage }: { stage: string }) {
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
  return <Badge variant="slate" size="sm">{normalized || 'New'}</Badge>;
}

/** His tooltip for an email or SMS pill, naming only what the server recorded. */
function channelTitle(label: 'Email' | 'SMS', c: SpiderHistoryChannel): string {
  if (c.status === 'SENT') return `${label}: Successfully Sent${c.sent ? ` to ${c.sent} recipient(s)` : ''}`;
  if (c.status === 'FAILED') return `${label}: Delivery Failed${c.error ? ` — ${c.error}` : ''}`;
  return `${label}: Skipped${c.skip_reason ? ` (${c.skip_reason})` : ''}`;
}

/** His tile word for an outcome; an outcome the server cannot know is "—". */
const tileWord = (status: string | undefined) =>
  status === 'SENT' ? 'Sent' : status === 'FAILED' ? 'Failed' : status === 'SKIPPED' ? 'Skipped' : '—';

/** His dot pill colours: green sent, red failed, amber skipped. */
const pillClass = (status: string) =>
  status === 'SENT'
    ? 'bg-success-surface border-success-border text-success-text'
    : status === 'FAILED'
      ? 'bg-danger-surface border-danger-border text-danger-text'
      : 'bg-warning-surface border-warning-border text-warning-text';
const dotClass = (status: string) =>
  status === 'SENT' ? 'bg-success' : status === 'FAILED' ? 'bg-danger' : 'bg-warning';

export interface SpiderHistoryProps {
  /** Whether Spider is on (his empty state differs). */
  isSpiderActive: boolean;
  /** His "{n} lead targets": the open leads Spider watches (the picker header's N, #3436); unset while not known. */
  watchedLeads?: number;
  /** Refresh also re-reads the tab's count. */
  onRefresh?: () => void;
}

export function SpiderHistory({ isSpiderActive, watchedLeads, onRefresh }: SpiderHistoryProps) {
  const navigate = useNavigate();
  const { toast } = useToast();

  // Dedicated Search & Filter state for History Logs
  const [filterLead, setFilterLead] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [historyFilterState, setHistoryFilterState] = useState<FilterState>({});
  const [customDate, setCustomDate] = useState('');
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [previewTab, setPreviewTab] = useState<'email' | 'sms' | 'inApp'>('email');

  // Focus trap & focus restoration refs for History preview drawer (ACC-10)
  const drawerRef = useRef<HTMLDivElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);

  // Pagination for History Logs
  const [pageSize, setPageSize] = useState<number>(25);
  const [currentPage, setCurrentPage] = useState<number>(1);

  // The search box asks the server once typing pauses, from page 1 (his reset on every change).
  useEffect(() => {
    const t = setTimeout(() => {
      setSearchQuery(filterLead);
      setCurrentPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [filterLead]);

  const filterOptions = useSpiderHistoryFilters();
  const recipientOptions = useMemo<FacetOption[]>(() => filterOptions.data?.recipients ?? [], [filterOptions.data]);
  const customerOptions = useMemo<FacetOption[]>(() => filterOptions.data?.customers ?? [], [filterOptions.data]);

  // The filter options could not be read (an older server's missing route reads as empty lists,
  // not as this): say so, once per failure, rather than showing empty lists silently.
  const filtersFailed = filterOptions.isError;
  const filtersError = filterOptions.error;
  useEffect(() => {
    if (!filtersFailed) return;
    toast({
      title: 'Failed to load filter options',
      description: extractApiError(filtersError, 'The Recipients and Customers filters could not be loaded.'),
      variant: 'destructive',
    });
  }, [filtersFailed, filtersError, toast]);

  // The toolbar as the request body, worked out when each request is made, so a date preset such as
  // Today never goes stale after midnight. Every Recipient or Customer ticked filters nothing.
  const optionCounts = useMemo(
    () => ({ recipients: recipientOptions.length, customers: customerOptions.length }),
    [recipientOptions, customerOptions],
  );
  const buildParams = useCallback(
    () => historyQueryParams(searchQuery, historyFilterState, customDate, new Date(), optionCounts),
    [searchQuery, historyFilterState, customDate, optionCounts],
  );

  const {
    data: dbLogsResponse,
    isLoading: isLogsLoading,
    isFetching: isLogsFetching,
    isError: isLogsError,
    error: logsError,
    refetch: refetchDbLogs,
  } = useSpiderHistory(currentPage, pageSize, { searchQuery, historyFilterState, customDate, optionCounts }, buildParams);

  const historyLogs: SpiderHistoryItem[] = useMemo(() => dbLogsResponse?.items ?? [], [dbLogsResponse]);

  // Selected log item (null by default so table is full width until user opens preview)
  const selectedLog = useMemo(() => {
    if (!selectedLogId) return null;
    return historyLogs.find((l) => l.id === selectedLogId) || null;
  }, [historyLogs, selectedLogId]);

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

  // `total`: how many rows matched, when the server stopped short of them (its export cap).
  const handleExportLogs = (logs: SpiderHistoryItem[], label: string, total?: number) => {
    const filename = `spider_notification_history_${label.toLowerCase().replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
    exportCsvFile(filename, HISTORY_CSV_HEADERS, historyCsvRows(logs));
    toast({
      title: 'Export Complete',
      description:
        total !== undefined && total > logs.length
          ? `Exported ${logs.length} of ${total} notification history records to CSV.`
          : `Successfully exported ${logs.length} notification history records to CSV.`,
    });
  };

  // "All filtered": every row the server matches, not just this page, worked out now. The server
  // stops at its cap and says so; the toast then names how many of how many went out. A failed
  // request is said here (the request itself is silent).
  const handleExportAllFiltered = async () => {
    try {
      const all = await fetchSpiderHistoryExport(buildParams());
      handleExportLogs(all.items, 'All Logs', all.truncated ? all.total : undefined);
    } catch (err) {
      toast({
        title: 'Export Failed',
        description: extractApiError(err, 'Could not export notification history.'),
        variant: 'destructive',
      });
    }
  };

  const resolveOptions = useCallback(
    (sourceId: string): FacetOption[] => {
      if (sourceId === 'recipients') return recipientOptions;
      if (sourceId === 'customers') return customerOptions;
      return [];
    },
    [recipientOptions, customerOptions],
  );

  const resolveMax = useCallback((_sourceId: string): number => 0, []);

  // His Custom Date option, with the date field it needs to mean anything.
  const renderFacet = useCallback(
    (facet: FacetConfig, ctx: FacetControlContext) => {
      if (facet.key !== 'dateTime') return undefined;
      const custom = ctx.value?.kind === 'multi' && ctx.value.values.includes(CUSTOM_DATE);
      return (
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="flex min-h-0 flex-1 flex-col">
            <CheckboxFacet facet={facet} value={ctx.value} onChange={ctx.onChange} options={facet.options ?? []} />
          </div>
          {custom && (
            <DateField
              value={customDate}
              onChange={(v) => {
                setCustomDate(v);
                setCurrentPage(1);
              }}
              aria-label="Custom Date"
            />
          )}
        </div>
      );
    },
    [customDate],
  );

  const isFiltered = isHistoryFiltered(searchQuery, historyFilterState);
  const filteredLogs = historyLogs;
  const paginatedLogs = filteredLogs;

  const totalLogs = dbLogsResponse?.total ?? 0;
  const totalPages = dbLogsResponse?.total_pages ?? (Math.ceil(totalLogs / pageSize) || 1);
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  const refreshAll = () => {
    refetchDbLogs();
    filterOptions.refetch();
    onRefresh?.();
  };

  return (
    <div className="space-y-6">
      {/* History Logs Toolbar matching v2 reference image: Search leads... | Filter | Export | Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/80 bg-surface-light p-3 shadow-sm">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-soft" />
          <Input
            value={filterLead}
            onChange={(e) => setFilterLead(e.target.value)}
            kind="search"
            placeholder="Search leads..."
            aria-label="Search leads"
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
              aria-label="Clear search"
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
            renderFacet={renderFacet}
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
              <DropdownMenuItem onClick={handleExportAllFiltered}>
                All filtered ({totalLogs} logs)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="sm"
            onClick={refreshAll}
            disabled={isLogsFetching}
            className="h-9 px-3 gap-1.5"
            title="Refresh notification logs from database"
            aria-label="Refresh"
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
            {extractApiError(logsError, 'A network error occurred while retrieving notification logs from the database.')}
          </p>
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={() => refetchDbLogs()} className="gap-1.5">
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Retry</span>
            </Button>
          </div>
        </div>
      ) : isLogsLoading ? (
        <Skeleton data-spider-history-placeholder aria-hidden className="h-64 w-full rounded-card" />
      ) : filteredLogs.length === 0 ? (
        <div className="rounded-2xl border border-border/80 bg-surface-light p-12 text-center shadow-sm">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-ai-50 border border-ai-200 text-ai-600 mb-4">
            <CheckCircle2 className="h-7 w-7 text-success" />
          </div>
          <h3 className="text-base font-bold text-text-primary">
            {!isFiltered
              ? isSpiderActive
                ? 'All Monitored Stage Leads are Healthy'
                : 'No Historical Alert Logs'
              : 'No notification logs matched your search filter.'}
          </h3>
          <p className="text-xs text-text-secondary max-w-md mx-auto mt-1">
            {!isFiltered
              ? isSpiderActive
                ? // No count read (the overview failed or is still loading): the number's sentence is left out, never "0".
                  `${watchedLeads === undefined ? '' : `Spider is actively monitoring ${watchedLeads} lead targets in the background. `}When overdue alerts trigger, notification logs and message previews will appear here.`
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
                    const email = log.outcomes.email;
                    const sms = log.outcomes.sms;
                    const inApp = log.outcomes.in_app;

                    return (
                      <tr
                        key={log.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`View notification details for lead ${log.lead_number}`}
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
                              <span>{historyTimeStr(log.alerted_at)}</span>
                            </div>
                            <div className="flex items-center gap-1 text-[11px] text-text-soft">
                              <Calendar className="h-3 w-3 text-text-soft shrink-0" />
                              <span>{historyDateStr(log.alerted_at)}</span>
                            </div>
                            {/* Reported in Spider's starting summary, not alerted on its own (#2794). */}
                            {log.in_starting_summary && (
                              <span className="mt-1 inline-flex h-5 w-fit items-center rounded-full border border-ai-200 bg-ai-50 px-2 text-[11px] font-bold text-ai-600">
                                In starting summary
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Lead ID */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          <span className="font-mono font-medium text-text-primary text-xs">
                            {log.lead_number}
                          </span>
                        </td>

                        {/* Stage */}
                        <td className="py-3.5 px-4 whitespace-nowrap">
                          {log.stage_name ? <LeadStageChip stage={log.stage_name} /> : <span className="text-text-soft">—</span>}
                        </td>

                        {/* Lead Address */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-1.5 text-xs text-text-secondary max-w-[200px]" title={log.service_location ?? undefined}>
                            <MapPin className="h-3.5 w-3.5 text-text-soft shrink-0" />
                            <span className="truncate">{log.service_location || 'Service location on file'}</span>
                          </div>
                        </td>

                        {/* Customer Name */}
                        <td className="py-3.5 px-4">
                          <div className="min-w-0">
                            <p className="font-bold text-text-primary truncate">
                              {log.customer_name}
                            </p>
                            {log.company_name && (
                              <p className="text-[10px] text-text-soft truncate max-w-[140px]">
                                {log.company_name}
                              </p>
                            )}
                          </div>
                        </td>

                        {/* Notification Types: clean badges with dot indicators and channel names only */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {email?.enabled && (
                              <span
                                title={channelTitle('Email', email)}
                                className={cn(
                                  'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border shadow-xs',
                                  pillClass(email.status)
                                )}
                              >
                                <span
                                  className={cn(
                                    'inline-block h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0',
                                    dotClass(email.status)
                                  )}
                                />
                                <span>Email</span>
                              </span>
                            )}
                            {sms?.enabled && (
                              <span
                                title={channelTitle('SMS', sms)}
                                className={cn(
                                  'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border shadow-xs',
                                  pillClass(sms.status)
                                )}
                              >
                                <span
                                  className={cn(
                                    'inline-block h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0',
                                    dotClass(sms.status)
                                  )}
                                />
                                <span>SMS</span>
                              </span>
                            )}
                            {inApp?.enabled && (
                              <span
                                title={
                                  inApp.status === 'SENT'
                                    ? 'In-App: Notification Delivered'
                                    : 'In-App: Skipped'
                                }
                                className={cn(
                                  'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border shadow-xs',
                                  pillClass(inApp.status)
                                )}
                              >
                                <span
                                  className={cn(
                                    'inline-block h-2 w-2 min-w-[8px] min-h-[8px] rounded-full shrink-0',
                                    dotClass(inApp.status)
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
                                    onKeyDown={(e) => e.stopPropagation()}
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
                    <SelectTrigger className="h-8 w-[4.5rem]" aria-label="Rows">
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
                    aria-label="First page"
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
                    aria-label="Previous page"
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
                    aria-label="Next page"
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
                    aria-label="Last page"
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
            <PreviewDrawer
              log={selectedLog}
              drawerRef={drawerRef}
              previewTab={previewTab}
              setPreviewTab={setPreviewTab}
              onClose={() => setSelectedLogId(null)}
              onOpenLead={() => {
                setSelectedLogId(null);
                if (selectedLog.lead_id) {
                  navigate(`/leads/${selectedLog.lead_id}`);
                } else {
                  navigate('/leads');
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── The preview drawer ──────────────────────────────────────────────────────

const PREVIEW_TABS = [
  ['email', Mail, 'Email'],
  ['sms', MessageSquare, 'SMS'],
  ['inApp', Bell, 'In-App'],
] as const;

function PreviewDrawer({
  log: selectedLog,
  drawerRef,
  previewTab,
  setPreviewTab,
  onClose,
  onOpenLead,
}: {
  log: SpiderHistoryItem;
  drawerRef: React.RefObject<HTMLDivElement | null>;
  previewTab: 'email' | 'sms' | 'inApp';
  setPreviewTab: (tab: 'email' | 'sms' | 'inApp') => void;
  onClose: () => void;
  onOpenLead: () => void;
}) {
  const timeStr = historyTimeStr(selectedLog.alerted_at);
  const email = selectedLog.outcomes.email;
  const sms = selectedLog.outcomes.sms;
  const inApp = selectedLog.outcomes.in_app;
  const recipientNames = selectedLog.recipients.map((r) => r.name);
  const recipientEmails = selectedLog.recipients.map((r) => r.email).filter(Boolean) as string[];
  const emailTo = recipientEmails.length > 0 ? recipientEmails : recipientNames;

  return (
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
        className="fixed inset-0 bg-scrim/40 pointer-fine:backdrop-blur-xs transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
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
                onClick={onClose}
                className="h-7 w-7 p-0"
                title="Close preview"
                aria-label="Close preview"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Stacked Details: 1. Customer Name, 2. Lead ID, 3. Lead Address */}
            <div className="space-y-1">
              {/* 1. Customer Name */}
              <div className="text-sm font-bold text-text-primary truncate">
                {selectedLog.customer_name || 'Customer'}
                {selectedLog.company_name && (
                  <span className="text-xs font-normal text-text-soft ml-1.5">
                    ({selectedLog.company_name})
                  </span>
                )}
              </div>

              {/* 2. Lead ID */}
              <div className="text-xs font-mono font-medium text-text-secondary">
                {selectedLog.lead_number}
              </div>

              {/* 3. Lead Address */}
              <div className="flex items-center gap-1.5 text-xs text-text-secondary truncate" title={selectedLog.service_location ?? undefined}>
                <MapPin className="h-3.5 w-3.5 text-text-soft shrink-0" />
                <span className="truncate">{selectedLog.service_location || 'Service location on file'}</span>
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

            <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-2">
              {/* Email status pill */}
              <div className={cn(
                "p-2 rounded-lg border flex flex-col gap-0.5",
                email?.status === 'SENT'
                  ? "bg-success-surface border-success-border text-success-text"
                  : email?.status === 'FAILED'
                    ? "bg-danger-surface border-danger-border text-danger-text"
                    : "bg-surface-light border-border text-text-secondary"
              )}>
                <div className="flex items-center gap-1 font-bold text-[11px]">
                  <Mail className="h-3 w-3 shrink-0" />
                  <span>Email</span>
                </div>
                <span className="text-[10px] font-medium">
                  {tileWord(email?.status)}
                </span>
              </div>

              {/* SMS status pill */}
              <div className={cn(
                "p-2 rounded-lg border flex flex-col gap-0.5",
                sms?.status === 'SENT'
                  ? "bg-success-surface border-success-border text-success-text"
                  : sms?.status === 'FAILED'
                    ? "bg-danger-surface border-danger-border text-danger-text"
                    : "bg-surface-light border-border text-text-secondary"
              )}>
                <div className="flex items-center gap-1 font-bold text-[11px]">
                  <MessageSquare className="h-3 w-3 shrink-0" />
                  <span>SMS</span>
                </div>
                <span className="text-[10px] font-medium">
                  {tileWord(sms?.status)}
                </span>
              </div>

              {/* In-App status pill: the outcome the server recorded (his always read "Delivered") */}
              <div className={cn(
                "p-2 rounded-lg border flex flex-col gap-0.5",
                inApp?.status === 'SENT'
                  ? "bg-ai-50 border-ai-200 text-ai-600"
                  : "bg-surface-light border-border text-text-secondary"
              )}>
                <div className="flex items-center gap-1 font-bold text-[11px]">
                  <Bell className={cn("h-3 w-3 shrink-0", inApp?.status === 'SENT' && "text-ai-600")} />
                  <span>In-App</span>
                </div>
                <span className="text-[10px] font-medium">
                  {inApp?.status === 'SENT' ? 'Delivered' : tileWord(inApp?.status)}
                </span>
              </div>
            </div>
          </div>

          {/* Channel Switcher Tabs (Email | SMS | In-App) */}
          <div role="tablist" aria-label="Notification Channel Previews" className="flex items-center border-b border-border bg-surface-light px-4 pt-2 gap-2">
            {PREVIEW_TABS.map(([tab, Icon, label]) => (
              <div
                key={tab}
                role="tab"
                tabIndex={0}
                aria-selected={previewTab === tab}
                onClick={() => setPreviewTab(tab)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setPreviewTab(tab);
                  }
                }}
                className={cn(
                  'h-auto -mb-px flex items-center gap-1.5 px-3 py-2 text-xs font-bold border-b-2 transition-all cursor-pointer select-none',
                  previewTab === tab
                    ? 'border-ai-600 text-ai-600'
                    : 'border-transparent text-text-secondary hover:text-text-primary'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
              </div>
            ))}
          </div>

          {/* Scrollable Preview Body */}
          <div className="p-5 space-y-4 flex-1 overflow-y-auto">
            {/* 1. Email Preview */}
            {previewTab === 'email' && (() => {
              const isEmailSkipped = email?.status === 'SKIPPED';
              const senderDisplay = email?.from || defaultSenderEmail;

              return (
                <div className="space-y-3">
                  <div className="rounded-xl border border-border/70 bg-background-light/40 p-3 text-xs space-y-1.5">
                    {!isEmailSkipped ? (
                      <>
                        <div className="flex items-center justify-between text-text-secondary">
                          <span>From: <strong>{senderDisplay}</strong></span>
                          <span className="font-mono text-[10px]">{timeStr}</span>
                        </div>
                        <p className="text-text-secondary truncate">
                          To: <strong>{emailTo.join(', ')}</strong>
                        </p>
                      </>
                    ) : (
                      <div className="flex items-center justify-between text-text-secondary">
                        <p className="text-text-secondary truncate">
                          To: <strong>{emailTo.join(', ')}</strong>
                        </p>
                        <span className="font-mono text-[10px]">{timeStr}</span>
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-border/80 bg-surface-light p-4 text-xs space-y-3 shadow-xs">
                    <div className="flex items-center gap-2 pb-2 border-b border-border/60">
                      <Avatar ring="ai" className="h-8 w-8 shrink-0">
                        <AvatarImage src={SPIDER.image} alt="Spider" className="object-contain" />
                        <AvatarFallback tone="solid">🕷️</AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-bold text-text-primary">Spider Lead Alert</p>
                      </div>
                    </div>

                    <div className="rounded-lg bg-danger-surface border border-danger-border p-2.5 text-danger-text font-semibold text-[11px] flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>Action Required: Lead has been inactive for {elapsedText(selectedLog.elapsed)} in {selectedLog.stage_name ?? '—'} stage.</span>
                    </div>

                    <div className="space-y-1.5 text-text-secondary leading-relaxed whitespace-pre-line text-[11px]">
                      {selectedLog.email_body ?? '—'}
                    </div>

                    <div className="pt-2">
                      <Button
                        type="button"
                        variant="solid"
                        tone="ai"
                        size="sm"
                        onClick={onOpenLead}
                        className="w-full gap-1.5"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Open Lead #{selectedLog.lead_number} in Pipeline
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* 2. SMS Preview */}
            {previewTab === 'sms' && (() => {
              const isSmsSkipped = sms?.status === 'SKIPPED';

              return (
                <div className="space-y-3">
                  {!isSmsSkipped && (
                    <div className="rounded-xl border border-border/70 bg-background-light/40 p-3 text-xs">
                      <p className="text-text-secondary">
                        SMS Target Recipients: <strong>{recipientNames.join(', ')}</strong>
                      </p>
                    </div>
                  )}

                  {/* Phone chat bubble style */}
                  <div className="rounded-2xl border border-border/80 bg-background-light/30 p-4 space-y-2">
                    <div className="text-center text-[10px] text-text-soft font-mono">
                      SMS Message • {timeStr}
                    </div>
                    <div className="max-w-[90%] rounded-2xl rounded-tl-sm bg-ai-600 text-on-fill p-3.5 text-xs leading-relaxed shadow-sm">
                      <p className="font-semibold text-[11px] mb-1 opacity-90">🕷️ Spider AI Alert:</p>
                      <p className="whitespace-pre-line">{selectedLog.sms_message ?? '—'}</p>
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
                      {`Overdue Lead: #${selectedLog.lead_number} - ${selectedLog.customer_name}`}
                    </p>
                    <p className="text-xs text-text-secondary leading-relaxed">
                      {selectedLog.in_app_message ?? '—'}
                    </p>
                    <div className="pt-2 flex items-center gap-2">
                      <span className="text-[10px] font-mono text-ai-600 font-bold">
                        {timeStr}
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
  );
}
