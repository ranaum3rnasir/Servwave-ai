import { formatCurrency } from '@/lib/utils';
import type { PaymentsSummary } from '@/lib/api/paymentsPage';

import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { Badge } from '@/ui-kit/components/ui/badge';

import { InfoPopover } from '../../_shared/infoPopover';
import { LoadError } from '../../_shared/loadError';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const money = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? formatCurrency(n) : '—');

/** 'YYYY-MM-DD' as "Oct 19, Monday", read as a plain calendar day (never shifted by the viewer's zone). */
function arrivalNote(day: string | null | undefined): string | null {
  if (!day) return null;
  const at = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${WEEKDAYS[at.getUTCDay()]}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The word the schedule is read as in the note: only a stored daily, weekly or monthly schedule has one. */
function intervalWord(scheduleText: string | null | undefined): 'daily' | 'weekly' | 'monthly' | null {
  const text = (scheduleText ?? '').trim().toLowerCase();
  if (text.startsWith('daily')) return 'daily';
  if (text.startsWith('weekly')) return 'weekly';
  if (text.startsWith('monthly')) return 'monthly';
  return null;
}

/**
 * The one note a user must know about this tile (verbatim from the approved screen). The sentence about the date
 * is dropped when the date is unknown or the schedule is manual or not stored, because it would have nothing to say.
 */
function payoutPopoverText(next: PaymentsSummary['next_payout']): string {
  const word = next.date ? intervalWord(next.schedule_text) : null;
  const dateSentence = word ? ` The date is the next ${word} payout; bank holidays can move it.` : '';
  return (
    'Estimated. This is money you collected online that is not in a payout yet, after fees and refunds.'
    + dateSentence
    + ' In transit is money already sent to your bank that has not arrived yet, usually 1 to 2 business days.'
  );
}

/**
 * Two columns on a phone; above 640px as many 190px columns as fit, 16px apart (the approved screen). The figures are
 * 22px on a phone and 26px above it.
 */
const TILE_GRID = [
  'grid-cols-2 gap-3 min-[641px]:gap-4',
  'min-[641px]:grid-cols-[repeat(auto-fit,minmax(190px,1fr))] xl:grid-cols-[repeat(auto-fit,minmax(190px,1fr))]',
  '[&_[data-slot=stat-card-value]]:text-[22px] min-[641px]:[&_[data-slot=stat-card-value]]:text-[26px]',
].join(' ');

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
      <StatCardGroup className={TILE_GRID} aria-busy="true" aria-label="Totals for this period">
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
    <StatCardGroup className={TILE_GRID} aria-busy={refreshing} aria-label="Totals for this period" role="group">
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
      <StatCard
        label={
          <span data-testid="next-payout-label" className="flex items-center gap-1.5 min-[641px]:h-[18.75px] max-sm:items-start">
            <span className="min-w-0">Next payout</span>
            <Badge variant="softBlue" size="pill">Estimated</Badge>
            {/* The "?" keeps its full tap area but takes no more room than its 20px icon (negative margins), so
                the label row never grows past the tile; the label text wraps first, as on the approved screen. */}
            <span className="-mx-1 -my-1 inline-flex shrink-0 max-sm:-mx-3 max-sm:-my-3">
              <InfoPopover label="Next payout">{payoutPopoverText(summary.next_payout)}</InfoPopover>
            </span>
          </span>
        }
        value={money(summary.next_payout?.amount)}
        detail={
          <>
            {arrival && <span className="block">{arrival}</span>}
            <span className="block">In transit {money(summary.next_payout?.in_transit)}</span>
          </>
        }
      />
    </StatCardGroup>
  );
}
