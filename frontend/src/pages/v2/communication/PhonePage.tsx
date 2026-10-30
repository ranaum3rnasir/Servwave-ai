import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, Ban, BarChart3, GraduationCap, Hash, ListChecks, MessageSquare, Phone,
  PhoneCall, PhoneMissed, Shield, Users, Workflow,
} from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import type { AppAction } from '@/lib/ability';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useIsCommunicationPilotOrg } from '@/lib/useIsCommunicationPilotOrg';

import {
  blockNumberErrorMessage, groupTargetOptions, useBlockedNumbers, useBlockNumber, useCallFlows,
  useCallGroups, useCalls, useMessageThreads, useNumbers, usePhoneAgents, usePhoneCustomers,
  useUnblockNumber,
} from '@/lib/api/communication';
import type {
  BlockReason, CallFlow, CallGroup, CallSession, MessageThread,
} from '@/lib/api/communication';

import {
  callNeedsAttention, computeRange, countCallsOnDay, DateRangeControl, DEMO_NOW,
  describeSearchScope, NEEDS_ATTENTION_WITHOUT_INSIGHTS_HELP,
} from '@/components/communication/phone/shared';
import type { CallsFocus, RangePreset, Tab } from '@/components/communication/phone/shared';

import { openPhoneTab } from '@/lib/communication/phoneTabHandoff';
import { BlockedCallersView } from '@/components/communication/phone/BlockedCallersView';
import { CallFlowsView } from '@/components/communication/phone/CallFlows';
import { CallGroupsView } from '@/components/communication/phone/CallGroups';
import { CallMaskingView } from '@/components/communication/phone/CallMaskingView';
import { CallsView } from '@/components/communication/phone/CallsView';
import { DispatchView } from '@/components/communication/phone/DispatchView';
import { NumbersView } from '@/components/communication/phone/NumbersView';
import type { OwnedNumber } from '@/components/communication/phone/NumbersView';
import { PerformanceView } from '@/components/communication/phone/PerformanceView';
import { TrainingView } from '@/components/communication/phone/TrainingView';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { toast } from '@/ui-kit/components/ui/sonner';
import { useIsBelow, useIsShortHeight } from '@/ui-kit/hooks/useMediaQuery';
import { cn } from '@/ui-kit/lib/utils';

import { TabStrip } from '../_shared/tabs';
import { v2Path } from '../uiV2';
import { PlanUsage } from './components/planUsage';
import { ModuleTabPanel, useRoutedTab } from './components/routedTabs';
import { useRecordVisit } from '../pageBreadcrumbs';
import { useScheduleTimezone } from '@/lib/schedule-tz';

/** Top-level pages of the Phone module (the Workiz-style primary nav). */
type ModuleSection =
  | 'calls' | 'numbers' | 'flows' | 'masking' | 'groups' | 'training' | 'blocked';

type KpiKey = 'calls' | 'callback' | 'unread' | 'attention';

const MODULE_TABS: {
  key: ModuleSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { key: 'calls', label: 'Calls', icon: ListChecks },
  { key: 'numbers', label: 'Phone numbers', icon: Hash },
  { key: 'flows', label: 'Call flows', icon: Workflow },
  { key: 'masking', label: 'Call masking', icon: Shield },
  { key: 'groups', label: 'Call groups', icon: Users },
  { key: 'training', label: 'Training', icon: GraduationCap },
  { key: 'blocked', label: 'Blocked callers', icon: Ban },
];

const MODULE_SECTION_KEYS = MODULE_TABS.map((t) => t.key);

/** The switch (as the action it compiles into) a person needs to see each section. Calls has none: it shows whenever Show
 *  Phone is on. The org gates below sit on top of these, never instead of them. */
const SECTION_SWITCH: Record<Exclude<ModuleSection, 'calls'>, AppAction> = {
  numbers: 'phone_numbers_tab',
  flows: 'call_flows_tab',
  masking: 'call_masking_tab',
  groups: 'call_groups_tab',
  training: 'training_tab',
  blocked: 'blocked_callers_tab',
};

// Prototype-only surface (mock-fed, no backend): visible ONLY for demo orgs.
const DEMO_ONLY_SECTIONS: ModuleSection[] = ['masking'];

// Sections not yet ready for every real org, but visible for the live CTM pilot
// org and the demo org - locked for every other real org so nothing looks
// half-built. flows/groups have local-only Save; training's scoring is
// simulated.
//
// `blocked` is the exception: it IS fully backed (real BlockedNumber rows,
// honoured by call ingest). It sits here on Ran's scope call (2026-08-13, a
// customer's phone launch): a newly phone-enabled org gets the two pages it needs
// to buy a number and watch its calls, and nothing else. Move it out of this
// list when call screening is part of the launch surface.
const PILOT_AND_DEMO_SECTIONS: ModuleSection[] = ['flows', 'groups', 'training', 'blocked'];

/**
 * /v2/communication/phone - the Phone module hub on the CRM UI kit.
 *
 * A SHELL, exactly as the legacy page is. It owns the module-level lifted state
 * that several sub-views mutate (calls / threads / numbers / call flows / call
 * groups), renders the primary nav, the Calls KPI strip and the Calls sub-tabs,
 * and hands each section to the sub-view component that already implements it.
 * Every sub-view is imported unchanged - the kit has no call log, no IVR
 * builder, no call-group editor and no training simulator to replace them with,
 * and re-authoring 9,000 lines of them would not be a restyle.
 *
 * Preserved exactly, because losing any of them is a behaviour change:
 *
 *   - the `if (seed.length) set...` hydration guard on every lifted array, so
 *     an empty response never clears a locally mutated list
 *   - `setNumbers` / `setCallFlows` / `setCallGroups` / `setCalls` identity, so
 *     the numbers <-> flows link and the dispatch queue keep working
 *   - the demo-org and pilot-org section gates, including the rule that a deep
 *     link to a hidden section falls back to Calls rather than 404ing
 *   - the "Unread messages" KPI navigating to the Text page instead of
 *     selecting a tab
 *   - the CASL gate returning BEFORE any JSX, above which every query has
 *     already fired
 *
 * The dialer is NOT embedded here. It lives in the dedicated `/phone` tab - the
 * single softphone device-owner surface - and this page's button opens that tab
 * through the shared handoff, as the legacy page does.
 */
export default function PhonePage() {
  useRecordVisit('comm-phone', 'Phone');
  const navigate = useNavigate();
  const ability = useAppAbility();
  const canRead = ability.can('read', 'Communication');
  // See call insights (S08.13): the Performance & QA sub-tab, and the sentiment and review flag Needs Attention counts.
  const mayInsights = ability.can('see_call_insights', 'Communication');
  const isDemo = useIsDemoOrg();
  const isPilot = useIsCommunicationPilotOrg();
  // ServWave's User has no per-branch field; the sales-email decoration uses
  // the product label.
  const branch = 'ServWave';

  const onToast = (m: string) => toast(m);

  const { active: requestedSection, goToTab } = useRoutedTab<ModuleSection>(
    MODULE_SECTION_KEYS,
    'calls',
  );

  // A section is hidden when the org may not see it. Hidden sections are
  // dropped from the nav AND deep links to them fall back to Calls.
  const isSectionHidden = (s: ModuleSection): boolean =>
    (s !== 'calls' && !ability.can(SECTION_SWITCH[s], 'Communication')) ||
    (!isDemo && DEMO_ONLY_SECTIONS.includes(s)) ||
    (!isDemo && !isPilot && PILOT_AND_DEMO_SECTIONS.includes(s));
  const section: ModuleSection = isSectionHidden(requestedSection) ? 'calls' : requestedSection;
  const moduleTabs = MODULE_TABS.filter((t) => !isSectionHidden(t.key));
  // The Phone usage bar follows its own switch.
  const mayUsageBar = ability.can('phone_usage_bar', 'Communication');

  // Within-Calls sub-tab + KPI focus stay local (a sub-nav, no remount needed).
  const [tab, setTab] = useState<Tab>('calls');
  const [activeKpi, setActiveKpi] = useState<KpiKey | null>(null);
  const [callsFocus, setCallsFocus] = useState<CallsFocus>('all');

  const { data: seedCalls = [] } = useCalls();
  const { data: seedThreads = [] } = useMessageThreads();
  // A tab's data is asked for only by a person who sees the tab (its switch, and the org gate on top): the server refuses
  // the rest, and a request bound to fail is not made.
  const { data: seedFlows = [] } = useCallFlows(!isSectionHidden('flows'));
  const { data: seedGroups = [] } = useCallGroups(!isSectionHidden('groups'));
  const { data: blockedNumbers = [] } = useBlockedNumbers(!isSectionHidden('blocked'));
  const { data: seedNumbers = [], isLoading: numbersLoading } = useNumbers();
  // Fired, not read - exactly as the legacy shell fires it, which binds its
  // result to a variable nothing consumes. Kept because the request itself is
  // observable: it warms the shared ['communication','customers'] cache that
  // the softphone's screen-pop reads through its own copy of this hook.
  usePhoneCustomers();
  const { data: phoneAgents = [] } = usePhoneAgents();
  const blockMutation = useBlockNumber();
  const unblockMutation = useUnblockNumber();

  const [calls, setCalls] = useState<CallSession[]>([]);
  const [threads, setThreads] = useState<MessageThread[]>([]);
  // Owned numbers + custom call flows are lifted here so the Call flows tab and
  // the Phone numbers tab share one source of truth: a number's flowId is what
  // links them.
  const [numbers, setNumbers] = useState<OwnedNumber[]>([]);
  const [callFlows, setCallFlows] = useState<CallFlow[]>([]);
  const [callGroups, setCallGroups] = useState<CallGroup[]>([]);

  // The five lifted arrays are server-seeded MIRRORS, and the sub-views below
  // write straight into four of them (DispatchView -> setCalls, NumbersView ->
  // setNumbers, CallFlowsView -> setCallFlows, CallGroupsView -> setCallGroups),
  // so reading the query values directly would discard every un-persisted edit
  // on the next refetch. That is the architecture, not an oversight, and the
  // `if (seed.length)` guard on each is load-bearing too: an empty response must
  // never clear a locally mutated list. Each seed effect is therefore kept and
  // the rule suppressed per site.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DispatchView writes live softphone sessions straight into `calls`, so they exist only client-side until the call ends
    if (seedCalls.length) setCalls(seedCalls);
  }, [seedCalls]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the mirror plus its non-empty guard is what stops a transient empty response zeroing the "Unread messages" KPI that reads `threads`
    if (seedThreads.length) setThreads(seedThreads);
  }, [seedThreads]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- CallFlowsView edits `callFlows` in place, and a number's flowId points into it
    if (seedFlows.length) setCallFlows(seedFlows);
  }, [seedFlows]);
  useEffect(() => {
    // Wording note: write "call group", never the telephony synonym that pairs
    // the word "ring" with a hyphen. The unresolved-class guard scans source
    // text (comments included) for utility-class candidates, and that word is a
    // real Tailwind prefix, so the hyphenated phrase registers as a new unknown
    // utility and fails the guard. Naming the offending token in this note, even
    // inside backticks, trips it just the same.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- CallGroupsView edits call group membership in place through setCallGroups
    if (seedGroups.length) setCallGroups(seedGroups);
  }, [seedGroups]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- `numbers` is the shared source of truth NumbersView and the flow-assignment handler above both write into
    if (seedNumbers.length) setNumbers(seedNumbers);
  }, [seedNumbers]);

  function blockNumber(input: {
    number: string;
    name?: string;
    reason: BlockReason;
    note?: string;
  }) {
    const number = input.number.trim();
    if (!number) return;
    // No client-side duplicate check: the server owns it (409 ALREADY_BLOCKED),
    // and it is the only check that survives a second browser.
    blockMutation.mutate(
      {
        number,
        name: input.name,
        reason: input.reason,
        note: input.note?.trim() || undefined,
      },
      {
        onSuccess: () => onToast(`🚫 Blocked ${input.name ? `${input.name} · ` : ''}${number}`),
        onError: (err) => onToast(blockNumberErrorMessage(err)),
      },
    );
  }

  function unblockNumber(id: string) {
    unblockMutation.mutate(
      { id },
      {
        onSuccess: () => onToast('✓ Number unblocked'),
        onError: (err) => onToast(blockNumberErrorMessage(err)),
      },
    );
  }

  // Assign a flow to a set of numbers (and detach numbers no longer selected),
  // keeping number.flowId as the single source of truth for the linkage.
  function assignFlowToNumbers(flowId: string, numberIds: string[]) {
    setNumbers((prev) =>
      prev.map((n) => {
        if (numberIds.includes(n.id)) return { ...n, flowId };
        if (n.flowId === flowId) return { ...n, flowId: '' };
        return n;
      }),
    );
  }

  // Date-range filter for the Calls page - lifted here so the picker can sit
  // beside the sub-tabs while the table and stats consume the range.
  // Call days are the ORG's days: "calls today" must not roll over at the
  // viewer's midnight.
  const tz = useScheduleTimezone();
  // A phone, or a phone held sideways: too little height for a log inside a page of its own.
  const belowMd = useIsBelow('md');
  const shortHeight = useIsShortHeight();
  const compact = belowMd || shortHeight;
  const [datePreset, setDatePreset] = useState<RangePreset>('30d');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const dateRange = useMemo(
    () => computeRange(datePreset, dateStart, dateEnd, tz, isDemo),
    [datePreset, dateStart, dateEnd, tz, isDemo],
  );
  // The window the Calls search actually covers, so an out-of-range hit reads
  // as "outside this window" rather than "not in the system". `null` under
  // "All time" - nothing is hidden there, so nothing is disclosed.
  const searchScope = useMemo(
    () => describeSearchScope(datePreset, dateStart, dateEnd, tz, isDemo),
    [datePreset, dateStart, dateEnd, tz, isDemo],
  );

  const missed = calls.filter((c) => c.status === 'missed' || c.status === 'voicemail');
  const unreadCount = threads.reduce((s, t) => s + t.unread, 0);
  const needsAttention = calls.filter((c) => callNeedsAttention(c, mayInsights));
  // "Calls today" = calls on the calendar day of the page anchor (DEMO_NOW for
  // demo orgs, real now otherwise), not the all-time count.
  const callsToday = useMemo(
    () => countCallsOnDay(calls, isDemo ? DEMO_NOW : new Date(), tz),
    [calls, isDemo, tz],
  );

  // Coarse module gate. Without read on Communication there's nothing to show.
  if (!canRead) {
    return <EmptyState title="You don't have access to the Phone module." />;
  }

  const showCalls = section === 'calls';

  return (
    // Bounded by the shell (boundedPages.ts): the page is the canvas's one flexible child, never
    // `h-full`. On the Calls section it is also the one scroller whenever the chrome above the log
    // leaves the log less than its 200 px, so the log is never squeezed to nothing (mobile slice 71).
    <div className={cn('flex min-h-0 flex-1 flex-col', showCalls && 'overflow-y-auto overscroll-contain')}>
      <PageHeader
        className="mb-3 shrink-0"
        title="ServWave Phone"
        actions={
          <div className="flex items-center gap-3">
            {/* Every org, not just demo - see the legacy page for why. The meter
                reads the org's own real usage now, so a demo-only gate would
                hide it from exactly the orgs it is for. */}
            {mayUsageBar && <PlanUsage onToast={onToast} branch={branch} />}
            <Button
              onClick={() => openPhoneTab()}
              aria-label="Open dialer"
              title="Open dialer - opens the phone tab"
            >
              <Phone />
              Dialer
            </Button>
          </div>
        }
      />

      {/* Primary module nav: one row that scrolls inside itself (the strip owns that). With only Calls left there is
          nothing to choose between, so no strip of one. */}
      {moduleTabs.length > 1 && (
        <TabStrip
          className="shrink-0"
          value={section}
          onValueChange={(next) => goToTab(next as ModuleSection)}
          tabs={moduleTabs.map((t) => ({
            value: t.key,
            label: <SectionTabLabel icon={t.icon} label={t.label} />,
          }))}
        />
      )}

      <ModuleTabPanel value="training" activeValue={section} className="overflow-y-auto overscroll-contain">
        <TrainingView onToast={onToast} />
      </ModuleTabPanel>

      <ModuleTabPanel value="numbers" activeValue={section} className="overflow-y-auto overscroll-contain">
        <NumbersView
          numbers={numbers}
          setNumbers={setNumbers}
          callFlows={callFlows}
          flowsHidden={isSectionHidden('flows')}
          loading={numbersLoading}
          onToast={onToast}
        />
      </ModuleTabPanel>

      <ModuleTabPanel value="flows" activeValue={section} className="overflow-hidden">
        <CallFlowsView
          assignmentsHidden={!ability.can(SECTION_SWITCH.numbers, 'Communication')}
          flows={callFlows}
          setFlows={setCallFlows}
          numbers={numbers}
          groupOptions={groupTargetOptions(callGroups)}
          onAssignNumbers={assignFlowToNumbers}
          onToast={onToast}
        />
      </ModuleTabPanel>

      <ModuleTabPanel value="groups" activeValue={section} className="overflow-y-auto overscroll-contain">
        <CallGroupsView groups={callGroups} setGroups={setCallGroups} onToast={onToast} />
      </ModuleTabPanel>

      <ModuleTabPanel value="masking" activeValue={section} className="overflow-y-auto overscroll-contain">
        <CallMaskingView onToast={onToast} />
      </ModuleTabPanel>

      <ModuleTabPanel value="blocked" activeValue={section} className="overflow-y-auto overscroll-contain">
        <BlockedCallersView
          blocked={blockedNumbers}
          onBlock={blockNumber}
          onUnblock={unblockNumber}
        />
      </ModuleTabPanel>

      {showCalls && (
        <div className="flex flex-1 flex-col">
          {/* KPI tiles - clickable, jump to the matching sub-tab. */}
          <StatCardGroup className="shrink-0 py-4">
            <StatCard
              label="Calls today"
              value={String(callsToday)}
              tone="brand"
              active={activeKpi === 'calls'}
              onClick={() => {
                setActiveKpi('calls');
                setCallsFocus('all');
                setTab('calls');
              }}
            />
            <StatCard
              label="Missed Calls"
              value={String(missed.length)}
              tone="amber"
              active={activeKpi === 'callback'}
              onClick={() => {
                setActiveKpi('callback');
                setCallsFocus('callback');
                setTab('calls');
              }}
            />
            {/* Cross-page jump, not a tab selection - the unread count belongs
                to the Text module and always did. */}
            <StatCard
              label="Unread messages"
              value={String(unreadCount)}
              tone="blue"
              active={activeKpi === 'unread'}
              onClick={() => navigate(v2Path('/communication/text'))}
            />
            <StatCard
              label="Needs Attention"
              value={String(needsAttention.length)}
              tone="red"
              title={mayInsights ? undefined : NEEDS_ATTENTION_WITHOUT_INSIGHTS_HELP}
              active={activeKpi === 'attention'}
              onClick={() => {
                setActiveKpi('attention');
                setCallsFocus('attention');
                setTab('calls');
              }}
            />
          </StatCardGroup>

          {/* Sub-tabs, with the date range pinned right while Calls is open. Below md the date range
              wraps under the tabs so they keep the whole row instead of being squeezed to a sliver. */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <TabStrip
              className="min-w-0 basis-full md:flex-1 md:basis-0"
              value={tab}
              onValueChange={(next) => setTab(next as Tab)}
              tabs={[
                { value: 'calls', label: <SubTabLabel icon={ListChecks} label="Calls" count={calls.length} /> },
                // Dispatch & Calls is a mock-fed prototype board - demo orgs only.
                ...(isDemo
                  ? [{
                      value: 'dispatch',
                      label: <SubTabLabel icon={PhoneCall} label="Dispatch & Calls" count={calls.length} />,
                    }]
                  : []),
                // The scorecards are call insights: no sub-tab without See call insights.
                ...(mayInsights
                  ? [{
                      value: 'performance',
                      label: <SubTabLabel icon={BarChart3} label="Performance & QA" count={phoneAgents.length} />,
                    }]
                  : []),
              ]}
            />
            {tab === 'calls' && (
              <div className="shrink-0 py-1.5">
                <DateRangeControl
                  preset={datePreset}
                  customStart={dateStart}
                  customEnd={dateEnd}
                  range={dateRange}
                  onPreset={(p) => setDatePreset(p)}
                  onCustom={(s, e) => {
                    setDateStart(s);
                    setDateEnd(e);
                    setDatePreset('custom');
                  }}
                />
              </div>
            )}
          </div>

          {/* The log: the rest of the page, never under 200 px. Where the page is short (a phone,
              a phone held sideways) it takes the height it needs and the page scrolls, so there is
              one scroller, not a log scrolling inside a page that scrolls. */}
          <div data-slot="call-log" className={cn('border-t', compact ? 'shrink-0' : 'min-h-[200px] flex-1 overflow-y-auto overscroll-contain')}>
            {tab === 'calls' && (
              <CallsView
                calls={calls}
                range={dateRange}
                searchScope={searchScope}
                // Widening is a click, never automatic - the query survives it.
                onSearchAllTime={() => setDatePreset('all')}
                focus={callsFocus}
                onClearFocus={() => {
                  setCallsFocus('all');
                  setActiveKpi(null);
                }}
                onToast={onToast}
              />
            )}
            {tab === 'dispatch' && isDemo && (
              <DispatchView calls={calls} setCalls={setCalls} onToast={onToast} />
            )}
            {tab === 'performance' && mayInsights && <PerformanceView calls={calls} onToast={onToast} />}
          </div>
        </div>
      )}
    </div>
  );
}

/** A primary-nav tab label: icon plus name. */
function SectionTabLabel({
  icon: Icon, label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon />
      {label}
    </span>
  );
}

/** A sub-tab label: icon, name and the count pill the legacy TabButton drew. */
function SubTabLabel({
  icon: Icon, label, count,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <Icon />
      {label}
      <Badge variant="softNeutral" size="sm">
        {count}
      </Badge>
    </span>
  );
}
