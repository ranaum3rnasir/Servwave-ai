import { useRef, useState, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';

import api from '@/lib/axios';
import { usePaymentDetail, type AttentionActionId, type AttentionItem } from '@/lib/api/paymentsPage';
import { extractApiError } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Label } from '@/ui-kit/components/ui/label';
import { toast } from '@/ui-kit/components/ui/sonner';

import { useDrawerHost } from '../drawerHost';
import { stackForItem } from '../drawerStack';
import { focusCardHeading, useFinish } from './attentionFinish';
import { PHONE_TAP_AREA } from '../phoneTap';
import { AttachInvoiceDialog } from './AttachInvoiceDialog';
import { ContactCustomerDialog } from './ContactCustomerDialog';
import { RefundPaymentDialog } from './RefundPaymentDialog';
import { RefundUnappliedDialog } from './RefundUnappliedDialog';
import { UpdateBankAccountDialog } from './UpdateBankAccountDialog';

export const ACTION_LABEL: Record<AttentionActionId, string> = {
  contact_customer: 'Contact customer',
  mark_resolved: 'Mark resolved',
  refund_again: 'Refund again',
  respond: 'Respond',
  update_bank_account: 'Update bank account',
  refund: 'Refund',
  attach_to_invoice: 'Attach to invoice',
  create_invoice: 'Create invoice',
};

/**
 * What an action button says. Create invoice opens a page in a new tab, so it carries the new-tab icon and the words for
 * a screen reader (the same pair as `NewTabLink`).
 */
export function ActionLabel({ id }: { id: AttentionActionId }) {
  return (
    <>
      {ACTION_LABEL[id]}
      {id === 'create_invoice' && (
        <>
          {' '}
          <ExternalLink aria-hidden />
          <span className="sr-only"> (opens in a new tab)</span>
        </>
      )}
    </>
  );
}

/** Refund is the one red button, unless it is the first (then it is the filled one). */
export function actionVariant(id: AttentionActionId, index: number, fill = true): 'default' | 'outline' | 'destructive' {
  if (fill && index === 0) return 'default';
  return id === 'refund' ? 'destructive' : 'outline';
}

/** Every control this slice adds is 44px tall on a phone; the kit's defaults are left alone. */
export const PHONE_TAP = 'max-sm:min-h-11';

const FALLBACK_ERROR = 'This could not be done. Try again in a moment.';

/** The buttons come only from the server's `actions`; Respond needs a dispute to open. */
export function visibleActions(item: AttentionItem): AttentionActionId[] {
  return item.actions.filter((a) => a !== 'respond' || Boolean(item.dispute_id));
}

const UNMATCHED: ReadonlySet<string> = new Set(['unmatched_payment', 'unmatched_refund']);
/** The source row id of an item (the part of its key after the type). */
const sourceId = (item: AttentionItem) => item.key.slice(item.key.indexOf(':') + 1);

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
  title, confirmLabel, pending, confirmDisabled = false, intent = 'form', onClose, onConfirm, error, children,
}: {
  title: string;
  confirmLabel: string;
  pending: boolean;
  /** The confirm button waits on something other than a request (the payment it acts on is still loading). */
  confirmDisabled?: boolean;
  /** A short choice is a bottom sheet on a phone (`choice`); a form is full-screen (`form`). */
  intent?: 'form' | 'choice';
  onClose: (restoreFocus?: boolean) => void;
  onConfirm: () => void;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogContent
        intent={intent}
        className={`sm:max-w-md ${PHONE_TAP_AREA}`}
        // The opener is not a Dialog trigger, so the page puts focus back itself (see useActionPress).
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {children}
          {error && <Alert tone="danger" role="alert">{error}</Alert>}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" className={PHONE_TAP} onClick={() => onClose()} disabled={pending}>Cancel</Button>
          <Button type="button" className={PHONE_TAP} onClick={onConfirm} disabled={pending || confirmDisabled}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The words a person may close an item with. They match the server's list for the kind; the first is chosen on open. */
export const RESOLVE_REASONS_FAILED_REFUND = ['Returned the money another way', 'Handled outside ServWave'] as const;
export const RESOLVE_REASONS_OTHER = ['Handled outside ServWave', 'Duplicate entry', 'Not our payment'] as const;
export const resolveReasonsFor = (item: AttentionItem): readonly string[] =>
  item.type === 'failed_refund' ? RESOLVE_REASONS_FAILED_REFUND : RESOLVE_REASONS_OTHER;

/** The only resolve dialog: no money moves, the item moves to Resolved items, and the person says why. */
function ResolveDialog({ item, onClose }: { item: AttentionItem; onClose: (restoreFocus?: boolean) => void }) {
  const finish = useFinish();
  const unmatched = UNMATCHED.has(item.type);
  const reasons = resolveReasonsFor(item);
  const [reason, setReason] = useState<string>(reasons[0]!);
  const req = useRequest(
    () => {
      const url = unmatched ? `/api/payments-needing-attention/${sourceId(item)}/resolve` : `/api/payments-page/attention/${item.key}/resolve`;
      return api.post(url, { reason }, { silentErrors: true });
    },
    () => { finish('Marked as resolved'); onClose(false); focusCardHeading(); },
  );
  return (
    <ActionDialog title="Mark as resolved" intent="choice" confirmLabel="Mark resolved" pending={req.pending} error={req.error} onClose={onClose} onConfirm={req.run}>
      <p className="text-sm">Close this item without moving any money. It moves to Resolved items.</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="attention-resolve-reason">Reason</Label>
        <SelectField
          id="attention-resolve-reason"
          value={reason}
          onValueChange={setReason}
          options={reasons.map((r) => ({ value: r, label: r }))}
          disabled={req.pending}
        />
      </div>
    </ActionDialog>
  );
}

/**
 * The failed refund's own payment is fetched first. The dialog is up at once: a loading line while it comes, an error
 * with Retry if it does not, and the prefilled refund form once it is here. Confirm waits for the payment.
 */
function RefundAgainDialog({ item, onClose }: { item: AttentionItem; onClose: () => void }) {
  const finish = useFinish();
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

/**
 * Create invoice opens the new-invoice page in a NEW browser tab, from the click itself (so a pop-up blocker allows it).
 * The page learns the customer and the unapplied item from the address. With `noopener` the browser always hands back
 * null, which would look like a blocked tab, so the opener is cut afterwards instead; a null here really is a block.
 */
function openInvoiceInNewTab(item: AttentionItem) {
  const params = new URLSearchParams();
  if (item.customer?.id) params.set('customer_id', item.customer.id);
  params.set('unapplied_payment_id', sourceId(item));
  const tab = window.open(`/invoices/new?${params.toString()}`, '_blank');
  if (!tab) {
    toast.error('Your browser blocked the new tab. Allow pop-ups for this site.');
    return;
  }
  tab.opener = null;
}

/** What pressing an action does: Respond opens the Payment, its Dispute and the Respond view; every other action opens its own dialog. */
export function useActionPress(item: AttentionItem) {
  const [active, setActive] = useState<AttentionActionId | null>(null);
  const host = useDrawerHost();
  const opener = useRef<HTMLElement | null>(null);
  return {
    active,
    /** Closing without resolving puts focus back on the control that opened the dialog. */
    close: (restoreFocus = true) => {
      setActive(null);
      const target = opener.current;
      opener.current = null;
      if (restoreFocus && target) window.setTimeout(() => { if (target.isConnected) target.focus(); }, 0);
    },
    /** `from` is the control to return focus to: the pressed button, or "More" when chosen from its menu. */
    press: (id: AttentionActionId, from?: HTMLElement | null) => {
      if (id === 'respond') {
        const views = stackForItem(item, { respond: true });
        if (views) host.open(views);
        return;
      }
      if (id === 'create_invoice') {
        openInvoiceInNewTab(item);
        return;
      }
      opener.current = from ?? null;
      setActive(id);
    },
  };
}

/** The dialog for the pressed action, mounted fresh every time it is pressed (so a form never keeps an old answer). */
export function ActionDialogs({ item, active, onClose }: { item: AttentionItem; active: AttentionActionId | null; onClose: (restoreFocus?: boolean) => void }) {
  return (
    <>
      {active === 'contact_customer' && <ContactCustomerDialog item={item} onClose={() => onClose()} />}
      {active === 'mark_resolved' && <ResolveDialog item={item} onClose={onClose} />}
      {active === 'attach_to_invoice' && <AttachInvoiceDialog item={item} onClose={onClose} />}
      {active === 'refund' && <RefundUnappliedDialog item={item} onClose={onClose} />}
      {active === 'refund_again' && item.refund_again && <RefundAgainDialog item={item} onClose={onClose} />}
      <UpdateBankAccountDialog open={active === 'update_bank_account'} onOpenChange={(next) => { if (!next) onClose(); }} />
    </>
  );
}

/** Every action as its own button, first filled, the rest outlined (the payment drawer's footer). */
export function AttentionActions({
  item, size = 'sm', omit, fill = true,
}: {
  item: AttentionItem;
  size?: 'sm' | 'default';
  /** Buttons to leave out where the same action is offered elsewhere on screen (the drawer's dispute alert has Respond). */
  omit?: AttentionActionId[];
  /** The first button is filled. A footer with several items fills one button in all, so the others pass false. */
  fill?: boolean;
}) {
  const { active, press, close } = useActionPress(item);
  const actions = visibleActions(item).filter((a) => !omit?.includes(a));
  if (!actions.length) return null;
  return (
    <>
      {actions.map((id, i) => (
        <Button key={id} type="button" size={size} variant={actionVariant(id, i, fill)} className={PHONE_TAP} onClick={(event) => press(id, event.currentTarget)}>
          <ActionLabel id={id} />
        </Button>
      ))}
      <ActionDialogs item={item} active={active} onClose={close} />
    </>
  );
}
