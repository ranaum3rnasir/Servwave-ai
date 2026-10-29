import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { ACCOUNTS, AR_DEMO_SALES_90D, type Account } from './arAging.data';

// Fixed "now" so the deterministic demo data resolves to stable dates (its
// seeded daysLate values are relative to this anchor — matches catalog date).
export const AR_MOCK_NOW = new Date(2026, 5, 7, 12, 0, 0);

/**
 * AR-aging accounts + the "now" they age against.
 *  • demo org  → the deterministic sample accounts, anchored to AR_MOCK_NOW.
 *  • real org  → GET /api/reports/ar-aging (outstanding invoices grouped by
 *    customer, days-late computed server-side), aged against the real clock.
 * The live `now` is memoized once per mount so the report's useMemos stay stable.
 * `dso` is rendered as-is from the backend for real orgs — the frontend performs
 * no DSO arithmetic itself except on the demo path (fixture-only, below).
 */
export function useArAging(isDemo: boolean): {
  accounts: Account[];
  now: Date;
  isLoading: boolean;
  isError: boolean;
  dso: number | null;
} {
  const liveNow = useMemo(() => new Date(), []);
  const live = useQuery({
    queryKey: ['ar-aging'],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/ar-aging');
      return {
        accounts: (data.accounts ?? []) as Account[],
        dso: (data.dso ?? null) as number | null,
      };
    },
    staleTime: 60_000,
    enabled: !isDemo,
  });

  if (isDemo) {
    const demoAr = ACCOUNTS.reduce(
      (s, a) => s + a.invoices.reduce((t, i) => t + i.balance, 0), 0,
    );
    return {
      accounts: ACCOUNTS, now: AR_MOCK_NOW, isLoading: false, isError: false,
      dso: Math.round((demoAr / AR_DEMO_SALES_90D) * 90),
    };
  }
  return {
    accounts: live.data?.accounts ?? [],
    now: liveNow,
    isLoading: live.isLoading,
    isError: live.isError,
    dso: live.data?.dso ?? null,
  };
}
