import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Check, Loader2, Package, Receipt, Wrench } from 'lucide-react';
import { cn, extractApiError, formatCurrency } from '@/lib/utils';
import { listJobLines, createJobInvoice } from '@/lib/api/jobs';
import api from '@/lib/axios';

// SERV10X-38 Task 6: bills a job's OWN line items (JobLineItem, added on the Items tab) via
// the explicit draw/itemized endpoint POST /api/jobs/:id/invoices. Three modes:
//   - Amount:   a flat dollar draw against the job's remaining balance.
//   - Percent:  a flat draw computed as a % of the job's total.
//   - Itemized: pick specific job lines; they're copied onto the new invoice verbatim.
// Over-billing is deliberately NOT blocked (Spec B1): a job's billable-line total is an estimate
// of the work, not a ceiling on what may be invoiced. `billing.remaining` is shown as a reference
// and used as a default — it never blocks a submit. The over-billed amount is surfaced on the
// job's billing summary via computeJobBilling.over_billed.

type Mode = 'AMOUNT' | 'PERCENT' | 'ITEMIZED';

/**
 * First line of the stored description is the item name, the rest is detail — the same rule
 * `LineItemRow`/`AddLineDialog` use when they write and read these back apart (`name\ndetail`).
 */
function splitDescription(description: string): { name: string; detail: string } {
  const parts = description.split('\n');
  return { name: parts[0] || '', detail: parts.slice(1).join('\n') };
}

interface CreateJobInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  jobNumber: string;
  /** Navigate to the freshly-created invoice. */
  onCreated: (invoiceId: string) => void;
  /** Send the invoice immediately after creating it (the lifecycle-bar path). */
  sendAfterCreate?: boolean;
  /** State 2 — skip the form entirely and offer to send this existing draft. */
  existingDraft?: { id: string; invoice_number: string } | null;
  /** Preselected billing mode. Defaults to AMOUNT. */
  initialMode?: Mode;
}

export function CreateJobInvoiceDialog({
  open,
  onOpenChange,
  jobId,
  jobNumber,
  onCreated,
  sendAfterCreate = false,
  existingDraft = null,
  initialMode = 'AMOUNT',
}: CreateJobInvoiceDialogProps) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [amount, setAmount] = useState('');
  const [percent, setPercent] = useState('');
  const [lineIds, setLineIds] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState('');
  const [needsRecipient, setNeedsRecipient] = useState(false);
  // Set the moment createJobInvoice succeeds (whether or not the follow-up send does). Once
  // set, a retry must only re-attempt the send — never call createJobInvoice a second time,
  // which would silently stack a duplicate invoice on the job.
  const [createdInvoiceId, setCreatedInvoiceId] = useState<string | null>(null);

  const sendInvoice = async (invoiceId: string) => {
    try {
      await api.post(`/api/invoices/${invoiceId}/send`, recipient ? { to: recipient } : {});
      setNeedsRecipient(false);
    } catch (err) {
      // The API 400s with a recipient message when the customer has no email on file
      // (invoice.controller.ts:1125-1128). That is a collectable fact, not a failure — reveal
      // the field and let them finish here rather than bouncing them to the customer record.
      if (/recipient/i.test(extractApiError(err, ''))) {
        setNeedsRecipient(true);
        throw new Error('Enter an email address to send this invoice to.');
      }
      throw err;
    }
  };

  // Only the job's OWN line items are billable here — fetched fresh whenever the dialog opens
  // so `remaining` reflects any items added/edited on the Items tab since the last invoice.
  const { data } = useQuery({
    queryKey: ['job-line-items', jobId],
    queryFn: () => listJobLines(jobId),
    enabled: open,
  });
  const lines = data?.lines ?? [];
  const billing = data?.billing ?? { subtotal: 0, total: 0, invoiced: 0, remaining: 0 };

  // The PERCENT draw is a percent of the job's PRE-TAX, PRE-DISCOUNT subtotal - the backend
  // computes it that way on purpose (job.controller.createInvoiceFromJob passes taxRate 0 /
  // no discount to computeJobBilling for exactly this basis, then layers tax onto the resulting
  // invoice). Since job-items-estimate-parity D1/D2 made `billing.total` tax-inclusive, `total`
  // is no longer that basis - showing it here would quote the user a percent of one number while
  // the server charged a percent of another (e.g. 50% of a $213.25 total reading, but $200.00
  // billed). `billing.subtotal` IS the server's basis, so the two agree again.
  const percentBasis = billing.subtotal;

  const reset = () => {
    setMode('AMOUNT');
    setAmount('');
    setPercent('');
    setLineIds([]);
    setDescription('');
    setFormError(null);
    setRecipient('');
    setNeedsRecipient(false);
    setCreatedInvoiceId(null);
  };

  const itemizedTotal = lines
    .filter((l) => lineIds.includes(l.id))
    .reduce((sum, l) => sum + Number(l.line_total), 0);
  const allSelected = lines.length > 0 && lineIds.length === lines.length;

  const mutation = useMutation({
    mutationFn: async () => {
      // A prior submit already created the invoice and only the send failed (e.g. missing
      // recipient, collected below) — resubmitting must retry ONLY the send, never call
      // createJobInvoice again.
      if (createdInvoiceId) {
        await sendInvoice(createdInvoiceId);
        return { invoice: { id: createdInvoiceId } };
      }
      const body =
        mode === 'AMOUNT'
          ? { amount: Number(amount), description: description.trim() || undefined }
          : mode === 'PERCENT'
            ? { percent: Number(percent), description: description.trim() || undefined }
            : { lineIds, description: description.trim() || undefined };
      const created = await createJobInvoice(jobId, body);
      setCreatedInvoiceId(created.invoice.id);
      if (sendAfterCreate) await sendInvoice(created.invoice.id);
      return created;
    },
    onSuccess: ({ invoice }) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['job-line-items', jobId] });
      queryClient.invalidateQueries({ queryKey: ['job-financials', jobId] });
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      onOpenChange(false);
      reset();
      onCreated((invoice as { id: string }).id);
    },
    onError: () => {
      // The invoice may well have been created before the send failed. Re-read so a retry lands
      // in State 2 (send the existing draft) instead of State 3 (create another one).
      queryClient.invalidateQueries({ queryKey: ['job-financials', jobId] });
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
    },
  });

  const sendDraft = useMutation({
    mutationFn: () => sendInvoice(existingDraft!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job-financials', jobId] });
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      queryClient.invalidateQueries({ queryKey: ['job-timeline', jobId] });
      onOpenChange(false);
    },
  });

  const toggleLine = (lineId: string) =>
    setLineIds((prev) => (prev.includes(lineId) ? prev.filter((id) => id !== lineId) : [...prev, lineId]));

  const handleSubmit = () => {
    setFormError(null);

    // Once the invoice already exists (create succeeded, only the send failed), the form
    // fields describe an invoice that's already been created — resubmitting only retries the
    // send, so the create-mode validation below no longer applies.
    if (!createdInvoiceId) {
      if (mode === 'AMOUNT') {
        const n = Number(amount);
        if (!(n > 0)) {
          setFormError('Enter an amount greater than 0.');
          return;
        }
      } else if (mode === 'PERCENT') {
        const n = Number(percent);
        if (!(n > 0) || n > 100) {
          setFormError('Enter a percent between 0 and 100.');
          return;
        }
      } else {
        if (lineIds.length === 0) {
          setFormError('Select at least one line item.');
          return;
        }
      }
    }

    mutation.mutate();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Modal
      open={open}
      onClose={() => handleOpenChange(false)}
      title={`Create Invoice for ${jobNumber}`}
      subtitle={
        <>
          Remaining balance:{' '}
          <span className="font-semibold text-text-primary">{formatCurrency(billing.remaining)}</span> of{' '}
          {formatCurrency(billing.total)}.
        </>
      }
      width="md"
      data-testid="create-job-invoice-dialog"
      // Two different jobs, so two different footers: with a draft already on
      // the job the only useful action is to SEND that one, not to create a
      // second beside it.
      footer={
        existingDraft ? (
          <>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={sendDraft.isPending}>
              Cancel
            </Button>
            <Button variant="solid" tone="business" onClick={() => sendDraft.mutate()} disabled={sendDraft.isPending}>
              {sendDraft.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sending...
                </>
              ) : (
                <>
                  <Receipt className="mr-2 h-4 w-4" /> Send {existingDraft.invoice_number}
                </>
              )}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="solid" tone="business"
              data-testid="create-job-invoice-submit"
              onClick={handleSubmit}
              disabled={mutation.isPending}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creating...
                </>
              ) : (
                <>
                  <Receipt className="mr-2 h-4 w-4" /> {sendAfterCreate ? 'Create & Send' : 'Create Invoice'}
                </>
              )}
            </Button>
          </>
        )
      }
    >
      {existingDraft ? (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {jobNumber} already has draft invoice {existingDraft.invoice_number}. Send it
            rather than creating a second one.
          </p>
          {needsRecipient && (
            <div className="space-y-1">
              <Label htmlFor="invoice-recipient">Send to</Label>
              <Input
                id="invoice-recipient"
                type="email"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="customer@example.com"
              />
            </div>
          )}
          {sendDraft.isError && (
            <p className="text-sm text-danger">
              {extractApiError(sendDraft.error, 'Failed to send invoice')}
            </p>
          )}
        </div>
      ) : (
      <div className="space-y-4">
        {/* Mode toggle */}
        <div className="flex rounded-md border border-border p-0.5" role="tablist" aria-label="Billing mode">
          {([
            ['AMOUNT', 'Amount'],
            ['PERCENT', 'Percent'],
            ['ITEMIZED', 'Itemized'],
          ] as [Mode, string][]).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'flex-1 rounded-[4px] py-1.5 text-sm font-medium transition-colors',
                mode === m ? 'bg-primary text-on-fill' : 'text-text-secondary hover:bg-background-light',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === 'AMOUNT' && (
          <div className="space-y-1">
            <Label htmlFor="draw-amount">Amount ($)</Label>
            <Input
              id="draw-amount"
              type="number"
              min={0.01}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        )}

        {mode === 'PERCENT' && (
          <div className="space-y-1">
            <Label htmlFor="draw-percent">
              Percent of {formatCurrency(percentBasis)} pre-tax job total (%)
            </Label>
            <Input
              id="draw-percent"
              type="number"
              min={0.01}
              max={100}
              step={0.01}
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </div>
        )}

        {mode === 'ITEMIZED' && (
          <div className="space-y-2">
            <Label>Select line items</Label>
            {lines.length === 0 ? (
              <p className="text-sm text-text-secondary">No line items on this job yet.</p>
            ) : (
              <>
                <div className="flex items-center gap-3">
                  <Checkbox
                    id="invoice-select-all-lines"
                    checked={allSelected ? true : lineIds.length > 0 ? 'indeterminate' : false}
                    onCheckedChange={() => setLineIds(allSelected ? [] : lines.map((l) => l.id))}
                  />
                  <label
                    htmlFor="invoice-select-all-lines"
                    className="cursor-pointer text-xs font-semibold text-text-secondary"
                  >
                    {allSelected ? 'Clear all' : `Select all ${lines.length}`}
                  </label>
                </div>

                <div className="max-h-80 space-y-2 overflow-y-auto pr-0.5">
                  {lines.map((line) => {
                    const { name, detail } = splitDescription(line.description);
                    const isSelected = lineIds.includes(line.id);
                    const ItemTypeIcon = line.item_type === 'SERVICE' ? Wrench : Package;
                    return (
                      <button
                        key={line.id}
                        type="button"
                        onClick={() => toggleLine(line.id)}
                        aria-pressed={isSelected}
                        className={cn(
                          'relative block w-full rounded-card border p-3 text-left transition-all',
                          isSelected
                            ? 'border-primary bg-primary-subtle ring-1 ring-primary'
                            : 'border-border hover:border-border-soft hover:bg-background-light',
                        )}
                      >
                        <span className="flex items-start gap-2.5">
                          <ItemTypeIcon
                            className={cn(
                              'mt-0.5 h-4 w-4 shrink-0',
                              isSelected ? 'text-primary' : 'text-text-soft',
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block break-words pr-6 text-sm font-semibold text-text-primary">
                              {name}
                            </span>
                            {detail && (
                              <span className="mt-1 block text-xs leading-relaxed text-text-secondary">
                                {detail}
                              </span>
                            )}
                          </span>
                          {isSelected && (
                            <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary">
                              <Check className="h-3 w-3 text-on-fill" />
                            </span>
                          )}
                        </span>
                        <span className="mt-2.5 flex items-baseline justify-between border-t border-border-soft pt-2">
                          <span className="text-xs tabular-nums text-text-secondary">
                            {Number(line.quantity)} x {formatCurrency(Number(line.unit_price))}
                          </span>
                          <span className="text-base font-semibold tabular-nums text-text-primary">
                            {formatCurrency(Number(line.line_total))}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-baseline justify-between rounded-card bg-background-light px-3 py-2">
                  <span className="text-xs text-text-secondary">
                    {lineIds.length} of {lines.length} selected
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-text-primary">
                    {formatCurrency(itemizedTotal)}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="invoice-description">Description (optional)</Label>
          <Input
            id="invoice-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Progress payment"
          />
        </div>

        {/* The invoice may already exist at this point (create succeeded, send didn't) — see
            `createdInvoiceId` in the mutation above. Resubmitting here retries the send only. */}
        {needsRecipient && (
          <div className="space-y-1">
            <Label htmlFor="invoice-recipient">Send to</Label>
            <Input
              id="invoice-recipient"
              type="email"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="customer@example.com"
            />
          </div>
        )}

        {formError && <p className="text-sm text-danger">{formError}</p>}
        {mutation.isError && (
          <p className="text-sm text-danger">
            {extractApiError(mutation.error, 'Failed to create invoice')}
          </p>
        )}
      </div>
      )}
    </Modal>
  );
}
