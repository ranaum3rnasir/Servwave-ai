import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/modal';
import { GiveBackLedger, EMPTY } from '@/components/invoices/GiveBackLedger';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { SelectField } from '@/components/form/SelectField';
import { AlertTriangle, Info } from 'lucide-react';
import { formatCurrency, extractApiError } from '@/lib/utils';
import { creditInvoice } from '@/lib/api/invoices';
import type { PaymentMethod, Credit, Refund } from '@/types/entities';
import {
  BANK_DUAL_CREDIT_WARNING, BANK_REFUND_WINDOW_MESSAGE, GIVE_BACK_PHRASE, giveBackDestination, refundDoorState, refundDrawnPayments,
  type RefundSourcePayment,
} from '@/lib/refund-rules';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
import { LONG_TEXT_MAX } from '@/lib/textLimits';

interface CreditInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  /** Outstanding balance — credits apply here first; excess is refunded. */
  balanceOwed: number;
  /** Existing credits for the ledger (GET may omit; render defensively). */
  credits?: Credit[];
  /**
   * Payments go-live slice 22/29: whether the user holds "Refund payments". A credit that sends
   * money back is a refund, which the server refuses without it (403), so without it the dialog
   * offers only a credit against what is still owed.
   */
  canRefund: boolean;
  /**
   * Slice 28b: the payments a give-back would draw from, with the refunds already on them, so the
   * bank rules (the second-credit warning, the 180-day message) show here as in the Refund dialog.
   */
  payments?: RefundSourcePayment[];
  refunds?: Refund[];
}

// R5b (2026-07-22) — derived from the shared list (was a hand-maintained duplicate) so D3's +4
// values reach every payment-method picker in the app, not just the ones someone remembered.
const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = PAYMENT_METHOD_ORDER.map((value) => ({
  value,
  label: PAYMENT_METHOD_LABELS[value],
}));

export function CreditInvoiceDialog({
  open,
  onOpenChange,
  invoiceId,
  balanceOwed,
  credits = [],
  canRefund,
  payments = [],
  refunds = [],
}: CreditInvoiceDialogProps) {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('');
  const [refundInstead, setRefundInstead] = useState(false);
  // Payment reversal opt-in (docs/adr/0004-refund-never-reopens-amount-due.md). Only meaningful
  // alongside refundInstead and only when a balance is owed; mirrors the backend's own guards but
  // does not substitute for them - the API is the contract.
  const [reopenBalance, setReopenBalance] = useState(false);
  const [method, setMethod] = useState<PaymentMethod | ''>('');
  const [nonTaxableConcession, setNonTaxableConcession] = useState(false);

  const parsedAmount = amount.trim() === '' ? NaN : Number(amount);
  // Without the refund permission nothing can go back, so a credit is capped at what is owed.
  const overBalance = !canRefund && !Number.isNaN(parsedAmount) && parsedAmount > balanceOwed + 0.0001;
  const amountInvalid = Number.isNaN(parsedAmount) || parsedAmount <= 0 || overBalance;
  const safeAmount = Number.isNaN(parsedAmount) ? 0 : parsedAmount;
  const excess = !Number.isNaN(parsedAmount) ? Math.max(parsedAmount - balanceOwed, 0) : 0;
  const showMethod = canRefund && (refundInstead || excess > 0);
  // The cash that goes back: all of it for "send back instead", else the excess over the balance.
  const giveBack = !canRefund || Number.isNaN(parsedAmount) ? 0 : refundInstead ? parsedAmount : excess;
  // The picker follows the PAYMENT the give-back would come from, not the amount typed: with no
  // amount yet, a cent stands in for it to find the payments that have something left to return.
  const drawn = refundDrawnPayments({ payments, refunds: refunds ?? [], amount: giveBack > 0 ? giveBack : 0.01 });
  const { showMethodPicker, method: sentMethod, bankRefund, pastBankWindow } = refundDoorState(drawn, method);
  const destination = giveBackDestination(drawn, showMethodPicker);
  const backTo = GIVE_BACK_PHRASE[destination];

  const reset = () => {
    setAmount('');
    setReason('');
    setCategory('');
    setRefundInstead(false);
    setReopenBalance(false);
    setMethod('');
    setNonTaxableConcession(false);
  };

  const handleRefundInsteadChange = (checked: boolean) => {
    setRefundInstead(checked);
    if (!checked) setReopenBalance(false);
  };

  const mutation = useMutation({
    mutationFn: async () => {
      return creditInvoice(invoiceId, {
        amount: parsedAmount,
        reason,
        category: category.trim() || undefined,
        refund_instead: refundInstead || undefined,
        reopen_balance: reopenBalance || undefined,
        // Slice 30: a hand method is sent only for a give-back recorded by hand (see refundDoorState).
        method: (sentMethod || undefined) as PaymentMethod | undefined,
        non_taxable_concession: nonTaxableConcession || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onOpenChange(false);
      reset();
    },
  });

  const ledger = credits ?? [];

  return (
    <Modal
      intent="form"
      open={open}
      onClose={() => onOpenChange(false)}
      title="Issue Credit"
      subtitle="Apply a credit / give-back to this invoice."
      width="sm"
      data-testid="credit-invoice-dialog"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="credit-invoice-submit"
            onClick={() => mutation.mutate()}
            disabled={amountInvalid || !reason.trim() || pastBankWindow || mutation.isPending}
          >
            {mutation.isPending ? 'Processing...' : 'Issue Credit'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <GiveBackLedger
          rows={ledger}
          columns={[
            {
              key: 'date',
              label: 'Date',
              render: (c) => (
                <span className="whitespace-nowrap">
                  {c.created_at ? new Date(c.created_at).toLocaleDateString('en-US') : EMPTY}
                </span>
              ),
            },
            {
              key: 'amount',
              label: 'Amount',
              numeric: true,
              render: (c) => (
                <span className="text-success-text">{formatCurrency(Number(c.amount))}</span>
              ),
            },
            { key: 'category', label: 'Category', render: (c) => c.category || EMPTY },
            {
              key: 'reason',
              label: 'Reason',
              render: (c) => <span className="block max-w-[10rem] truncate">{c.reason || EMPTY}</span>,
            },
          ]}
        />

        <div className="flex gap-2 rounded-lg border border-info-border bg-info-surface p-3 text-sm text-info-text">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          {!canRefund ? (
            <span>
              Credits lower the outstanding balance
              {balanceOwed > 0 && <> ({formatCurrency(balanceOwed)} owed)</>}.
            </span>
          ) : !refundInstead ? (
            <span>
              Credits apply to the outstanding balance first
              {balanceOwed > 0 && <> ({formatCurrency(balanceOwed)} owed)</>}; any excess is
              refunded {destination === 'hand'
                ? (sentMethod ? `by hand, as ${sentMethod.replace('_', ' ').toLowerCase()}` : 'by hand, with the method you choose')
                : backTo}.
            </span>
          ) : reopenBalance ? (
            <span>
              The full amount {destination === 'hand' ? 'is recorded as a refund by hand' : `goes back ${backTo}`} and returns to the balance: the customer will owe{' '}
              {formatCurrency(balanceOwed + safeAmount)}, and
              the invoice reopens as unpaid.
            </span>
          ) : (
            <span>
              The full amount {destination === 'hand' ? 'is recorded as a refund by hand' : `goes back ${backTo}`}. The {formatCurrency(balanceOwed)} balance still
              owed is unchanged - the give-back is recorded as a write-off credit so the invoice
              still balances.
            </span>
          )}
        </div>

        <div>
          <Label>Amount *</Label>
          <Input
            kind="money"
            data-testid="credit-amount-input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min={0.01}
            step={0.01}
            placeholder="0.00"
          />
          {overBalance ? (
            <p className="text-xs text-danger mt-1">A credit can be at most the {formatCurrency(balanceOwed)} still owed.</p>
          ) : (
            amountInvalid && amount.trim() !== '' && (
              <p className="text-xs text-danger mt-1">Enter a positive amount.</p>
            )
          )}
          {!canRefund ? null : refundInstead ? (
            <p className="text-xs text-text-secondary mt-1">
              {destination === 'hand'
                ? `${formatCurrency(safeAmount)} refund recorded by hand`
                : `${formatCurrency(safeAmount)} refunded ${backTo}`} · nothing credited to the balance.
            </p>
          ) : (
            excess > 0 && (
              <p className="text-xs text-text-secondary mt-1">
                {formatCurrency(balanceOwed)} credited · {formatCurrency(excess)} refunded as excess{destination === 'hand' ? ', recorded by hand' : ` ${backTo}`}.
              </p>
            )
          )}
        </div>

        <div>
          <Label>Category</Label>
          <Input
            type="text"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="e.g. goodwill, adjustment (optional)"
          />
        </div>

        {canRefund && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="credit-refund-instead"
              data-testid="credit-refund-instead"
              checked={refundInstead}
              onCheckedChange={(checked) => handleRefundInsteadChange(Boolean(checked))}
            />
            <Label htmlFor="credit-refund-instead" className="cursor-pointer">
              Send the money back instead of crediting the balance
            </Label>
          </div>
        )}

        {refundInstead && balanceOwed > 0 && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="credit-reopen-balance"
              data-testid="credit-reopen-balance"
              checked={reopenBalance}
              onCheckedChange={(checked) => setReopenBalance(Boolean(checked))}
            />
            <Label htmlFor="credit-reopen-balance" className="cursor-pointer">
              Put the refunded amount back on the customer&apos;s balance (payment reversal)
            </Label>
          </div>
        )}

        {showMethod && (pastBankWindow ? (
          <p className="text-sm text-danger" data-testid="credit-bank-window">
            {BANK_REFUND_WINDOW_MESSAGE}
          </p>
        ) : (
          bankRefund && (
            <div
              className="flex gap-2 rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-warning-text"
              data-testid="credit-bank-warning"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{BANK_DUAL_CREDIT_WARNING}</span>
            </div>
          )
        ))}

        {showMethod && showMethodPicker && (
          <div>
            <Label>Refund method</Label>
            <SelectField
              aria-label="Refund method"
              value={method || 'NONE'}
              onValueChange={(v) => setMethod(v === 'NONE' ? '' : (v as PaymentMethod))}
              className="w-full h-9"
              options={[
                { value: 'NONE', label: 'Select a method...' },
                ...PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label })),
              ]}
            />
          </div>
        )}

        <div className="flex items-center gap-2">
          <Checkbox
            id="credit-non-taxable"
            checked={nonTaxableConcession}
            onCheckedChange={(checked) => setNonTaxableConcession(Boolean(checked))}
          />
          <Label htmlFor="credit-non-taxable" className="cursor-pointer">
            Non-taxable concession (do not reverse tax)
          </Label>
        </div>

        <div>
          <Label>Reason *</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Provide details about this credit..."
            maxLength={LONG_TEXT_MAX}
          />
        </div>

        {mutation.error && (
          <p className="text-sm text-danger">
            {extractApiError(mutation.error, 'Failed to issue credit')}
          </p>
        )}
      </div>
    </Modal>
  );
}
