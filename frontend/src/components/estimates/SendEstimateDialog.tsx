import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
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
import { Check, Loader2, Send, AlertTriangle, X, Lock } from 'lucide-react';
import { extractApiError } from '@/lib/utils';
import { useOrganization, type PaymentMethod } from '@/lib/api/organization';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import { useFeature } from '@/lib/entitlements';
import {
  DEFAULT_DEPOSIT_POLICY,
  DEPOSIT_POLICY_LABELS,
  describeMethods,
  NOT_IN_PLAN_NOTE,
  ONLINE_METHOD_LABELS,
  onlineMethodActive,
  orderMethods,
  orgDefaultMethods,
  orgManualMethods,
  sameMethods,
  type DepositPolicy,
  type OnlineMethod,
} from '@/lib/payment-options';
import { PaymentsSetupBanner } from '@/components/payments/PaymentsSetupBanner';
import { DepositControls } from '@/components/estimates/DepositControls';
import { useDepositDraft } from '@/components/estimates/useDepositDraft';
import type { DepositType } from '@/lib/deposit';
import { canAutoFocus } from '@/ui-kit/lib/autoFocus';
import { SendingAsLine } from '@/components/communication/inbox/ComposeWindow';
import { useHandSender } from '@/components/communication/useHandSender';

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
  // Payments go-live slice 21 - this estimate's stored deposit-policy override; null/omitted = the
  // org's policy. The dialog can change it (story 30); it is saved before the send.
  depositPolicy?: DepositPolicy | null;
  // The estimate is locked (deposit paid, or lock_on_send on a sent estimate): the backend refuses
  // every PATCH, so the policy is shown read-only and never saved. Defaults `false`.
  locked?: boolean;
  // Slice 27 - the estimate's status, so the locked-policy note is worded for what can be done: a
  // won estimate cannot be recalled to Draft. Omitted = the sent wording.
  estimateStatus?: string | null;
  // Slice 27 - the methods the estimate was last sent with (its send_config). A resend starts from
  // these, so the methods and the stored deposit policy beside them agree. Ignored on a first send.
  sentMethods?: PaymentMethod[] | null;
  onSuccess: () => void;
}

const DEPOSIT_POLICY_ORDER: DepositPolicy[] = ['REQUIRED_BEFORE_APPROVAL', 'PAY_LATER'];
const ONLINE_METHODS: OnlineMethod[] = ['CARD', 'ACH'];

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
  depositPolicy = null,
  locked = false,
  estimateStatus = null,
  sentMethods = null,
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

  // §4.5 — pre-fill from org defaults. Slice 21: the org's DEFAULT offer (lib/payment-options),
  // so a method the owner leaves out by default (Card or Bank) starts unticked but can be added.
  // Slice 16: while the plan lacks online payments, Card and Bank start unticked and say why (the
  // customer's page cannot offer them).
  const onlinePaymentsInPlan = useFeature('online_payments');
  const orgDefault = orgDefaultMethods(org, onlinePaymentsInPlan);
  const orgDefaultKey = orgDefault.join('|');
  // A resend starts from the methods the estimate went out with; a first send from the org's defaults.
  const seedMethods = alreadySent && sentMethods && sentMethods.length > 0 ? sentMethods : orgDefault;
  const [enabledMethods, setEnabledMethods] = useState<Set<PaymentMethod>>(new Set(seedMethods));

  // When org data loads after the dialog mounts, sync the pre-fill. Adjusted during render, like
  // the `wasOpen` reset below (`react-hooks/set-state-in-effect`).
  const [seededDefaultKey, setSeededDefaultKey] = useState(orgDefaultKey);
  if (seededDefaultKey !== orgDefaultKey) {
    setSeededDefaultKey(orgDefaultKey);
    setEnabledMethods(new Set(seedMethods));
  }
  const manualMethods = orgManualMethods(org);
  const methodsDiffer = !sameMethods(Array.from(enabledMethods), orgDefault);

  // Slice 21 - the deposit policy for THIS estimate. `undefined` = untouched (shows what the
  // estimate stores, else the org's); `null` = "Use org default". Kept as a choice rather than a
  // value so an org that loads after the dialog opens still seeds it correctly.
  const orgPolicy: DepositPolicy = org?.deposit_policy ?? DEFAULT_DEPOSIT_POLICY;
  const [policyChoice, setPolicyChoice] = useState<DepositPolicy | null | undefined>(undefined);
  const effectivePolicy: DepositPolicy =
    policyChoice === undefined ? (depositPolicy ?? orgPolicy) : (policyChoice ?? orgPolicy);
  const policyDiffers = effectivePolicy !== orgPolicy;
  // What the estimate should store after this send: null whenever it matches the org.
  const policyToStore: DepositPolicy | null = effectivePolicy === orgPolicy ? null : effectivePolicy;
  const policyEditable = canEditDeposit && !locked;
  const policyChanged =
    policyEditable && policyChoice !== undefined && policyToStore !== (depositPolicy ?? null);
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
      setEnabledMethods(new Set(seedMethods));
      setPolicyChoice(undefined);
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
  // PRD 10 (S10.12): the estimate goes out from the sender's OWN address; a person with no address of their own cannot send it.
  const handSender = useHandSender();

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
      // Slice 21 - the deposit-policy override, saved the same way and for the same reason.
      if (depositRequired && policyChanged) {
        await api.patch(`/api/estimates/${estimateId}`, { deposit_policy: policyToStore });
      }

      const { data } = await api.post(`/api/estimates/${estimateId}/send`, {
        deposit_required: depositRequired,
        payment_methods: orderMethods(enabledMethods),
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
        intent="form"
        className="max-w-md"
        onOpenAutoFocus={(e) => {
          // On touch the dialog itself takes focus (DialogContent), not the field.
          if (!canAutoFocus()) return;
          e.preventDefault();
          recipientInputRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Send Estimate</DialogTitle>
        </DialogHeader>

        <PaymentsSetupBanner onSetup={() => navigate('/settings/servwave-payments')} />

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

        {handSender.known && (
          <SendingAsLine
            address={handSender.sender.fromAddress}
            name={handSender.sender.fromName}
            addressNeeded={handSender.sender.addressNeeded}
            className="border-b-0 px-0 py-0"
          />
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
                  Sending estimates by text is coming soon - you&apos;ll be able to deliver this one over SMS once it&apos;s available.
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
                kind="email"
                personalAutofill={false}
                id="recipient-email"
                ref={recipientInputRef}
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
                kind="email"
                personalAutofill={false}
                id="cc-emails"
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

                  {/* Slice 21 - when this customer pays the deposit (story 30). */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p id="send-deposit-policy" className="text-xs font-medium uppercase tracking-wide">
                        When the deposit is paid
                      </p>
                      {policyDiffers && policyEditable && (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs"
                          onClick={() => setPolicyChoice(null)}
                        >
                          Use org default
                        </Button>
                      )}
                    </div>
                    <div
                      role="radiogroup"
                      aria-labelledby="send-deposit-policy"
                      className="flex flex-col items-start gap-2"
                    >
                      {DEPOSIT_POLICY_ORDER.map((value) => (
                        <Button
                          key={value}
                          type="button"
                          role="radio"
                          size="sm"
                          variant={effectivePolicy === value ? 'solid' : 'outline'}
                          tone="neutral"
                          aria-checked={effectivePolicy === value}
                          disabled={!policyEditable}
                          onClick={() => setPolicyChoice(value)}
                        >
                          {effectivePolicy === value && (
                            <Check data-testid="policy-selected-check" aria-hidden="true" />
                          )}
                          {DEPOSIT_POLICY_LABELS[value]}
                        </Button>
                      ))}
                    </div>
                    {policyDiffers && (
                      <p className="text-xs text-muted-foreground">
                        Org default: {DEPOSIT_POLICY_LABELS[orgPolicy]}
                      </p>
                    )}
                    {locked && (
                      <p className="text-xs text-muted-foreground">
                        {estimateStatus === 'WON'
                          ? 'Locked: this estimate is approved, so the deposit policy can no longer change.'
                          : 'Locked with the estimate. Recall it to Draft to change it.'}
                      </p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs uppercase tracking-wide">
                      Payment methods
                    </Label>

                    {[...ONLINE_METHODS, ...manualMethods].map((key) => {
                      const online = key === 'CARD' || key === 'ACH';
                      const unavailable = online && !onlineMethodActive(org, key, onlinePaymentsInPlan);
                      return (
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
                              {online ? ONLINE_METHOD_LABELS[key] : PAYMENT_METHOD_LABELS[key]}
                            </label>
                          </div>
                          {unavailable && (
                            <p className="pl-6 text-xs text-muted-foreground">
                              {!onlinePaymentsInPlan
                                ? NOT_IN_PLAN_NOTE
                                : key === 'CARD'
                                  ? 'Unavailable until card payments are active'
                                  : 'Unavailable until bank payments are active'}
                            </p>
                          )}
                        </div>
                      );
                    })}

                    {methodsDiffer && orgAcceptedMethods.length > 0 && (
                      <p className="text-xs text-muted-foreground">
                        Org default: {describeMethods(orgDefault)}
                      </p>
                    )}

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
          </TabsContent>
        </Tabs>

        {/* Actions: its own slot, so Send stays in reach on a phone (the one tab is the whole form). */}
        <DialogFooter className="gap-3 border-t pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!canSend || mutation.isPending || handSender.blockedReason !== undefined}
            disabledReason={handSender.blockedReason}
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
