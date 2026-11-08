import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Loader2, Send, AlertTriangle, X, Lock } from 'lucide-react';
import { extractApiError } from '@/lib/utils';
import { useOrganization, type PaymentMethod } from '@/lib/api/organization';
import { PAYMENT_METHOD_LABELS, PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';
import { StripePaymentsBanner } from '@/components/payments/StripePaymentsBanner';
import { DepositControls } from '@/components/estimates/DepositControls';
import { useDepositDraft } from '@/components/estimates/useDepositDraft';
import type { DepositType } from '@/lib/deposit';

interface SendEstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  estimateNumber: string;
  totalAmount: number;
  // #1997 — `undefined` means the requester's Customer read scope excludes this row and the
  // backend never sent the key at all (redacted); `null` means the customer genuinely has no
  // email on file. The two render differently — see `emailRedacted` below.
  customerEmail: string | null | undefined;
  alreadySent: boolean;
  sentAt?: string | null;
  // The estimate's own deposit override (Receipt Card). The send CHARGES this in preference to the
  // org defaults (backend resolveDepositAmount), so the preview has to read it or it shows one
  // number and bills another.
  depositType?: DepositType | null;
  depositValue?: number | string | null;
  // True once a send_config exists, i.e. the deposit has been billed and can no longer move.
  // Deliberately NOT derived from `alreadySent` (which is status === 'SENT'): a PENDING or WON
  // estimate is equally past its first send, and the Receipt Card gates on send_config too.
  depositFrozen?: boolean;
  // The deposit actually billed (send_config). Displayed verbatim once frozen - the real charged
  // figure outranks anything recomputed from the estimate's current totals.
  existingDepositAmount?: number | null;
  existingDepositPercentage?: number | null;
  // `ability.can('update', 'Estimate')`, resolved once at the EstimateWorkspacePage callsite
  // (#2010 finding 1). Mirrors MarkSentDialogProps' identical comment. Defaults `true`.
  canEditDeposit?: boolean;
  // #2091 - `depositInvoiceIsUnpaid` (lib/deposit.ts) on the estimate's own DEPOSIT invoice. A
  // resend re-prices exactly that invoice (repriceUnpaidDepositInvoice) while it stays unpaid, so
  // the frozen `existingDepositAmount` above is about to go stale - see useDepositDraft's
  // `depositInvoiceUnpaid`/`willReprice` for what this drives. Defaults `false`.
  depositInvoiceUnpaid?: boolean;
  onSuccess: () => void;
}

const DEFAULT_MESSAGE =
  'Thank you for your recent service inquiry with us. Click the link below to view your estimate.';

export function SendEstimateDialog({
  open,
  onOpenChange,
  estimateId,
  estimateNumber,
  totalAmount,
  customerEmail,
  alreadySent,
  sentAt,
  depositType,
  depositValue,
  depositFrozen = false,
  existingDepositAmount,
  existingDepositPercentage,
  canEditDeposit = true,
  depositInvoiceUnpaid = false,
  onSuccess,
}: SendEstimateDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: org } = useOrganization();
  const orgAcceptedMethods: PaymentMethod[] =
    (org?.accepted_payment_methods as PaymentMethod[] | undefined) ?? [];

  const [messageBody, setMessageBody] = useState(DEFAULT_MESSAGE);
  const [depositRequired, setDepositRequired] = useState(true);

  // The deposit draft - mirroring, mode inference, the dirty rule and the patch body - shared with
  // MarkSentDialog via useDepositDraft (#2010). See that file for the behaviour this used to own
  // directly.
  const {
    percent: depositPercent,
    amount: depositAmountInput,
    editable: depositEditable,
    dirty: depositChanged,
    valid: depositValid,
    willReprice: depositWillReprice,
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
    depositInvoiceUnpaid,
  });

  // §4.5 — pre-fill from org defaults. Dispatcher can only narrow this set.
  const [enabledMethods, setEnabledMethods] = useState<Set<PaymentMethod>>(
    new Set(orgAcceptedMethods),
  );

  // When org data loads after the dialog mounts, sync the pre-fill.
  useEffect(() => {
    setEnabledMethods(new Set(orgAcceptedMethods));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org?.accepted_payment_methods?.join('|')]);
  const [ccEmails, setCcEmails] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState<string>('');
  const [ccError, setCcError] = useState<string | null>(null);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MAX_CC = 5;

  // #1997 — `undefined` (never `null`, which stays the pre-existing "genuinely no email on file"
  // behaviour below) means the requester's Customer read scope redacted the key entirely. The
  // "To" field must not present itself as an empty address the rep is expected to fill; it
  // degrades to a read-only neutral placeholder instead. The only signal is key absence — never a
  // role name.
  const emailRedacted = customerEmail === undefined;
  const savedEmail = customerEmail ?? '';

  // One-off recipient (editable "To"). Seeded from the customer's saved email; the override is
  // request-scoped (sent as recipient_override) and never overwrites the saved customer record.
  // Adjusted during render rather than in an effect when the prop itself changes (e.g. the
  // customer loads in after the dialog first mounts) - same idiom, same reason, as the `wasOpen`
  // reset below (`react-hooks/set-state-in-effect`).
  const [recipientEmail, setRecipientEmail] = useState(savedEmail);
  const [lastSavedEmail, setLastSavedEmail] = useState(savedEmail);
  if (savedEmail !== lastSavedEmail) {
    setLastSavedEmail(savedEmail);
    setRecipientEmail(savedEmail);
  }
  const recipientValid = emailRedacted || EMAIL_RE.test(recipientEmail.trim());

  // Every open starts a fresh compose. The dialog stays mounted while closed, so without this a
  // cancelled edit survives: reopening still showed the one-off address typed the time before,
  // and since an override is only threaded when it DIFFERS from the saved customer email, that
  // stale value reads as the customer's own address while quietly addressing someone else.
  //
  // Adjusted during render rather than in an effect - React's documented way to reset state when
  // a prop changes. An effect would re-render the stale compose once before clearing it, which is
  // what `react-hooks/set-state-in-effect` (enforced on changed lines in CI) is guarding against.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setRecipientEmail(savedEmail);
      setCcEmails([]);
      setCcInput('');
      setCcError(null);
      setMessageBody(DEFAULT_MESSAGE);
      setDepositRequired(true);
      setEnabledMethods(new Set(orgAcceptedMethods));
    }
  }

  // Radix focuses the first tabbable child on open, which is the "Via SMS" lock - a non-feature
  // whose tooltip then opens on focus and covers the "To" label. Send the caret to the recipient
  // field instead: it is the first thing worth acting on, and it keeps the SMS explanation
  // reachable by Tab rather than deleting the affordance.
  const recipientInputRef = useRef<HTMLInputElement>(null);
  // Only thread an override when the user edited the address away from the saved customer email.
  // Never threaded when redacted — the field is read-only, so there is nothing to have edited,
  // and sendEstimateInternal's fallback to the stored address is what must fire (estimate.
  // controller.ts:2354).
  const recipientOverride =
    !emailRedacted && recipientEmail.trim().toLowerCase() !== savedEmail.trim().toLowerCase()
      ? recipientEmail.trim()
      : undefined;

  const tryAddCc = (raw: string) => {
    const candidate = raw.trim().replace(/,$/, '').trim();
    if (!candidate) return;
    if (!EMAIL_RE.test(candidate)) {
      setCcError('Invalid email address');
      return;
    }
    if (ccEmails.includes(candidate) || candidate.toLowerCase() === savedEmail.toLowerCase()) {
      setCcError('Email already added');
      return;
    }
    if (ccEmails.length >= MAX_CC) {
      setCcError(`Maximum ${MAX_CC} CC emails`);
      return;
    }
    setCcEmails([...ccEmails, candidate]);
    setCcInput('');
    setCcError(null);
  };

  const removeCc = (email: string) => {
    setCcEmails(ccEmails.filter((e) => e !== email));
    setCcError(null);
  };

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
  // gates the button, it only drives the warning copy below.
  const canSend = recipientValid && depositValid;

  const mutation = useMutation({
    mutationFn: async () => {
      // Persist the deposit BEFORE sending, through the same PATCH the Receipt Card uses. The send
      // endpoint takes no deposit argument - it re-derives the charge from the estimate row - so
      // the row is the single source of truth and this has to land first. A failure here throws
      // into onError and the send never happens: better a blocked send than one that bills a
      // different deposit than the one on screen.
      if (depositEditable && depositRequired && depositChanged) {
        await api.patch(`/api/estimates/${estimateId}`, depositPatchBody);
      }

      const { data } = await api.post(`/api/estimates/${estimateId}/send`, {
        deposit_required: depositRequired,
        payment_methods: Array.from(enabledMethods),
        message_body: messageBody,
        ...(!emailRedacted && ccEmails.length > 0 ? { cc_emails: ccEmails } : {}),
        ...(recipientOverride ? { recipient_override: recipientOverride } : {}),
      });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
      onSuccess();
      toast({ title: 'Estimate sent', description: `${estimateNumber} has been emailed to the customer.` });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to send estimate';
      toast({ title: 'Estimate not sent', description: msg, variant: 'destructive', duration: Infinity });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md max-h-[90vh] overflow-y-auto"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          recipientInputRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Send Estimate</DialogTitle>
        </DialogHeader>

        <StripePaymentsBanner onSetup={() => navigate('/settings/payments')} />

        {/* Resend warning */}
        {alreadySent && (
          <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-surface p-3 text-sm text-warning-text">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              This estimate was already sent
              {sentAt && ` on ${new Date(sentAt).toLocaleDateString('en-US')}`}.
              Sending again will deliver a new email to the customer.
            </span>
          </div>
        )}

        <Tabs defaultValue="email">
          <TabsList className="w-full">
            <TabsTrigger value="email" className="flex-1">
              Via Email
            </TabsTrigger>
            {/* R4 (2026-07-21) — SMS lock upgraded to the AddStepButton pattern (workflows/
                AddStepButton.tsx): greyed + a "Coming soon" badge + an explanatory tooltip on
                hover/focus, instead of a bare disabled tab with no reason given. A plain element,
                not a real TabsPrimitive.Trigger — Radix's `disabled` sets pointer-events:none
                (tabs.tsx's `disabled:pointer-events-none`), which would silently kill the hover
                that the tooltip depends on. There's no TabsContent for "sms" to switch to yet. */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    role="tab"
                    aria-disabled="true"
                    aria-selected="false"
                    tabIndex={0}
                    className="-mb-px inline-flex flex-1 cursor-not-allowed items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-transparent pb-2.5 text-sm font-semibold text-text-secondary opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                  >
                    Via SMS
                    <span className="inline-flex items-center gap-1 rounded-pill bg-background-light px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary">
                      <Lock className="h-2.5 w-2.5" aria-hidden />
                      Coming Soon
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Sending estimates by text is coming soon — you&apos;ll be able to deliver this one over SMS once it&apos;s available.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </TabsList>

          <TabsContent value="email" className="space-y-4 mt-4">
            {/* To — editable one-off recipient, not saved to the customer. Read-only with a
                neutral placeholder when the requester's Customer scope redacted the saved
                address (#1997): it must not present itself as an empty field the rep is
                expected to fill. */}
            <div className="space-y-1.5">
              <Label htmlFor="recipient-email">To</Label>
              <Input
                id="recipient-email"
                ref={recipientInputRef}
                type="email"
                value={emailRedacted ? '' : recipientEmail}
                placeholder={emailRedacted ? "Sent to the customer's saved email address" : undefined}
                readOnly={emailRedacted}
                onChange={(e) => setRecipientEmail(e.target.value)}
              />
              {!emailRedacted && !recipientValid && (
                <p className="text-xs text-danger">Enter a valid email address</p>
              )}
            </div>

            {/* CC (one-time recipients, not saved). Disabled when redacted (#1997): the backend
                403s any client-supplied recipient, including cc_emails, once the requester's
                Customer read scope excludes this row, so the input must not offer an address it
                cannot use. */}
            <div className="space-y-1.5">
              <Label htmlFor="cc-emails">
                CC{' '}
                <span className="text-xs font-normal text-text-secondary">
                  (optional, not saved to customer)
                </span>
              </Label>
              {!emailRedacted && ccEmails.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {ccEmails.map((email) => (
                    <span
                      key={email}
                      className="inline-flex items-center gap-1 rounded-full bg-neutral-surface px-2.5 py-1 text-xs text-text-primary"
                    >
                      {email}
                      {/* chip close-X affordance - not Button-shaped, left raw. */}
                      <button
                        type="button"
                        onClick={() => removeCc(email)}
                        className="text-text-secondary hover:text-text-primary"
                        aria-label={`Remove ${email}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <Input
                id="cc-emails"
                type="email"
                placeholder={emailRedacted ? 'Not available for this customer' : 'Add email and press Enter'}
                value={ccInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setCcError(null);
                  if (v.endsWith(',')) {
                    tryAddCc(v);
                  } else {
                    setCcInput(v);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    if (ccInput.trim()) {
                      e.preventDefault();
                      tryAddCc(ccInput);
                    }
                  } else if (e.key === 'Backspace' && !ccInput && ccEmails.length > 0) {
                    const last = ccEmails[ccEmails.length - 1];
                    if (last) removeCc(last);
                  }
                }}
                onBlur={() => {
                  if (ccInput.trim()) tryAddCc(ccInput);
                }}
                disabled={emailRedacted || ccEmails.length >= MAX_CC}
              />
              {!emailRedacted && ccError && <p className="text-xs text-danger">{ccError}</p>}
            </div>

            {/* Message */}
            <div className="space-y-1.5">
              <Label>Message</Label>
              <Textarea
                value={messageBody}
                onChange={(e) => setMessageBody(e.target.value)}
                rows={3}
              />
            </div>

            {/* Deposit settings */}
            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="deposit-toggle" className="text-sm font-semibold">
                  Require deposit
                </Label>
                <Switch
                  id="deposit-toggle"
                  checked={depositRequired}
                  onCheckedChange={setDepositRequired}
                />
              </div>

              {depositRequired && (
                <>
                  <DepositControls
                    idPrefix="send"
                    percent={depositPercent}
                    amount={depositAmountInput}
                    totalAmount={totalAmount}
                    editable={depositEditable}
                    frozen={depositFrozen}
                    willReprice={depositWillReprice}
                    valid={depositValid}
                    onPercentChange={handleDepositPercentChange}
                    onAmountChange={handleDepositAmountChange}
                  />

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
                              id={`pm-${key}`}
                              checked={enabledMethods.has(key)}
                              onCheckedChange={() => toggleMethod(key)}
                            />
                            {/* Checkbox-row label (sits beside, not above, its control) - not a
                                FormField-shape site, left raw. */}
                            <label
                              htmlFor={`pm-${key}`}
                              className="text-sm font-medium cursor-pointer select-none"
                            >
                              {PAYMENT_METHOD_LABELS[key]}
                            </label>
                          </div>
                        </div>
                      ))}

                    {orgAcceptedMethods.length === 0 && (
                      <p className="text-xs text-danger">
                        No payment methods accepted by your organization. Update
                        them in Organization Settings.
                      </p>
                    )}

                    {orgAcceptedMethods.length > 0 && enabledMethods.size === 0 && (
                      <p className="text-xs text-danger">
                        No payment method selected. The customer will not be able to pay the
                        deposit or approve this estimate online.
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Error */}
            {mutation.isError && (
              <p className="text-sm text-danger">
                {extractApiError(mutation.error, 'Failed to send estimate')}
              </p>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3 border-t pt-4">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => mutation.mutate()}
                disabled={!canSend || mutation.isPending}
              >
                {mutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                {mutation.isPending
                  ? 'Sending...'
                  : alreadySent
                    ? `Resend ${estimateNumber}`
                    : `Send ${estimateNumber}`}
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
