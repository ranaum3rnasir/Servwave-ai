import { invoiceDisplayLines } from '@/lib/invoices/displayLines';
import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Calendar, CreditCard, Download, Eye, FileText, Gift, Link2, Loader2,
  Lock, MapPin, Send, Trash2, XCircle, DollarSign,
} from 'lucide-react';

import api from '@/lib/axios';
import { useScheduleTimezone, formatInstant, ORG_DAY_FORMAT } from '@/lib/schedule-tz';
import { useAppAbility } from '@/contexts/AbilityContext';
import { RecordNumberEditor } from '@/components/crm/RecordNumberEditor';
import { canSeePricing as canSeePricingAbility, canSeePrices as canSeePricesAbility } from '@/lib/ability';
import { PriceFreeLines } from '@/components/money/PriceFreeLines';
import { customerDisplayName } from '@/lib/customer-name';
import { cn, downloadBlob, extractApiError, formatCurrency } from '@/lib/utils';
import { isInvoiceEditable, isInvoiceRenumberLocked } from '@/lib/invoiceEditable';
import { createInvoicePaymentLink, markInvoiceSent, fetchStateTaxRates, updateInvoiceBilling } from '@/lib/api/invoices';
import { useOrganization } from '@/lib/api/shared/organization';

// Feature components with no kit equivalent - reused, never forked. Each owns
// behaviour that belongs to shared infrastructure (IconRail, TagInput,
// PdfPreviewDialog) or to money arithmetic this branch must not touch
// (the receipt card, the line-items editor, the seven action dialogs).
import { IconRail } from '@/components/crm/IconRail';
import { DetailHeader, type DetailHeaderAction } from '@/components/detail/DetailHeader';
import { InternalCostsCard } from '@/components/crm/InternalCostsCard';
import { TagInput } from '@/components/leads/TagInput';
import { PdfPreviewDialog } from '@/components/estimates/PdfPreviewDialog';
import { InvoiceReceiptCard } from '@/components/invoices/InvoiceReceiptCard';
import { InvoicePaymentOptionsCard } from '@/components/invoices/InvoicePaymentOptionsCard';
import {
  InvoiceLineItemsEditor, InvoiceScopeOfWorkCard,
} from '@/components/invoices/InvoiceLineItemsEditor';
import { SendInvoiceDialog } from '@/components/invoices/SendInvoiceDialog';
import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';
import { VoidInvoiceDialog } from '@/components/invoices/VoidInvoiceDialog';
import { DeleteInvoiceDialog } from '@/components/invoices/DeleteInvoiceDialog';
import { RefundInvoiceDialog } from '@/components/invoices/RefundInvoiceDialog';
import { paymentCounts, refundCounts, refundHoldsCap } from '@/lib/payment-ledger';
import { CreditInvoiceDialog } from '@/components/invoices/CreditInvoiceDialog';
import { VoidPaymentDialog } from '@/components/invoices/VoidPaymentDialog';
import { CancelBankPaymentDialog } from '@/components/invoices/CancelBankPaymentDialog';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { Badge } from '@/ui-kit/components/ui/badge';
import { PrimaryContactLines } from '@/components/contact/CustomerContactBlock';
import { useContactPolicyInput } from '@/components/contact/useContactPolicyInput';
import { customerNameDisplay } from '@/components/contact/contactDisplayPolicy';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';
import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Table } from '@/ui-kit/components/ui/table';

import { v2Path, preferV2Path } from '../uiV2';
import { StatusChip } from '../_shared/statusChip';
import { ProcessingBadge } from '@/components/invoices/ProcessingBadge';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { useRecordVisit } from '../pageBreadcrumbs';
import NotAuthorizedPage from '@/components/NotAuthorizedPage';
import { isForbiddenError, retryUnlessRefused } from '../_shared/loadErrorState';
import {
  buildLedgerEvents, deriveInvoiceMoney, getAvailableActions, getDueDateLabel,
  isDepositCreditPayment, isOverdue, round2,
  type InvoiceDetail, type Payment as InvoicePayment, type LedgerEvent,
} from '@/lib/invoices/invoiceMoney';

/** Payments go-live slice 05: the tooltip on a history row that has not settled. */
const SETTLEMENT_TITLES: Record<NonNullable<LedgerEvent['settlement']>, (isRefund: boolean) => string> = {
  PROCESSING: () => 'This payment has not cleared yet - it counts once it does',
  PENDING: () => 'This refund has not landed yet - it counts once it does',
  FAILED: (isRefund) =>
    isRefund ? 'This refund did not go through - nothing was given back' : 'This payment did not go through - it never counted',
};

/**
 * /v2/invoices/:id - the invoice detail page on the CRM UI kit.
 *
 * MONEY IS NOT AUTHORED HERE. `buildLedgerEvents`, `deriveInvoiceMoney`, the
 * permission core (`getAvailableActions`) and the small derivations around them
 * all come from `@/lib/invoices/invoiceMoney`, the single implementation this
 * page and the legacy page both run. One ledger pass
 * feeds every surface below - the receipt card, the overpaid banner, the
 * payments stat row and the ledger footer - so they cannot disagree.
 *
 * Ten feature components are reused rather than rebuilt (IconRail, TagInput,
 * InvoiceReceiptCard, InvoiceScopeOfWorkCard, InvoiceLineItemsEditor,
 * InternalCostsCard, PdfPreviewDialog and the seven action dialogs). Each is
 * either shared infrastructure or a money surface; rebuilding either would fork
 * arithmetic the migration brief marks untouchable. All are in the gap ledger.
 */
export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  // Whether the customer's name opens the customer's page: only for a person who may open it.
  const customerNameLinks = customerNameDisplay(useContactPolicyInput()).link;

  const [sendOpen, setSendOpen] = useState(false);
  const [resendOpen, setResendOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [voidPaymentOpen, setVoidPaymentOpen] = useState(false);
  const [voidPaymentTarget, setVoidPaymentTarget] = useState<InvoicePayment | null>(null);
  const [cancelBankTarget, setCancelBankTarget] = useState<InvoicePayment | null>(null);
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [markSentPromptOpen, setMarkSentPromptOpen] = useState(false);
  const [markSentOpen, setMarkSentOpen] = useState(false);
  // Controlled so the Payments stat card's "View all payments" can jump tabs.
  const [activeTab, setActiveTab] = useState('line-items');

  // --- Queries -------------------------------------------------------------

  const { data: invoice, isLoading, error: invoiceError } = useQuery({
    queryKey: ['invoice', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/invoices/${id}`);
      return data.invoice as InvoiceDetail;
    },
    retry: retryUnlessRefused,
  });

  useRecordVisit('invoices', invoice?.invoice_number);

  // Declared BEFORE the isLoading/!invoice early returns - every hook must run
  // on every render regardless of loading state.
  const { data: org } = useOrganization();

  // Aging is a fact about the BUSINESS's calendar, not the viewer's. Both the due date and
  // the day count beside it render on this one clock so they can never name different days -
  // and so two staff in two zones see one invoice age identically (#1634).
  const timeZone = useScheduleTimezone();

  // The receipt card is the sole editable money surface, so this page owns the
  // billing mutation and the tax-rate lookup.
  const canEditInvoiceBilling =
    !!invoice && isInvoiceEditable(invoice.status) && (invoice.actions?.includes('edit') ?? false);
  // The invoice of a Done job takes no discount or tax change from anyone (S06.19); the tip is not a price and stays editable.
  const canEditInvoicePrices = canEditInvoiceBilling && !invoice?.price_edit_closed_reason;

  const { data: taxRates = [] } = useQuery({
    queryKey: ['state-tax-rates'],
    queryFn: fetchStateTaxRates,
    enabled: canEditInvoiceBilling,
    staleTime: 60 * 60 * 1000,
  });

  // --- Mutations -----------------------------------------------------------

  const invalidateInvoice = () => {
    queryClient.invalidateQueries({ queryKey: ['invoice', id] });
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
  };

  const billingMutation = useMutation({
    mutationFn: (body: { tip?: number; discount_amount?: number; tax_rate?: number }) =>
      updateInvoiceBilling(id!, body),
    onSuccess: invalidateInvoice,
    onError: (err) => toast.error(extractApiError(err, 'Failed to update totals')),
  });

  // Cost model. Goes through the main PATCH /api/invoices/:id, not the billing
  // sub-route above.
  const costMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/invoices/${id}`, body),
    onSuccess: invalidateInvoice,
    onError: (err) => toast.error(extractApiError(err, 'Could not save')),
  });

  // Copying a link never changes the status. On a DRAFT it offers to mark the invoice as sent.
  const announceCopied = () => {
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
    toast('Payment link copied');
    if (invoice?.status === 'DRAFT' && invoice.actions?.includes('send')) setMarkSentPromptOpen(true);
  };

  const markSentMutation = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Missing invoice id');
      return markInvoiceSent(id);
    },
    onSuccess: () => {
      setMarkSentPromptOpen(false);
      setMarkSentOpen(false);
      invalidateInvoice();
      toast.success('Invoice marked as sent');
    },
    onError: (err: unknown) => toast.error(extractApiError(err, 'Could not mark the invoice as sent')),
  });

  const createPaymentLinkMutation = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Missing invoice id');
      return createInvoicePaymentLink(id);
    },
    onSuccess: ({ url }) => {
      invalidateInvoice();
      navigator.clipboard.writeText(url);
      announceCopied();
    },
    onError: (err: unknown) => {
      toast.error('Could not create payment link', {
        description: extractApiError(err, 'Please try again.'),
      });
    },
  });

  // #1997 round 3 — `public_token` is entirely ABSENT (not `null`) when this requester cannot
  // read the anchored customer; `createInvoicePaymentLink` is a live backend action unrelated to
  // that read scope, and for an already-sent invoice it just hands back the SAME real token in
  // its `url` response - treating "absent" the same as "null" would turn the fallback below into
  // a side door around the redaction. See the `linkRedacted`-gated menu item below.
  const linkRedacted = !!invoice && invoice.public_token === undefined;

  const handleCopyLink = () => {
    if (linkRedacted) return;
    if (invoice?.public_token) {
      const url = `${window.location.origin}/p/invoices/${invoice.id}?token=${invoice.public_token}`;
      navigator.clipboard.writeText(url);
      announceCopied();
    } else {
      createPaymentLinkMutation.mutate();
    }
  };

  async function handleDownloadPdf() {
    if (!id) return;
    setDownloadingPdf(true);
    try {
      const res = await api.get(`/api/invoices/${id}/pdf`, { responseType: 'blob' });
      downloadBlob(res.data as Blob, `Invoice-${invoice?.invoice_number ?? id}.pdf`);
    } catch (err) {
      toast.error('Download failed', {
        description: extractApiError(err, 'Could not download the invoice PDF.'),
      });
    } finally {
      setDownloadingPdf(false);
    }
  }

  // --- Loading / not found -------------------------------------------------

  if (isLoading) {
    return (
      // Shaped like the loaded page: an unframed header block, then the one
      // card the content area really has.
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3 w-3" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="flex flex-col gap-5">
          <div className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-8 w-64" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-4 w-80" />
              <Skeleton className="h-4 w-40" />
            </div>
            <div className="flex flex-col items-end gap-3">
              <div className="flex items-center gap-2">
                <Skeleton className="h-9 w-28" />
                <Skeleton className="h-8 w-8" />
              </div>
              <Skeleton className="h-9 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex justify-between">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
            <Skeleton className="h-3 w-full rounded-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // The server refused the invoice: the person may not open it (the page never decides that itself).
  if (!invoice && isForbiddenError(invoiceError)) return <NotAuthorizedPage />;

  if (!invoice) {
    return (
      <Card>
        <CardContent className="text-center">
          <p className="text-muted-foreground">Invoice not found</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate(v2Path('/invoices'))}>
            Back to Invoices
          </Button>
        </CardContent>
      </Card>
    );
  }

  // --- Derived data --------------------------------------------------------

  const actions = getAvailableActions(invoice, ability);
  // Payments go-live slice 21 - one invoice's payment options, on the page and in the send sheet.
  const paymentOptions = {
    paymentMethodsOverride: invoice.payment_methods_override,
    allowPartialPayment: invoice.allow_partial_payment,
    org,
    canEdit: canEditInvoiceBilling,
    isDeposit: invoice.kind === 'DEPOSIT',
  };
  const overdue = isOverdue(invoice, timeZone);
  const canSeePricing = canSeePricingAbility(ability);
  // P11: a person without See prices gets no price anywhere on the invoice: no totals, balance, payments or priced grid.
  const canSeePrices = canSeePricesAbility(ability);
  // Customer resolves from the top-level field (deposit/orphan invoices) or via
  // the job. Backend always supplies one; the empty fallback keeps render
  // null-safe for a job-less invoice.
  const customer = invoice.customer ?? invoice.job?.customer ?? {
    id: '', first_name: '', last_name: '', email: '', phone: '',
  };
  // The heading's second half. `customerDisplayName` already IS the rule asked
  // for - a trimmed first+last when there is one, the company name when there
  // is not - so it is reused rather than re-stated here; a local variant would
  // be a second definition of a name the other ~17 v2 call sites already share.
  // `company_name` is not on the shared `InvoiceCustomer` type but IS selected
  // by the backend's `invoiceDetailSelect` on both `customer` and
  // `job.customer`, so it is there at runtime.
  const customerName = customerDisplayName(customer);
  const loc = invoice.job?.service_location ?? null;
  // Copy-to-Invoice: a job-less standalone invoice reaches its source estimate
  // only via the top-level invoice.estimate.
  const estimate = invoice.job?.estimate ?? invoice.estimate ?? null;
  const ownLineItems = invoice.line_items ?? [];
  const estimateItems = estimate?.line_items ?? [];
  // Own lines win; with scope blocks and no own lines nothing is borrowed from the estimate (slice 35).
  const allItems = invoiceDisplayLines(ownLineItems, invoice.scopes, estimateItems).map((li) => ({ ...li }));
  // Invoice-BORN synced lines only. Void and delete auto-return these
  // server-side; the dialogs say so.
  const syncedLineCount = ownLineItems.filter((li) => li.stock_status === 'SYNCED').length;

  const totalAmount = Number(invoice.total_amount);
  const amountDue = Number(invoice.amount_due);
  const customerPayments = invoice.payments.filter((payment) => !isDepositCreditPayment(payment));
  // Voided payments are money that never really changed hands - the backend
  // adds them straight back onto amount_due - so no "paid"/"collected" figure
  // may count them. Nor may a payment that has not SUCCEEDED (payments go-live
  // slice 05): a PROCESSING bank payment has not landed and a FAILED one never will.
  const paymentsTotal = round2(
    customerPayments
      .filter((payment) => payment.voided_at == null && paymentCounts(payment))
      .reduce((sum, payment) => sum + Number(payment.amount), 0),
  );

  // ONE ledger pass feeds every money surface below.
  const ledgerEvents = buildLedgerEvents(invoice);
  const money = deriveInvoiceMoney(ledgerEvents, totalAmount);

  // Net-paid cap for refunds. net_collected is in the GET select but legacy
  // rows carry 0; fall back to the non-voided customer payments.
  // Slice 05: net_collected subtracts only SUCCEEDED refunds, but a PENDING refund already holds
  // its share of what can still be refunded - the backend's cap counts it - so it comes off here.
  const pendingRefundsTotal = round2(
    (invoice.refunds ?? [])
      .filter((r) => refundHoldsCap(r) && !refundCounts(r))
      .reduce((sum, r) => sum + Number(r.amount), 0),
  );
  const netPaid = round2(Math.max(0, (Number(invoice.net_collected ?? 0) || paymentsTotal) - pendingRefundsTotal));
  // Only a payment that went through can be reversed: the backend's refund door reads only
  // non-voided SUCCEEDED payments and answers 400 for any other id.
  const refundablePayments = customerPayments.filter((p) => p.voided_at == null && paymentCounts(p));
  // Manual (non-card, non-PI-backed), non-voided payments can be individually
  // voided - mirrors the backend's voidPayment guard exactly rather than an
  // allowlist of method names.
  const isVoidableMethod = (payment: { method: string; paid_through_processor: boolean }) =>
    payment.method !== 'CARD' && payment.method !== 'EXTERNAL_CARD' && !payment.paid_through_processor;
  const openVoidPayment = (payment: InvoicePayment) => {
    setVoidPaymentTarget(payment);
    setVoidPaymentOpen(true);
  };
  // The server voids a payment only on these invoices (a terminal one is never reopened), so the
  // row's Void is offered only there (slice 29).
  const canVoidPayment = ability.can('void_payment', 'Invoice')
    && ['PAID', 'PARTIAL', 'PARTIALLY_REFUNDED'].includes(invoice.status);
  // Payments go-live slice 29 (D17): a bank payment still processing is cancelled, not refunded.
  const canCancelBankPayment = ability.can('refund', 'Invoice');

  // A durable breadcrumb trail: incoming state wins; otherwise reconstruct from
  // the invoice's own job data so reloads do not eject from job context. Job
  // links stay on the LEGACY path - Jobs is a separate migration.

  // The trail this page pushes to the pages it links out to.
  const outboundBreadcrumbs = [
    { label: 'Invoices', href: v2Path('/invoices') },
    { label: invoice.invoice_number, href: v2Path(`/invoices/${id}`) },
  ];

  const renderLedgerRow = (event: LedgerEvent) => {
    // For INVOICE-source inbound rows, event.key is the underlying Payment id.
    const payment =
      event.source === 'INVOICE' && !event.isRefund && !event.isCredit
        ? invoice.payments.find((p) => p.id === event.key)
        : undefined;
    const isVoided = event.voided;
    // Refunds and credits both render as outbound (danger tone, minus sign).
    const isOutbound = event.isRefund || event.isCredit;
    const canOfferVoid =
      canVoidPayment &&
      payment !== undefined &&
      !isDepositCreditPayment(payment) &&
      isVoidableMethod(payment) &&
      // Slice 05: only a payment that went through can be voided (the backend refuses the rest).
      paymentCounts(payment) &&
      !isVoided;
    const canOfferCancel =
      canCancelBankPayment &&
      payment !== undefined &&
      payment.method === 'ACH' &&
      payment.state === 'PROCESSING' &&
      !!payment.paid_through_processor &&
      !isVoided;

    return (
      <tr
        key={event.key}
        className={cn(
          'hover:bg-muted',
          isOutbound && 'bg-status-red-subtle/40',
          isVoided && 'line-through opacity-60',
        )}
      >
        <td className="whitespace-nowrap py-2.5 pr-3 text-sm">
          <span title={new Date(event.date).toLocaleString()}>
            {new Date(event.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </td>
        <td className="py-2.5 pr-3">
          <div
            className={cn(
              'flex items-center gap-2 border-l-2 pl-2',
              isOutbound
                ? 'border-status-red'
                : event.countsInNet
                  ? 'border-status-green'
                  : 'border-border',
            )}
          >
            <span className={cn('text-sm font-medium', isOutbound && 'text-status-red-emphasis')}>
              {event.label}
            </span>
            {event.settlement ? (
              <span
                className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide no-underline"
                title={SETTLEMENT_TITLES[event.settlement](event.isRefund)}
              >
                {event.settlement.toLowerCase()}
              </span>
            ) : (
              !event.countsInNet && (
                <span
                  className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide no-underline"
                  title="Money that moved on the deposit invoice - only the applied deposit credit counts here"
                >
                  on deposit invoice
                </span>
              )
            )}
            {isVoided && (
              <span className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide no-underline">
                voided
              </span>
            )}
          </div>
        </td>
        <td className="py-2.5 pr-3">
          {event.source === 'ESTIMATE' && event.estimateId ? (
            <Badge variant="outline" size="sm" asChild>
              <Link to={preferV2Path(`/estimates/${event.estimateId}`)}>{event.estimateNumber || 'ESTIMATE'}</Link>
            </Badge>
          ) : (
            <Badge variant="softNeutral" size="sm">INVOICE</Badge>
          )}
        </td>
        <td className="py-2.5 pr-3">
          <Badge variant="outline" size="sm">{event.methodDisplay}</Badge>
        </td>
        <td
          className={cn(
            'py-2.5 pr-3 text-right text-sm font-semibold tabular-nums',
            isOutbound
              ? 'text-status-red-emphasis'
              : event.countsInNet
                ? 'text-status-green-emphasis'
                : 'text-muted-foreground',
          )}
        >
          {/* Amount stands alone. The customer-paid service fee has its own
              column - it is never part of this row's amount. */}
          {event.countsInNet ? event.sign : ''}{formatCurrency(event.amount)}
        </td>
        <td className="text-muted-foreground py-2.5 pr-3 text-right text-sm tabular-nums">
          {event.serviceFeeAmount != null && Number(event.serviceFeeAmount) > 0
            ? formatCurrency(Number(event.serviceFeeAmount))
            : '-'}
        </td>
        <td className="text-muted-foreground py-2.5 text-sm">
          <span className="flex items-center justify-between gap-2">
            <span>{event.by}</span>
            {canOfferVoid && payment && (
              <Button
                variant="ghost"
                size="sm"
                className="text-status-red-emphasis h-auto px-1.5 py-0.5 text-xs no-underline"
                onClick={() => openVoidPayment(payment)}
              >
                Void
              </Button>
            )}
            {canOfferCancel && payment && (
              <Button
                variant="ghost"
                size="sm"
                className="text-status-red-emphasis h-auto px-1.5 py-0.5 text-xs no-underline"
                onClick={() => setCancelBankTarget(payment)}
              >
                Cancel payment
              </Button>
            )}
          </span>
        </td>
      </tr>
    );
  };

  const inbound = ledgerEvents.filter((e) => !e.isRefund && !e.isCredit);
  const outbound = ledgerEvents.filter((e) => e.isRefund || e.isCredit);
  const hasReversals = outbound.length > 0;
  const hasCredits = outbound.some((e) => e.isCredit);

  // The header's actions (mobile slice 55). One primary (Send, else Record Payment); on a phone
  // the rest fold into "More actions", from sm up the inline ones sit beside it as before.
  const canRefundNow =
    ability.can('refund', 'Invoice') &&
    netPaid > 0 &&
    ['PAID', 'PARTIAL', 'PARTIALLY_REFUNDED'].includes(invoice.status);
  // The statuses the server applies a credit on (slice 29: a REFUNDED invoice is refused).
  const canCreditNow =
    ability.can('credit', 'Invoice') && ['SENT', 'PARTIAL', 'PAID', 'PARTIALLY_REFUNDED'].includes(invoice.status);
  const primaryAction = actions.canSend ? (
    <Button onClick={() => setSendOpen(true)}>
      <Send /> Send Invoice
    </Button>
  ) : actions.canRecordPayment ? (
    <Button onClick={() => setRecordPaymentOpen(true)}>
      <DollarSign /> Record Payment
    </Button>
  ) : undefined;
  const copyLinkLabel = linkRedacted
    ? 'Not available for this customer'
    : linkCopied
      ? 'Copied!'
      : createPaymentLinkMutation.isPending
        ? 'Creating link...'
        : 'Copy payment link';
  const invoiceHeaderActions: DetailHeaderAction[] = [
    ...(actions.canResend
      ? [{ key: 'resend', label: 'Resend Invoice', icon: <Send />, inline: true, buttonVariant: 'outline' as const, group: 'pay', onSelect: () => setResendOpen(true) }]
      : []),
    ...(actions.canSend && actions.canRecordPayment
      ? [{ key: 'record-payment', label: 'Record Payment', icon: <DollarSign />, inline: true, group: 'pay', onSelect: () => setRecordPaymentOpen(true) }]
      : []),
    ...(canRefundNow
      ? [{ key: 'refund', label: 'Refund', icon: <CreditCard />, inline: true, buttonVariant: 'destructive' as const, buttonSize: 'sm' as const, group: 'pay', onSelect: () => setRefundOpen(true) }]
      : []),
    ...(canCreditNow
      ? [{ key: 'credit', label: 'Credit', icon: <Gift />, inline: true, buttonVariant: 'outline' as const, buttonSize: 'sm' as const, group: 'pay', onSelect: () => setCreditOpen(true) }]
      : []),
    ...(actions.canEdit
      ? [{
          // OQ-2 carried over as-is: `/invoices/:id/edit` has no route in either layer and falls
          // through to the catch-all. Reproduced, not fixed - fixing it is a behaviour change,
          // and it is in the ledger.
          key: 'edit', label: 'Edit', icon: <FileText />, group: 'doc', onSelect: () => navigate(v2Path(`/invoices/${id}/edit`)),
        }]
      : []),
    // The link opens the customer's own page, which shows every price, so it needs See prices (P11, H6): without it the
    // server leaves the token out and the item is not drawn, the same as Preview and Download below.
    ...(actions.canCopyLink && canSeePrices
      ? [{ key: 'copy-link', label: copyLinkLabel, icon: <Link2 />, group: 'doc', disabled: createPaymentLinkMutation.isPending || linkRedacted, onSelect: handleCopyLink }]
      : []),
    ...(actions.canMarkSent
      ? [{ key: 'mark-sent', label: 'Mark as sent', icon: <Send />, group: 'doc', onSelect: () => setMarkSentOpen(true) }]
      : []),
    // The document is its prices, so Preview and Download need See prices (P11).
    ...(canSeePrices
      ? [
          { key: 'preview-pdf', label: 'Preview PDF', icon: <Eye />, group: 'doc', onSelect: () => setPdfPreviewOpen(true) },
          {
            key: 'download-pdf',
            label: 'Download PDF',
            icon: downloadingPdf ? <Loader2 className="animate-spin" /> : <Download />,
            group: 'doc',
            disabled: downloadingPdf,
            onSelect: handleDownloadPdf,
          },
        ]
      : []),
    { key: 'print', label: 'Print', icon: <FileText />, group: 'doc', onSelect: () => window.print() },
    ...(actions.canVoid
      ? [{ key: 'void', label: 'Void Invoice', icon: <XCircle />, group: 'end', variant: 'destructive' as const, onSelect: () => setVoidOpen(true) }]
      : []),
    ...(actions.canDelete
      ? [{ key: 'delete', label: 'Delete', icon: <Trash2 />, group: 'end', variant: 'destructive' as const, onSelect: () => setDeleteOpen(true) }]
      : []),
  ];

  return (
    <IconRail entityType="INVOICE" entityId={id!}>
      <div className="flex flex-col gap-6" data-testid="invoice-detail">

        {/* Hero.
            NO CARD. The customer block used to sit inside a bordered
            CardContent, which framed a page header as a box and squeezed the
            identity, contact and meta lines into it. The header is the page,
            not a panel on it, so the frame is gone and the separation is
            spacing - the tab strip below draws the only rule this needs.

            Mobile slice 55: the shared detail header owns the stacking. Below sm it is
            Back + the invoice and customer on one row (the name truncates, its full value in
            the title), the status and contact rows, the amount due, the one primary action
            full width and every other action inside "More actions". From sm up the old
            cluster (actions right, amount due under them) is unchanged. */}
        <DetailHeader
          backTo={preferV2Path('/invoices')}
          backLabel="Back to invoices"
          primaryFirst
          menuLabel="More actions"
          menuIconOnly
          identity={
            // role/aria-level rather than an <h1>: the design-system raw-tag ratchet sits at its
            // floor for h1-h6. The accessible heading is preserved.
            //
            // Invoice id THEN customer, the same shape JobDetailPage's heading uses.
            // `customerName` carries the company-name fallback, so a customer with no personal
            // name still names itself here instead of leaving a hole.
            <span
              role="heading"
              aria-level={1}
              className="flex min-w-0 items-baseline gap-x-2 text-[23px] font-bold tracking-[-0.032em]"
            >
              <span className="shrink-0">
                <RecordNumberEditor
                  entity="invoice"
                  id={id!}
                  number={invoice.invoice_number}
                  canEdit={ability.can('renumber', 'Invoice') && !isInvoiceRenumberLocked(invoice)}
                  onRenamed={() => {
                    queryClient.invalidateQueries({ queryKey: ['invoice', id] });
                    queryClient.invalidateQueries({ queryKey: ['invoices'] });
                  }}
                />
              </span>
              <span aria-hidden="true" className="text-subtle-foreground shrink-0">·</span>
              {customer.id && customerNameLinks ? (
                <Link
                  to={preferV2Path(`/customers/${customer.id}`)}
                  title={customerName}
                  className="min-w-0 truncate hover:underline"
                >
                  {customerName}
                </Link>
              ) : (
                <span title={customerName} className="min-w-0 truncate">{customerName}</span>
              )}
            </span>
          }
          meta={
            <div className="flex min-w-0 basis-full flex-col gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                <StatusChip domain="invoice" status={overdue ? 'OVERDUE' : invoice.status} />
                <ProcessingBadge amount={invoice.processing_amount} />
                {invoice.kind === 'DEPOSIT' && <Badge variant="softBlue" size="sm">Deposit</Badge>}
                {invoice.kind === 'PLAN' && <Badge variant="softGreen" size="sm">Service Plan</Badge>}
              </div>

              {/* Contact and location on one wrapping row, spaced rather than
                  glued together with interpuncts. The customer's name is no
                  longer repeated here - it is the heading now. */}
              <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-sm">
                {/* The customer's primary phone and email, drawn by the shared block through the contact display
                    policy: what a tap, a copy and a selection do follows the person's switches. A long email
                    or address wraps so its full value stays on screen. */}
                <PrimaryContactLines
                  customer={customer}
                  name={customerName}
                  context={{ customerId: customer.id, customerName }}
                  icons
                />
                {loc && (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <MapPin className="size-3.5 shrink-0" />
                    <span className="min-w-0 break-words">
                      {loc.address_line1}
                      {loc.address_line2 && `, ${loc.address_line2}`}
                      {`, ${loc.city}, ${loc.state} ${loc.zip}`}
                    </span>
                  </span>
                )}
              </div>

              <TagInput entityType="INVOICE" entityId={id!} tags={invoice.tags ?? []} />

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {invoice.job && (
                  // Jobs is a separate migration - legacy path, and the trail
                  // handed over points back at the v2 invoice.
                  <Link
                    to={preferV2Path(`/jobs/${invoice.job.id}`)}
                    state={{ breadcrumbs: outboundBreadcrumbs }}
                    className="text-brand hover:underline"
                  >
                    Job {invoice.job.job_number}
                  </Link>
                )}
                {estimate && (
                  <>
                    {invoice.job && <span className="text-muted-foreground">{'·'}</span>}
                    <Link
                      to={preferV2Path(`/estimates/${estimate.id}`)}
                      state={{ breadcrumbs: outboundBreadcrumbs }}
                      className="text-brand hover:underline"
                    >
                      Estimate {estimate.estimate_number}
                    </Link>
                  </>
                )}
              </div>

              <div className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
                <Calendar className="size-3" />
                {invoice.sent_at && <span>Sent {new Date(invoice.sent_at).toLocaleDateString()}</span>}
                {invoice.sent_at && invoice.due_date && <span>{'·'}</span>}
                {invoice.due_date && (
                  <span>
                    Due {formatInstant(invoice.due_date, timeZone, ORG_DAY_FORMAT)}
                    {(invoice.status === 'SENT' || invoice.status === 'PARTIAL') && (
                      <span className={cn('ml-1', overdue && 'text-status-red-emphasis font-medium')}>
                        ({getDueDateLabel(invoice, timeZone)})
                      </span>
                    )}
                  </span>
                )}
                {invoice.paid_at && <span>{'·'} Paid {new Date(invoice.paid_at).toLocaleDateString()}</span>}
              </div>
            </div>
          }
          aside={
            canSeePrices ? (
              <div className="flex flex-col sm:items-end">
                <p
                  data-testid="invoice-amount-due"
                  className={cn(
                    'text-3xl font-bold tabular-nums',
                    overdue && 'text-status-red-emphasis',
                  )}
                >
                  {formatCurrency(amountDue)}
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">Amount Due</p>
              </div>
            ) : undefined
          }
          primary={primaryAction}
          secondary={invoiceHeaderActions}
        />

        {/* Resend reminder - a material edit landed after the invoice was sent,
            so the customer's copy is stale. Non-blocking. */}
        {invoice.needs_resend && actions.canResend && (
          <div className="bg-status-amber-subtle text-status-amber-emphasis flex items-center justify-between gap-2 rounded-lg border px-4 py-3 text-sm">
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
              <span className="font-medium">
                This invoice changed since it was sent - the customer hasn&apos;t seen the update.
              </span>
            </span>
            <Button variant="outline" size="sm" onClick={() => setResendOpen(true)}>
              <Send /> Resend
            </Button>
          </div>
        )}

        {overdue && (
          <div className="bg-status-red-subtle text-status-red-emphasis flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
            <AlertTriangle className="size-4 shrink-0" />
            <span className="font-medium">OVERDUE</span> - {getDueDateLabel(invoice, timeZone)} past due (was due{' '}
            {formatInstant(invoice.due_date, timeZone, ORG_DAY_FORMAT)})
          </div>
        )}

        {invoice.status === 'VOIDED' && (
          <div className="bg-muted text-muted-foreground flex items-center gap-2 rounded-lg border px-4 py-3 text-sm">
            <XCircle className="size-4 shrink-0" />
            This invoice was voided on{' '}
            {invoice.voided_at ? new Date(invoice.voided_at).toLocaleDateString() : 'unknown date'}
            {invoice.voided_reason && `: ${invoice.voided_reason}`}
          </div>
        )}

        {/* More was settled against this invoice than it bills for. The backend
            accepts an overpayment and only flags it on the timeline, so this is
            the one place a user ever sees it. */}
        {money.overpaidAmount > 0 && (
          <div
            role="alert"
            data-testid="invoice-overpaid-banner"
            className="bg-status-amber-subtle text-status-amber-emphasis flex items-center gap-2 rounded-lg border px-4 py-3 text-sm"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span className="font-medium">Overpaid by {formatCurrency(money.overpaidAmount)}</span>
            {' - issue a refund to return the surplus.'}
          </div>
        )}

        {/* Tabs sit on the page, not in a card. Everything inside the Line
            Items panel - the receipt, the scope-of-work block, the line-items
            table - already draws its own frame, so a Card here put a border
            around a stack of borders and cost every one of them a gutter. The
            tab strip's own rule is the separation the section needs. */}
        <div>
          <TabStrip
            value={activeTab}
            onValueChange={setActiveTab}
            tabs={[
              { value: 'line-items', label: `Line Items (${allItems.length})` },
              ...(canSeePrices ? [{ value: 'payments', label: `Payments (${ledgerEvents.length})` }] : []),
            ]}
          />

          <TabPanel value="line-items" activeValue={activeTab}>
            <div className="flex flex-col gap-6 pt-6">
              {/* The one editable money surface. Discount/Tip/Tax-rate controls
                  go interactive only once the invoice is actually editable AND
                  the user holds `update Invoice` - the card's own contract is
                  "a control is interactive iff its handler prop is provided",
                  so a locked or read-only viewer gets undefined handlers. */}
              {invoice.price_edit_closed_reason && (
                <div
                  data-testid="invoice-done-prices-notice"
                  role="status"
                  className="border-border bg-muted text-foreground flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] font-medium"
                >
                  <Lock className="size-4 shrink-0" />
                  <span>{invoice.price_edit_closed_reason}</span>
                </div>
              )}
              {canSeePrices && (
                <>
                  <InvoiceReceiptCard
                    invoice={invoice}
                    overdue={overdue}
                    onDiscountChange={canEditInvoicePrices ? (v) => billingMutation.mutate({ discount_amount: v }) : undefined}
                    onTipChange={canEditInvoiceBilling ? (v) => billingMutation.mutate({ tip: v }) : undefined}
                    onTaxRateChange={canEditInvoicePrices ? (r) => billingMutation.mutate({ tax_rate: r }) : undefined}
                    taxRates={canEditInvoicePrices ? taxRates : undefined}
                    refundedTotal={money.refundedTotal}
                    creditedTotal={money.creditedTotal}
                    settledTotal={money.settled}
                    overpaidAmount={money.overpaidAmount}
                  />

                  {/* Payments at a glance. The full ledger stays reachable via
                      "View all payments", which jumps to the Payments tab. */}
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                        Payments
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        {actions.canRecordPayment && (
                          <Button size="sm" onClick={() => setRecordPaymentOpen(true)}>
                            <DollarSign /> Record payment
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => setActiveTab('payments')}>
                          View all payments
                        </Button>
                      </div>
                    </div>
                    <StatCardGroup>
                      <StatCard label="Deposit credit" value={formatCurrency(Number(invoice.deposit_credit))} />
                      <StatCard label="Paid" value={formatCurrency(paymentsTotal)} />
                      <StatCard
                        label="Balance"
                        value={formatCurrency(amountDue)}
                        tone={amountDue > 0 ? 'amber' : 'green'}
                      />
                      <StatCard
                        label="Status"
                        value={<StatusChip domain="invoice" status={overdue ? 'OVERDUE' : invoice.status} />}
                      />
                    </StatCardGroup>
                  </div>
                </>
              )}

              {canSeePrices ? (
                <>
                  <InvoiceScopeOfWorkCard invoice={invoice} />
                  <InvoiceLineItemsEditor invoice={invoice} estimateLines={estimateItems} />
                </>
              ) : (
                <PriceFreeLines lines={allItems} scopes={invoice.scopes ?? []} title="Scope of work" />
              )}
              {/* Payments go-live slice 21 - which methods this invoice offers and whether it
                  takes partial payments, against the org's defaults. Editable on the same gate
                  as the rest of the invoice. */}
              <InvoicePaymentOptionsCard invoiceId={invoice.id} {...paymentOptions} />
              {canSeePricing && (
                <InternalCostsCard
                  lineItems={invoice.line_items ?? []}
                  scopes={invoice.scopes ?? []}
                  laborHours={invoice.labor_hours}
                  overheadMode={invoice.overhead_mode}
                  overheadValue={invoice.overhead_value}
                  discountedSubtotal={Number(invoice.subtotal ?? 0) - Number(invoice.discount_amount ?? 0)}
                  orgLaborRate={org?.labor_rate ?? 0}
                  orgOverheadMode={org?.overhead_mode ?? 'PERCENTAGE'}
                  orgOverheadValue={org?.overhead_value ?? 0}
                  canEditNow={canEditInvoiceBilling}
                  onCommitLaborHours={(hours) => costMutation.mutate({ labor_hours: hours })}
                  onCommitOverhead={(mode, value) => costMutation.mutate({ overhead_mode: mode, overhead_value: value })}
                />
              )}
            </div>
          </TabPanel>

          <TabPanel value="payments" activeValue={activeTab}>
            <div className="pt-6">
              {actions.canRecordPayment && (
                <div className="mb-4 flex justify-end">
                  <Button size="sm" onClick={() => setRecordPaymentOpen(true)}>
                    <DollarSign /> Record Payment
                  </Button>
                </div>
              )}

              {ledgerEvents.length === 0 ? (
                <EmptyState
                  icon={<DollarSign />}
                  title="No payments recorded yet"
                  description="Payments will appear here once recorded. Deposit credit is shown in the payment summary."
                  action={
                    actions.canRecordPayment ? (
                      <Button size="sm" onClick={() => setRecordPaymentOpen(true)}>
                        <DollarSign /> Record Payment
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <Table className="w-full text-sm" data-testid="invoice-ledger">
                    <thead>
                      <tr className="text-muted-foreground border-b text-left text-xs uppercase tracking-wide">
                        <th className="pb-2 pr-3">Date</th>
                        <th className="pb-2 pr-3">Event</th>
                        <th className="pb-2 pr-3">Source</th>
                        <th className="pb-2 pr-3">Method</th>
                        <th className="pb-2 pr-3 text-right">Amount</th>
                        <th className="pb-2 pr-3 text-right">Service fee</th>
                        <th className="pb-2">By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-border/50 divide-y">
                      {inbound.map(renderLedgerRow)}
                      {hasReversals && (
                        <>
                          <tr>
                            <td colSpan={7} className="py-1.5">
                              <span className="flex items-center gap-2">
                                <span className="border-status-red flex-1 border-t border-dashed" />
                                <span className="text-status-red-emphasis text-xs font-medium uppercase tracking-wide">
                                  {hasCredits ? 'Refunds & Credits' : 'Refunds'}
                                </span>
                                <span className="border-status-red flex-1 border-t border-dashed" />
                              </span>
                            </td>
                          </tr>
                          {outbound.map(renderLedgerRow)}
                        </>
                      )}
                    </tbody>
                    <tfoot>
                      {/* Every figure here comes from the shared `money`
                          derivation - the same one the receipt card reads - so
                          the two surfaces cannot disagree. */}
                      <tr>
                        <td colSpan={7} className="text-muted-foreground pt-3 text-right text-xs">
                          {ledgerEvents.length} event{ledgerEvents.length !== 1 ? 's' : ''} {'·'}{' '}
                          <span className="text-status-green-emphasis">
                            +{formatCurrency(money.collectedGross)} collected
                          </span>
                          {money.refundedTotal > 0 && (
                            <>
                              {' · '}
                              <span className="text-status-red-emphasis">
                                {'−'}{formatCurrency(money.refundedTotal)} refunded
                              </span>
                            </>
                          )}
                          {money.creditedTotal > 0 && (
                            <>
                              {' · '}
                              <span className="text-status-red-emphasis">
                                {'−'}{formatCurrency(money.creditedTotal)} credited
                              </span>
                            </>
                          )}
                          {' · Net cash '}
                          {/* Net cash can go negative (a refund then a void). */}
                          <span
                            className={
                              money.netCash < 0
                                ? 'text-status-red-emphasis'
                                : money.netCash === 0
                                  ? 'text-muted-foreground'
                                  : 'text-status-green-emphasis'
                            }
                          >
                            {formatCurrency(money.netCash)}
                          </span>
                        </td>
                      </tr>
                    </tfoot>
                </Table>
              )}
            </div>
          </TabPanel>
        </div>

        {/* Dialogs. Send is mounted TWICE - the resend instance is a separate
            component instance with its own state. Refund, Credit and
            VoidPayment self-invalidate and take no onSuccess prop. */}
        <ConfirmDialog
          open={markSentPromptOpen}
          onOpenChange={setMarkSentPromptOpen}
          title="Mark this invoice as sent?"
          description={null}
          confirmLabel="Mark as sent"
          cancelLabel="Not now"
          isPending={markSentMutation.isPending}
          onConfirm={() => markSentMutation.mutate()}
        />
        <ConfirmDialog
          open={markSentOpen}
          onOpenChange={setMarkSentOpen}
          title={`Mark ${invoice.invoice_number} as sent?`}
          description="No email is sent."
          confirmLabel="Mark as sent"
          isPending={markSentMutation.isPending}
          onConfirm={() => markSentMutation.mutate()}
        />
        <SendInvoiceDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoice_number}
          customerEmail={customer.email}
          dueDate={invoice.due_date}
          totalAmount={totalAmount}
          amountDue={amountDue}
          lineItems={allItems}
          onSuccess={invalidateInvoice}
          paymentOptions={paymentOptions}
        />
        <SendInvoiceDialog
          open={resendOpen}
          onOpenChange={setResendOpen}
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoice_number}
          customerEmail={customer.email}
          dueDate={invoice.due_date}
          totalAmount={totalAmount}
          amountDue={amountDue}
          lineItems={allItems}
          onSuccess={invalidateInvoice}
          paymentOptions={paymentOptions}
          isResend
        />

        <RecordPaymentDialog
          open={recordPaymentOpen}
          onOpenChange={setRecordPaymentOpen}
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoice_number}
          amountDue={amountDue}
          processingAmount={Number(invoice.processing_amount ?? 0)}
          onSuccess={invalidateInvoice}
        />

        <VoidInvoiceDialog
          open={voidOpen}
          onOpenChange={setVoidOpen}
          invoiceId={invoice.id}
          invoiceNumber={invoice.invoice_number}
          syncedLineCount={syncedLineCount}
          onSuccess={() => {
            invalidateInvoice();
            navigate(v2Path('/invoices'));
          }}
        />

        <PdfPreviewDialog
          open={pdfPreviewOpen}
          onOpenChange={setPdfPreviewOpen}
          pdfUrl={`/api/invoices/${id}/pdf`}
          downloadFilename={`Invoice-${invoice.invoice_number}.pdf`}
          title={`Invoice ${invoice.invoice_number}`}
        />

        <DeleteInvoiceDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          invoiceId={invoice.id}
          syncedLineCount={syncedLineCount}
          onSuccess={() => navigate(v2Path('/invoices'))}
        />

        <RefundInvoiceDialog
          open={refundOpen}
          onOpenChange={setRefundOpen}
          invoiceId={invoice.id}
          netPaid={netPaid}
          payments={refundablePayments.map((p) => ({
            id: p.id,
            amount: p.amount,
            method: p.method,
            paid_at: p.paid_at,
            paid_through_processor: p.paid_through_processor,
          }))}
          refunds={invoice.refunds}
        />

        <CreditInvoiceDialog
          open={creditOpen}
          onOpenChange={setCreditOpen}
          invoiceId={invoice.id}
          balanceOwed={amountDue}
          credits={invoice.credits}
          canRefund={ability.can('refund', 'Invoice')}
          payments={refundablePayments.map((p) => ({
            id: p.id,
            amount: p.amount,
            method: p.method,
            paid_at: p.paid_at,
            paid_through_processor: p.paid_through_processor,
          }))}
          refunds={invoice.refunds}
        />

        {cancelBankTarget && (
          <CancelBankPaymentDialog
            open
            onOpenChange={(open) => {
              if (!open) setCancelBankTarget(null);
            }}
            invoiceId={invoice.id}
            payment={cancelBankTarget}
          />
        )}

        {voidPaymentTarget && (
          <VoidPaymentDialog
            open={voidPaymentOpen}
            onOpenChange={(open) => {
              setVoidPaymentOpen(open);
              if (!open) setVoidPaymentTarget(null);
            }}
            invoiceId={invoice.id}
            payment={{
              id: voidPaymentTarget.id,
              amount: voidPaymentTarget.amount,
              method: voidPaymentTarget.method,
              reference_number: voidPaymentTarget.reference_number,
            }}
          />
        )}
      </div>
    </IconRail>
  );
}
