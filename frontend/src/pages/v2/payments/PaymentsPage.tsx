import { lazy, Suspense, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CircleDollarSign } from 'lucide-react';

import { usePaymentsSummary } from '@/lib/api/paymentsPage';
import { useStripeStatus } from '@/lib/api/organization';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useScheduleTimezone } from '@/lib/schedule-tz';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { TabPanel, TabStrip, type TabItem } from '../_shared/tabs';
import { AttentionCard } from './components/AttentionCard';
import { PHONE_TAP_AREA } from './phoneTap';
import { KpiRow } from './components/KpiRow';
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

  const openPayout = (payoutId: string) => {
    setSearchParams((prev) => {
      const out = new URLSearchParams();
      for (const [key, value] of prev) if (FRAME_KEYS.has(key)) out.set(key, value);
      out.set('tab', 'payouts');
      out.set('payout', payoutId);
      return out;
    });
  };

  // An org with no payout account (or that has not accepted the terms) has nothing to show yet, so nothing is
  // asked of the totals route until the status says the account exists.
  const notSetUp = Boolean(status) && (!status!.connected || !status!.terms_accepted);
  const summary = usePaymentsSummary(range, { enabled: Boolean(status) && !notSetUp });
  const tabState: PaymentsTabState = { params, setParams, openPayout };

  return (
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
                <Link to="/settings/payout-account">Set up your payout account</Link>
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
          {/* The table below lists the same items while the chip is on, so the card steps aside. */}
          {!(tab === 'payments' && params.get('chip') === 'attention') && <AttentionCard />}
          <div>
            <TabStrip tabs={[...TABS]} value={tab} onValueChange={changeTab} />
            <Suspense fallback={null}>
              <TabPanel value="payments" activeValue={tab}>
                <PaymentsTab range={range} tabState={tabState} />
              </TabPanel>
              <TabPanel value="payouts" activeValue={tab}>
                <PayoutsTab range={range} tabState={tabState} />
              </TabPanel>
              <TabPanel value="documents" activeValue={tab}>
                <DocumentsTab range={range} tabState={tabState} />
              </TabPanel>
            </Suspense>
          </div>
        </>
      )}
    </div>
  );
}
