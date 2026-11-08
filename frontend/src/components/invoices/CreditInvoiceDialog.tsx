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
import { Info } from 'lucide-react';
import { formatCurrency, extractApiError } from '@/lib/utils';
import { creditInvoice } from '@/lib/api/invoices';
import type { PaymentMethod, Credit } from '@/types/entities';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';

interface CreditInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  /** Outstanding balance — credits apply here first; excess is refunded. */
  balanceOwed: number;
  /** Existing credits for the ledger (GET may omit; render defensively). */
  credits?: Credit[];
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
  const amountInvalid = Number.isNaN(parsedAmount) || parsedAmount <= 0;
  const safeAmount = Number.isNaN(parsedAmount) ? 0 : parsedAmount;
  const excess = !Number.isNaN(parsedAmount) ? Math.max(parsedAmount - balanceOwed, 0) : 0;
  const showMethod = refundInstead || excess > 0;

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
        method: method || undefined,
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
            disabled={amountInvalid || !reason.trim() || mutation.isPending}
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
          {!refundInstead ? (
            <span>
              Credits apply to the outstanding balance first
              {balanceOwed > 0 && <> ({formatCurrency(balanceOwed)} owed)</>}; any excess is
              refunded to {method ? method.replace('_', ' ').toLowerCase() : 'the chosen method'}.
            </span>
          ) : reopenBalance ? (
            <span>
              The full amount goes back as cash and returns to the balance: the customer will owe{' '}
              {formatCurrency(balanceOwed + safeAmount)}, and
              the invoice reopens as unpaid.
            </span>
          ) : (
            <span>
              The full amount goes back as cash. The {formatCurrency(balanceOwed)} balance still
              owed is unchanged - the give-back is recorded as a write-off credit so the invoice
              still balances.
            </span>
          )}
        </div>

        <div>
          <Label>Amount *</Label>
          <Input
            type="number"
            data-testid="credit-amount-input"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            min={0.01}
            step={0.01}
            placeholder="0.00"
          />
          {amountInvalid && amount.trim() !== '' && (
            <p className="text-xs text-danger mt-1">Enter a positive amount.</p>
          )}
          {refundInstead ? (
            <p className="text-xs text-text-secondary mt-1">
              {formatCurrency(safeAmount)} refunded as cash · nothing credited to the balance.
            </p>
          ) : (
            excess > 0 && (
              <p className="text-xs text-text-secondary mt-1">
                {formatCurrency(balanceOwed)} credited · {formatCurrency(excess)} refunded as excess.
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

        <div className="flex items-center gap-2">
          <Checkbox
            id="credit-refund-instead"
            data-testid="credit-refund-instead"
            checked={refundInstead}
            onCheckedChange={(checked) => handleRefundInsteadChange(Boolean(checked))}
          />
          <Label htmlFor="credit-refund-instead" className="cursor-pointer">
            Send the money back as cash instead of crediting the balance
          </Label>
        </div>

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

        {showMethod && (
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
            maxLength={500}
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
