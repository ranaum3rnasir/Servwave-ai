import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { markEstimateSent } from '@/lib/api/estimates';
import { toast } from '@/components/ui/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, FileCheck } from 'lucide-react';
import { formatCurrency, extractApiError } from '@/lib/utils';
import { useOrganization, type PaymentMethod } from '@/lib/api/organization';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
import type { DepositType } from '@/lib/deposit';
import { DepositControls } from '@/components/estimates/DepositControls';
import { useDepositDraft } from '@/components/estimates/useDepositDraft';

interface MarkSentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  estimateNumber: string;
  totalAmount: number;
  // The estimate's own deposit override (Receipt Card). markSent() runs the same commitFirstSend
  // ceremony as send(), so it charges resolveDepositAmount's answer - which prefers this over the
  // org defaults. The preview has to read it or it shows one number and bills another.
  depositType?: DepositType | null;
  depositValue?: number | string | null;
  // True once a send_config exists (see SendEstimateDialogProps' identical comment). Defensive
  // only here: Mark Sent is DRAFT-only at both ends, so a DRAFT has no send_config and no user can
  // reach a frozen Mark Sent dialog - but the shared control must not grow a second, divergent
  // freeze rule later.
  depositFrozen?: boolean;
  // The deposit actually billed (send_config). See SendEstimateDialogProps' identical comment.
  existingDepositAmount?: number | null;
  existingDepositPercentage?: number | null;
  // `ability.can('update', 'Estimate')`, resolved once at the EstimateWorkspacePage callsite
  // (#2010 finding 1). A role holding `send Estimate` but not `update Estimate` gets a read-only
  // deposit here instead of inputs that lead to a PATCH the backend refuses. Defaults `true`.
  canEditDeposit?: boolean;
  onSuccess: () => void;
}

const CC_SURCHARGE_RATE = 0.035;

/**
 * R4 (2026-07-21) — port-plan §3.2's `marksent`/`domarksent`: the estimate was delivered outside
 * the app (in person, a phone call, a printed copy), so this stamps SENT and starts the deposit
 * clock without emailing anything. Body shape mirrors `send()` exactly (deposit_required/
 * payment_methods/message_body) because the backend runs the identical commitFirstSend ceremony —
 * deliberately NOT a lighter form, so the deposit policy can't be dodged by picking this over Send.
 */
export function MarkSentDialog({
  open,
  onOpenChange,
  estimateId,
  estimateNumber,
  totalAmount,
  depositType,
  depositValue,
  depositFrozen,
  existingDepositAmount,
  existingDepositPercentage,
  canEditDeposit = true,
  onSuccess,
}: MarkSentDialogProps) {
  const queryClient = useQueryClient();
  const { data: org } = useOrganization();
  const orgAcceptedMethods: PaymentMethod[] =
    (org?.accepted_payment_methods as PaymentMethod[] | undefined) ?? [];

  const [depositRequired, setDepositRequired] = useState(true);
  const [enabledMethods, setEnabledMethods] = useState<Set<PaymentMethod>>(
    new Set(orgAcceptedMethods),
  );
  const [note, setNote] = useState('');

  // The deposit draft - shared with SendEstimateDialog via useDepositDraft (#2010), so Mark Sent
  // offers the same editable "Deposit %" / "Deposit amount" pair Send does, instead of the
  // read-only `resolveDeposit(...)` text it rendered before.
  const {
    percent: depositPercent,
    amount: depositAmountInput,
    amountNumber: depositAmount,
    editable: depositEditable,
    dirty: depositChanged,
    valid: depositValid,
    setPercent: handleDepositPercentChange,
    setAmount: handleDepositAmountChange,
    patchBody: depositPatchBody,
  } = useDepositDraft({
    open,
    totalAmount,
    depositType,
    depositValue,
    depositFrozen,
    existingDepositAmount,
    existingDepositPercentage,
    depositRequired,
    canEditDeposit,
  });

  useEffect(() => {
    setEnabledMethods(new Set(orgAcceptedMethods));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.accepted_payment_methods?.join('|')]);

  // Recomputed from the live draft amount, not from a static resolution - otherwise this would
  // quote a processing fee for a deposit the operator just changed.
  const ccTotal = depositAmount * (1 + CC_SURCHARGE_RATE);
  const ccFee = ccTotal - depositAmount;

  const toggleMethod = (key: PaymentMethod) => {
    setEnabledMethods((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // #2044 — missing payment methods is a warning, never a block: `enabledMethods.size` no longer
  // gates the button, it only drives the warning copy below. `depositValid` (#2010) stays.
  const canSubmit = depositValid;

  const mutation = useMutation({
    mutationFn: async () => {
      // Persist the deposit BEFORE stamping SENT, through the same PATCH Send uses - the mark-sent
      // endpoint takes no deposit argument. A failed PATCH throws into onError and the mark-sent
      // never fires: better a blocked stamp than one that bills a deposit other than the one on
      // screen (mirrors SendEstimateDialog.tsx's mutationFn).
      if (depositEditable && depositRequired && depositChanged) {
        await api.patch(`/api/estimates/${estimateId}`, depositPatchBody);
      }

      return markEstimateSent(estimateId, {
        deposit_required: depositRequired,
        payment_methods: Array.from(enabledMethods),
        ...(note.trim() ? { message_body: note.trim() } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
      onSuccess();
      toast({ title: 'Marked sent', description: `${estimateNumber} is now Sent — no email was delivered.` });
    },
    onError: (err: unknown) => {
      toast({ title: 'Could not mark as sent', description: extractApiError(err, 'Failed to mark estimate as sent'), variant: 'destructive', duration: Infinity });
    },
  });

  // The mutation outlives any one opening of the dialog, so a failed attempt leaves `mutation.error`
  // set and the next open renders last time's refusal as if it were about this attempt.
  useEffect(() => {
    if (open) mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Mark {estimateNumber} as Sent</DialogTitle>
          <DialogDescription>
            Use this when the estimate was delivered outside the app — no email goes out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Note (internal)</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="How was it delivered? (optional)"
            />
          </div>

          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center justify-between">
              <Label htmlFor="mark-sent-deposit-toggle" className="text-sm font-semibold">
                Require deposit
              </Label>
              <Switch
                id="mark-sent-deposit-toggle"
                checked={depositRequired}
                onCheckedChange={setDepositRequired}
              />
            </div>

            {depositRequired && (
              <>
                <DepositControls
                  idPrefix="mark-sent"
                  percent={depositPercent}
                  amount={depositAmountInput}
                  totalAmount={totalAmount}
                  editable={depositEditable}
                  frozen={Boolean(depositFrozen)}
                  valid={depositValid}
                  onPercentChange={handleDepositPercentChange}
                  onAmountChange={handleDepositAmountChange}
                />

                <p className="text-sm text-text-secondary">
                  {depositPercent}% ={' '}
                  <span className="font-medium tabular-nums text-text-primary">
                    {formatCurrency(depositAmount)}
                  </span>
                </p>

                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wide">
                    Payment methods
                  </Label>

                  {PAYMENT_METHOD_ORDER
                    .filter((key) => orgAcceptedMethods.includes(key))
                    .map((key) => (
                      <div key={key} className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`mark-sent-pm-${key}`}
                            checked={enabledMethods.has(key)}
                            onCheckedChange={() => toggleMethod(key)}
                          />
                          {/* Checkbox-row label (sits beside, not above, its control) - not a
                              FormField-shape site, left raw. */}
                          <label
                            htmlFor={`mark-sent-pm-${key}`}
                            className="text-sm font-medium cursor-pointer select-none"
                          >
                            {PAYMENT_METHOD_LABELS[key]}
                          </label>
                        </div>
                        {key === 'CARD' && enabledMethods.has('CARD') && (
                          <p className="ml-6 text-xs text-text-secondary tabular-nums">
                            {formatCurrency(ccTotal)} (incl. {formatCurrency(ccFee)} processing fee)
                          </p>
                        )}
                      </div>
                    ))}

                  {orgAcceptedMethods.length === 0 && (
                    <p className="text-xs text-danger">
                      No payment methods accepted by your organization. Update them in Organization Settings.
                    </p>
                  )}
                  {orgAcceptedMethods.length > 0 && enabledMethods.size === 0 && (
                    <p className="text-xs text-danger">
                      No payment method selected. The customer will not be able to pay the deposit
                      or approve this estimate online.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          {mutation.isError && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to mark estimate as sent')}
            </p>
          )}

          <div className="flex justify-end gap-3 border-t pt-4">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => mutation.mutate()}
              disabled={!canSubmit || mutation.isPending}
            >
              {mutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileCheck className="mr-2 h-4 w-4" />
              )}
              {mutation.isPending ? 'Marking...' : 'Mark as Sent'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
