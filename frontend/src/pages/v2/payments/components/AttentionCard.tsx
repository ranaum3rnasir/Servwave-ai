import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, Clock, Info } from 'lucide-react';

import { useAttention, type AttentionItem } from '@/lib/api/paymentsPage';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { arrangeCardItems, ATTENTION_FETCH_LIMIT, CARD_ROWS } from '../attentionCardItems';
import { timeLeft, useNow } from '../timeLeft';
import { PHONE_TAP } from './attentionActions';
import { ATTENTION_CARD_TITLE_ID } from './attentionIds';
import { AttentionRowActions } from './AttentionRowActions';
import { useDrawerHost } from '../drawerHost';
import { stackForItem } from '../drawerStack';
import { ItemTitle, SecondaryLine } from './attentionRow';

const TILE = 'grid size-9 shrink-0 place-items-center rounded-[10px] border [&_svg]:size-[18px]';
const TILE_RED = `${TILE} bg-status-red-subtle text-status-red-emphasis border-status-red-subtle`;
const TILE_AMBER = `${TILE} bg-status-amber-subtle text-status-amber-emphasis border-status-amber-subtle`;
const TILE_GREEN = `${TILE} bg-status-green-subtle text-status-green-emphasis border-status-green-subtle`;

/** Red for money that failed to move and for a dispute with under 48 hours left; amber for the rest. */
function RowIcon({ item, now }: { item: AttentionItem; now: number }) {
  const failed = item.type === 'failed_payment' || item.type === 'failed_refund' || item.type === 'failed_payout';
  const urgentDispute = item.type === 'dispute' && Boolean(timeLeft(item.respond_by, now)?.urgent);
  const Icon = item.type === 'dispute' ? Clock : item.type === 'unmatched_payment' || item.type === 'unmatched_refund' ? Info : AlertTriangle;
  return (
    <span className={failed || urgentDispute ? TILE_RED : TILE_AMBER}>
      <Icon aria-hidden />
    </span>
  );
}

function Row({ item, timeZone, now }: { item: AttentionItem; timeZone: string; now: number }) {
  const host = useDrawerHost();
  const views = stackForItem(item);
  return (
    <li
      className={`flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-3.5 ${views ? 'hover:bg-muted/50 cursor-pointer' : ''}`}
      onClick={views ? () => host.open(views) : undefined}
    >
      <RowIcon item={item} now={now} />
      <div className="min-w-0 flex-1 basis-60">
        <div className="text-sm font-semibold"><ItemTitle item={item} /></div>
        <div className="text-text-secondary text-[13px]"><SecondaryLine item={item} timeZone={timeZone} now={now} /></div>
      </div>
      <AttentionRowActions item={item} />
    </li>
  );
}

function SkeletonRows() {
  return (
    <ul aria-hidden className="divide-y border-t">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-4 px-5 py-3.5">
          <Skeleton className="size-9 shrink-0 rounded-[10px]" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Everything that needs a person, at the top of Payments. The card is always on the page and never moves: open items
 * list their rows, nothing open reads "Nothing needs attention", and loading and a failed load keep the same frame.
 * Choosing a chip below never hides or shrinks it. The buttons on a row are the server's list for this caller.
 */
export function AttentionCard() {
  const timeZone = useScheduleTimezone();
  const [, setParams] = useSearchParams();
  const { data, isError, refetch, isFetching } = useAttention('open', { limit: ATTENTION_FETCH_LIMIT }, { silentErrors: true });
  const now = useNow(60_000);
  const rows = useMemo(() => arrangeCardItems(data?.items ?? []), [data?.items]);
  const open = data?.counts?.open ?? 0;
  const resolved = data?.counts?.resolved ?? 0;
  const failed = isError && !data?.items;
  const loading = !data?.items && !failed;

  const showTable = (view: 'open' | 'resolved') =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'payments');
      next.set('chip', 'attention');
      next.set('attView', view);
      // The person lands on the full list: nothing from the page they were on narrows or covers it.
      for (const key of ['d', 'payment', 'payout', 'dispute', 'type', 'page', 'q']) next.delete(key);
      return next;
    });

  return (
    <Card role="region" aria-labelledby={ATTENTION_CARD_TITLE_ID}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <CardTitle level={2} id={ATTENTION_CARD_TITLE_ID} tabIndex={-1} className="flex items-center gap-2 outline-none">
          Needs attention
          {open > 0 && <Badge variant="softRed" size="pill">{open}</Badge>}
        </CardTitle>
        {data?.items && (
          <Button type="button" size="sm" variant="ghost" className={`${PHONE_TAP} -mr-3`} onClick={() => showTable('resolved')}>
            Resolved items ({resolved})
          </Button>
        )}
      </CardHeader>
      {loading && <div role="status" aria-label="Loading what needs attention"><SkeletonRows /></div>}
      {failed && (
        <div className="border-t p-4">
          <Alert tone="danger" role="alert">
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <span>Couldn’t load what needs attention.</span>
              <Button type="button" size="sm" variant="outline" className={PHONE_TAP} onClick={() => void refetch()} disabled={isFetching}>
                Retry
              </Button>
            </div>
          </Alert>
        </div>
      )}
      {data?.items && open <= 0 && (
        <div className="flex items-center gap-4 border-t px-5 py-3.5">
          <span className={TILE_GREEN}><Check aria-hidden /></span>
          <span className="text-sm font-semibold">Nothing needs attention</span>
        </div>
      )}
      {data?.items && open > 0 && (
        <ul className="divide-y border-t">
          {rows.map((item) => <Row key={item.key} item={item} timeZone={timeZone} now={now} />)}
        </ul>
      )}
      {open > CARD_ROWS && (
        <div className="flex justify-center border-t px-5 py-3">
          <Button type="button" size="sm" variant="ghost" className={PHONE_TAP} onClick={() => showTable('open')}>
            View all {open}
          </Button>
        </div>
      )}
    </Card>
  );
}
