import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Send, Loader2, X } from 'lucide-react';
import { formatCurrency, extractApiError } from '@/lib/utils';
import { formatExactDay } from '@/lib/format-date';
import { StripePaymentsBanner } from '@/components/payments/StripePaymentsBanner';

interface SendInvoiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  invoiceNumber: string;
  // #1997 — `undefined` means the requester's Customer read scope redacted the saved email
  // entirely (key absent); `null` means the customer genuinely has no email on file. See
  // `emailRedacted` below for how the two render differently.
  customerEmail: string | null | undefined;
  dueDate: string | null;
  totalAmount: number;
  amountDue: number;
  lineItems: InvoiceLineItem[];
  onSuccess: () => void;
  isResend?: boolean;
}

const DEFAULT_MESSAGE =
  'Your invoice is ready. Click the link below to view it and make a payment.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_CC = 5;

export function SendInvoiceDialog({
  open,
  onOpenChange,
  invoiceId,
  invoiceNumber,
  customerEmail,
  dueDate,
  totalAmount,
  amountDue,
  lineItems,
  onSuccess,
  isResend = false,
}: SendInvoiceDialogProps) {
  const navigate = useNavigate();
  // #1997 — `undefined` (never `null`, which keeps the pre-existing "genuinely no email on
  // file" blocked-send behaviour below) means the requester's Customer read scope redacted the
  // key entirely. Unlike the estimate dialog, this one BLOCKS Send on an invalid/empty address
  // (`EMAIL_RE.test`), so an empty seed here would make a legitimately permitted send impossible.
  const emailRedacted = customerEmail === undefined;
  const savedEmail = customerEmail ?? '';

  // One-off recipient (editable "To"). Seeded from the customer's saved email; the override is
  // request-scoped and never overwrites the saved customer record. Adjusted during render rather
  // than in an effect when the prop itself changes - same idiom, same reason, as the `wasOpen`
  // reset below (`react-hooks/set-state-in-effect`).
  const [recipientEmail, setRecipientEmail] = useState(savedEmail);
  const [lastSavedEmail, setLastSavedEmail] = useState(savedEmail);
  if (savedEmail !== lastSavedEmail) {
    setLastSavedEmail(savedEmail);
    setRecipientEmail(savedEmail);
  }
  const recipientValid = emailRedacted || EMAIL_RE.test(recipientEmail.trim());

  const [messageBody, setMessageBody] = useState(DEFAULT_MESSAGE);

  const [ccEmails, setCcEmails] = useState<string[]>([]);
  const [ccInput, setCcInput] = useState<string>('');
  const [ccError, setCcError] = useState<string | null>(null);

  // Every open starts a fresh compose - same reason, and same render-time reset, as
  // SendEstimateDialog. InvoiceDetailPage mounts this component twice (send + resend) and never
  // unmounts either, so without this a cancelled edit persists into the next send of the same
  // invoice.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setRecipientEmail(savedEmail);
      setCcEmails([]);
      setCcInput('');
      setCcError(null);
      setMessageBody(DEFAULT_MESSAGE);
    }
  }

  const tryAddCc = (raw: string) => {
    const candidate = raw.trim().replace(/,$/, '').trim();
    if (!candidate) return;
    if (!EMAIL_RE.test(candidate)) {
      setCcError('Invalid email address');
      return;
    }
    if (ccEmails.includes(candidate) || candidate.toLowerCase() === recipientEmail.trim().toLowerCase()) {
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

  const mutation = useMutation({
    mutationFn: async () => {
      const endpoint = isResend ? `/api/invoices/${invoiceId}/resend` : `/api/invoices/${invoiceId}/send`;
      // #1997 — `to` OMITTED (never an empty string) when redacted, so sendInvoiceInternal /
      // resendInvoiceInternal fall back to the stored address (invoice.controller.ts:1515/:1665)
      // instead of failing the "No recipient email" 400.
      const { data } = await api.post(endpoint, {
        ...(emailRedacted ? {} : { to: recipientEmail.trim() }),
        ...(!emailRedacted && ccEmails.length > 0 ? { cc_emails: ccEmails } : {}),
        ...(messageBody.trim() ? { message_body: messageBody } : {}),
      });
      return data;
    },
    onSuccess: () => {
      onSuccess();
      onOpenChange(false);
      // The success toast must not echo an address it does not have when redacted.
      toast({
        title: isResend ? 'Invoice resent' : 'Invoice sent',
        description: emailRedacted
          ? `${invoiceNumber} has been emailed to the customer.`
          : `${invoiceNumber} has been emailed to ${recipientEmail.trim()}.`,
      });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Failed to send invoice';
      toast({ title: 'Send failed', description: msg, variant: 'destructive', duration: Infinity });
    },
  });

  const formattedDueDate = dueDate
    ? formatExactDay(dueDate, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : 'No due date';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{isResend ? 'Resend' : 'Send'} Invoice {invoiceNumber}</SheetTitle>
          <SheetDescription>
            This will {isResend ? 're-email' : 'email'} invoice {invoiceNumber} to the recipient below.
          </SheetDescription>
        </SheetHeader>

        <StripePaymentsBanner onSetup={() => navigate('/settings/payments')} />

        <div className="space-y-4">
          {/* To — editable one-off recipient, not saved to the customer. Read-only with a
              neutral placeholder when the requester's Customer scope redacted the saved address
              (#1997): it must not present itself as an empty field the rep is expected to fill,
              and Send must stay enabled rather than blocking on the now-empty seed. */}
          <div className="space-y-1.5">
            <Label htmlFor="invoice-recipient-email">To</Label>
            <Input
              id="invoice-recipient-email"
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
            <Label htmlFor="invoice-cc-emails">
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
              id="invoice-cc-emails"
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
            <Label htmlFor="invoice-message">Message</Label>
            <Textarea
              id="invoice-message"
              value={messageBody}
              onChange={(e) => setMessageBody(e.target.value)}
              rows={3}
            />
          </div>

          {/* Invoice details */}
          <div className="rounded-lg border border-border bg-background-light p-3 space-y-1.5 text-sm">
            <p className="font-medium">Invoice details</p>
            {lineItems.length === 0 ? (
              <p className="text-text-secondary">No line items</p>
            ) : (
              <div className="space-y-2">
                {[...lineItems]
                  .sort((a, b) => a.sequence - b.sequence)
                  .map((item) => (
                    <div key={item.id} className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-text-primary break-words">{item.description}</p>
                        <p className="text-xs text-text-secondary">
                          {Number(item.quantity)} × {formatCurrency(Number(item.unit_price))}
                        </p>
                      </div>
                      <span className="font-medium shrink-0">
                        {formatCurrency(Number(item.line_total))}
                      </span>
                    </div>
                  ))}
              </div>
            )}
            <div className="border-t border-border pt-1.5 space-y-1.5">
              <div className="flex justify-between">
                <span className="text-text-secondary">Total</span>
                <span className="font-medium">{formatCurrency(totalAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">Amount Due</span>
                <span className="font-medium">{formatCurrency(amountDue)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">Due Date</span>
                <span className="font-medium">{formattedDueDate}</span>
              </div>
            </div>
          </div>

          {mutation.isError && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to send invoice')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => mutation.mutate()}
              disabled={!recipientValid || mutation.isPending}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  {isResend ? 'Resend Invoice' : 'Send Invoice'}
                </>
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
