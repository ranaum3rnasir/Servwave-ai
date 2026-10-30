import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Clock } from 'lucide-react';

import { useAttention, type AttentionItem } from '@/lib/api/paymentsPage';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';

import { AttentionActions, PHONE_TAP } from './attentionActions';
import { ItemTitle, SecondaryLine } from './attentionRow';

/** The card never grows with the backlog; the rest is one click away in the table. */
export const CARD_LIMIT = 5;

function RowIcon({ item }: { item: AttentionItem }) {
  if (item.type === 'dispute') return <Clock className="text-muted-foreground size-5 shrink-0" aria-hidden />;
  const danger = item.type === 'failed_payment' || item.type === 'failed_payout';
  return <AlertTriangle className={`size-5 shrink-0 ${danger ? 'text-destructive' : 'text-muted-foreground'}`} aria-hidden />;
}

/**
 * Everything that needs a person, at the top of Payments (payments go-live P7): the open items with their buttons.
 * Rendered only while something is open. The buttons are the server's list for this caller, so a view-only caller sees
 * the card with none.
 */
export function AttentionCard() {
  const timeZone = useScheduleTimezone();
  const [, setParams] = useSearchParams();
  const { data, isError, refetch, isFetching } = useAttention('open', { limit: CARD_LIMIT });
  const open = data?.counts?.open ?? 0;
  const resolved = data?.counts?.resolved ?? 0;
  if (isError && !data) {
    return (
      <Alert tone="danger" role="alert">
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span>Couldn’t load what needs attention.</span>
          <Button type="button" size="sm" variant="outline" className={PHONE_TAP} onClick={() => void refetch()} disabled={isFetching}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  }
  if (open <= 0 || !data?.items) return null;

  const showTable = (view: 'open' | 'resolved') =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'payments');
      next.set('chip', 'attention');
      next.set('attView', view);
      // The person lands on the full list: nothing from the page they were on narrows or covers it.
      for (const key of ['payment', 'payout', 'dispute', 'type', 'page', 'q']) next.delete(key);
      return next;
    });

  return (
    <Card role="region" aria-labelledby="attention-card-title">
      <CardHeader className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <CardTitle level={2} id="attention-card-title" className="flex items-center gap-2">
          Needs attention
          <Badge variant="softRed" size="pill">{open}</Badge>
        </CardTitle>
        <Button type="button" size="sm" variant="ghost" className={`${PHONE_TAP} -mr-3`} onClick={() => showTable('resolved')}>
          Resolved items ({resolved})
        </Button>
      </CardHeader>
      <ul className="divide-y border-t">
        {data.items.map((item) => (
          <li key={item.key} className="flex items-start gap-3 px-5 py-3">
            <span className="flex h-5 items-center max-sm:mt-3 sm:mt-0.5"><RowIcon item={item} /></span>
            {/* The text and the buttons share one column, so on a phone the buttons wrap under the text, not the icon. */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-3">
              <div className="min-w-0 flex-1 basis-56">
                <div className="text-sm font-semibold"><ItemTitle item={item} /></div>
                <div className="text-text-secondary text-[13px]"><SecondaryLine item={item} timeZone={timeZone} /></div>
              </div>
              <div className="flex flex-wrap gap-2"><AttentionActions item={item} /></div>
            </div>
          </li>
        ))}
      </ul>
      {open > data.items.length && (
        <div className="border-t px-5 py-3">
          <Button type="button" size="sm" variant="ghost" className={`${PHONE_TAP} -ml-3`} onClick={() => showTable('open')}>
            Show all {open}
          </Button>
        </div>
      )}
    </Card>
  );
}
