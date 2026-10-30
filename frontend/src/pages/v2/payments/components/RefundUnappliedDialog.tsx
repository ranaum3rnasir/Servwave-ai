import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useRefundPaymentNeedingAttention } from '@/lib/api/paymentsNeedingAttention';
import { paymentsPageKeys, useUnappliedDetail, type AttentionItem } from '@/lib/api/paymentsPage';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { toast } from '@/ui-kit/components/ui/sonner';

import { PHONE_TAP_AREA } from '../phoneTap';
import { focusCardHeading, useFinish } from './attentionFinish';

const toCents = (n: number) => Math.round(n * 100);
const idOf = (key: string) => key.slice(key.indexOf(':') + 1);

/**
 * Return all or part of an unapplied payment (V7-09c, spec 7.16). The amount starts at what is left on the item. A full
 * amount resolves the item; a partial one leaves it open showing what is left, and the drawer stays open on it. The
 * server checks the amount again. The form mounts fresh every time it opens.
 */
export function RefundUnappliedDialog({ item, onClose }: { item: AttentionItem; onClose: (restoreFocus?: boolean) => void }) {
  const queryClient = useQueryClient();
  const finish = useFinish();
  const detail = useUnappliedDetail(item.key).data;
  const left = detail?.amount ?? item.amount ?? 0;
  const block = detail?.customer_block && !detail.customer_block.restricted ? detail.customer_block : null;
  const customer = block?.name ?? item.customer?.name ?? null;
  const card = detail?.payer?.detail ?? null;

  const [amountText, setAmountText] = useState(left.toFixed(2));
  const [amountError, setAmountError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const refund = useRefundPaymentNeedingAttention();

  const body = [
    `Return money to ${customer ?? 'the customer'}${card ? ` (${card})` : ''}.`,
    'This payment is not on an invoice.',
    'This cannot be undone.',
  ].join(' ');

  const fail = (message: string) => {
    setAmountError(message);
    amountRef.current?.focus();
  };

  const submit = () => {
    if (sending.current) return;
    setServerError(null);
    const parsed = Number(amountText.replace(/[$,\s]/g, ''));
    if (!(Number.isFinite(parsed) && parsed > 0 && toCents(parsed) > 0)) return fail('Enter an amount above $0.00.');
    if (toCents(parsed) > toCents(left)) return fail(`Enter ${formatCurrency(left)} or less.`);
    setAmountError(null);
    sending.current = true;
    const dollars = toCents(parsed) / 100;
    refund.mutate({ id: idOf(item.key), amount: dollars }, {
      onSuccess: (row) => {
        const message = `Refunded ${formatCurrency(dollars)}${customer ? ` to ${customer}` : ''}`;
        // Still open: a part went back and the rest is on the item. The drawer stays on it, showing what is left.
        if (row?.status === 'OPEN') {
          toast.success(message);
          void queryClient.invalidateQueries({ queryKey: paymentsPageKeys.all });
          // The Refund button that opened this is still on screen: focus goes back to it.
          onClose();
        } else {
          finish(message);
          onClose(false);
          focusCardHeading();
        }
      },
      onError: (err) => {
        const data = (err as { response?: { data?: { field?: string } } }).response?.data;
        const message = extractApiError(err, 'This could not be refunded. Try again in a moment.');
        if (data?.field === 'amount') fail(message);
        else setServerError(message);
      },
      onSettled: () => { sending.current = false; },
    });
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !refund.isPending) onClose(); }}>
      <DialogContent intent="form" className={`sm:max-w-md ${PHONE_TAP_AREA}`} onCloseAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Refund payment</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <p className="text-sm">{body}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="unapplied-refund-amount">Amount</Label>
            <Input
              ref={amountRef}
              id="unapplied-refund-amount"
              kind="money"
              className="text-right tabular-nums"
              value={amountText}
              aria-invalid={amountError ? true : undefined}
              aria-describedby={amountError ? 'unapplied-refund-error unapplied-refund-hint' : 'unapplied-refund-hint'}
              onChange={(event) => { setAmountText(event.target.value); setAmountError(null); }}
              onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
            />
            {amountError && <p id="unapplied-refund-error" className="text-destructive text-[13px]" role="alert">{amountError}</p>}
            <p id="unapplied-refund-hint" className="text-muted-foreground text-[13px]">{formatCurrency(left)} left to refund</p>
          </div>
          {serverError && <Alert tone="danger" role="alert">{serverError}</Alert>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onClose()} disabled={refund.isPending}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={submit} disabled={refund.isPending}>Refund</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
