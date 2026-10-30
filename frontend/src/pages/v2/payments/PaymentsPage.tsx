import { lazy, Suspense, useCallback, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CircleDollarSign } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

import { paymentsPageKeys, usePaymentsSummary } from '@/lib/api/paymentsPage';
import { channelAvailable, subscribe } from '@/lib/paymentsChannel';
import { formatCurrency } from '@/lib/utils';
import { useStripeStatus } from '@/lib/api/organization';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useScheduleTimezone } from '@/lib/schedule-tz';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { toast } from '@/ui-kit/components/ui/sonner';

import { TabPanel, TabStrip, type TabItem } from '../_shared/tabs';
import { AttentionCard } from './components/AttentionCard';
import { PHONE_TAP_AREA } from './phoneTap';
import { useCanvasMinHeight } from './useCanvasMinHeight';
import { KpiRow } from './components/KpiRow';
import { PaymentsDrawerHost } from './components/PaymentsDrawerHost';
import { PaymentsDrawerProvider } from './drawerHost';
import { PeriodPicker } from './components/PeriodPicker';
import { periodFromParams, periodToParams, type Period } from './periods';
import type { PaymentsTabState } from './types';

const PaymentsTab = lazy(() => import('./tabs/PaymentsTab'));
const PayoutsTab = lazy(() => import('./tabs/PayoutsTab'));
const DocumentsTab = lazy(() => import('./tabs/DocumentsTab'));

const TABS = [
  { value: 'payments', label: 'Payments' },
  { value: 'payouts', label: 'Payouts' },
  { value: 'documents', label: 'Documents' },
] as const satisfies readonly TabItem[];
type TabKey = (typeof TABS)[number]['value'];
const isTabKey = (v: string | null): v is TabKey => TABS.some((t) => t.value === v);

/** Keys the frame owns; a tab's own keys are dropped when the tab changes. */
const FRAME_KEYS = new Set(['tab', 'period', 'from', 'to']);

/**
 * Payments: the money ServWave took, what it cost, and where it is going. This file is the frame (title, period,
 * KPI tiles, tabs); each tab body is its own lazy component with the {@link PaymentsTabProps} contract. Tab and
 * period live in the URL, so a link and the Back button restore both.
 */
export default function PaymentsPage() {
  const ability = useAppAbility();
  const tz = useScheduleTimezone();
  const { data: status, isLoading: statusLoading } = useStripeStatus();
  const [params, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  // "Create invoice" on an unapplied payment saves in another tab. That tab tells this one, and the card, table, tiles and
  // open drawers refetch by themselves. A browser with no BroadcastChannel still refreshes when this window regains focus
  // (the app's queries do not refetch on focus on their own).
  useEffect(() => {
    const refresh = () => void queryClient.invalidateQueries({ queryKey: paymentsPageKeys.all });
    const stop = subscribe((m) => {
      refresh();
      toast.success(`Payment of ${formatCurrency(m.amount)} recorded on the new invoice ${m.invoice_number}`);
    });
    // The focus refetch is only the fallback for a browser with no channel.
    const fallback = !channelAvailable();
    if (fallback) window.addEventListener('focus', refresh);
    return () => {
      stop();
      if (fallback) window.removeEventListener('focus', refresh);
    };
  }, [queryClient]);

  const rawTab = params.get('tab');
  const tab: TabKey = isTabKey(rawTab) ? rawTab : 'payments';
  const period = useMemo(() => periodFromParams(params, tz), [params, tz]);
  const range = useMemo(() => ({ from: period.from, to: period.to }), [period.from, period.to]);

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      });
    },
    [setSearchParams],
  );

  const changePeriod = (next: Period) => setParams(periodToParams(next));
  const changeTab = (next: string) => {
    setSearchParams((prev) => {
      const out = new URLSearchParams();
      for (const [key, value] of prev) if (FRAME_KEYS.has(key)) out.set(key, value);
      out.set('tab', next);
      return out;
    });
  };

  // An org with no payout account (or that has not accepted the terms) has nothing to show yet, so nothing is
  // asked of the totals route until the status says the account exists.
  const notSetUp = Boolean(status) && (!status!.connected || !status!.terms_accepted);
  const summary = usePaymentsSummary(range, { enabled: Boolean(status) && !notSetUp });
  const tabState: PaymentsTabState = { params, setParams };
  const { attach: attachPanels, height: panelsHeight } = useCanvasMinHeight();

  return (
    <PaymentsDrawerProvider>
    <div className={`flex flex-col gap-5 ${PHONE_TAP_AREA}`}>
      <PageHeader title="Payments" actions={notSetUp ? undefined : <PeriodPicker period={period} onChange={changePeriod} />} />

      {statusLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : notSetUp ? (
        <EmptyState
          icon={<CircleDollarSign />}
          title="Payments are not set up yet"
          action={
            ability.can('manage_payout_account', 'Organization') ? (
              <Button asChild>
                <Link to="/settings/servwave-payments#payout-account">Set up your payout account</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <KpiRow
            summary={summary.data}
            loading={summary.isPending && !summary.isError}
            error={summary.isError}
            refreshing={summary.isFetching}
            onRetry={() => void summary.refetch()}
          />
          {/* Always on the page, outside the tab panels: a tab or chip change never remounts, hides or moves it. */}
          <AttentionCard />
          <div>
            <TabStrip tabs={[...TABS]} value={tab} onValueChange={changeTab} />
            {/* A shorter panel (an empty list, the Payouts tab) must not shrink the page under the person's scroll. */}
            <div ref={attachPanels} style={panelsHeight ? { minHeight: panelsHeight } : undefined}>
              <Suspense fallback={null}>
                <TabPanel value="payments" activeValue={tab} animate={false}>
                  <PaymentsTab range={range} tabState={tabState} />
                </TabPanel>
                <TabPanel value="payouts" activeValue={tab} animate={false}>
                  <PayoutsTab range={range} tabState={tabState} />
                </TabPanel>
                <TabPanel value="documents" activeValue={tab} animate={false}>
                  <DocumentsTab range={range} tabState={tabState} />
                </TabPanel>
              </Suspense>
            </div>
          </div>
        </>
      )}
      <PaymentsDrawerHost />
    </div>
    </PaymentsDrawerProvider>
  );
}
