import React, { useState } from 'react';
import { useBeeStore } from '@/stores/beeStore';
import { formatSnakeCase } from '@/lib/utils';
import {
  Users,
  PhoneIncoming,
  ListOrdered,
  AlertTriangle,
  Play,
  Rocket,
  Pause,
  Phone,
  Hand,
  Clock,
  Sparkles,
  ChevronRight,
  ShieldAlert,
  ShieldCheck,
  Hammer,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Heading } from '@/ui-kit/components/ui/heading';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui-kit/components/ui/table';
import { OutcomeBadge as MultiOutcomeBadge } from './BeeCallLogTab';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { token } from '@/design-system';

// Color mapping to design tokens for outcome tags
const OUTCOME_COLORS: Record<string, string> = {
  'Warranty lead': '#2F7D5D',
  'New Job lead': '#316CCC',
  'New-work lead': '#316CCC',
  'Callback later - office': token('--warning-border'),
  'Need Human': token('--ai-border'),
  'complaints - Need human': token('--danger-text'),
  'Not interested': token('--text-soft'),
  'Has other Coverage': token('--info-text'),
  'No answer/Machine': token('--border-color'),
  'Wrong Number': token('--warning-strong'),
  'Donot Call': token('--ocean-900'),
  'others': token('--success'),
};

const getOutcomeColor = (key: string): string => {
  return OUTCOME_COLORS[key] || token('--success');
};

export const BeeHomeTab: React.FC = () => {
  const {
    metrics,
    settings,
    setupDone,
    isLoading,
    error,
    setActiveTab,
    homeDateRange,
    setHomeDateRange,
    homeAgentFilter,
    setHomeAgentFilter,
    loadCalls,
    openCallDetail,
    setCallsFilterOutcome,
  } = useBeeStore();

  const totalSteps = 7;
  const currentDoneList =
    settings?.setup_config?.setupDone && Array.isArray(settings.setup_config.setupDone)
      ? settings.setup_config.setupDone.slice(0, totalSteps)
      : (setupDone || [0, 0, 0, 0, 0, 0, 0]).slice(0, totalSteps);
  const doneCount = currentDoneList.filter((d: number) => d === 1).length;
  const remainingSteps = Math.max(0, totalSteps - doneCount);
  const isLive = Boolean(metrics?.isActive ?? settings?.is_active);

  const [hoveredDay, setHoveredDay] = useState<any | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  React.useEffect(() => {
    loadCalls(1);
  }, [loadCalls]);

  const funnel = metrics?.funnel ?? null;
  const callsPerDay = metrics?.callsPerDay ?? [];
  const needsHumanList = metrics?.needsHuman ?? [];
  const upcomingList = metrics?.upcomingExpirations ?? [];
  const recentCallsList = metrics?.recentCalls ?? [];

  // SVG dimensions for Stacked Bar Chart
  const svgWidth = 460;
  const svgHeight = 180;
  const padLeft = 28;
  const padBottom = 24;
  const chartMax = 30;
  const barWidth = 32;
  const step = callsPerDay.length > 0 ? (svgWidth - padLeft - 10) / callsPerDay.length : 1;

  return (
    <div className="space-y-4 font-sans text-text-primary">
      {/* Toast notification */}
      {toastMessage && (
        <div className="fixed bottom-6 right-6 z-50 bg-ocean-900 text-on-fill px-4 py-2.5 rounded-xl shadow-xl text-xs font-semibold flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2">
          <Sparkles className="h-4 w-4 text-warning" />
          {toastMessage}
        </div>
      )}

      {/* Setup Readiness Banner when Bee is Deactivated */}
      {!isLive && (
        <div className="flex items-center gap-3 bg-ai-50 border border-ai-200 rounded-2xl px-5 py-3.5 text-sm shadow-xs">
          <Rocket className="h-5 w-5 text-ai-600 flex-shrink-0" />
          <div className="flex-1">
            <strong className="text-ai-600 font-bold">
              {remainingSteps > 0
                ? `Finish setup - ${remainingSteps} step${remainingSteps === 1 ? '' : 's'} left.`
                : `Setup complete - ${totalSteps} of ${totalSteps} steps done.`}
            </strong>{' '}
            <span className="text-text-secondary text-xs">
              {remainingSteps > 0
                ? `Bee can only be activated from the Test & go live tab after all ${totalSteps} setup steps are completed.`
                : 'Proceed to the Test & go live tab in Setup to activate Bee.'}
            </span>
          </div>
          <Button
            size="sm"
            onClick={() => setActiveTab('setup')}
            className="h-8 px-3"
          >
            {remainingSteps > 0 ? 'Continue setup' : 'Go to Test & go live'}
          </Button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-2.5">
          <Select value={homeAgentFilter} onValueChange={(val) => setHomeAgentFilter(val)}>
            <SelectTrigger className="w-[190px] h-9">
              <SelectValue placeholder="All agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              <SelectItem value="doors">Warranty - Doors</SelectItem>
              <SelectItem value="security">Warranty - Security</SelectItem>
            </SelectContent>
          </Select>

          <Select value={homeDateRange} onValueChange={(val) => setHomeDateRange(val)}>
            <SelectTrigger className="w-[150px] h-9">
              <SelectValue placeholder="Date range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="yesterday">Yesterday</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Summary KPI Cards Grid matching mockup */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3.5">
        {/* Customers Called / Total Calls */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setActiveTab('calls')}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setActiveTab('calls')}
          className="p-4 rounded-2xl bg-surface-light border border-border/80 hover:border-brand/40 text-left shadow-sm transition hover:shadow-md group cursor-pointer"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-text-secondary group-hover:text-text-primary">
            <Users className="h-4 w-4 text-brand" />
            <span>Customers called</span>
          </div>
          <div className="text-2xl font-bold mt-2 tracking-tight text-text-primary">
            {isLoading && !metrics ? (
              <span className="text-text-secondary animate-pulse text-xl">Loading...</span>
            ) : metrics ? (
              metrics.kpis?.customersCalled?.value ?? funnel?.totalCalls ?? 0
            ) : (
              '-'
            )}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {isLoading && !metrics
              ? 'Loading metrics...'
              : metrics
              ? metrics.kpis?.customersCalled?.subtitle || '0 call attempts'
              : error
              ? 'Unavailable'
              : '-'}
          </div>
        </div>

        {/* Reached */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setActiveTab('calls')}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setActiveTab('calls')}
          className="p-4 rounded-2xl bg-surface-light border border-border/80 hover:border-brand/40 text-left shadow-sm transition hover:shadow-md group cursor-pointer"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-text-secondary group-hover:text-text-primary">
            <PhoneIncoming className="h-4 w-4 text-success-text" />
            <span>Reached</span>
          </div>
          <div className="text-2xl font-bold mt-2 tracking-tight text-text-primary">
            {isLoading && !metrics ? (
              <span className="text-text-secondary animate-pulse text-xl">Loading...</span>
            ) : metrics ? (
              metrics.kpis?.reached?.value ?? funnel?.reached ?? 0
            ) : (
              '-'
            )}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {isLoading && !metrics
              ? 'Loading metrics...'
              : metrics
              ? metrics.kpis?.reached?.subtitle || `${funnel?.reachRate ?? 0}% reach rate`
              : error
              ? 'Unavailable'
              : '-'}
          </div>
        </div>

        {/* Warranty leads */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            setCallsFilterOutcome('INTERESTED_WARRANTY');
            setActiveTab('calls');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              setCallsFilterOutcome('INTERESTED_WARRANTY');
              setActiveTab('calls');
            }
          }}
          className="p-4 rounded-2xl bg-surface-light border border-border/80 hover:border-brand/40 text-left shadow-sm transition hover:shadow-md group cursor-pointer"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-text-secondary group-hover:text-text-primary">
            <ShieldCheck className="h-4 w-4 text-success-text" />
            <span>Warranty leads</span>
          </div>
          <div className="text-2xl font-bold mt-2 tracking-tight text-text-primary">
            {isLoading && !metrics ? (
              <span className="text-text-secondary animate-pulse text-xl">Loading...</span>
            ) : metrics ? (
              metrics.kpis?.warrantyLeads?.value ?? metrics.counts?.warrantyLeadsCount ?? 0
            ) : (
              '-'
            )}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {isLoading && !metrics
              ? 'Loading metrics...'
              : metrics
              ? metrics.kpis?.warrantyLeads?.subtitle || '0 won'
              : error
              ? 'Unavailable'
              : '-'}
          </div>
        </div>

        {/* New Job leads */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            setCallsFilterOutcome('INTERESTED_NEW_WORK');
            setActiveTab('calls');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              setCallsFilterOutcome('INTERESTED_NEW_WORK');
              setActiveTab('calls');
            }
          }}
          className="p-4 rounded-2xl bg-surface-light border border-border/80 hover:border-brand/40 text-left shadow-sm transition hover:shadow-md group cursor-pointer"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-text-secondary group-hover:text-text-primary">
            <Hammer className="h-4 w-4 text-info-text" />
            <span>New Job leads</span>
          </div>
          <div className="text-2xl font-bold mt-2 tracking-tight text-text-primary">
            {isLoading && !metrics ? (
              <span className="text-text-secondary animate-pulse text-xl">Loading...</span>
            ) : metrics ? (
              metrics.kpis?.newWorkLeads?.value ?? metrics.counts?.newWorkLeadsCount ?? 0
            ) : (
              '-'
            )}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {isLoading && !metrics
              ? 'Loading metrics...'
              : metrics
              ? metrics.kpis?.newWorkLeads?.subtitle || '$0 estimated'
              : error
              ? 'Unavailable'
              : '-'}
          </div>
        </div>

        {/* In queue */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setActiveTab('queue')}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setActiveTab('queue')}
          className="p-4 rounded-2xl bg-surface-light border border-border/80 hover:border-brand/40 text-left shadow-sm transition hover:shadow-md group cursor-pointer"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-text-secondary group-hover:text-text-primary">
            <ListOrdered className="h-4 w-4 text-warning-text" />
            <span>In queue</span>
          </div>
          <div className="text-2xl font-bold mt-2 tracking-tight text-text-primary">
            {isLoading && !metrics ? (
              <span className="text-text-secondary animate-pulse text-xl">Loading...</span>
            ) : metrics ? (
              metrics.kpis?.inQueue?.value ?? funnel?.queued ?? 0
            ) : (
              '-'
            )}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {isLoading && !metrics
              ? 'Loading metrics...'
              : metrics
              ? metrics.kpis?.inQueue?.subtitle || ''
              : error
              ? 'Unavailable'
              : '-'}
          </div>
        </div>

        {/* Needs Human */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => {
            const el = document.getElementById('needs-human-section');
            if (el) el.scrollIntoView({ behavior: 'smooth' });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              const el = document.getElementById('needs-human-section');
              if (el) el.scrollIntoView({ behavior: 'smooth' });
            }
          }}
          className="p-4 rounded-2xl bg-danger-surface/40 border border-danger-border text-left shadow-sm transition hover:shadow-md group cursor-pointer"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-danger-text">
            <AlertTriangle className="h-4 w-4 text-danger-strong" />
            <span>Needs a human</span>
          </div>
          <div className="text-2xl font-bold mt-2 tracking-tight text-danger-strong">
            {isLoading && !metrics ? (
              <span className="text-danger-text animate-pulse text-xl">Loading...</span>
            ) : metrics ? (
              metrics.kpis?.needsHumanCount?.value ?? needsHumanList.length
            ) : (
              '-'
            )}
          </div>
          <div className="text-xs text-danger-text/80 mt-0.5">
            {isLoading && !metrics
              ? 'Loading metrics...'
              : metrics
              ? 'Action required by office'
              : error
              ? 'Unavailable'
              : '-'}
          </div>
        </div>
      </div>

      {/* Row 1: Outcome Funnel & Calls Per Day */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Outcome Funnel Card */}
        <div className="p-5 rounded-2xl bg-surface-light border border-border/80 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <Heading level={3} scale="sm" className="font-bold text-text-primary">Outcome funnel</Heading>
              <span className="text-xs text-text-secondary">
                {homeDateRange === 'today' ? 'today' : homeDateRange === '30d' ? 'last 30 days' : 'last 7 days'}
              </span>
            </div>

            {/* ONLY the 3 metrics specified by user */}
            {funnel ? (
              <div className="space-y-3.5">
                {/* 1. Queued */}
                <div className="grid grid-cols-[130px_1fr_48px] items-center gap-3 text-xs">
                  <span className="font-semibold text-text-secondary">Queued</span>
                  <div className="h-5 bg-muted rounded-md overflow-hidden relative border border-border/40">
                    <div
                      className="h-full bg-ocean-800 rounded-md transition-all duration-500"
                      style={{ width: '100%' }}
                    />
                  </div>
                  <strong className="text-right font-bold text-text-primary">
                    {funnel.queued}
                  </strong>
                </div>

                {/* 2. Total Calls Made */}
                <div className="grid grid-cols-[130px_1fr_48px] items-center gap-3 text-xs">
                  <span className="font-semibold text-text-secondary">Total calls made</span>
                  <div className="h-5 bg-muted rounded-md overflow-hidden relative border border-border/40">
                    <div
                      className="h-full bg-ocean-700 rounded-md transition-all duration-500"
                      style={{
                        width: `${funnel.queued > 0 ? Math.min(100, Math.max(5, (funnel.totalCalls / funnel.queued) * 100)) : 0}%`,
                      }}
                    />
                  </div>
                  <strong className="text-right font-bold text-text-primary">
                    {funnel.totalCalls}
                  </strong>
                </div>

                {/* 3. Reached */}
                <div className="grid grid-cols-[130px_1fr_48px] items-center gap-3 text-xs">
                  <span className="font-semibold text-text-secondary">Reached</span>
                  <div className="h-5 bg-muted rounded-md overflow-hidden relative border border-border/40">
                    <div
                      className="h-full bg-success rounded-md transition-all duration-500"
                      style={{
                        width: `${funnel.queued > 0 ? Math.min(100, Math.max(5, (funnel.reached / funnel.queued) * 100)) : 0}%`,
                      }}
                    />
                  </div>
                  <strong className="text-right font-bold text-text-primary">
                    {funnel.reached}
                  </strong>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-10 text-xs text-text-secondary">
                {isLoading && !metrics ? (
                  <span className="animate-pulse">Loading funnel data...</span>
                ) : (
                  <span>Outcome funnel unavailable</span>
                )}
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-border mt-4 flex items-center justify-between text-xs text-text-secondary">
            <p className="italic">Weekends show zero because calls only run Mon-Fri.</p>
            <span className="font-bold text-success-text">
              {funnel ? `${funnel.reachRate}% Reach Rate` : (isLoading ? '...' : '-')}
            </span>
          </div>
        </div>

        {/* Calls Per Day Card (with color-coded outcome tags) */}
        <div className="p-5 rounded-2xl bg-surface-light border border-border/80 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <Heading level={3} scale="sm" className="font-bold text-text-primary">Calls per day</Heading>
              <span className="text-xs text-text-secondary">by outcome tag</span>
            </div>

            {/* Interactive SVG Stacked Bar Chart */}
            {callsPerDay.length > 0 ? (
              <div className="relative w-full overflow-hidden">
                <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-auto">
                  {/* Horizontal reference gridlines */}
                  {[0, 10, 20, 30].map((v) => {
                    const y = svgHeight - padBottom - (v / chartMax) * (svgHeight - padBottom - 12);
                    return (
                      <g key={v}>
                        <line
                          x1={padLeft}
                          x2={svgWidth - 8}
                          y1={y}
                          y2={y}
                          stroke="currentColor"
                          className="text-border"
                          strokeWidth="1"
                        />
                        <text
                          x={padLeft - 6}
                          y={y + 3}
                          textAnchor="end"
                          className="text-[10px] fill-text-soft font-mono"
                        >
                          {v}
                        </text>
                      </g>
                    );
                  })}

                  {/* Day Bars */}
                  {callsPerDay.map((day, i) => {
                    let currentY = svgHeight - padBottom;
                    const x = padLeft + i * step + (step - barWidth) / 2;

                    const outcomeKeys = Object.keys(day.outcomes || {});

                    return (
                      <g
                        key={day.date}
                        onMouseEnter={() => setHoveredDay(day)}
                        onMouseLeave={() => setHoveredDay(null)}
                        className="cursor-pointer transition-opacity hover:opacity-85"
                      >
                        {outcomeKeys.map((key) => {
                          const count = day.outcomes[key] || 0;
                          if (!count) return null;
                          const h = (count / chartMax) * (svgHeight - padBottom - 12);
                          currentY -= h;
                          const fill = getOutcomeColor(key);
                          return (
                            <rect
                              key={key}
                              x={x}
                              y={currentY}
                              width={barWidth}
                              height={h}
                              fill={fill}
                              rx={2}
                            />
                          );
                        })}

                        {/* Day Label on X Axis */}
                        <text
                          x={x + barWidth / 2}
                          y={svgHeight - 6}
                          textAnchor="middle"
                          className="text-[10px] fill-text-soft font-medium"
                        >
                          {day.dayLabel}
                        </text>
                      </g>
                    );
                  })}
                </svg>

                {/* Hover Tooltip Overlay */}
                {hoveredDay && (
                  <div className="absolute top-2 right-2 bg-ocean-900 text-on-fill text-[11px] p-2.5 rounded-xl shadow-lg z-10 pointer-events-none border border-ocean-700">
                    <div className="font-bold border-b border-ocean-700 pb-1 mb-1 text-on-fill">
                      {hoveredDay.dayLabel} ({hoveredDay.total} calls)
                    </div>
                    {Object.entries(hoveredDay.outcomes || {}).map(([k, v]: [string, any]) =>
                      v > 0 ? (
                        <div key={k} className="flex items-center justify-between gap-3 text-xs">
                          <span className="flex items-center gap-1.5">
                            <span
                              className="w-2 h-2 rounded-full inline-block"
                              style={{ background: getOutcomeColor(k) }}
                            />
                            {formatSnakeCase(k)}
                          </span>
                          <strong className="font-bold">{v}</strong>
                        </div>
                      ) : null
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-[180px] text-xs text-text-secondary">
                {isLoading && !metrics ? (
                  <span className="animate-pulse">Loading call activity...</span>
                ) : (
                  <span>No call activity data to display</span>
                )}
              </div>
            )}
          </div>

          {/* Outcome Tag Legend */}
          <div className="pt-3 border-t border-border mt-3 flex flex-wrap gap-x-3.5 gap-y-1.5 text-[11px] text-text-secondary">
            {Object.entries(OUTCOME_COLORS).map(([tag, color]) => (
              <span key={tag} className="inline-flex items-center gap-1.5 font-medium">
                <i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Row 2: Needs a Human & Upcoming Warranty Expirations */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Needs a Human Card */}
        <div id="needs-human-section" className="p-5 rounded-2xl bg-surface-light border border-border/80 shadow-sm space-y-3">
          <div className="flex items-center justify-between border-b border-border pb-3">
            <Heading level={3} scale="sm" className="font-bold flex items-center gap-2 text-text-primary">
              <Hand className="h-4 w-4 text-danger-strong" />
              Needs a human
            </Heading>
            <span className="text-xs font-bold text-danger-text bg-danger-surface px-2.5 py-0.5 rounded-full border border-danger-border">
              {isLoading && !metrics ? '...' : metrics ? `${needsHumanList.length} open` : '-'}
            </span>
          </div>

          <div className="divide-y divide-border">
            {needsHumanList.map((item) => {
              const isComplaint = item.tag.toLowerCase().includes('complaint');
              const isCallback = item.tag.toLowerCase().includes('callback');
              const borderAccent = isComplaint
                ? 'border-l-4 border-danger bg-danger-surface/20'
                : isCallback
                ? 'border-l-4 border-warning bg-warning-surface/20'
                : 'border-l-4 border-ai-500 bg-ai-50/20';

              return (
                <div
                  key={item.id}
                  className={`pl-3 py-3 ${borderAccent} flex items-center justify-between gap-3 hover:bg-muted/30 transition rounded-r-xl`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-text-primary">
                        {item.customerName}
                      </span>
                      <BeeOutcomeTag tag={item.tag} />
                    </div>
                    <p className="text-xs text-text-secondary line-clamp-1 mt-0.5">
                      {item.reason}
                    </p>
                  </div>

                  <div className="flex-shrink-0 flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => showToast(`Calling ${item.customerName} directly from your line…`)}
                      className="h-8 gap-1.5"
                    >
                      <Phone className="h-3.5 w-3.5" />
                      Call now
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => showToast(`Assigned ${item.customerName} callback ticket to dispatcher.`)}
                      className="h-8"
                    >
                      Assign
                    </Button>
                  </div>
                </div>
              );
            })}

            {needsHumanList.length === 0 && (
              <div className="text-center py-8 text-xs text-text-secondary">
                {isLoading && !metrics
                  ? 'Loading items...'
                  : error
                  ? 'Unable to load human assistance items.'
                  : 'No active human assistance requests. All calls handled autonomously by Bee!'}
              </div>
            )}
          </div>
        </div>

        {/* Upcoming Warranty Expirations Card (< 30 days) */}
        <div className="p-5 rounded-2xl bg-surface-light border border-border/80 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between border-b border-border pb-3 mb-3">
              <Heading level={3} scale="sm" className="font-bold text-text-primary">Upcoming warranty expirations</Heading>
              <span className="text-xs text-text-secondary font-medium">next 30 days</span>
            </div>

            <div className="overflow-x-auto">
              <Table className="w-full text-left text-xs border-collapse">
                <TableHeader>
                  <TableRow className="border-b border-border text-text-secondary font-semibold uppercase tracking-wider text-[11px]">
                    <TableHead className="pb-2.5 font-bold">Customer</TableHead>
                    <TableHead className="pb-2.5 font-bold">Job</TableHead>
                    <TableHead className="pb-2.5 font-bold">Ends</TableHead>
                    <TableHead className="pb-2.5 font-bold text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="divide-y divide-border">
                  {upcomingList.map((row) => (
                    <TableRow key={row.id} className="hover:bg-muted/30 transition">
                      <TableCell><span className="font-bold text-text-primary">{row.customerName}</span></TableCell>
                      <TableCell><span className="text-text-secondary">{row.job}</span></TableCell>
                      <TableCell><span className="font-medium text-text-primary">{row.warrantyEndDate}</span></TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <BeeStatusTag status={row.status} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {upcomingList.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-8 text-xs text-text-secondary">
                        {isLoading && !metrics
                          ? 'Loading upcoming expirations...'
                          : error
                          ? 'Unable to load upcoming expirations.'
                          : 'No upcoming warranty expirations found.'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="pt-3 border-t border-border mt-3 text-xs text-text-secondary flex items-center justify-between">
            <span>Jobs approaching expiration enter the dial queue automatically.</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveTab('queue')}
              className="h-auto p-0"
            >
              <span className="text-brand hover:underline font-semibold text-xs flex items-center gap-0.5">
                View Queue <ChevronRight className="h-3 w-3" />
              </span>
            </Button>
          </div>
        </div>
      </div>

      {/* Row 3: Recent Calls (Full Width Table) */}
      <div className="p-5 rounded-2xl bg-surface-light border border-border/80 shadow-sm">
        <div className="flex items-center justify-between border-b border-border pb-3 mb-3">
          <Heading level={3} scale="sm" className="font-bold text-text-primary">Recent calls</Heading>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setActiveTab('calls')}
            className="h-8"
          >
            Open call log
          </Button>
        </div>

        <div className="overflow-x-auto">
          <Table className="w-full text-left text-xs border-collapse">
            <TableHeader>
              <TableRow className="border-b border-border text-text-secondary font-bold uppercase tracking-wider text-[11px]">
                <TableHead className="pb-2.5">Date &amp; time</TableHead>
                <TableHead className="pb-2.5">Customer</TableHead>
                <TableHead className="pb-2.5">Phone</TableHead>
                <TableHead className="pb-2.5">Job #</TableHead>
                <TableHead className="pb-2.5">Job Type</TableHead>
                <TableHead className="pb-2.5">Warranty ends</TableHead>
                <TableHead className="pb-2.5">Agent</TableHead>
                <TableHead className="pb-2.5">Attempt</TableHead>
                <TableHead className="pb-2.5">Length</TableHead>
                <TableHead className="pb-2.5">Outcome</TableHead>
                <TableHead className="pb-2.5">Call cost</TableHead>
                <TableHead className="pb-2.5 text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="divide-y divide-border">
              {recentCallsList.map((call) => (
                <TableRow
                  key={call.id}
                  onClick={() => openCallDetail(call as any)}
                  className="hover:bg-muted/30 transition cursor-pointer group"
                >
                  <TableCell><span className="text-text-secondary whitespace-nowrap">{call.t}</span></TableCell>
                  <TableCell><span className="font-bold text-text-primary whitespace-nowrap">{call.c}</span></TableCell>
                  <TableCell><span className="font-mono text-text-secondary whitespace-nowrap">{call.p}</span></TableCell>
                  <TableCell><span className="font-medium text-primary whitespace-nowrap">{(call.job_number || call.j || '-').replace(/^#/, '')}</span></TableCell>
                  <TableCell><span className="text-text-secondary whitespace-nowrap">{formatSnakeCase(call.job_type || call.jt || 'General Service')}</span></TableCell>
                  <TableCell><span className="text-text-secondary whitespace-nowrap">{call.we}</span></TableCell>
                  <TableCell><span className="text-text-secondary whitespace-nowrap">{call.ag}</span></TableCell>
                  <TableCell><span className="text-text-secondary whitespace-nowrap">{call.at}</span></TableCell>
                  <TableCell><span className="font-mono text-text-secondary whitespace-nowrap">{call.d}</span></TableCell>
                  <TableCell>
                    <MultiOutcomeBadge
                      outcome={call.outcome || call.o}
                      outcomes={call.outcomes}
                      lf={call.lf}
                    />
                  </TableCell>
                  <TableCell><span className="font-semibold text-text-primary whitespace-nowrap">{call.v}</span></TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCallDetail(call as any);
                        }}
                        className="h-7 w-7"
                        aria-label="Play recording"
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {recentCallsList.length === 0 && (
                <TableRow>
                  <TableCell colSpan={12} className="text-center py-8 text-xs text-text-secondary">
                    {isLoading && !metrics
                      ? 'Loading recent calls...'
                      : error
                      ? 'Unable to load recent calls.'
                      : 'No recent calls recorded.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
};

// Clean tag badge for call outcomes matching CRM design tokens
export const BeeOutcomeTag: React.FC<{ tag: string }> = ({ tag }) => {
  const t = (tag || '').toLowerCase();
  if (t.includes('complaint')) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-danger-surface text-danger-text border border-danger-border">
        complaints - Need human
      </span>
    );
  }
  if (t.includes('callback')) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-warning-surface text-warning-text border border-warning-border">
        Callback later - office
      </span>
    );
  }
  if (t.includes('human') || t === 'need human') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-ai-50 text-ai-600 border border-ai-200">
        Need Human
      </span>
    );
  }
  if (t.includes('coverage') || t.includes('covered')) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-info-surface text-info-text border border-info-border">
        Has other Coverage
      </span>
    );
  }
  if (t.includes('not interested') || t.includes('not_interested')) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-neutral-surface text-neutral-text border border-neutral-border">
        Not interested
      </span>
    );
  }
  if (t.includes('no answer') || t.includes('machine') || t.includes('voicemail')) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-neutral-surface text-text-soft border border-border">
        No answer/Machine
      </span>
    );
  }
  if (t.includes('wrong')) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-warning-surface text-warning-strong border border-warning-border">
        Wrong Number
      </span>
    );
  }
  if (t.includes('dnc') || t.includes('opt_out') || t.includes('donot')) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-ocean-900 text-on-fill border border-ocean-900">
        Donot Call
      </span>
    );
  }
  if (t.includes('lead') || t.includes('sold') || t.includes('others') || t.includes('both') || t.includes('warranty')) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-success-surface text-success-text border border-success-border">
        Lead created
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-neutral-surface text-text-secondary border border-border">
      {formatSnakeCase(tag)}
    </span>
  );
};

// Status tag helper for upcoming expirations table matching CRM tokens
export const BeeStatusTag: React.FC<{ status: string }> = ({ status }) => {
  const s = status.toLowerCase();
  if (s.includes('lead') || s.includes('created')) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-success-surface text-success-text border border-success-border">Lead created</span>;
  }
  if (s.includes('callback')) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-warning-surface text-warning-text border border-warning-border">Callback</span>;
  }
  if (s.includes('queued')) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-info-surface text-info-text border border-info-border">Queued</span>;
  }
  if (s.includes('skipped')) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-danger-surface text-danger-text border border-danger-border">Skipped</span>;
  }
  if (s.includes('called')) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-neutral-surface text-text-secondary border border-border">Called</span>;
  }
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-neutral-surface text-text-secondary border border-border">{formatSnakeCase(status)}</span>;
};

// Backward-compatible OutcomeBadge export for other tabs/modals
export const OutcomeBadge: React.FC<{ outcome: string }> = ({ outcome }) => {
  return <BeeOutcomeTag tag={outcome} />;
};
