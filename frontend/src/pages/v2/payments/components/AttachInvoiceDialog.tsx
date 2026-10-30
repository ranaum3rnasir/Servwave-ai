import { useEffect, useRef, useState } from 'react';

import { useAttachPaymentNeedingAttention } from '@/lib/api/paymentsNeedingAttention';
import {
  useCaptureInvoices, useUnappliedDetail, type AttachableInvoice, type AttentionItem,
} from '@/lib/api/paymentsPage';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { DialogList } from '@/ui-kit/components/ui/dialogList';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';

import { RadioRow, onRadioGroupKeyDown } from '../../_shared/radioRow';
import { PHONE_TAP_AREA } from '../phoneTap';
import { focusCardHeading, useFinish } from './attentionFinish';

const SHORT_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const toCents = (n: number) => Math.round(n * 100);
const idOf = (key: string) => key.slice(key.indexOf(':') + 1);

interface AttachRefusal { code?: string; balance?: number; amount?: number; error?: string }

/** The line under a row's name: when it is due (or that it is paid), the job, and why it is near the top. */
function rowLine(row: AttachableInvoice, refund: boolean, timeZone: string): string {
  const when = row.status === 'PAID' ? 'Paid' : row.due_date ? `Due ${formatInstant(row.due_date, timeZone, SHORT_DAY)}` : null;
  const tag = row.meant ? ` · Meant for this ${refund ? 'refund' : 'payment'}` : row.same_amount ? ' · Same amount' : '';
  return `${[when, row.job_type].filter(Boolean).join(' · ')}${tag}`;
}

/** What will happen to the chosen invoice, in the words the person will see on it afterwards. Never says "more than". */
function outcomeNote(row: AttachableInvoice | null, amount: number, refund: boolean): string | null {
  if (!row) return null;
  if (refund) return `The refund will show on ${row.number}.`;
  const left = toCents(row.balance) - toCents(amount);
  return left > 0 ? `${row.number} will show ${formatCurrency(left / 100)} still due.` : `${row.number} will show as paid.`;
}

/**
 * Attach an unapplied payment (or refund) to an invoice (V7-09c, spec 7.16). A search, a list of invoices to choose from
 * (the ones that owe less than the payment are shown but cannot be chosen), a note on what will happen, and the whole
 * amount goes on: a payment is never split. The form mounts fresh every time it opens.
 */
export function AttachInvoiceDialog({
  item, preselect, onClose,
}: {
  item: AttentionItem;
  /** A suggested invoice the person already picked. */
  preselect?: AttachableInvoice;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const timeZone = useScheduleTimezone();
  const id = idOf(item.key);
  const refund = item.type === 'unmatched_refund';
  const detail = useUnappliedDetail(item.key).data;
  const amount = detail?.amount ?? item.amount ?? 0;
  const customer = (detail?.customer_block && !detail.customer_block.restricted ? detail.customer_block.name : null) ?? item.customer?.name ?? null;
  const finish = useFinish();

  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const list = useCaptureInvoices(id, term);
  const rows = list.data ?? [];

  const [picked, setPicked] = useState<AttachableInvoice | null>(preselect?.can_attach ? preselect : null);
  const [seeded, setSeeded] = useState(Boolean(preselect));
  // The invoice the money was meant for starts chosen, but only when it can take the whole amount.
  if (!seeded && list.data && term === '') {
    setSeeded(true);
    const meant = list.data.find((r) => r.meant && r.can_attach);
    if (meant) setPicked(meant);
  }
  const [chooseError, setChooseError] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const sending = useRef(false);

  const attach = useAttachPaymentNeedingAttention();
  const noun = refund ? 'Refund' : 'Payment';

  const submit = () => {
    if (sending.current) return;
    if (!picked) {
      setChooseError(true);
      return;
    }
    setServerError(null);
    sending.current = true;
    attach.mutate({ id, invoiceId: picked.id }, {
      onSuccess: (data) => {
        finish(`${noun} of ${formatCurrency(amount)} attached to ${data.invoice?.number ?? picked.number}`);
        onClose(false);
        focusCardHeading();
      },
      onError: (err) => {
        const body = (err as { response?: { data?: AttachRefusal } }).response?.data;
        if (body?.code === 'INVOICE_BALANCE_BELOW_PAYMENT' && body.balance != null && body.amount != null) {
          setServerError(`Only ${formatCurrency(body.balance)} is due on ${picked.number}, less than this ${formatCurrency(body.amount)} payment.`);
          setPicked(null);
          void list.refetch();
        } else {
          setServerError(extractApiError(err, 'This could not be attached. Try again in a moment.'));
        }
      },
      onSettled: () => { sending.current = false; },
    });
  };

  const hasDisabled = rows.some((r) => !r.can_attach);
  const firstEnabled = rows.find((r) => r.can_attach)?.id;
  const note = outcomeNote(picked, amount, refund);
  const intro = refund
    ? `Record the ${formatCurrency(amount)} refund${customer ? ` to ${customer}` : ''} on an invoice.`
    : `Record the ${formatCurrency(amount)} payment${customer ? ` from ${customer}` : ''} on an invoice.`;

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !attach.isPending) onClose(); }}>
      <DialogContent intent="choice" className={`sm:max-w-lg ${PHONE_TAP_AREA}`} onCloseAutoFocus={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Attach to invoice</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <p className="text-sm">{intro}</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="attach-invoice-search">Find an invoice</Label>
            <Input
              id="attach-invoice-search"
              kind="search"
              placeholder="Number or customer"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {list.isError && !list.data ? (
            <Alert tone="danger" role="alert">
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <span>Couldn’t load the invoices.</span>
                <Button type="button" size="sm" variant="outline" onClick={() => void list.refetch()} disabled={list.isFetching}>Retry</Button>
              </div>
            </Alert>
          ) : (
            <DialogList as="ul" cap="max-h-[260px] overflow-y-auto" role="radiogroup" aria-label="Invoices" className="flex flex-col" onKeyDown={onRadioGroupKeyDown}>
              {rows.length === 0 && (
                <li className="text-muted-foreground p-3 text-sm">{list.isPending ? 'Loading…' : 'No invoice matches'}</li>
              )}
              {rows.map((row) => (
                <li key={row.id}>
                  <RadioRow
                    checked={picked?.id === row.id}
                    disabled={!row.can_attach}
                    tabIndex={row.can_attach && (picked ? picked.id === row.id : row.id === firstEnabled) ? 0 : -1}
                    onClick={() => { if (row.can_attach) { setPicked(row); setChooseError(false); setServerError(null); } }}
                    label={`${row.number} · ${row.customer}`}
                    description={<span className="whitespace-normal">{rowLine(row, refund, timeZone)}</span>}
                    trailing={formatCurrency(row.amount)}
                    className={`min-h-11 w-full px-3 py-1.5${row.can_attach ? '' : ' opacity-60'}`}
                  />
                  {!row.can_attach && (
                    <p className="text-muted-foreground px-3 pb-2 pl-[38px] text-[12.5px]">
                      Only {formatCurrency(row.payable_now)} is due, less than this {formatCurrency(amount)} payment.
                    </p>
                  )}
                </li>
              ))}
            </DialogList>
          )}
          {hasDisabled && (
            <p className="text-muted-foreground text-[12.5px]">
              Greyed-out invoices owe less than this payment. Refund the extra first, then attach what is left.
            </p>
          )}
          {note && <p className="text-muted-foreground text-[12.5px]" role="status">{note}</p>}
          {chooseError && <p className="text-destructive text-[13px]" role="alert">Choose an invoice.</p>}
          {serverError && <p className="text-destructive text-[13px]" role="alert">{serverError}</p>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onClose()} disabled={attach.isPending}>Cancel</Button>
          <Button type="button" onClick={submit} disabled={attach.isPending}>{refund ? 'Attach refund' : 'Attach payment'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
