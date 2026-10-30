import { formatCurrency } from '@/lib/utils';
import type { PaymentsSummary } from '@/lib/api/paymentsPage';

import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';

import { InfoPopover } from '../../_shared/infoPopover';
import { LoadError } from '../../_shared/loadError';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const money = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? formatCurrency(n) : '—');

/** 'YYYY-MM-DD' as "Wed, Oct 15", read as a plain calendar day (never shifted by the viewer's zone). */
function arrivalNote(day: string | null | undefined): string | null {
  if (!day) return null;
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  return `${WEEKDAYS[at.getUTCDay()]}, ${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The one sentence a user must know: where the money goes. The first two parts drop when the API sends null. */
function payoutPopoverText(next: PaymentsSummary['next_payout']): string {
  const where = next.bank_label ? `Payouts go to ${next.bank_label}${next.schedule_text ? ` ${next.schedule_text}` : ''}. ` : '';
  return `${where}This is the money from payments not yet in a payout.`;
}

/**
 * The four KPI tiles for the chosen period. The previous period's numbers stay up while the next ones load
 * (`refreshing`), and a failed load shows one Retry in place of the tiles; the tabs below still work.
 */
export function KpiRow({
  summary, loading, error, refreshing, onRetry,
}: {
  summary: PaymentsSummary | undefined;
  loading: boolean;
  error: boolean;
  refreshing: boolean;
  onRetry: () => void;
}) {
  if (error && !summary) {
    return <LoadError title="Couldn’t load these totals." onRetry={onRetry} retrying={refreshing} />;
  }

  if (loading || !summary) {
    return (
      <StatCardGroup aria-busy="true" aria-label="Totals for this period">
        <StatCard label="Collected" value="" detail="" loading />
        <StatCard label="Fees" value="" detail="" loading />
        <StatCard label="Net" value="" detail="" loading />
        <StatCard label="Next payout" value="" detail="" loading />
      </StatCardGroup>
    );
  }

  const feePercent = summary.collected > 0 ? ((summary.fees / summary.collected) * 100).toFixed(1) : '0.0';
  const arrival = arrivalNote(summary.next_payout?.date);

  return (
    <StatCardGroup aria-busy={refreshing} aria-label="Totals for this period" role="group">
      <StatCard
        label="Collected"
        value={money(summary.collected)}
        detail={plural(summary.count, 'payment')}
      />
      <StatCard
        label="Fees"
        value={money(summary.fees)}
        detail={
          <>
            <span className="block">{feePercent}% of collected</span>
            {summary.fees_pending > 0 && <span className="block whitespace-normal">Some fees are still being confirmed.</span>}
          </>
        }
      />
      <StatCard
        label="Net"
        value={money(summary.net)}
        detail={
          <>
            <span className="block">Refunds {money(summary.refunds)}</span>
            {/* Net only counts payments whose fees are confirmed, so while some are not, Collected - Fees - Refunds
                is not Net. Say why instead of showing four figures that do not add up. */}
            {summary.fees_pending > 0 && (
              <span className="block">{plural(summary.fees_pending, 'payment')} not counted until fees are confirmed</span>
            )}
          </>
        }
      />
      <div className="relative">
        <StatCard
          label="Next payout"
          value={money(summary.next_payout?.amount)}
          detail={
            <>
              {arrival && <span className="block">{arrival}</span>}
              <span className="block">In transit {money(summary.next_payout?.in_transit)}</span>
            </>
          }
          className="h-full"
        />
        <div className="absolute top-1 right-1">
          <InfoPopover label="Next payout">{payoutPopoverText(summary.next_payout)}</InfoPopover>
        </div>
      </div>
    </StatCardGroup>
  );
}
