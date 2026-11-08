import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, ArrowLeft, Briefcase, Copy, Download, Eye, FileCheck, FileText, History,
  Link2, Lock, MailWarning, MoreHorizontal, Receipt, Redo2, Send, ShieldOff, ThumbsDown, ThumbsUp,
  Trash2, Undo2,
} from 'lucide-react';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { ESTIMATE_STATUS, type EstimateStatusValue } from '@/constants/estimateStatus';
import { useAppAbility } from '@/contexts/AbilityContext';
import { canSeePricing as canSeePricingAbility } from '@/lib/ability';
import {
  copyEstimateToInvoice, deleteEstimate, setEstimateStatus, setEstimateStatusTo,
  type EstimateLineItem, type EstimateScopePhoto, type Scope,
} from '@/lib/api/estimates';
import { useOrganization } from '@/lib/api/organization';
import { useLeadCommunications, findTransactionalEmail } from '@/lib/api/jobCommunications';
import { depositInvoiceIsUnpaid } from '@/lib/deposit';
import { extractApiError } from '@/lib/utils';
import { useConfirm } from '@/hooks/useConfirm';

// Domain surfaces with no kit counterpart — imported as-is, never forked. Each
// owns its own fetching, mutations and permission checks; this page is their
// frame. Every one is a ledger row.
import { EstimateInternalCostsCard } from '@/components/estimates/EstimateInternalCostsCard';
import {
  EstimateLineItemsEditor, EstimateScopeOfWorkCard,
} from '@/components/estimates/EstimateLineItemsEditor';
import { EstimateReceiptCard } from '@/components/estimates/EstimateReceiptCard';
import { CancelEstimateDialog } from '@/components/estimates/CancelEstimateDialog';
import { DeclineEstimateInternalDialog } from '@/components/estimates/DeclineEstimateInternalDialog';
import { DuplicateEstimateDialog } from '@/components/estimates/DuplicateEstimateDialog';
import { MarkSentDialog } from '@/components/estimates/MarkSentDialog';
import { PdfPreviewDialog } from '@/components/estimates/PdfPreviewDialog';
import { RecordEstimatePaymentDialog } from '@/components/estimates/RecordEstimatePaymentDialog';
import { RefundDepositDialog } from '@/components/estimates/RefundDepositDialog';
import { SendEstimateDialog } from '@/components/estimates/SendEstimateDialog';
import { VoidApprovalDialog } from '@/components/estimates/VoidApprovalDialog';
import { WaiveDepositDialog } from '@/components/estimates/WaiveDepositDialog';
import { TagInput } from '@/components/leads/TagInput';
import { Thumbnail } from '@/components/ui/thumbnail';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import { SignatureCard } from '@/features/estimate-workspace/components/SignatureCard';
import { CustomerHeader } from '@/features/estimate-workspace/components/CustomerHeader';
import { EstimateNameTitle } from '@/features/estimate-workspace/components/EstimateNameTitle';
import { EstimateTabs, type TabStripAnchor } from '@/features/estimate-workspace/components/EstimateTabs';
import { HistoryPanel } from '@/features/estimate-workspace/components/HistoryPanel';
import { NotesCard } from '@/features/estimate-workspace/components/NotesCard';
import { convertToJobState } from '@/features/estimate-workspace/lib/convertToJob';
import type { PanelEstimate } from '@/features/estimate-workspace/lib/panelEstimate';
import { RecordNumberEditor } from '@/components/crm/RecordNumberEditor';

import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Spinner } from '@/ui-kit/components/ui/spinner';

import { preferV2Path, v2Path } from '../uiV2';
import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { LOST_REASON_LABELS } from '@/constants/lostReasons';
import { useLostReasonOptions } from '@/lib/api/lostReasonOptions';

import { StatusChip } from './components/statusChip';
import {
  EstimateStatusMenu, type EstimateStatusMenuProps,
} from './components/statusMenu';
import { useRecordVisit } from '../pageBreadcrumbs';

/**
 * /v2/estimates/:id — the estimate workspace on the CRM UI kit.
 *
 * CREATE=EDIT: there is no separate estimate form page. This page IS the
 * editor, and `/estimates/new` is a shim that mints a DRAFT and redirects here.
 *
 * What changed is the FRAME: the top bar, the banners, the Actions menu, the
 * delete confirmation and the two small rail cards are kit components. What did
 * not change is anything that decides money, status or permission — the lock
 * policy, the ability gates, every mutation and its invalidation set, and the
 * whole editing surface (`EstimateScopeOfWorkCard`, `EstimateLineItemsEditor`,
 * `EstimateReceiptCard`, `EstimateInternalCostsCard`, `CustomerHeader`,
 * `EstimateTabs`, `NotesCard`, `SignatureCard`, `HistoryPanel`,
 * `TagInput`, `JobLeadTasksTab` and the eleven dialogs) which is imported
 * unchanged. The kit ships no equivalent for any of them; the module ledger
 * lists each one.
 *
 * Navigation goes through `v2Path` / `preferV2Path`, which are no-op shims now
 * that these pages own the bare paths — a row click, a Back button and a
 * post-create redirect all land on the plain URL. See `uiV2.ts`.
 */

type RawEstimate = PanelEstimate & {
  id: string;
  name?: string | null;
  scope_name?: string | null;
  scope_notes?: string | null;
  total_amount?: number | null;
  subtotal: number | string;
  tax_amount: number | string;
  public_token?: string | null;
  version: number;
  modified_after_send: boolean;
  superseded_by_id?: string | null;
  line_items: EstimateLineItem[];
  scopes: Scope[];
  /** Flat array of every scope-of-work photo on this estimate; grouped by `scope_id`. */
  scope_photos?: EstimateScopePhoto[];
  /** Hydrated by GET /api/estimates/:id only; absent on granular mutation responses. */
  tags?: { id: string; name: string; color: string }[];
  labor_hours?: number | string | null;
  overhead_mode?: 'PERCENTAGE' | 'FIXED' | null;
  overhead_value?: number | string | null;
};

/**
 * The three statuses that offer Record Payment. Widened to `string[]` on
 * purpose: `estimate.status` is a bare string off the API, and a tuple of
 * literals would refuse to test it.
 */
const RECORD_PAYMENT_STATUSES: string[] = [
  ESTIMATE_STATUS.DRAFT, ESTIMATE_STATUS.SENT, ESTIMATE_STATUS.PENDING,
];

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

/**
 * Residual "Estimate Info" card — number, author, lifecycle dates and the
 * signature thumbnail. The one slice of the retired three-way InfoPanel with no
 * Card A/B equivalent, kept as its own small rail card exactly as the legacy
 * page keeps it.
 */
/**
 * "Reason", on a declined estimate - the words, not the stored code.
 *
 * A COMPONENT OF ITS OWN so the hook below is mounted only when there is a reason to name. The
 * rail renders for every estimate and the overwhelming majority are not declined; putting the
 * fetch in the card would spend a request per estimate opened to label a row almost none of them
 * show.
 *
 * READS THE WHOLE LIST, INCLUDING SWITCHED-OFF ROWS - deliberately, and this is the difference
 * from `useOfferedLostReasonOptions`. Decision D4 is that a reason is deactivated and never
 * deleted precisely so that estimates already declined under it stay readable; filtering to the
 * active ones here would blank the label on exactly the history D4 exists to protect.
 *
 * Falls back through the five built-ins to the raw code. The code is never a nice thing to show,
 * but it is the truth, and an empty "Reason" row would read as "they did not tell us" - which is
 * a different fact entirely.
 */
function LostReasonRow({ code }: { code: string }) {
  const { data } = useLostReasonOptions();
  const label = data?.find((o) => o.code === code)?.label ?? LOST_REASON_LABELS[code] ?? code;
  return <InfoRow label="Reason" value={label} />;
}

function EstimateInfoCard({
  estimate,
}: {
  estimate: RawEstimate;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="size-4" />
          Estimate Info
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Number</span>
          {/* Read-only here on purpose: the editor moved to the page header, beside the id,
              where every other record keeps it. Leaving a second one in the rail would give
              the same field two pencils in two places. */}
          <span className="text-sm font-medium text-text-secondary">{estimate.estimate_number}</span>
        </div>
        {estimate.creator && (
          <InfoRow label="Created by" value={`${estimate.creator.first_name} ${estimate.creator.last_name}`} />
        )}
        {fmtDate(estimate.created_at) && <InfoRow label="Created" value={fmtDate(estimate.created_at)!} />}
        {fmtDate(estimate.sent_at) && <InfoRow label="Sent" value={fmtDate(estimate.sent_at)!} />}
        {fmtDate(estimate.approved_at) && <InfoRow label="Approved" value={fmtDate(estimate.approved_at)!} />}
        {fmtDate(estimate.declined_at) && <InfoRow label="Declined" value={fmtDate(estimate.declined_at)!} />}
        {/* SRVW-285 — why, directly under when. Both are optional on purpose: the customer may
            decline without saying anything, so a missing row means "they did not tell us" and
            never an empty field. Slice C — the label comes from the ORGANISATION's list now, not
            from the five built-ins alone: an admin who added "Designer" has to read "Designer"
            here and not WENT_WITH_A_DESIGNER. Same list both pickers offer, so the rail, the
            staff dialog and the customer's own screen cannot drift into three wordings for one
            loss. */}
        {estimate.lost_reason && <LostReasonRow code={estimate.lost_reason} />}
        {estimate.lost_reason_note && <InfoRow label="Their comment" value={estimate.lost_reason_note} />}
        {fmtDate(estimate.cancelled_at) && <InfoRow label="Cancelled" value={fmtDate(estimate.cancelled_at)!} />}
        {estimate.signature_data && (
          // `components/ui/thumbnail`, not a raw <img>: the raw-tag ratchet in
          // component-api-guard counts every <img> outside the primitives and
          // may only decrease. A signature is wide rather than square, so it
          // takes the escape hatch that primitive documents for an
          // out-of-ladder tile — `size={null}` plus layout-only classes, with
          // its own `outline` variant supplying the frame so no appearance
          // class is decided at this call site.
          <Thumbnail
            src={estimate.signature_data}
            alt="Signature"
            size={null}
            variant="outline"
            className="mt-2 h-12 w-auto object-contain"
          />
        )}
      </CardContent>
    </Card>
  );
}

const BANNER_TONE = {
  neutral: 'bg-muted text-muted-foreground border-border',
  warning: 'bg-status-amber-subtle text-status-amber-emphasis border-status-amber/30',
  danger: 'bg-status-red-subtle text-status-red-emphasis border-status-red/30',
} as const;

/**
 * A page-level notice.
 *
 * The kit ships no Alert primitive — an open BUILD gap in
 * `UI_KIT_MISSING_COMPONENTS.md` — and its toasts are transient, so the three
 * banners this page needs are composed here. A plain `<div>` rather than the
 * kit's Card on purpose: the component-API ratchet counts appearance classes
 * handed to `<Card>` at a call site, and a tinted banner is exactly that. The
 * tint is chosen ONCE inside this component and selected by a `tone` name, so
 * no call site below names a colour.
 */
function Banner({
  tone = 'neutral', icon, children, action,
}: {
  tone?: keyof typeof BANNER_TONE;
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`mb-4 flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3 text-sm ${BANNER_TONE[tone]}`}>
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export default function EstimateWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  const { confirm, confirmDialog } = useConfirm();

  const [sendOpen, setSendOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [waiveOpen, setWaiveOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [markSentOpen, setMarkSentOpen] = useState(false);
  const [declineInternalOpen, setDeclineInternalOpen] = useState(false);
  const [voidApprovalOpen, setVoidApprovalOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const { data: estimate, isLoading } = useQuery<RawEstimate>({
    queryKey: ['estimate', id],
    queryFn: async () => {
      const res = await api.get(`/api/estimates/${id}`);
      return res.data.estimate;
    },
    enabled: !!id,
  });

  useRecordVisit('estimates', estimate?.estimate_number);

  const { data: org } = useOrganization();

  // Hard-bounce fact (email slice 5). The estimate's own record carries no
  // delivery state, so the send is found on the lead's communications feed by
  // subject — the same lookup the v1 page used, carried over unchanged.
  const { data: leadComms } = useLeadCommunications(estimate?.lead_id ?? undefined);
  const estimateSendItem = estimate
    ? findTransactionalEmail(leadComms, `Estimate ${estimate.estimate_number}`)
    : undefined;
  const hardBounced = estimateSendItem?.deliveryStatus === 'BOUNCED'
    && estimateSendItem?.bounceKind === 'HARD';

  // Lock policy: a PAID deposit is always locked; otherwise SENT and PENDING
  // alike are locked only when the org's lock_on_send toggle is ON.
  //
  // This MUST stay in lockstep with the backend's `isEstimateLocked` — that
  // helper is the authority and this is its presentation mirror. A divergence
  // here does not merely mis-render: it offers an edit affordance the server
  // will reject, or hides one the server would allow. Copied verbatim.
  const status = estimate?.status ?? ESTIMATE_STATUS.DRAFT;
  const depositInvoice = estimate?.invoices?.find((inv) => inv.kind === 'DEPOSIT');
  const depositPaid = depositInvoice?.status === 'PAID';
  const lockOnSend = org?.lock_on_send ?? false;
  const isSigned = status === ESTIMATE_STATUS.PENDING;
  const isSentLike = status === ESTIMATE_STATUS.SENT || isSigned;
  const locked = depositPaid || (isSentLike && lockOnSend);
  const isTerminal = [
    ESTIMATE_STATUS.WON, ESTIMATE_STATUS.DECLINED, 'EXPIRED', ESTIMATE_STATUS.ARCHIVED, 'SUPERSEDED',
  ].includes(status);
  // Editable in place unless locked or in a terminal/read-only state. PENDING
  // is included alongside DRAFT/SENT — editing an unlocked PENDING estimate is
  // the signature-invalidation path, not a blocked action.
  const canEditNow = !locked && !isTerminal && (status === ESTIMATE_STATUS.DRAFT || isSentLike);
  // The single ability gating every granular line/scope mutation.
  const canManageLines = canEditNow && ability.can('update', 'Estimate');
  // Cost/margin visibility, shared with the backend's canSeePricing gate.
  const canSeePricing = canSeePricingAbility(ability);
  // Writing INTO the catalog is a separate, admin-grantable ability; editing
  // estimate lines must not imply catalog-write rights.
  const canSaveToPriceBook = ability.can('create', 'PriceBook');

  async function handleDownloadPdf() {
    if (!id) return;
    setDownloading(true);
    try {
      const res = await api.get(`/api/estimates/${id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Estimate-${estimate?.estimate_number ?? id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('Download failed', {
        description: extractApiError(err, 'Could not download the estimate PDF.'),
      });
    } finally {
      setDownloading(false);
    }
  }

  function handleCopyLink() {
    if (estimate?.public_token) {
      // The PUBLIC page is not part of this module and has no v2 counterpart,
      // so this URL stays a bare origin-relative link on purpose.
      const url = `${window.location.origin}/p/estimates/${estimate.id}?token=${estimate.public_token}`;
      navigator.clipboard.writeText(url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    }
  }

  // --- Lifecycle mutations ---------------------------------------------------
  const deleteMutation = useMutation({
    mutationFn: async () => deleteEstimate(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      navigate(v2Path('/estimates'));
    },
    onError: (err: unknown) =>
      toast.error('Delete failed', { description: extractApiError(err, 'Failed to delete estimate') }),
  });

  // backtodraft/backtosent are the same-row correction path that replaced
  // Revise; approve-internal records a verbal/off-platform win.
  // Spec B1 - recall goes through the FREE setter, not the retained
  // `backtodraft` alias. The alias keeps its original source-status gate (SENT,
  // PENDING) by design, so leaving it here makes the pill's Draft row render
  // enabled on a won/declined/archived estimate and 400 on click. It keeps its
  // own mutation rather than folding into statusMutation only for its richer
  // success copy - the customer's link dying is worth saying out loud.
  const backToDraftMutation = useMutation({
    mutationFn: async () => setEstimateStatusTo(id!, ESTIMATE_STATUS.DRAFT),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      toast('Recalled to Draft', { description: "The customer's link is now invalid — edit and re-send when ready." });
    },
    onError: (err: unknown) =>
      toast.error('Recall failed', { description: extractApiError(err, 'Failed to recall estimate to draft') }),
  });

  const backToSentMutation = useMutation({
    mutationFn: async () => setEstimateStatus(id!, 'backtosent'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      toast('Moved back to Sent');
    },
    onError: (err: unknown) =>
      toast.error('Update failed', { description: extractApiError(err, 'Failed to move estimate back to sent') }),
  });

  // Spec B1 — the single mutation behind every free status move from the pill.
  // Targets that need something the setter cannot invent (a lost_reason, or a
  // cancellation reason) open their dialog instead of calling this.
  //
  // Approve (Verbal) routes through here too rather than keeping its own
  // approveInternalMutation, so the pill's WON row and the Actions menu's
  // Approve (Verbal) issue the IDENTICAL request. POST /:id/approve-internal
  // itself stays on the backend; this page simply no longer has two ways to
  // record the same win.
  const statusMutation = useMutation({
    mutationFn: async (vars: { status: EstimateStatusValue }) => setEstimateStatusTo(id!, vars.status),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      toast(`Moved to ${STATUS_REGISTRY.estimate[vars.status]?.label ?? vars.status}`);
    },
    onError: (err: unknown) =>
      toast.error('Status change failed', { description: extractApiError(err, 'Failed to change status') }),
  });

  const createJobMutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post('/api/jobs', { estimate_id: id });
      return data.job as { id: string };
    },
    onSuccess: (job) => {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      // A new job on the estimate's customer, landing in the board's unscheduled bucket.
      refreshAfterVisitWrite(queryClient, { jobId: job.id });
      navigate(preferV2Path(`/jobs/${job.id}`));
    },
    onError: (err: unknown) =>
      toast.error('Create job failed', { description: extractApiError(err, 'Failed to create job') }),
  });

  // Converts the estimate directly into a standalone Invoice, independent of
  // the Job pipeline. Gating lives on the trigger, not here — the backend 409s
  // regardless as its own guard.
  const copyToInvoiceMutation = useMutation({
    mutationFn: async () => copyEstimateToInvoice(id!),
    onSuccess: ({ invoice }) => {
      queryClient.invalidateQueries({ queryKey: ['estimate', id] });
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      navigate(preferV2Path(`/invoices/${invoice.id}`));
    },
    onError: (err: unknown) =>
      toast.error('Copy to invoice failed', { description: extractApiError(err, 'Failed to copy estimate to invoice') }),
  });

  if (isLoading || !estimate) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-12 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  // --- Derived permission gates (exact parity with the legacy page) ----------
  const isDraft = status === ESTIMATE_STATUS.DRAFT;
  const isSent = status === ESTIMATE_STATUS.SENT;
  const isApproved = status === ESTIMATE_STATUS.WON;
  const canSend = ability.can('send', 'Estimate');
  const canCancelEstimate = ability.can('cancel', 'Estimate');
  const canDeleteEstimate = ability.can('delete', 'Estimate');
  const canRecordPayment = ability.can('record_payment', 'Estimate');
  const canCreateJob = ability.can('create', 'Job');
  // Copy-to-Invoice is gated on `create Invoice`, NOT on WON status: the
  // backend allows any estimate status. An existing standard invoice or job
  // disables the action with a tooltip instead of surfacing a raw 409.
  const canCopyToInvoice = ability.can('create', 'Invoice');
  const standardInvoice = estimate.invoices?.find((inv) => inv.kind === 'STANDARD' && inv.status !== 'VOIDED');
  // "This estimate has a job by either pointer" — provenance `job` or anchor
  // `job_id` — stated once for the three call sites that gate on it.
  const hasJob = !!(estimate.job || estimate.job_id);
  // #2026 — the container the tab strip lists. An estimate carries exactly one anchor, and the
  // strip follows whichever it is. Read in the backend's own precedence order (lead, then job,
  // then the customer every estimate carries) so a row that predates the single-anchor guard and
  // holds two still lists the more specific container.
  const tabStripAnchor: TabStripAnchor | null =
    estimate.lead_id ? { kind: 'lead', id: estimate.lead_id }
    : estimate.job_id ? { kind: 'job', id: estimate.job_id }
    : estimate.customer_id ? { kind: 'customer', id: estimate.customer_id }
    : null;
  // #2048 — the ONE convert-to-job gate, shared by the header button and the Actions item so the
  // two can never drift (convertToJob.ts). `depositInvoice` is resolved below; declared here and
  // read once both controls are in scope.
  const convertGate = convertToJobState({ estimate, depositInvoice, canCreateJob });
  const canWaiveDeposit = ability.can('waive_deposit', 'Estimate');
  const canRefundDeposit = ability.can('refund', 'Invoice');
  const canDuplicate = ability.can('duplicate', 'Estimate');
  // mark-sent reuses the `send` grant (same population, same "deliver the
  // document" intent). void_approval has no non-admin grant row, so
  // `ability.can` resolves false for everyone else without a round-trip.
  const canMarkSent = canSend && isDraft;
  const canSetStatus = ability.can('update', 'Estimate');
  const canBackToDraft = canSetStatus && isSentLike;

  // Spec B1 — the ONE rule that still blocks a status change: a won estimate
  // whose money trail is already real cannot be unwound, because that would
  // orphan invoices or payments pointing at it. Mirrors the backend's
  // blockedByMoneyTrail() so the row is disabled with an explanation instead of
  // failing on click. Everything else is reachable.
  //
  // Only the DEPOSIT half is predicted here, because that is the only half this
  // payload carries. The job half stays server-enforced: the row is offered, and
  // a refusal comes back as the backend's own message in a destructive toast.
  const depositPaidOut = (depositInvoice?.payments?.length ?? 0) > 0;
  const blockedByMoney = isApproved && depositPaidOut;
  const moneyTrailReason = blockedByMoney ? 'The deposit has payments recorded' : undefined;

  // Lifecycle handlers, named once so the status pill's dropdown and the Actions
  // menu below invoke the IDENTICAL confirm copy + mutation. Two call sites for
  // the same verb is exactly how the two surfaces would drift apart otherwise.
  const confirmRecallToDraft = async () => {
    const ok = await confirm({
      title: `Recall ${estimate.estimate_number} to Draft?`,
      // Only promise to kill a link that exists - most estimates reaching here
      // from WON/DECLINED/ARCHIVED have no live token, and warning about one is
      // noise that teaches users to skim.
      description: [
        estimate.public_token ? "The customer's current link will stop working" : 'The estimate reopens for editing',
        isSigned ? ' and their signature will be cleared' : '',
        '.',
      ].join(''),
      confirmLabel: 'Recall to Draft',
      tone: 'danger',
    });
    if (ok) backToDraftMutation.mutate();
  };
  const confirmApproveInternal = async () => {
    const ok = await confirm({
      title: `Record ${estimate.estimate_number} as approved?`,
      description: 'Verbal or off-platform win. No signature will be captured.',
      confirmLabel: 'Record as approved',
    });
    if (ok) statusMutation.mutate({ status: ESTIMATE_STATUS.WON });
  };
  // PENDING means "customer approved and signed, deposit outstanding". Set by
  // hand it is honestly UNSIGNED, and the customer is still asked to sign if they
  // open their link - so the confirm says so rather than letting a rep assume a
  // signature exists.
  const confirmMarkPending = async () => {
    const ok = await confirm({
      title: `Move ${estimate.estimate_number} to Approved — Deposit Pending?`,
      description: 'Records the approval without a customer signature. If the customer later opens their link, they will still be asked to sign.',
      confirmLabel: 'Move to Deposit Pending',
    });
    if (ok) statusMutation.mutate({ status: ESTIMATE_STATUS.PENDING });
  };

  // Which statuses the pill's dropdown offers. Under Spec B1 estimate status is
  // UNORDERED: every status is reachable from every other, so these entries gate
  // on PERMISSION and on the single integrity rule (the money trail), never on
  // where the estimate currently sits.
  //
  // Two targets still route through a dialog rather than straight to the setter,
  // because they need something the setter cannot invent: DECLINED needs a
  // lost_reason, ARCHIVED takes an optional cancellation reason.
  const statusTargets: EstimateStatusMenuProps['targets'] = {
    [ESTIMATE_STATUS.DRAFT]: {
      enabled: canSetStatus && !blockedByMoney,
      reason: moneyTrailReason ?? 'You do not have permission to change this estimate',
      onSelect: confirmRecallToDraft,
    },
    [ESTIMATE_STATUS.SENT]: {
      // SENT is a label like the other five - it records where the estimate sits,
      // not that a customer link exists. So this is always the plain setter, never
      // the mark-sent ceremony. Minting a customer link stays where it belongs:
      // Send, Resend and Mark as sent in the Actions menu, each an explicit act of
      // delivery rather than a side effect of relabelling.
      enabled: canSetStatus && !blockedByMoney,
      reason: moneyTrailReason ?? 'You do not have permission to change this estimate',
      onSelect: () => statusMutation.mutate({ status: ESTIMATE_STATUS.SENT }),
    },
    [ESTIMATE_STATUS.PENDING]: {
      enabled: canSetStatus && !blockedByMoney,
      reason: moneyTrailReason ?? 'You do not have permission to change this estimate',
      onSelect: confirmMarkPending,
    },
    [ESTIMATE_STATUS.WON]: {
      enabled: canSetStatus,
      reason: 'You do not have permission to change this estimate',
      onSelect: confirmApproveInternal,
    },
    [ESTIMATE_STATUS.DECLINED]: {
      enabled: canSetStatus && !blockedByMoney,
      reason: moneyTrailReason ?? 'You do not have permission to change this estimate',
      onSelect: () => setDeclineInternalOpen(true),
    },
    [ESTIMATE_STATUS.ARCHIVED]: {
      enabled: canSetStatus && !blockedByMoney,
      reason: moneyTrailReason ?? 'You do not have permission to change this estimate',
      onSelect: () => setCancelOpen(true),
    },
  };
  const canBackToSent = canSetStatus && isSigned;
  const canApproveInternal = ability.can('approve', 'Estimate') && isSentLike;
  const canDeclineInternal = ability.can('decline', 'Estimate') && isSentLike;
  const canVoidApproval = ability.can('void_approval', 'Estimate') && isApproved;
  const canCopyLink = !!estimate.public_token;

  const sc = estimate.send_config;
  // True once a send_config exists, i.e. the deposit has been billed and can no longer move
  // (SendEstimateDialog.tsx:48-51 documents this exact definition; EstimateReceiptCard.tsx:130's
  // `depositSent` is the same predicate). Deliberately not derived from `isSent`/`alreadySent`
  // (status === 'SENT'): a PENDING or WON estimate is equally past its first send.
  const depositFrozen = Boolean(sc);
  // #2091 - QA staging: a resend kept showing the figure billed at first send while the send
  // itself re-priced the still-unpaid deposit invoice to a different one (repriceUnpaidDeposit
  // Invoice). `depositInvoice` (below) already carries `status` and `payments` off the same
  // estimate GET response - no extra fetch needed to tell the dialogs the truth.
  const depositInvoiceUnpaid = depositInvoiceIsUnpaid(depositInvoice);
  // Security round 1 (#2010) finding 1 - the shared deposit editor took no ability check, so a
  // role holding `send Estimate` but not `update Estimate` saw fully editable inputs in Mark Sent
  // and typing into them wedged the action behind a PATCH the backend correctly 403s. Computed
  // once here (the same `ability.can('update', 'Estimate')` `canManageLines` above uses) and
  // ANDed into `useDepositDraft`'s `editable` in both dialogs.
  const canEditDeposit = ability.can('update', 'Estimate');
  const depPayment = depositInvoice?.payments?.[0];
  const depMethod = depPayment?.method ?? null;
  const hasStripePayment = Boolean(depPayment?.stripe_payment_intent_id);
  // An estimate reaches its customer through the lead when it is lead-anchored
  // and through its own direct relation when it is customer-anchored. Read
  // both, in the order the backend's send() and CustomerHeader already use.
  const customer = estimate.lead?.customer ?? estimate.customer ?? null;
  // #1997 — deliberately NOT `?? ''`: `undefined` (the key is entirely ABSENT — the requester
  // cannot read this customer) and `null` (the customer genuinely has no email on file) are two
  // different states SendEstimateDialog must render differently. Collapsing both to '' here would
  // make the dialog treat a real privacy redaction as an editable blank the rep is expected to fill.
  const customerEmail = customer?.email;
  const customerId = (customer as { id?: string } | null)?.id ?? estimate.customer_id ?? null;
  const totalAmount = estimate.total_amount ?? 0;
  const showWaive = canWaiveDeposit && !!depositInvoice && ['DRAFT', 'SENT'].includes(depositInvoice.status);
  const showRefund =
    canRefundDeposit && !!depositInvoice && ['PAID', 'PARTIALLY_REFUNDED'].includes(depositInvoice.status);

  return (
    <div>
      {/* Top bar: back, title, status pill, then the one primary action and the
          Actions menu. */}
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => navigate(v2Path('/estimates'))}
            aria-label="Back to estimates"
          >
            <ArrowLeft />
          </Button>
          <EstimateNameTitle
            estimateId={id!}
            leadId={estimate.lead_id ?? ''}
            name={estimate.name}
            estimateNumber={estimate.estimate_number}
            canEdit={ability.can('update', 'Estimate')}
            numberSlot={
              <RecordNumberEditor
                entity="estimate"
                id={id!}
                number={estimate.estimate_number}
                canEdit={ability.can('renumber', 'Estimate')}
                isDerivedAndLocked={!!estimate.container_kind && !estimate.number_is_custom}
                onRenamed={() => {
                  queryClient.invalidateQueries({ queryKey: ['estimate', id] });
                  queryClient.invalidateQueries({ queryKey: ['estimates'] });
                }}
              />
            }
          />
          <EstimateStatusMenu
            status={status}
            // Spec B1 — no status is terminal any more, so the only thing that
            // makes the pill inert is having no permission to change it at all.
            // `locked` (deposit paid) locks the DOCUMENT, not the lifecycle;
            // unwinding a paid one is refused by the money guard, which explains
            // itself on the row rather than hiding the whole control.
            readOnly={!canSetStatus}
            targets={statusTargets}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {RECORD_PAYMENT_STATUSES.includes(status) && canRecordPayment && (
            <Button onClick={() => setRecordPaymentOpen(true)}>
              Record Payment
            </Button>
          )}

          {/* Two different job links, and both have to be clear before offering
              a conversion: `job` is PROVENANCE (a Job created FROM this
              estimate), `job_id` is the ANCHOR (this estimate was written
              against an existing job). A job-anchored estimate has job_id with
              NO Job pointing back, so gating on `job` alone still offered
              "Create Job" on it - and the backend now 400s that. Gate/reason
              shared with the Actions menu's "Convert to job" item via
              `convertGate` (#2048) - rendered output unchanged. */}
          {convertGate.visible &&
            (convertGate.disabled ? (
              <Button disabled title={convertGate.reason}>
                <Briefcase />
                Create Job
              </Button>
            ) : (
              <Button onClick={() => createJobMutation.mutate()} disabled={createJobMutation.isPending}>
                {createJobMutation.isPending ? <Spinner label={null} /> : <Briefcase />}
                Create Job
              </Button>
            ))}

          {/* Send never disappears: available in every status, gated only on
              !isTerminal. A terminal estimate gets "Send a copy" — same
              endpoint, but the backend skips the status change and timeline
              entry a real (re)send would write. */}
          {canSend && !isTerminal && (
            <Button onClick={() => setSendOpen(true)}>
              <Send />
              {isDraft ? 'Send' : 'Resend'}
            </Button>
          )}
          {/* #2090 ruling 18: SUPERSEDED is the one terminal status with nothing
              left to send - revise() retired its public link, and the send
              endpoint now 400s it. ABSENT rather than disabled, per the repo's
              stated convention for a control with no meaning in the current
              state (see ScopeOfWorkCard). The Superseded banner below already
              carries the rep's next step: the current revision. */}
          {canSend && isTerminal && status !== 'SUPERSEDED' && (
            <Button variant="outline" onClick={() => setSendOpen(true)}>
              <Send />
              Send a copy
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" aria-label="Actions">
                Actions
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* "View job" deliberately does NOT live here: the hero's
                  "Attached to" strip (CustomerHeader) is the one place that
                  names the related record and carries its status. */}
              {standardInvoice && (
                <DropdownMenuItem onClick={() => navigate(preferV2Path(`/invoices/${standardInvoice.id}`))}>
                  <Receipt />
                  View invoice
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setPreviewOpen(true)}>
                <Eye />
                Preview
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleDownloadPdf} disabled={downloading}>
                {downloading ? <Spinner label={null} /> : <Download />}
                Download
              </DropdownMenuItem>
              {canCopyLink && (
                <DropdownMenuItem onClick={handleCopyLink}>
                  <Link2 />
                  {linkCopied ? 'Copied!' : 'Copy Link'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
                <History />
                History
              </DropdownMenuItem>

              {/* Mirrors the header "Create Job" button - same gate, same disabled reason, same
                  mutation (#2048's `convertGate`). Labelled "Convert to job" per the issue; the
                  header button keeps its own pre-existing "Create Job" label (the deliberate
                  asymmetry the frozen test pins). */}
              {convertGate.visible && (
                <DropdownMenuItem
                  disabled={convertGate.disabled}
                  title={convertGate.reason}
                  onClick={() => createJobMutation.mutate()}
                >
                  <Briefcase />
                  Convert to job
                </DropdownMenuItem>
              )}

              {/* Lifecycle verbs. backtodraft/backtosent replace Revise as the
                  same-row correction path; approve-internal / decline-internal
                  record a verbal/off-platform outcome; void-approval is the
                  guarded unwind, admin-only. */}
              {(canMarkSent || canApproveInternal || canDeclineInternal || canBackToDraft || canBackToSent || canVoidApproval) && (
                <DropdownMenuSeparator />
              )}
              {canMarkSent && (
                <DropdownMenuItem onClick={() => setMarkSentOpen(true)}>
                  <FileCheck />
                  Mark Sent
                </DropdownMenuItem>
              )}
              {canApproveInternal && (
                <DropdownMenuItem onClick={confirmApproveInternal}>
                  <ThumbsUp />
                  Approve (Verbal)
                </DropdownMenuItem>
              )}
              {canDeclineInternal && (
                <DropdownMenuItem onClick={() => setDeclineInternalOpen(true)}>
                  <ThumbsDown />
                  Decline
                </DropdownMenuItem>
              )}
              {canBackToDraft && (
                <DropdownMenuItem onClick={confirmRecallToDraft}>
                  <Undo2 />
                  Recall to Draft
                </DropdownMenuItem>
              )}
              {canBackToSent && (
                <DropdownMenuItem
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Move ${estimate.estimate_number} back to Sent?`,
                      confirmLabel: 'Move to Sent',
                    });
                    if (ok) backToSentMutation.mutate();
                  }}
                >
                  <Redo2 />
                  Move back to Sent
                </DropdownMenuItem>
              )}
              {canVoidApproval && (
                <DropdownMenuItem onClick={() => setVoidApprovalOpen(true)} variant="destructive">
                  <ShieldOff />
                  Void Approval
                </DropdownMenuItem>
              )}

              {canCopyToInvoice && <DropdownMenuSeparator />}
              {canCopyToInvoice && (
                <DropdownMenuItem
                  disabled={!!standardInvoice || hasJob || copyToInvoiceMutation.isPending}
                  title={
                    standardInvoice
                      ? `Already copied to Invoice ${standardInvoice.invoice_number}`
                      : hasJob
                        ? 'This estimate already has a Job — invoice through the Job instead'
                        : undefined
                  }
                  onClick={() => copyToInvoiceMutation.mutate()}
                >
                  {copyToInvoiceMutation.isPending ? <Spinner label={null} /> : <Receipt />}
                  Copy to Invoice
                </DropdownMenuItem>
              )}

              {canDuplicate && <DropdownMenuSeparator />}
              {canDuplicate && (
                <DropdownMenuItem onClick={() => setDuplicateOpen(true)}>
                  <Copy />
                  Duplicate
                </DropdownMenuItem>
              )}

              {((canCancelEstimate && (isDraft || isSent)) || (canDeleteEstimate && isDraft)) && (
                <DropdownMenuSeparator />
              )}
              {/* Labelled "Archive"; the internal action id
                  (ability.can('cancel', 'Estimate')) and the grant behind it
                  are UNCHANGED — copy only. */}
              {canCancelEstimate && (isDraft || isSent) && (
                <DropdownMenuItem onClick={() => setCancelOpen(true)} variant="destructive">
                  <Archive />
                  Archive
                </DropdownMenuItem>
              )}
              {canDeleteEstimate && isDraft && (
                <DropdownMenuItem onClick={() => setDeleteConfirmOpen(true)} variant="destructive">
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mb-3">
        <TagInput entityType="ESTIMATE" entityId={id!} tags={estimate.tags ?? []} />
      </div>

      {/* "Modified after send" is a server field, independent of any save-status
          chip: every edit on this page persists immediately through its own
          granular endpoint. Actionable rather than passive — the inline Resend
          is the whole point of surfacing it. */}
      {estimate.modified_after_send && canSend && !isTerminal && (
        <Banner
          tone="warning"
          icon={<Send className="size-4" />}
          action={
            <Button variant="outline" size="sm" onClick={() => setSendOpen(true)}>
              <Send />
              Resend
            </Button>
          }
        >
          This estimate changed since it was last sent — the customer hasn&apos;t seen the update.
        </Banner>
      )}

      {/* Delivery fact, HARD BOUNCE only (slice 5). A hard bounce means the
          address is dead, so this is the one delivery state that must never sit
          as a quiet pill in a list — same actionable shape as the
          modified-after-send banner above, in danger tone. Soft bounces and the
          other delivery states read through the Lead page's Communication tab
          pill instead. */}
      {hardBounced && canSend && !isTerminal && (
        <Banner
          tone="danger"
          icon={<MailWarning className="size-4" />}
          action={
            <Button variant="outline" size="sm" onClick={() => setSendOpen(true)}>
              <Send />
              Resend
            </Button>
          }
        >
          This estimate&apos;s email bounced — the customer likely never received it.
          {estimateSendItem?.deliveryStatusReason && (
            <span className="font-normal opacity-80"> ({estimateSendItem.deliveryStatusReason})</span>
          )}
        </Banner>
      )}

      {locked && (
        <Banner icon={<Lock className="size-4" />}>
          {depositPaid
            ? 'This estimate is locked — the deposit is paid. Recall it to Draft (Actions menu) to make changes.'
            : isSigned
              ? 'This estimate is locked (lock on send is ON for this org) — the customer approved and signed it, but the deposit is still outstanding. Recall it to Draft (Actions menu) to make changes.'
              : 'This estimate is locked (lock on send is ON for this org). Recall it to Draft (Actions menu) to make changes.'}
        </Banner>
      )}

      {status === 'SUPERSEDED' && (
        <Banner icon={<History className="size-4" />}>
          Superseded
          {estimate.superseded_by_id && (
            <Button
              variant="link"
              size="sm"
              onClick={() => navigate(v2Path(`/estimates/${estimate.superseded_by_id}`))}
            >
              view the current revision
            </Button>
          )}
        </Banner>
      )}

      {/* Per-anchor estimate tabs — switch between siblings in the same container, or add
          blank/copy. #2026: this used to be gated on `estimate.lead_id`, so a customer- or
          job-anchored estimate had no way to reach its siblings or to add another. */}
      {tabStripAnchor && id && (
        <div className="mb-4">
          <EstimateTabs anchor={tabStripAnchor} activeEstimateId={id} />
        </div>
      )}

      <div className="mb-4">
        <CustomerHeader estimate={estimate} />
      </div>

      {/* Body: canvas plus the right money rail. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <EstimateScopeOfWorkCard estimate={estimate} canManage={canManageLines} canSeePricing={canSeePricing} />
          <EstimateLineItemsEditor
            estimate={estimate}
            canManage={canManageLines}
            canSeePricing={canSeePricing}
            canSaveToPriceBook={canSaveToPriceBook}
          />
        </div>

        <aside className="lg:sticky lg:top-4 lg:self-start">
          <div className="flex flex-col gap-4">
            <EstimateReceiptCard estimate={estimate} canEditNow={canEditNow} />
            {canSeePricing && (
              <EstimateInternalCostsCard
                estimate={{
                  id: estimate.id,
                  line_items: estimate.line_items ?? [],
                  scopes: estimate.scopes ?? [],
                  labor_hours: estimate.labor_hours,
                  overhead_mode: estimate.overhead_mode,
                  overhead_value: estimate.overhead_value,
                  discountedSubtotal: Number(estimate.subtotal ?? 0) - Number(estimate.discount_amount ?? 0),
                }}
                orgLaborRate={org?.labor_rate ?? 0}
                orgOverheadMode={org?.overhead_mode ?? 'PERCENTAGE'}
                orgOverheadValue={org?.overhead_value ?? 0}
                canEditNow={canEditNow}
              />
            )}
            <EstimateInfoCard
              estimate={estimate}
            />
            {(showWaive || showRefund) && (
              <Card>
                <CardHeader>
                  <CardTitle>Deposit Actions</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {showWaive && (
                    <Button variant="outline" size="sm" onClick={() => setWaiveOpen(true)}>
                      Waive deposit
                    </Button>
                  )}
                  {showRefund && (
                    <Button variant="outline" size="sm" onClick={() => setRefundOpen(true)}>
                      Refund deposit
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
            {id && <NotesCard estimateId={id} />}
          </div>
        </aside>
      </div>

      <SignatureCard
        signatureData={estimate.signature_data}
        signatureAt={estimate.signature_at}
      />

      <div className="mt-4">
        <JobLeadTasksTab entity={{ type: 'ESTIMATE', id: id!, label: estimate.estimate_number }} />
      </div>

      <PdfPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        pdfUrl={`/api/estimates/${id}/pdf`}
        downloadFilename={`Estimate-${estimate.estimate_number}.pdf`}
        title={`Estimate ${estimate.estimate_number}`}
      />
      <MarkSentDialog
        open={markSentOpen}
        onOpenChange={setMarkSentOpen}
        estimateId={id!}
        estimateNumber={estimate.estimate_number}
        totalAmount={totalAmount}
        depositType={estimate.deposit_type ?? null}
        depositValue={estimate.deposit_value ?? null}
        depositFrozen={depositFrozen}
        existingDepositAmount={sc?.deposit_amount ?? null}
        existingDepositPercentage={sc?.deposit_percentage ?? null}
        canEditDeposit={canEditDeposit}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['estimate', id] })}
      />
      <DeclineEstimateInternalDialog
        open={declineInternalOpen}
        onOpenChange={setDeclineInternalOpen}
        estimateId={id!}
        estimateNumber={estimate.estimate_number}
      />
      <VoidApprovalDialog
        open={voidApprovalOpen}
        onOpenChange={setVoidApprovalOpen}
        estimateId={id!}
        estimateNumber={estimate.estimate_number}
        jobNumber={estimate.job?.job_number ?? null}
      />
      <SendEstimateDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        estimateId={id!}
        estimateNumber={estimate.estimate_number}
        totalAmount={totalAmount}
        customerEmail={customerEmail}
        alreadySent={isSent}
        sentAt={estimate.sent_at}
        depositType={estimate.deposit_type ?? null}
        depositValue={estimate.deposit_value ?? null}
        depositFrozen={depositFrozen}
        existingDepositAmount={sc?.deposit_amount ?? null}
        existingDepositPercentage={sc?.deposit_percentage ?? null}
        canEditDeposit={canEditDeposit}
        depositInvoiceUnpaid={depositInvoiceUnpaid}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ['estimate', id] })}
      />
      <RecordEstimatePaymentDialog
        open={recordPaymentOpen}
        onOpenChange={setRecordPaymentOpen}
        estimateId={id!}
        estimateNumber={estimate.estimate_number}
        totalAmount={totalAmount}
        existingDepositAmount={sc?.deposit_amount ?? null}
        existingDepositPercentage={sc?.deposit_percentage ?? null}
      />
      <DuplicateEstimateDialog
        open={duplicateOpen}
        onOpenChange={setDuplicateOpen}
        estimateId={id!}
        currentLeadId={estimate.lead_id ?? null}
        customerId={customerId}
      />
      <CancelEstimateDialog open={cancelOpen} onOpenChange={setCancelOpen} estimateId={id!} />

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogIcon tone="danger">
              <Trash2 />
            </DialogIcon>
            <div className="min-w-0">
              <DialogTitle>Delete this estimate?</DialogTitle>
              <DialogDescription>
                This permanently removes the estimate and its line items. The lead&apos;s other
                estimates are renumbered. This cannot be undone.
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete estimate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {depositInvoice && (
        <>
          <WaiveDepositDialog
            open={waiveOpen}
            onOpenChange={setWaiveOpen}
            estimateId={id!}
            estimateStatus={status}
            paymentMethod={depMethod}
          />
          <RefundDepositDialog
            open={refundOpen}
            onOpenChange={setRefundOpen}
            estimateId={id!}
            depositInvoiceId={depositInvoice.id}
            depositAmount={Number(depositInvoice.total_amount ?? 0)}
            hasStripePayment={hasStripePayment}
          />
        </>
      )}
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} estimateId={id!} />
      {confirmDialog}
    </div>
  );
}
