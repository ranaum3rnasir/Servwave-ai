import { useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import type { BreadcrumbItem } from '@/components/ui/breadcrumb';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import type { InvoiceKind, Refund, Credit, VoidPaymentReason } from '@/types/entities';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Text } from '@/components/ui/text';
import { Stack } from '@/components/ui/stack';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/data/status-badge';
import { TabsContent } from '@/components/ui/tabs';
import { Breadcrumb } from '@/components/ui/breadcrumb';
import { TabStrip } from '@/components/patterns/TabStrip';
import { RecordNumberEditor } from '@/components/crm/RecordNumberEditor';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TagInput } from '@/components/leads/TagInput';
import { SendInvoiceDialog } from '@/components/invoices/SendInvoiceDialog';
import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';
import { VoidInvoiceDialog } from '@/components/invoices/VoidInvoiceDialog';
import { DeleteInvoiceDialog } from '@/components/invoices/DeleteInvoiceDialog';
import { RefundInvoiceDialog } from '@/components/invoices/RefundInvoiceDialog';
import { CreditInvoiceDialog } from '@/components/invoices/CreditInvoiceDialog';
import { VoidPaymentDialog } from '@/components/invoices/VoidPaymentDialog';
import { InvoiceLineItemsEditor, InvoiceScopeOfWorkCard } from '@/components/invoices/InvoiceLineItemsEditor';
import { InvoiceReceiptCard } from '@/components/invoices/InvoiceReceiptCard';
import { PdfPreviewDialog } from '@/components/estimates/PdfPreviewDialog';
import { InternalCostsCard } from '@/components/crm/InternalCostsCard';
import { useOrganization, type PaymentMethod } from '@/lib/api/organization';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { KpiStrip } from '@/components/data/KpiStrip';
import { IconRail } from '@/components/crm/IconRail';
import { useJobCommunications, findTransactionalEmail } from '@/lib/api/jobCommunications';
import { EmailDeliveryPill } from '@/components/communication/shared/EmailDeliveryPill';
import { EmptyState } from '@/components/ui/empty-state';
import { toast } from '@/components/ui/use-toast';
import { updateInvoiceBilling, fetchStateTaxRates, createInvoicePaymentLink } from '@/lib/api/invoices';
import { isInvoiceEditable, isInvoiceRenumberLocked } from '@/lib/invoiceEditable';
import type { InvoiceLineItem, Scope } from '@/lib/api/jobs';
import {
  Send,
  DollarSign,
  MoreHorizontal,
  Trash2,
  XCircle,
  FileText,
  Link2,
  AlertTriangle,
  Phone,
  Mail,
  MapPin,
  Calendar,
  CreditCard,
  Gift,
  Wallet,
  Receipt,
  Eye,
  Download,
  Loader2,
} from 'lucide-react';
import { cn, formatCurrency, formatPhone, extractApiError, downloadBlob } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { formatExactDay } from '@/lib/format-date';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import { canSeePricing as canSeePricingAbility, type AppAbility } from '@/lib/ability';

// ─── Types + derivations ───────────────────────────
// Money, ledger and permission logic lives in @/lib/invoices/invoiceMoney so
// this page and the /v2 invoice pages run the same implementation.
import {
  type LineItem,
  type Payment,
  type InvoiceDetail,
  type InvoiceCustomer,
  type LedgerEvent,
  type InvoiceMoneyFigures,
  isDepositCreditPayment,
  round2,
  processorLabel,
  deriveInvoiceMoney,
  buildLedgerEvents,
  getAvailableActions,
  isOverdue,
  getDueDateLabel,
} from '@/lib/invoices/invoiceMoney';


// ─── Component ──────────────────────────────────────

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const ability = useAppAbility();
  const incomingBreadcrumbs: BreadcrumbItem[] | undefined = location.state?.breadcrumbs;

  // Dialog states
  const [sendOpen, setSendOpen] = useState(false);
  const [resendOpen, setResendOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [voidPaymentOpen, setVoidPaymentOpen] = useState(false);
  const [voidPaymentTarget, setVoidPaymentTarget] = useState<Payment | null>(null);
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // Controlled so the Payments stat-grid card's "View all payments" link can jump tabs.
  const [activeTab, setActiveTab] = useState('line-items');

  // ─── Queries ────────────────────────────────────

  const { data: invoice, isLoading } = useQuery({
    queryKey: ['invoice', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/invoices/${id}`);
      return data.invoice as InvoiceDetail;
    },
  });

  // R3b (2026-07-21) — cost model (D2/D8): org labor_rate/overhead defaults for <InternalCostsCard>.
  // Declared here (before the isLoading/!invoice early returns below) — every hook must run on
  // every render regardless of loading state, or React throws "Rendered more hooks than during
  // the previous render" once the invoice query resolves.
  const { data: org } = useOrganization();
  // Not routed (see App.tsx) - kept compiling only because ~60 tests still import this file.
  const timeZone = useScheduleTimezone();

  // Delivery fact (slice 5) — Email carries no invoice_id column to join on
  // directly, so this reads the SAME job-scoped comm timeline the Job page's
  // Communication tab already renders (invoice sends stamp job_id on the
  // Email row, see lib/email.ts's sendInvoiceEmail call site) and picks out
  // this invoice's own send by its deterministic subject prefix
  // (`Invoice ${invoiceNumber}...`, unique per org). Same "declared before the
  // early returns" rule as useOrganization above — enabled:false-equivalent
  // via jobId undefined until the invoice loads.
  const { data: jobComms } = useJobCommunications(invoice?.job?.id);
  const invoiceSendItem = invoice
    ? findTransactionalEmail(jobComms, `Invoice ${invoice.invoice_number}`)
    : undefined;

  // v12 receipt consolidation (plan §3/§4 Invoice): <InvoiceReceiptCard> (Card A) is now the sole
  // editable money surface — this page owns the billing mutation + tax-rate lookup that used to
  // live inside InvoiceLineItemsEditor's own <TotalsFooter>.
  const canEditInvoiceBilling = !!invoice && isInvoiceEditable(invoice.status) && ability.can('update', 'Invoice');

  const { data: taxRates = [] } = useQuery({
    queryKey: ['state-tax-rates'],
    queryFn: fetchStateTaxRates,
    enabled: canEditInvoiceBilling,
    staleTime: 60 * 60 * 1000,
  });

  // ─── Mutations ──────────────────────────────────

  const invalidateInvoice = () => {
    queryClient.invalidateQueries({ queryKey: ['invoice', id] });
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
  };

  const billingMutation = useMutation({
    mutationFn: (body: { tip?: number; discount_amount?: number; tax_rate?: number }) =>
      updateInvoiceBilling(id!, body),
    onSuccess: invalidateInvoice,
    onError: (err) => toast({ title: extractApiError(err, 'Failed to update totals'), variant: 'destructive' }),
  });

  // R3b (2026-07-21) — cost model (D2/D8). Goes through the main PATCH /api/invoices/:id
  // (editInvoiceSchema), not the billing sub-route above.
  const costMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/invoices/${id}`, body),
    onSuccess: invalidateInvoice,
    onError: (err) => toast({ title: extractApiError(err, 'Could not save'), variant: 'destructive' }),
  });

  const createPaymentLinkMutation = useMutation({
    mutationFn: async () => {
      if (!id) throw new Error('Missing invoice id');
      return createInvoicePaymentLink(id);
    },
    onSuccess: ({ url }) => {
      invalidateInvoice();
      navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
      toast({ title: 'Payment link created', description: 'The invoice is now marked as Sent, and the link is copied to your clipboard.' });
    },
    onError: (err: any) => {
      toast({ title: 'Could not create payment link', description: err?.response?.data?.error ?? 'Please try again.', variant: 'destructive' });
    },
  });

  const handleCopyLink = () => {
    if (invoice?.public_token) {
      const url = `${window.location.origin}/p/invoices/${invoice.id}?token=${invoice.public_token}`;
      navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } else {
      createPaymentLinkMutation.mutate();
    }
  };

  // Download the invoice PDF via the authed axios client — mirrors
  // EstimateWorkspacePage's handleDownloadPdf.
  async function handleDownloadPdf() {
    if (!id) return;
    setDownloadingPdf(true);
    try {
      const res = await api.get(`/api/invoices/${id}/pdf`, { responseType: 'blob' });
      downloadBlob(res.data as Blob, `Invoice-${invoice?.invoice_number ?? id}.pdf`);
    } catch (err) {
      toast({
        title: 'Download failed',
        description: extractApiError(err, 'Could not download the invoice PDF.'),
        variant: 'destructive',
      });
    } finally {
      setDownloadingPdf(false);
    }
  }

  // ─── Loading State ─────────────────────────────

  if (isLoading) {
    return (
      <Stack gap={4}>
        {/* Breadcrumb skeleton */}
        <Stack direction="horizontal" align="center" gap={1.5}>
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-3 w-3" />
          <Skeleton className="h-4 w-28" />
        </Stack>

        {/* Hero skeleton */}
        <Card pad={4}>
          <Stack direction="horizontal" align="start" justify="between">
            <Stack gap={2}>
              <Stack direction="horizontal" align="center" gap={3}>
                <Skeleton className="h-7 w-32" />
                <Skeleton shape="circle" className="h-5 w-16" />
              </Stack>
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-40" />
            </Stack>
            {/* `align="end"` replaces the old right-alignment class plus `ml-auto`. Both
                children are fixed-width blocks containing no text, so the inherited
                horizontal alignment never reached a glyph; the wider child spans the
                whole shrink-to-fit column either way. */}
            <Stack gap={2} align="end">
              <Skeleton className="h-9 w-32" />
              <Skeleton className="h-3 w-20" />
            </Stack>
          </Stack>
          <Stack direction="horizontal" align="center" gap={2} className="mt-4">
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-8 w-8" />
          </Stack>
        </Card>

        {/* Waterfall skeleton */}
        <Card pad={4}>
          {/* The last child's old `mt-2` never rendered: `.space-y-3 > :not([hidden]) ~
              :not([hidden])` is specificity (0,3,0) against `.mt-2`'s (0,1,0), so the
              12px seam won. Dropping it keeps gap={3} at that same 12px. */}
          <Stack gap={3}>
            {Array.from({ length: 4 }).map((_, i) => (
              <Stack key={i} direction="horizontal" justify="between">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-20" />
              </Stack>
            ))}
            <Skeleton shape="circle" className="h-3 w-full" />
          </Stack>
        </Card>

        {/* Tabs skeleton */}
        <Card pad={0}>
          <div className="flex gap-1 border-b border-border px-4 pt-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-3 py-2.5">
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
          <div className="p-4 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        </Card>
      </Stack>
    );
  }

  if (!invoice) {
    return (
      <Text as="div" tone="secondary" align="center" className="py-12">
        Invoice not found
      </Text>
    );
  }

  // ─── Derived Data ─────────────────────────────

  const actions = getAvailableActions(invoice, user?.role || '', ability);
  const overdue = isOverdue(invoice, timeZone);
  // Cost/margin visibility for <InternalCostsCard> — shared with the backend's canSeePricing
  // gate (SRVW-140), see lib/ability.ts.
  const canSeePricing = canSeePricingAbility(ability);
  // Customer resolves from the top-level field (deposit/orphan invoices) or via the job.
  // Backend always supplies one; the empty fallback keeps render null-safe.
  const customer: InvoiceCustomer = invoice.customer ?? invoice.job?.customer ?? {
    id: '',
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
  };
  const loc = invoice.job?.service_location ?? null;
  // Copy-to-Invoice (R5e): a job-less standalone invoice reaches its source estimate only via the
  // new top-level invoice.estimate — falls back so the links row still shows "Estimate {number}".
  const estimate = invoice.job?.estimate ?? invoice.estimate ?? null;
  // Line items now live on the invoice; fall back to the estimate items when the invoice owns none.
  const ownLineItems = invoice.line_items ?? [];
  const estimateItems = estimate?.line_items ?? [];
  const allItems = (ownLineItems.length > 0 ? ownLineItems : estimateItems)
    .map((li) => ({ ...li }))
    .sort((a, b) => a.sequence - b.sequence);
  // Inventory P1 §4 — invoice-BORN synced lines only (job-copied lines are stamped
  // NOT_TRACKED by construction, so the raw filter already is the scope rule). Void and
  // delete auto-return these server-side; the dialogs/confirms say so.
  const syncedLineCount = ownLineItems.filter((li) => li.stock_status === 'SYNCED').length;

  const totalAmount = Number(invoice.total_amount);
  const amountDue = Number(invoice.amount_due);
  const customerPayments = invoice.payments.filter((payment) => !isDepositCreditPayment(payment));
  // Voided payments are money that never really changed hands - the backend adds them straight back
  // onto amount_due (voidPayment) - so no "paid"/"collected" figure may count them.
  const paymentsTotal = round2(
    customerPayments
      .filter((payment) => payment.voided_at == null)
      .reduce((sum, payment) => sum + Number(payment.amount), 0),
  );

  // ONE ledger pass feeds every money surface below (Receipt card, overpaid banner, Payments KPI
  // strip, Payments-tab footer), so they cannot disagree. See `deriveInvoiceMoney`.
  const ledgerEvents = buildLedgerEvents(invoice);
  const money = deriveInvoiceMoney(ledgerEvents, totalAmount);

  // Net-paid cap for refunds. net_collected is in the GET select but legacy rows carry 0;
  // fall back to the non-voided customer payments so the client cap stays meaningful.
  const netPaid = Number(invoice.net_collected ?? 0) || paymentsTotal;
  // Manual (non-card, non-PI-backed), non-voided payments can be individually voided — mirrors
  // the backend's voidPayment guard exactly (invoice.controller.ts) rather than an allowlist of
  // method names, so a future new PaymentMethod (like R5b's Zelle/Venmo/Cash App/Other) is
  // voidable here the instant it's voidable server-side, with nothing to remember to add.
  const isVoidableMethod = (payment: { method: string; stripe_payment_intent_id: string | null }) =>
    payment.method !== 'CARD' && payment.method !== 'EXTERNAL_CARD' && !payment.stripe_payment_intent_id;
  const openVoidPayment = (payment: Payment) => {
    setVoidPaymentTarget(payment);
    setVoidPaymentOpen(true);
  };
  const canVoidPayment = ability.can('void_payment', 'Invoice');

  // Build a durable breadcrumb trail: incoming state wins; otherwise reconstruct
  // from the invoice's own job data so reloads don't eject from job context.
  const activeBreadcrumbs: BreadcrumbItem[] = incomingBreadcrumbs
    ? [...incomingBreadcrumbs, { label: invoice.invoice_number }]
    : invoice.job
      ? [
          { label: 'Jobs', href: '/jobs' },
          { label: invoice.job.job_number, href: `/jobs/${invoice.job.id}` },
          { label: invoice.invoice_number },
        ]
      : [{ label: 'Invoices', href: '/invoices' }, { label: invoice.invoice_number }];

  return (
    // SERV10X-59 — invoices previously had no activity surface. Both rail panels are on:
    // Activity is this invoice's notes + timeline surface (it reads the SAME
    // /api/invoices/:id/notes list the retired Notes tab did), and Attachments moved back
    // into the rail when the duplicate inline Attachments SectionCard was removed from the
    // Line Items tab.
    <IconRail entityType="INVOICE" entityId={id!}>
    {/* Deliberately still a <div className="space-y-4"> and NOT a <Stack gap={4}>.
        Breadcrumb's own root carries `mb-4` (components/ui/breadcrumb.tsx:18). In block
        flow that 16px bottom margin COLLAPSES with space-y-4's 16px top margin on the
        next sibling, so the seam renders 16px. Flex containers do not collapse margins,
        so gap={4} would render 16 + 16 = 32px. Converting this one needs Breadcrumb to
        stop owning its own trailing margin first (W2). */}
    <div className="space-y-4" data-testid="invoice-detail">
      {/* Breadcrumb */}
      <Breadcrumb items={activeBreadcrumbs} />

      {/* Hero Card */}
      <Card pad={4}>
        <Stack direction="horizontal" align="start" justify="between">
          {/* Left side */}
          <Stack gap={1.5}>
            <Stack direction="horizontal" align="center" gap={3}>
              <Heading>
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
              </Heading>
              <StatusBadge domain="invoice" status={overdue ? 'OVERDUE' : invoice.status} />
              {invoice.kind === 'DEPOSIT' && (
                <Badge intent="info">
                  Deposit
                </Badge>
              )}
              {invoice.kind === 'PLAN' && (
                <Badge intent="success">
                  Service Plan
                </Badge>
              )}
            </Stack>

            {/* Customer info */}
            <Text as="p" size="sm" tone="secondary">
              {customer.id ? (
                <Link to={`/customers/${customer.id}`} className="text-primary hover:underline font-medium">
                  {customerDisplayName(customer)}
                </Link>
              ) : (
                <Text as="span" weight="medium" tone="primary">{customerDisplayName(customer)}</Text>
              )}
              {customer.phone && (
                <>
                  {' · '}
                  <Phone className="inline h-3 w-3 mr-0.5" />
                  <a href={`tel:${customer.phone}`} className="hover:text-primary hover:underline">
                    {formatPhone(customer.phone)}
                  </a>
                </>
              )}
              {customer.email && (
                <>
                  {' · '}
                  <Mail className="inline h-3 w-3 mr-0.5" />
                  <a href={`mailto:${customer.email}`} className="hover:text-primary hover:underline">
                    {customer.email}
                  </a>
                </>
              )}
            </Text>

            {/* Service address */}
            {loc && (
              <Text as="p" size="sm" tone="secondary" className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                {loc.address_line1}
                {loc.address_line2 && `, ${loc.address_line2}`}
                {`, ${loc.city}, ${loc.state} ${loc.zip}`}
              </Text>
            )}

            <TagInput entityType="INVOICE" entityId={id!} tags={invoice.tags ?? []} />

            <Text as="div" size="sm" className="flex items-center gap-3">
              {invoice.job && (
                <Link
                  to={`/jobs/${invoice.job.id}`}
                  state={{
                    breadcrumbs: [
                      { label: 'Invoices', href: '/invoices' },
                      { label: invoice.invoice_number, href: `/invoices/${id}` },
                    ],
                  }}
                  className="text-primary hover:underline"
                >
                  Job {invoice.job.job_number}
                </Link>
              )}
              {estimate && (
                <>
                  <Text as="span" tone="secondary">·</Text>
                  <Link
                    to={`/estimates/${estimate.id}`}
                    state={{
                      breadcrumbs: [
                        { label: 'Invoices', href: '/invoices' },
                        { label: invoice.invoice_number, href: `/invoices/${id}` },
                      ],
                    }}
                    className="text-primary hover:underline"
                  >
                    Estimate {estimate.estimate_number}
                  </Link>
                </>
              )}
            </Text>

            <Text as="div" size="xs" tone="secondary" className="flex items-center gap-1.5">
              <Calendar className="h-3 w-3" />
              {invoice.sent_at && (
                <span>Sent {new Date(invoice.sent_at).toLocaleDateString()}</span>
              )}
              {/* Delivery fact (slice 5) - Delivered/Bounced/Failed as fact,
                  never an "Opened" claim. See findTransactionalEmail's doc
                  comment (lib/api/jobCommunications.ts) for the correlation. */}
              <EmailDeliveryPill
                status={invoiceSendItem?.deliveryStatus}
                reason={invoiceSendItem?.deliveryStatusReason}
              />
              {invoice.sent_at && invoice.due_date && <span>·</span>}
              {invoice.due_date && (
                <span>
                  Due {formatExactDay(invoice.due_date)}
                  {(invoice.status === 'SENT' || invoice.status === 'PARTIAL') && (
                    <Text
                      as="span"
                      className="ml-1"
                      tone={overdue ? 'danger' : 'secondary'}
                      weight={overdue ? 'medium' : undefined}
                    >
                      ({getDueDateLabel(invoice, timeZone)})
                    </Text>
                  )}
                </span>
              )}
              {invoice.paid_at && <span>· Paid {new Date(invoice.paid_at).toLocaleDateString()}</span>}
            </Text>
          </Stack>

          {/* Right side — actions + hero amount */}
          <Stack align="end" gap={3} className="shrink-0 ml-6">
            {/* Action buttons */}
            <Stack direction="horizontal" wrap align="center" justify="end" gap={2}>
              {/* Primary CTA */}
              {actions.canSend && (
                <Button variant="solid" tone="business" onClick={() => setSendOpen(true)}>
                  <Send className="mr-2 h-4 w-4" /> Send Invoice
                </Button>
              )}
              {actions.canResend && (
                <Button variant="outline" onClick={() => setResendOpen(true)}>
                  <Send className="mr-2 h-4 w-4" /> Resend Invoice
                </Button>
              )}
              {actions.canRecordPayment && (
                <Button variant="solid" tone="business" onClick={() => setRecordPaymentOpen(true)}>
                  <DollarSign className="mr-2 h-4 w-4" /> Record Payment
                </Button>
              )}
              {ability.can('refund', 'Invoice') &&
                netPaid > 0 &&
                ['PAID', 'PARTIAL', 'PARTIALLY_REFUNDED'].includes(invoice.status) && (
                  <Button size="sm" variant="solid" tone="danger" onClick={() => setRefundOpen(true)}>
                    <CreditCard className="mr-2 h-4 w-4" /> Refund
                  </Button>
                )}
              {ability.can('credit', 'Invoice') && invoice.status !== 'DRAFT' && invoice.status !== 'VOIDED' && (
                <Button size="sm" variant="outline" onClick={() => setCreditOpen(true)}>
                  <Gift className="mr-2 h-4 w-4" /> Credit
                </Button>
              )}

              {/* Overflow menu */}
              {(actions.canVoid || actions.canDelete || actions.canCopyLink || actions.canEdit) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" aria-label="More actions">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {actions.canEdit && (
                      <DropdownMenuItem onClick={() => navigate(`/invoices/${id}/edit`)}>
                        <FileText className="mr-2 h-4 w-4" /> Edit
                      </DropdownMenuItem>
                    )}
                    {actions.canCopyLink && (
                      <DropdownMenuItem onClick={handleCopyLink} disabled={createPaymentLinkMutation.isPending}>
                        <Link2 className="mr-2 h-4 w-4" />
                        {linkCopied
                          ? 'Copied!'
                          : createPaymentLinkMutation.isPending
                            ? 'Creating link…'
                            : invoice.public_token
                              ? 'Copy Payment Link'
                              : 'Create Payment Link'}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={() => setPdfPreviewOpen(true)}>
                      <Eye className="mr-2 h-4 w-4" /> Preview PDF
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleDownloadPdf} disabled={downloadingPdf}>
                      {downloadingPdf ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="mr-2 h-4 w-4" />
                      )}
                      Download PDF
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => window.print()}>
                      <FileText className="mr-2 h-4 w-4" /> Print
                    </DropdownMenuItem>
                    {actions.canVoid && (
                      <DropdownMenuItem onClick={() => setVoidOpen(true)} variant="destructive">
                        <XCircle className="mr-2 h-4 w-4" /> Void Invoice
                      </DropdownMenuItem>
                    )}
                    {actions.canDelete && (
                      <DropdownMenuItem onClick={() => setDeleteOpen(true)} variant="destructive">
                        <Trash2 className="mr-2 h-4 w-4" /> Delete
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </Stack>

            {/* Hero amount. `align="end"` replaces the right-alignment class: this
                column is shrink-to-fit, so aligning the inherited text right and
                right-aligning the shrink-wrapped lines themselves put the same glyphs in
                the same place. */}
            <Stack align="end">
              <Text
                as="p"
                data-testid="invoice-amount-due"
                size="3xl"
                weight="bold"
                tone={overdue ? 'danger' : 'primary'}
                className="tabular-nums"
              >
                {formatCurrency(amountDue)}
              </Text>
              <Text as="p" size="xs" tone="secondary" className="mt-0.5">Amount Due</Text>
            </Stack>
          </Stack>
        </Stack>
      </Card>

      {/* Resend reminder (SERV10X-59) — a material edit landed after the invoice was sent; the
          customer's copy is stale. Non-blocking: editing stays permitted, this is the visible
          nudge to give them the current version. Gated on canResend too — no point offering
          Resend to a viewer who can't send it, or on an invoice with no public link yet. */}
      {invoice.needs_resend && actions.canResend && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning-text">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <Text as="span" weight="medium">This invoice changed since it was sent — the customer hasn&apos;t seen the update.</Text>
          </span>
          <Button variant="outline" size="sm" onClick={() => setResendOpen(true)}>
            <Send className="mr-1 h-4 w-4" /> Resend
          </Button>
        </div>
      )}

      {/* Overdue banner */}
      {overdue && (
        <div className="flex items-center gap-2 rounded-lg border border-danger-border bg-danger-surface px-4 py-3 text-sm text-danger-text">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <Text as="span" weight="medium">OVERDUE</Text> — {getDueDateLabel(invoice, timeZone)} past due (was due{' '}
          {formatExactDay(invoice.due_date)})
        </div>
      )}

      {/* Voided banner */}
      {invoice.status === 'VOIDED' && (
        <div className="flex items-center gap-2 rounded-lg border border-neutral-border bg-neutral-surface px-4 py-3 text-sm text-neutral-text">
          <XCircle className="h-4 w-4 shrink-0" />
          This invoice was voided on {invoice.voided_at ? new Date(invoice.voided_at).toLocaleDateString() : 'unknown date'}
          {invoice.voided_reason && `: ${invoice.voided_reason}`}
        </div>
      )}

      {/* Overpaid banner - more was settled against this invoice than it bills for. The backend
          accepts an overpayment and only flags it on the timeline, so this is the one place a user
          ever sees it. */}
      {money.overpaidAmount > 0 && (
        <div
          role="alert"
          data-testid="invoice-overpaid-banner"
          className="flex items-center gap-2 rounded-lg border border-warning-border bg-warning-surface px-4 py-3 text-sm text-warning-text"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <Text as="span" weight="medium">Overpaid by {formatCurrency(money.overpaidAmount)}</Text>
          {' - issue a refund to return the surplus.'}
        </div>
      )}

      {/* Tabs - the Card wrapper is this page's own JSX now (phase 11.6 retired
          DetailPageShell's `card` prop; InvoiceDetailPage is the one call site
          that keeps this exact `<Card pad={0}>` shape). */}
      <Card pad={0}>
      <TabStrip
        tabs={[
          {
            value: 'line-items',
            label: (
              <>
                Line Items
                <Text as="span" size="xs" tone="secondary" className="ml-1.5">({allItems.length})</Text>
              </>
            ),
          },
          {
            value: 'payments',
            label: (
              <>
                Payments
                <Text as="span" size="xs" tone="secondary" className="ml-1.5">({ledgerEvents.length})</Text>
              </>
            ),
          },
        ]}
        active={activeTab}
        onChange={setActiveTab}
        padX={4}
        padTop={2}
      >
          {/* Line Items Tab */}
          <TabsContent value="line-items" pad={4}>
            {/* Deliberately still a <div className="space-y-5">: every child here is an
                imported feature component whose root margins this file cannot see, and
                flex gap does not collapse with a child margin the way space-y does. */}
            <div className="space-y-5">
              {/* Card A — the one editable money surface (v12 receipt consolidation). Discount/
                  Tip/Tax-rate controls go interactive only once the invoice is actually editable
                  AND the user holds `update Invoice` — <ReceiptCard>'s own contract is "a control
                  is interactive iff its handler prop is provided", so a locked/read-only viewer
                  gets undefined handlers and renders fully read-only. */}
              <InvoiceReceiptCard
                invoice={invoice}
                overdue={overdue}
                onDiscountChange={canEditInvoiceBilling ? (v) => billingMutation.mutate({ discount_amount: v }) : undefined}
                onTipChange={canEditInvoiceBilling ? (v) => billingMutation.mutate({ tip: v }) : undefined}
                onTaxRateChange={canEditInvoiceBilling ? (r) => billingMutation.mutate({ tax_rate: r }) : undefined}
                taxRates={canEditInvoiceBilling ? taxRates : undefined}
                refundedTotal={money.refundedTotal}
                creditedTotal={money.creditedTotal}
                settledTotal={money.settled}
                overpaidAmount={money.overpaidAmount}
              />

              {/* Payments — always-visible compact stat-grid (v12 §4 Invoice), replacing the old
                  tab-gated-only summary. The full ledger stays reachable via "View all payments",
                  which jumps to the (still-present) Payments tab rather than deleting it. */}
              <SectionCard
                title="Payments"
                icon={<Receipt className="h-4 w-4 text-text-secondary" />}
                meta={
                  <Stack direction="horizontal" align="center" gap={2}>
                    {actions.canRecordPayment && (
                      <Button size="sm" variant="solid" tone="business" onClick={() => setRecordPaymentOpen(true)}>
                        <DollarSign className="mr-1.5 h-4 w-4" /> Record payment
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setActiveTab('payments')}>
                      View all payments
                    </Button>
                  </Stack>
                }
              >
                <KpiStrip
                  items={[
                    { icon: Gift, label: 'Deposit credit', value: formatCurrency(Number(invoice.deposit_credit)) },
                    { icon: DollarSign, label: 'Paid', value: formatCurrency(paymentsTotal), tone: 'success' },
                    {
                      icon: Wallet,
                      label: 'Balance',
                      value: formatCurrency(amountDue),
                      tone: amountDue > 0 ? 'warning' : 'success',
                      emphasize: true,
                    },
                    {
                      icon: Receipt,
                      label: 'Status',
                      value: <StatusBadge domain="invoice" status={overdue ? 'OVERDUE' : invoice.status} />,
                    },
                  ]}
                />
              </SectionCard>

              <InvoiceScopeOfWorkCard invoice={invoice} />
              <InvoiceLineItemsEditor invoice={invoice} estimateLines={estimateItems} />
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
          </TabsContent>

          {/* Payments Tab */}
          <TabsContent value="payments" pad={4}>
            {actions.canRecordPayment && (
              <Stack direction="horizontal" justify="end" className="mb-4">
                <Button size="sm" onClick={() => setRecordPaymentOpen(true)}>
                  <DollarSign className="mr-2 h-4 w-4" /> Record Payment
                </Button>
              </Stack>
            )}

            {(() => {
              const ledger = ledgerEvents;
              const inbound = ledger.filter((e) => !e.isRefund && !e.isCredit);
              const outbound = ledger.filter((e) => e.isRefund || e.isCredit);
              const hasReversals = outbound.length > 0;
              const hasCredits = outbound.some((e) => e.isCredit);

              if (ledger.length === 0) {
                return (
                  <EmptyState
                    icon={DollarSign}
                    title="No payments recorded yet"
                    description="Payments will appear here once recorded. Deposit credit is shown in the payment summary."
                   
                    action={
                      actions.canRecordPayment ? (
                        <Button size="sm" onClick={() => setRecordPaymentOpen(true)}>
                          <DollarSign className="mr-2 h-4 w-4" /> Record Payment
                        </Button>
                      ) : undefined
                    }
                  />
                );
              }

              const renderRow = (event: LedgerEvent) => {
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
                  !isVoided;
                return (
                  <tr
                    key={event.key}
                    className={cn(
                      'hover:bg-background-light/30',
                      isOutbound && 'bg-danger-surface/40',
                      isVoided && 'opacity-60 line-through',
                    )}
                  >
                    <td className="py-2.5 pr-3 whitespace-nowrap text-sm">
                      <span title={new Date(event.date).toLocaleString()}>
                        {new Date(event.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className={cn(
                        'flex items-center gap-2 pl-2 border-l-2',
                        isOutbound ? 'border-danger-text' : event.countsInNet ? 'border-success-text' : 'border-border',
                      )}>
                        <Text as="span" weight="medium" size="sm" tone={isOutbound ? 'danger' : undefined}>
                          {event.label}
                        </Text>
                        {!event.countsInNet && (
                          <Text
                            as="span"
                            size="3xs"
                            weight="medium"
                            tone="secondary"
                            transform="uppercase"
                            tracking="wide"
                            className="no-underline"
                            title="Money that moved on the deposit invoice - only the applied deposit credit counts here"
                          >
                            on deposit invoice
                          </Text>
                        )}
                        {isVoided && (
                          <Text
                            as="span"
                            size="3xs"
                            weight="medium"
                            tone="secondary"
                            transform="uppercase"
                            tracking="wide"
                            className="no-underline"
                          >
                            voided
                          </Text>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      {event.source === 'ESTIMATE' && event.estimateId ? (
                        <Link
                          to={`/estimates/${event.estimateId}`}
                          className="text-xs font-medium border border-border rounded px-1.5 py-0.5 hover:bg-background-light transition-colors no-underline"
                        >
                          {event.estimateNumber || 'ESTIMATE'}
                        </Link>
                      ) : (
                        <span className="text-xs font-medium border border-border rounded px-1.5 py-0.5 bg-background-light">
                          INVOICE
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <Badge variant="outline">
                        {event.method.replace('_', ' ')}
                      </Badge>
                    </td>
                    <td className={cn(
                      'py-2.5 pr-3 text-right font-semibold tabular-nums text-sm',
                      isOutbound
                        ? 'text-danger-text'
                        : event.countsInNet
                          ? 'text-success-text'
                          : 'text-text-secondary',
                    )}>
                      {/* Amount stands alone. Everything that used to stack underneath it (the
                          processor-fee drill-in, the customer-paid service fee) now has its own
                          column, so this cell is one number and rows stay scannable. */}
                      {event.countsInNet ? event.sign : ''}{formatCurrency(event.amount)}
                    </td>
                    {/* Slice 5 (card service fee) — what the CUSTOMER paid on top, never part of
                        this row's amount (D1), hence its own column rather than the invoice's
                        arithmetic. '—' wherever no fee was collected. */}
                    <td className="py-2.5 pr-3 text-right tabular-nums text-sm text-text-secondary">
                      {event.serviceFeeAmount != null && Number(event.serviceFeeAmount) > 0
                        ? formatCurrency(Number(event.serviceFeeAmount))
                        : '—'}
                    </td>
                    {/* Slice 8 (customer-facing tipping) — same treatment as the service fee: its
                        own column, always a dollar figure and never a percentage (D11), riding on
                        the payment rather than the invoice (D10). */}
                    <td className="py-2.5 pr-3 text-right tabular-nums text-sm text-text-secondary">
                      {event.tipAmount != null && Number(event.tipAmount) > 0
                        ? formatCurrency(Number(event.tipAmount))
                        : '—'}
                    </td>
                    <td className="py-2.5 text-text-secondary text-sm">
                      <Stack direction="horizontal" align="center" justify="between" gap={2}>
                        <span>{event.by}</span>
                        {canOfferVoid && payment && (
                          <Button
                            size="3xs"
                            variant="ghost"
                            tone="danger"
                            className="no-underline"
                            onClick={() => openVoidPayment(payment)}
                          >
                            Void
                          </Button>
                        )}
                      </Stack>
                    </td>
                  </tr>
                );
              };

              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="invoice-ledger">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-text-secondary">
                        <th className="pb-2 pr-3">Date</th>
                        <th className="pb-2 pr-3">Event</th>
                        <th className="pb-2 pr-3">Source</th>
                        <th className="pb-2 pr-3">Method</th>
                        <th className="pb-2 pr-3 text-right">Amount</th>
                        <th className="pb-2 pr-3 text-right">Service fee</th>
                        <th className="pb-2 pr-3 text-right">Tip</th>
                        <th className="pb-2">By</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {inbound.map(renderRow)}
                      {hasReversals && (
                        <>
                          <tr>
                            <td colSpan={8} className="py-1.5">
                              <Stack direction="horizontal" align="center" gap={2}>
                                <div className="flex-1 border-t border-dashed border-danger-border" />
                                <Text as="span" size="xs" weight="medium" tone="danger" transform="uppercase" tracking="wide">
                                  {hasCredits ? 'Refunds & Credits' : 'Refunds'}
                                </Text>
                                <div className="flex-1 border-t border-dashed border-danger-border" />
                              </Stack>
                            </td>
                          </tr>
                          {outbound.map(renderRow)}
                        </>
                      )}
                    </tbody>
                    <tfoot>
                      {/* Every figure here comes from the shared `money` derivation above - the same
                          one the Receipt card reads - so the two surfaces cannot disagree. */}
                      <tr>
                        <td colSpan={8} className="pt-3 text-xs text-text-secondary text-right">
                          {ledger.length} event{ledger.length !== 1 ? 's' : ''} ·{' '}
                          <Text as="span" tone="success">+{formatCurrency(money.collectedGross)} collected</Text>
                          {money.refundedTotal > 0 && (
                            <>
                              {' · '}
                              <Text as="span" tone="danger">−{formatCurrency(money.refundedTotal)} refunded</Text>
                            </>
                          )}
                          {money.creditedTotal > 0 && (
                            <>
                              {' · '}
                              <Text as="span" tone="danger">−{formatCurrency(money.creditedTotal)} credited</Text>
                            </>
                          )}
                          {' · Net cash '}
                          {/* Net cash can go negative (e.g. a refund then a void) - tone by sign. */}
                          <Text
                            as="span"
                            tone={money.netCash < 0 ? 'danger' : money.netCash === 0 ? 'secondary' : 'success'}
                          >
                            {formatCurrency(money.netCash)}
                          </Text>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              );
            })()}
          </TabsContent>

      </TabStrip>
      </Card>

      {/* Dialogs */}
      <SendInvoiceDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        invoiceId={invoice.id}
        invoiceNumber={invoice.invoice_number}
        customerEmail={customer.email || ''}
        dueDate={invoice.due_date}
        totalAmount={totalAmount}
        amountDue={amountDue}
        lineItems={allItems}
        onSuccess={invalidateInvoice}
      />
      <SendInvoiceDialog
        open={resendOpen}
        onOpenChange={setResendOpen}
        invoiceId={invoice.id}
        invoiceNumber={invoice.invoice_number}
        customerEmail={customer.email || ''}
        dueDate={invoice.due_date}
        totalAmount={totalAmount}
        amountDue={amountDue}
        lineItems={allItems}
        onSuccess={invalidateInvoice}
        isResend
      />

      <RecordPaymentDialog
        open={recordPaymentOpen}
        onOpenChange={setRecordPaymentOpen}
        invoiceId={invoice.id}
        invoiceNumber={invoice.invoice_number}
        amountDue={amountDue}
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
          navigate('/invoices');
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
        onSuccess={() => navigate('/invoices')}
      />

      <RefundInvoiceDialog
        open={refundOpen}
        onOpenChange={setRefundOpen}
        invoiceId={invoice.id}
        netPaid={netPaid}
        payments={customerPayments.map((p) => ({
          id: p.id,
          amount: p.amount,
          method: p.method,
          paid_at: p.paid_at,
        }))}
        refunds={invoice.refunds}
      />

      <CreditInvoiceDialog
        open={creditOpen}
        onOpenChange={setCreditOpen}
        invoiceId={invoice.id}
        balanceOwed={amountDue}
        credits={invoice.credits}
      />

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
