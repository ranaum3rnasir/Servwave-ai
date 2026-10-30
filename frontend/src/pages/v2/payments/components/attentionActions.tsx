import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import api from '@/lib/axios';
import { paymentsPageKeys, usePaymentDetail, type AttentionActionId, type AttentionItem } from '@/lib/api/paymentsPage';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { toast } from '@/ui-kit/components/ui/sonner';
import { canAutoFocus } from '@/ui-kit/lib/autoFocus';

import { disputeDrawerReady } from '../featureFlags';
import { PHONE_TAP_AREA } from '../phoneTap';
import { RefundPaymentDialog } from './RefundPaymentDialog';
import { UpdateBankAccountDialog } from './UpdateBankAccountDialog';

export const ACTION_LABEL: Record<AttentionActionId, string> = {
  contact_customer: 'Contact customer',
  mark_resolved: 'Mark resolved',
  refund_again: 'Refund again',
  mark_settled: 'Mark settled',
  respond: 'Respond',
  update_bank_account: 'Update bank account',
  refund: 'Refund',
};

/** Every control this slice adds is 44px tall on a phone; the kit's defaults are left alone. */
export const PHONE_TAP = 'max-sm:min-h-11';

const MAX_NOTE = 500;
const COUNT_FROM = 400;
const FALLBACK_ERROR = 'This could not be done. Try again in a moment.';

/** The buttons come only from the server's `actions`; Respond needs the dispute drawer and a dispute to open. */
export function visibleActions(item: AttentionItem): AttentionActionId[] {
  return item.actions.filter((a) => a !== 'respond' || (disputeDrawerReady && Boolean(item.dispute_id)));
}

const UNMATCHED: ReadonlySet<string> = new Set(['unmatched_payment', 'unmatched_refund']);
/** The source row id of an item (the part of its key after the type). */
const sourceId = (item: AttentionItem) => item.key.slice(item.key.indexOf(':') + 1);

/**
 * What every successful action does: close the drawer that showed the payment, and ask again for everything the page
 * shows (attention list and counts, payments, tiles, drawer detail all share the `payments-page` key).
 */
function useFinish(item: AttentionItem) {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  return (message?: string) => {
    if (message) toast.success(message);
    if (item.payment_id && params.get('payment') === item.payment_id) {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('payment');
        return next;
      });
    }
    void queryClient.invalidateQueries({ queryKey: paymentsPageKeys.all });
  };
}

/** One request with a pending state, a one-press guard and the server's own refusal kept for the dialog to show. */
function useRequest(send: () => Promise<unknown>, onDone: () => void) {
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mutation = useMutation({
    mutationFn: send,
    onSuccess: onDone,
    onError: (err) => setError(extractApiError(err, FALLBACK_ERROR)),
    onSettled: () => { busy.current = false; },
  });
  return {
    error,
    setError,
    pending: mutation.isPending,
    run: () => {
      if (busy.current) return;
      busy.current = true;
      setError(null);
      mutation.mutate();
    },
  };
}

function ActionDialog({
  title, confirmLabel, pending, confirmDisabled = false, onClose, onConfirm, error, children,
}: {
  title: string;
  confirmLabel: string;
  pending: boolean;
  /** The confirm button waits on something other than a request (the payment it acts on is still loading). */
  confirmDisabled?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogContent intent="form" className={`sm:max-w-md ${PHONE_TAP_AREA}`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {children}
          {error && <Alert tone="danger" role="alert">{error}</Alert>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" className={PHONE_TAP} onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="button" className={PHONE_TAP} onClick={onConfirm} disabled={pending || confirmDisabled}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const customerOf = (item: AttentionItem) => item.customer?.name ?? 'the customer';
const amountOf = (item: AttentionItem) => (item.amount == null ? 'this amount' : formatCurrency(item.amount));

function ContactDialog({ item, onClose }: { item: AttentionItem; onClose: () => void }) {
  const finish = useFinish(item);
  const req = useRequest(
    () => api.post(`/api/payments-page/attention/${item.key}/contact-customer`, undefined, { silentErrors: true }),
    () => { finish('Email sent'); onClose(); },
  );
  return (
    <ActionDialog title="Contact customer" confirmLabel="Send email" pending={req.pending} error={req.error} onClose={onClose} onConfirm={req.run}>
      <p className="text-sm">
        Email {customerOf(item)} about the failed {amountOf(item)} payment on invoice {item.invoice?.number ?? ''}, with a link to pay again?
      </p>
    </ActionDialog>
  );
}

function ResolveDialog({ item, settle, onClose }: { item: AttentionItem; settle: boolean; onClose: () => void }) {
  const finish = useFinish(item);
  const unmatched = UNMATCHED.has(item.type);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const req = useRequest(
    () => {
      const trimmed = note.trim();
      if (unmatched) return api.post(`/api/payments-needing-attention/${sourceId(item)}/resolve`, undefined, { silentErrors: true });
      return api.post(`/api/payments-page/attention/${item.key}/resolve`, trimmed ? { note: trimmed } : {}, { silentErrors: true });
    },
    () => { finish(settle ? 'Marked as settled' : 'Marked resolved. No money was moved.'); onClose(); },
  );

  const submit = () => {
    if (note.length > MAX_NOTE) {
      setNoteError(`Keep the note to ${MAX_NOTE} characters or fewer.`);
      noteRef.current?.focus();
      return;
    }
    setNoteError(null);
    req.run();
  };

  return (
    <ActionDialog
      title={settle ? 'Mark as settled' : 'Mark resolved'}
      confirmLabel={settle ? 'Mark settled' : 'Mark resolved'}
      pending={req.pending}
      error={req.error}
      onClose={onClose}
      onConfirm={submit}
    >
      <p className="text-sm">
        {settle
          ? `Mark the ${amountOf(item)} refund to ${customerOf(item)} on invoice ${item.invoice?.number ?? ''} as settled? Use this when you returned the money another way.`
          : 'Mark this as resolved? No money is moved.'}
      </p>
      {!unmatched && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="attention-note">Note (optional)</Label>
          <Textarea
            ref={noteRef}
            id="attention-note"
            rows={3}
            autoFocus={canAutoFocus()}
            value={note}
            aria-invalid={noteError || note.length > MAX_NOTE ? true : undefined}
            aria-describedby={noteError ? 'attention-note-error' : undefined}
            onChange={(e) => { setNote(e.target.value); setNoteError(null); }}
          />
          {noteError && <p id="attention-note-error" className="text-destructive text-[13px]">{noteError}</p>}
          {note.length >= COUNT_FROM && (
            <p className={`${note.length > MAX_NOTE ? 'text-danger font-medium' : 'text-text-secondary'} text-right text-[13px] tabular-nums`}>
              {note.length}/{MAX_NOTE}
            </p>
          )}
        </div>
      )}
    </ActionDialog>
  );
}

function RefundUnmatchedDialog({ item, onClose }: { item: AttentionItem; onClose: () => void }) {
  const finish = useFinish(item);
  const req = useRequest(
    () => api.post(`/api/payments-needing-attention/${sourceId(item)}/refund`, undefined, { silentErrors: true }),
    () => { finish('Refund sent. The customer gets the money back through ServWave Payments.'); onClose(); },
  );
  return (
    <ActionDialog
      title="Refund this payment?"
      confirmLabel={item.amount == null ? 'Refund' : `Refund ${formatCurrency(item.amount)}`}
      pending={req.pending}
      error={req.error}
      onClose={onClose}
      onConfirm={req.run}
    >
      <p className="text-sm">{amountOf(item)} goes back to the customer.</p>
    </ActionDialog>
  );
}

/**
 * The failed refund's own payment is fetched first. The dialog is up at once: a loading line while it comes, an error
 * with Retry if it does not, and the prefilled refund form once it is here. Confirm waits for the payment.
 */
function RefundAgainDialog({ item, onClose }: { item: AttentionItem; onClose: () => void }) {
  const finish = useFinish(item);
  const again = item.refund_again!;
  const detail = usePaymentDetail(again.payment_id);
  if (!detail.data) {
    const failed = detail.isError;
    return (
      <ActionDialog
        title="Refund payment"
        confirmLabel="Refund"
        pending={false}
        confirmDisabled
        error={null}
        onClose={onClose}
        onConfirm={() => {}}
      >
        {failed ? (
          <Alert tone="danger" role="alert">
            <div className="flex w-full flex-wrap items-center justify-between gap-2">
              <span>Couldn’t load this payment.</span>
              <Button type="button" size="sm" variant="outline" className={PHONE_TAP} onClick={() => void detail.refetch()} disabled={detail.isFetching}>
                Retry
              </Button>
            </div>
          </Alert>
        ) : (
          <p className="text-text-secondary text-sm" role="status">Loading the payment…</p>
        )}
      </ActionDialog>
    );
  }
  return (
    <RefundPaymentDialog
      payment={detail.data}
      open
      prefill={{ amount: again.amount, category: again.reason_category, reason: again.reason }}
      onOpenChange={(next) => { if (!next) onClose(); }}
      onRefunded={() => finish()}
    />
  );
}

/** An item's action buttons, first filled, the rest outlined; each opens its own dialog, mounted fresh every time. */
export function AttentionActions({
  item, size = 'sm', omit,
}: {
  item: AttentionItem;
  size?: 'sm' | 'default';
  /** Buttons to leave out where the same action is offered elsewhere on screen (the drawer's dispute alert has Respond). */
  omit?: AttentionActionId[];
}) {
  const [active, setActive] = useState<AttentionActionId | null>(null);
  const [, setParams] = useSearchParams();
  const actions = visibleActions(item).filter((a) => !omit?.includes(a));
  if (!actions.length) return null;
  const close = () => setActive(null);

  const press = (id: AttentionActionId) => {
    if (id === 'respond') {
      if (item.dispute_id) setParams((prev) => { const next = new URLSearchParams(prev); next.set('tab', 'payments'); next.delete('payment'); next.set('dispute', item.dispute_id!); return next; });
      return;
    }
    setActive(id);
  };

  return (
    <>
      {actions.map((id, i) => (
        <Button key={id} type="button" size={size} variant={i === 0 ? 'default' : 'outline'} className={PHONE_TAP} onClick={() => press(id)}>
          {ACTION_LABEL[id]}
        </Button>
      ))}
      {active === 'contact_customer' && <ContactDialog item={item} onClose={close} />}
      {(active === 'mark_resolved' || active === 'mark_settled') && (
        <ResolveDialog item={item} settle={active === 'mark_settled'} onClose={close} />
      )}
      {active === 'refund' && <RefundUnmatchedDialog item={item} onClose={close} />}
      {active === 'refund_again' && item.refund_again && <RefundAgainDialog item={item} onClose={close} />}
      <UpdateBankAccountDialog open={active === 'update_bank_account'} onOpenChange={(next) => { if (!next) close(); }} />
    </>
  );
}
