import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertTriangle, ArrowUpRight, CalendarDays, CalendarPlus, CheckCircle2, ChevronDown,
  ClipboardList, ClipboardX, Copy, FileText, Mail, MapPin, Pencil, Phone, PlusCircle, Receipt,
  RotateCcw, StickyNote, Trash2, User, Wrench, XCircle,
} from 'lucide-react';

import api from '@/lib/axios';
import { useJobVisits } from '@/lib/useJobVisits';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { useVisitLifecycle } from '@/lib/useVisitLifecycle';
import { formatInstant, orgDayDiff, useScheduleTimezone } from '@/lib/schedule-tz';

/**
 * The Completed / Cancelled stamps. These two used to be a bare `toLocaleString()` with no
 * options at all, so they leaked the viewer's LOCALE as well as their zone - J00281's
 * 2026-08-20T17:35:59.488Z read "8/21/2026, 1:35:59 AM" in Manila against "8/20/2026,
 * 1:35:59 PM" on the org clock, a wrong day for any stamp at or after 16:00Z, while the
 * hero and the lifecycle rail on that same screen rendered the org clock (MV-TZ-10).
 */
const COMPLETION_STAMP: Intl.DateTimeFormatOptions = {
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit',
};
import { VisitsCard } from './components/visitsCard';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import { RecordNumberEditor } from '@/components/crm/RecordNumberEditor';
import { useModuleAccess } from '@/lib/entitlements';
import { canOnJob, canSeePricing as canSeePricingAbility, type AppAbility, type AppAction } from '@/lib/ability';
import { useTasksStore } from '@/stores/tasksStore';
import { customerDisplayName } from '@/lib/customer-name';
import { extractApiError, formatCurrency, formatPhone, getInitials } from '@/lib/utils';
import { useOrganization } from '@/lib/api/organization';
import {
  createEstimateFromJobItems, getJobFinancials, getJobTaskSummary, listJobLines,
  listJobScopes, reopenJob, type InvoiceLineItem,
} from '@/lib/api/jobs';
import { fetchStateTaxRates } from '@/lib/api/invoices';
import { useJobMaterialCost } from '@/lib/api/inventory';
import { useJobSubStatuses } from '@/lib/api/jobSubStatuses';
import { servicePlanKeys } from '@/lib/api/service-plans';
import { selectInvoiceSentState } from '@/lib/jobs/invoiceSentState';
import { isPaidOff } from '@/lib/jobs/lifecycle';

// App components with no kit equivalent - reused verbatim, one ledger row each.
import { IconRail } from '@/components/crm/IconRail';
import { InternalCostsCard } from '@/components/crm/InternalCostsCard';
import { TagInput } from '@/components/leads/TagInput';
import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';
import { AssignJobDialog } from '@/components/jobs/AssignJobDialog';
import { AttachEstimateDialog } from '@/components/jobs/AttachEstimateDialog';
import { CancelJobDialog } from '@/components/jobs/CancelJobDialog';
import { EditJobLocationDialog } from '@/components/jobs/EditJobLocationDialog';
import { JobLifecycleBar } from '@/components/jobs/JobLifecycleBar';
import { JobStagesSection } from '@/components/jobs/JobStagesSection';
import { PaymentsTab } from '@/components/jobs/PaymentsTab';
import { TeamCard } from '@/components/jobs/TeamCard';
import { ViewWorkOrderDialog } from '@/components/jobs/ViewWorkOrderDialog';
import { AiInsightsCard } from '@/components/jobs/AiInsightsCard';
import { AiJobAssistantBar } from '@/components/jobs/AiJobAssistantBar';
import { LineItemsEditor, JobScopeOfWorkCard } from '@/components/jobs/items/LineItemsEditor';
import { ReceiptCard } from '@/components/jobs/items/ReceiptCard';
import { CustomerContactCard } from '@/components/jobs/overview/CustomerContactCard';
import { JobFilesCard } from '@/components/jobs/overview/JobFilesCard';
import { JobNotesPreview } from '@/components/jobs/overview/JobNotesPreview';
import { CreateJobInvoiceDialog } from '@/components/invoices/CreateJobInvoiceDialog';
import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';
// The attachments body is a NAMED EXPORT of the legacy page, imported rather
// than re-authored: its tiles need raw <a>, <img>, <input type="file"> and
// <label> elements, and the design-system raw-tag ratchet sits at its floor for
// all four, so a v2 page may not add one. Same precedent
// `pages/v2/customers/CustomerFormPage.tsx` set by importing `customerSchema`
// from the legacy page. Ledger row.
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';
import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Progress } from '@/ui-kit/components/ui/progress';
import { Separator } from '@/ui-kit/components/ui/separator';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { toast } from '@/ui-kit/components/ui/sonner';
import { cn } from '@/ui-kit/lib/utils';

import { preferV2Path } from '../uiV2';
// The logistic-order list the Logistics tab mounts. It was the LEGACY
// `components/inventory/lo/LOList` until the rebuilt copy was promoted out of
// `pages/v2/inventory/` - this page cannot import a module folder, and mounting
// the legacy one put legacy chrome inside a v2 page.
import { LOList } from '../_shared/loList';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { StatusChip } from './components/statusChip';
import { useRecordVisit } from '../pageBreadcrumbs';

// --- Types (the legacy page's, verbatim) -------------------------------------

interface EstimateLineItem {
  id: string;
  sequence: number;
  description: string;
  quantity: number;
  unit_price: number;
  is_taxable: boolean;
  line_total: number;
  item_type?: string;
}

interface LeadWalkthrough {
  id: string;
  lead_number: string;
  status: string;
  walkthrough_scheduled_at: string | null;
  walkthrough_completed_at: string | null;
  walkthrough_notes: string | null;
  commission_owner?: { id: string; first_name: string; last_name: string; phone?: string | null; email?: string | null; role?: string | null; department?: { name?: string | null } | null } | null;
  walkthrough_performers: { user: { id: string; first_name: string; last_name: string } }[];
}

interface JobDetail {
  id: string;
  job_number: string;
  status: string;
  sub_status?: { id: string; label: string; parent: string } | null;
  job_type?: string | null;
  amount_invoiced?: number | string;
  scope_notes: string | null;
  estimated_duration: number | null;
  completion_notes: string | null;
  // S8 (RATIFIED, A5): scheduled_start/scheduled_end/is_all_day are DERIVED - the backend
  // computes them off `job.visits[]` (the next upcoming live visit, falling back to the
  // earliest non-cancelled one) rather than storing them; they are no longer authoritative.
  // New code on this page should read `job.visits[]` directly - see visitsCard.tsx. Kept here
  // for the existing hero tile / lifecycle bar reads (job-schedule-projection.ts on the backend).
  scheduled_start: string | null;
  scheduled_end: string | null;
  is_all_day?: boolean;
  started_at: string | null;
  // on_site_at DROPPED (S8): the backend job row no longer carries it and nothing on this page
  // ever read it - the visit's own on_site_at (visitsCard.tsx) is the only place this fact lives.
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
  updated_at: string;
  signature_at: string | null;
  dispatcher?: { id: string; first_name: string; last_name: string; phone?: string | null; email?: string | null; role?: string | null; department?: { name?: string | null } | null } | null;
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    company_name: string | null;
    email: string | null;
    phone: string;
  };
  assignees: { user: { id: string; first_name: string; last_name: string; phone?: string | null; email?: string | null; role?: string | null; department?: { name?: string | null } | null } }[];
  service_location: {
    id: string;
    address_line1: string;
    address_line2: string | null;
    city: string;
    state: string;
    zip: string;
  } | null;
  estimate: {
    id: string;
    estimate_number: string;
    total_amount: number | string;
    status: string;
    lead_id: string | null;
    lead: LeadWalkthrough | null;
    deposit: { id: string; amount: number | string; status: string; paid_at: string | null } | null;
    line_items: EstimateLineItem[];
  } | null;
  invoices: Array<{ id: string; invoice_number: string; status: string; total_amount: number | string; amount_due: number | string; created_at: string }>;
  linked_estimates?: Array<{ id: string; estimate_number: string; total_amount?: number | string; status: string }>;
  tags: Array<{ id: string; name: string; color: string }>;
  source_plan_id: string | null;
  source_plan: { id: string; service_plan_number: string; name: string } | null;
  labor_hours?: number | string | null;
  overhead_mode?: 'PERCENTAGE' | 'FIXED' | null;
  overhead_value?: number | string | null;
}

interface NoteItem {
  id: string;
  content: string;
  created_at: string;
  creator: { id: string; first_name: string; last_name: string };
  source?: string | null;
}

// --- Helpers (the legacy page's, verbatim) -----------------------------------

/**
 * Ability gates WHO; status gates WHEN. Spec B1 removes the status half - these
 * conditions are carried over exactly as they are so the two specs stay
 * separable.
 *
 * Role strings are deliberately absent: a technician's authority comes from the
 * same CASL rules the API enforces. Use `canOnJob`, never
 * `ability.can(verb, jobInstance)` - the server's own-job condition uses a
 * Prisma `some` operator the Mongo/sift matcher cannot evaluate, so the instance
 * form returns false for every technician.
 */
function getAvailableActions(
  job: JobDetail,
  ability: AppAbility,
  userId: string,
  // Multi-visit S8: the stored OWN_JOB row scope is a `visits` clause, so the client cannot
  // answer "is this mine" from the job payload alone. useJobVisits(id) is already in hand on
  // this page - passing its rows here is what keeps the technician's controls on screen.
  visits: { assignees?: { user_id: string }[] | null }[],
) {
  const on = (verb: AppAction) => canOnJob(ability, verb, { ...job, visits }, userId);

  return {
    canAssign: on('assign'),
    // Multi-visit S2: the Visits tab's own gate. `on(...)`, never ability.can - the subject-level
    // form is true for EVERY job in the org once a technician holds the per-user "Reschedule own
    // jobs" capability, so the visit dialog would open on a job whose POST canActOnRow then 403s.
    canReschedule: on('reschedule'),
    canUnassign: on('unassign'),
    canStart: on('start'),
    // S4 (D7a): the per-visit action row gates EACH button on the ability ITS route asks for. The
    // four routes do not share one: en-route has its own verb, which the default TECHNICIAN role
    // does not hold, and complete rides `start Job`. Handing the card a single flag offered every
    // crewed technician an "En route" button that could only ever 403.
    visitAbilities: { en_route: on('en_route'), arrive: on('arrive'), start: on('start') },
    // Self-exclusion, not an ordering rule: re-completing a complete job would
    // re-stamp completed_at and re-arm the follow-up automation for nothing.
    canComplete: on('complete') && job.status !== 'COMPLETED',
    // Self-exclusion, not an ordering rule.
    canCancel: on('cancel') && job.status !== 'CANCELLED',
    // Integrity: matches the backend delete guard, which blocks on ANY invoice
    // regardless of status.
    canDelete: on('delete') && job.invoices.length === 0,
    canReopen: ability.can('reopen', 'Job') && job.status === 'COMPLETED',
    canDuplicate: ability.can('create', 'Job'),
    canAddNotes: on('update'),
    // The money surface follows CREATION, not assignment. Same per-instance
    // question the backend asks with canActOnRow(..., 'manage_lines'), so the
    // buttons and the API agree.
    canManageLines: on('manage_lines'),
    // SRVW-112 - the same `update Job` gate the API puts on the sub-status door.
    canSetSubStatus: on('update'),
    // Service-plan visit-jobs were paid upfront via the plan's kind=PLAN
    // invoice; invoicing the spawned visit would double-charge, and the backend
    // blocks it too.
    canCreateInvoice: ability.can('create', 'Invoice') && job.status !== 'CANCELLED' && !job.source_plan_id,
  };
}

/**
 * Relative schedule hint: "Today", "Tomorrow", "in N days", or a date string.
 *
 * Measured on the ORG clock via orgDayDiff, not with local-Date arithmetic: raw instant
 * subtraction measures elapsed hours (11pm to 1am reads "0 days" though the date changed) and is
 * an hour out on the two DST days a year.
 */
function scheduleHint(dateStr: string, tz: string): string {
  const dayDiff = orgDayDiff(dateStr, tz);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Tomorrow';
  if (dayDiff > 1) return `in ${dayDiff} days`;
  return formatInstant(dateStr, tz, { month: 'short', day: 'numeric', year: 'numeric' });
}

function toNum(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isNaN(n) ? 0 : n;
}

/**
 * `PARTIALLY_PAID` -> `Partially paid`. The legacy page rendered the lowercased
 * value under a `capitalize` class; the class is an appearance token handed to
 * Badge, and that ratchet is at its floor, so the same transform happens here.
 */
function sentenceCase(value: string): string {
  const words = value.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Net-of-line-discount revenue for one job line - mirrors InternalCostsCard's own `netOf`. */
function netOf(line: InvoiceLineItem): number {
  return Math.max(0, toNum(line.line_total) - toNum(line.discount_amount));
}


/** Small uppercase caption - the legacy `SectionLabel`, on kit tokens. */
function Caption({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground mb-1 text-[10px] font-semibold uppercase tracking-widest">
      {children}
    </p>
  );
}

// --- Notes tab ---------------------------------------------------------------

/**
 * The notes composer and feed.
 *
 * Re-authored on kit primitives rather than imported, unlike the attachments
 * body: its only raw element was a `<textarea>`, which the kit's Textarea
 * replaces one-for-one. The mutation, its invalidation pair, the Cmd/Ctrl+Enter
 * submit and the newest-first sort are the legacy component's, unchanged.
 */
function NotesTabBody({
  jobId,
  notes,
  canAddNotes,
}: {
  jobId: string;
  notes: NoteItem[] | undefined;
  /** `update Job` - the API gate on POST /api/jobs/:id/notes. Without it the tab is
   *  read-only rather than absent: the history still reads, and no composer is offered
   *  whose submit the API is guaranteed to reject. */
  canAddNotes: boolean;
}) {
  const queryClient = useQueryClient();
  const [noteContent, setNoteContent] = useState('');

  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const { data } = await api.post(`/api/jobs/${jobId}/notes`, { content });
      return data.note;
    },
    onSuccess: () => {
      setNoteContent('');
      queryClient.invalidateQueries({ queryKey: ['job-notes-wt', jobId] });
      queryClient.invalidateQueries({ queryKey: ['notes', 'JOB', jobId] });
    },
  });

  const allNotes = [...(notes ?? [])].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  return (
    <div className="flex flex-col gap-4 p-5">
      {/* Composer - only for users the API will actually accept a note from. */}
      {canAddNotes && (
      <Card>
        <CardHeader>
          <CardTitle>Add note</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Textarea
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'Enter' &&
                noteContent.trim() &&
                !addNoteMutation.isPending
              ) {
                e.preventDefault();
                addNoteMutation.mutate(noteContent.trim());
              }
            }}
            placeholder="Write a note..."
            rows={3}
            aria-label="Note"
          />
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-[11px]">Cmd + Enter to add</span>
            <Button
              size="sm"
              disabled={!noteContent.trim() || addNoteMutation.isPending}
              onClick={() => addNoteMutation.mutate(noteContent.trim())}
            >
              {addNoteMutation.isPending ? 'Adding...' : 'Add Note'}
            </Button>
          </div>
          {addNoteMutation.error && <p className="text-destructive text-xs">Failed to add note</p>}
        </CardContent>
      </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Notes <span className="text-muted-foreground font-normal">({allNotes.length})</span>
          </CardTitle>
        </CardHeader>
        {allNotes.length === 0 ? (
          <EmptyState icon={<StickyNote />} title="No notes yet" />
        ) : (
          <div className="divide-y border-t">
            {allNotes.map((note) => (
              <div key={note.id} className="flex gap-3 px-5 py-4">
                <span className="bg-brand-subtle text-brand-emphasis mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold">
                  {getInitials(`${note.creator.first_name} ${note.creator.last_name}`)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-[13px] font-semibold">
                      {note.creator.first_name} {note.creator.last_name}
                    </span>
                    {note.source === 'LEAD' && (
                      <Badge variant="softBlue" size="pill">From Lead</Badge>
                    )}
                    <span className="text-muted-foreground ms-auto whitespace-nowrap text-[11px]">
                      {formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                    {note.content}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// --- Page --------------------------------------------------------------------

/**
 * /v2/jobs/:id - the job command center on the CRM UI kit.
 *
 * Every query key, mutation, invalidation set and permission expression below is
 * `pages/JobDetailPage.tsx`'s, carried over verbatim. What changed is the
 * chrome: the header card, the tab strip, the buttons, badges, menus, skeleton
 * and empty states are kit components, and the native `window.confirm` delete
 * became the kit's ConfirmDialog (the legacy page had already made that move to
 * the app's own ConfirmDialog).
 *
 * The heavy children - the lifecycle bar, the team/contact/insight cards, the
 * items editor, the payments tab, every dialog - are app components with no kit
 * equivalent and are mounted unchanged. Each has a ledger row.
 *
 * Job status is UNORDERED (Spec B1): any milestone is reachable from any other,
 * forward or backward, and cancel is not terminal. The only blocks are the
 * integrity rules listed on `getAvailableActions`.
 */
export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const ability = useAppAbility();
  // Cost/margin visibility for <InternalCostsCard> - shared with the backend's
  // canSeePricing gate (SRVW-140).
  const canSeePricing = canSeePricingAbility(ability);
  // D15 - the material-cost endpoint 403s without read PurchaseOrder. Module
  // access, not ability.can: inv-po.routes also carries requireFeature
  // ('inventory'), and CASL alone lets an admin on a sub-Scale plan through, and
  // the fetch then 402s.
  const canReadPO = useModuleAccess('inventory', 'read', 'PurchaseOrder');
  // Logistics (Logistic Orders + job stages) is entirely inventory-module surface.
  const canUseInventory = useModuleAccess('inventory', 'read', 'Inventory');

  // Tab state is CONTROLLED so CustomerContactCard's "View All" can switch to
  // the Communication tab. It is not reflected in the URL, exactly as today.
  const [activeTab, setActiveTab] = useState('overview');

  const [assignOpen, setAssignOpen] = useState(false);
  // Drives AssignJobDialog's copy: 'assign' from the crew-focused triggers (Actions >
  // Assign, TeamCard), 'schedule' from the date/time-focused ones (Actions > Schedule
  // Job/Reschedule, the schedule tile, the timeline node) - same dialog body either way.
  const [assignMode, setAssignMode] = useState<'assign' | 'schedule'>('assign');
  const openAssignDialog = (mode: 'assign' | 'schedule') => { setAssignMode(mode); setAssignOpen(true); };
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [editLocationOpen, setEditLocationOpen] = useState(false);
  const [createInvoiceOpen, setCreateInvoiceOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  // The header's New Task creates outside the Tasks tab; closing it re-reads the tab's list.
  const [tasksRefreshKey, setTasksRefreshKey] = useState(0);
  const [workOrderOpen, setWorkOrderOpen] = useState(false);
  const [editingServiceType, setEditingServiceType] = useState(false);
  const [invoiceSentOpen, setInvoiceSentOpen] = useState(false);
  const [attachEstimateOpen, setAttachEstimateOpen] = useState(false);
  const [paymentReceivedOpen, setPaymentReceivedOpen] = useState(false);
  const { data: org } = useOrganization();

  // --- Queries ---------------------------------------------------------------

  const { data: job, isLoading } = useQuery({
    queryKey: ['job', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/jobs/${id}`);
      return data.job as JobDetail;
    },
  });

  useRecordVisit('jobs', job?.job_number);

  // Multi-visit S2: its own query key rather than a field on the job payload - jobDetailSelect is
  // shared by getById and roughly ten action handlers, so one addition there changes every one of
  // those responses at once.
  const jobVisits = useJobVisits(id);
  const scheduleTz = useScheduleTimezone();
  // S5 (D11): the rail's per-visit controls ride the SAME hook the Visits card uses, so the two
  // renderers cannot drift on which URL a control posts to or what a success invalidates.
  // Routing through it is not stylistic: lib/axios.ts's interceptor handles 401 and 402 and not
  // 403, so a hand-rolled post fails silently and the control merely looks dead.
  const visitLifecycle = useVisitLifecycle(id);

  const { data: financials } = useQuery({
    queryKey: ['job-financials', id],
    queryFn: () => getJobFinancials(id!),
    enabled: !!id,
  });

  const { data: taskSummary } = useQuery({
    queryKey: ['job-task-summary', id],
    queryFn: () => getJobTaskSummary(id!),
    enabled: !!id,
  });

  // SERV10X-38: job-owned line items + the running billing preview. Shares its
  // queryKey with LineItemsEditor's own fetch, so mounting both issues one request.
  const { data: jobLineItemsData } = useQuery({
    queryKey: ['job-line-items', id],
    queryFn: () => listJobLines(id!),
    enabled: !!id,
  });

  const billableLineCount = jobLineItemsData?.lines?.length ?? 0;
  const invoiceSent = selectInvoiceSentState(financials, billableLineCount);
  // Once the job is fully paid off, Payment Received must stop being clickable -
  // there is no "view" action for it, so leaving it live only invites an
  // accidental extra payment.
  const jobPaidOff = isPaidOff(financials);
  // Conservative deposit check: a paid DEPOSIT invoice means credit may still be
  // unspent, and the composite create-then-pay path would consume it.
  const hasUnspentDeposit = (financials?.invoices ?? []).some(
    (i) => i.kind === 'DEPOSIT' && i.status === 'PAID',
  );

  // Scope-of-work blocks for InternalCostsCard's cost/margin rollup. Shares its
  // queryKey with JobScopeOfWorkCard's own fetch.
  const { data: jobScopesData } = useQuery({
    queryKey: ['job-scopes', id],
    queryFn: () => listJobScopes(id!),
    enabled: !!id,
  });

  // D15 - PO material actuals for InternalCostsCard's additive display row.
  const { data: materialCost } = useJobMaterialCost(id, canSeePricing && canReadPO);

  // Jurisdiction names for the Items tab's read-only Tax rate row. The row is not
  // editable here - the job's rate follows its estimate (D1) - but it still NAMES
  // the state, because several states share a rate.
  const { data: jobTaxRates = [] } = useQuery({
    queryKey: ['state-tax-rates'],
    queryFn: fetchStateTaxRates,
    enabled: canSeePricing,
    staleTime: 60 * 60 * 1000,
  });

  // Invalidate job-task-summary after any task mutation. The fingerprint is a
  // STRING, not an array: `.filter()` returns a new reference every render and an
  // identity comparison would loop forever. The first render is skipped.
  const jobTasksFingerprint = useTasksStore((s) =>
    s.tasks
      .filter((t) => t.linked_entity?.id === id)
      .map((t) => `${t.id}:${t.status}:${t.updated_at}`)
      .sort()
      .join(','),
  );
  const prevFingerprintRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevFingerprintRef.current === undefined) {
      prevFingerprintRef.current = jobTasksFingerprint;
      return;
    }
    if (prevFingerprintRef.current !== jobTasksFingerprint && id) {
      queryClient.invalidateQueries({ queryKey: ['job-task-summary', id] });
    }
    prevFingerprintRef.current = jobTasksFingerprint;
  }, [jobTasksFingerprint, id, queryClient]);

  // Attachments (with walkthrough) for JobFilesCard, AiInsightsCard and the tab.
  const { data: attachmentsData } = useQuery({
    queryKey: ['job-attachments-wt', id],
    queryFn: () =>
      api
        .get(`/api/attachments/JOB/${id}?include_lead=true`)
        .then((r) => r.data.attachments as Array<{ id: string; file_name: string; file_url: string; file_type: string; display_name: string; description?: string | null; context?: string | null; source?: string | null }>),
    enabled: !!id,
  });

  // Notes (with walkthrough) for JobNotesPreview and the Notes tab.
  const { data: notesData } = useQuery({
    queryKey: ['job-notes-wt', id],
    queryFn: () =>
      api
        .get(`/api/jobs/${id}/notes?include_lead=true`)
        .then((r) => r.data.notes as NoteItem[]),
    enabled: !!id,
  });

  // SRVW-112 - the org's sub-status catalog. Called unconditionally (hook rules);
  // the header filters it to the labels parented to this job's CURRENT status.
  const { data: subStatuses } = useJobSubStatuses();

  // --- Mutations -------------------------------------------------------------

  // This page's own derived data, which any write on the job can change.
  const invalidatePageData = () => {
    queryClient.invalidateQueries({ queryKey: ['job-task-summary', id] });
    queryClient.invalidateQueries({ queryKey: servicePlanKeys.bucket });
    queryClient.invalidateQueries({ queryKey: ['job-financials', id] });
    queryClient.invalidateQueries({ queryKey: ['job-line-items', id] });
  };

  // A write that is NOT a visit write (an invoice created, a payment recorded): the job, the jobs
  // list, the timeline and this page's data - never the scheduler board or the visit list.
  const invalidateJob = () => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['job-timeline', id] });
    invalidatePageData();
  };

  // The job-level verbs (start, complete, reopen) write the job's VISITS underneath them, so the
  // job, its visits, the board and the customer page refresh through the shared visit-write
  // helper, plus this page's own data.
  const refreshAfterJobVerb = () => {
    if (id) refreshAfterVisitWrite(queryClient, { jobId: id });
    invalidatePageData();
  };

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await api.delete(`/api/jobs/${id}`);
    },
    onSuccess: () => {
      // The job and every visit on it leave the board and the customer page; the job's own
      // queries are dropped rather than refetched (they would 404).
      if (id) refreshAfterVisitWrite(queryClient, { jobId: id }, { deleted: true });
      navigate(preferV2Path('/jobs'));
    },
  });

  const reopenMutation = useMutation({
    mutationFn: async () => reopenJob(id!),
    onSuccess: refreshAfterJobVerb,
  });

  // One-click close-out - no completion-note modal (a note is not required).
  const completeMutation = useMutation({
    mutationFn: async () => api.post(`/api/jobs/${id}/complete`),
    onSuccess: () => { refreshAfterJobVerb(); },
    onError: (err) => {
      toast.error(extractApiError(err, 'Failed to complete job'));
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => api.post(`/api/jobs/${id}/start`),
    onSuccess: refreshAfterJobVerb,
    onError: (err) => {
      toast.error(extractApiError(err, 'Failed to start job'));
    },
  });

  // Navigate to a freshly-created invoice, carrying the job breadcrumb trail.
  const goToInvoice = (invoiceId: string) => {
    queryClient.invalidateQueries({ queryKey: ['job', id] });
    navigate(preferV2Path(`/invoices/${invoiceId}`), {
      state: {
        breadcrumbs: [
          { label: 'Jobs', href: preferV2Path('/jobs') },
          { label: job!.job_number, href: preferV2Path(`/jobs/${id}`) },
        ],
      },
    });
  };

  const duplicateMutation = useMutation({
    mutationFn: () => api.post(`/api/jobs/${id}/duplicate`).then((r) => r.data),
    onSuccess: (data: { job: { id: string } }) => {
      refreshAfterVisitWrite(queryClient, { jobId: data.job.id });
      navigate(preferV2Path(`/jobs/${data.job.id}`));
    },
    onError: (err) => {
      toast.error(extractApiError(err, 'Failed to duplicate job'));
    },
  });

  const updateJobTypeMutation = useMutation({
    mutationFn: (job_type: string) => api.patch(`/api/jobs/${id}`, { job_type }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      setEditingServiceType(false);
    },
    onError: (err) => {
      toast.error(extractApiError(err, 'Failed to update service type'));
    },
  });

  // SRVW-112 - set or clear the sub-status. Its own door (POST /:id/sub-status).
  const subStatusMutation = useMutation({
    mutationFn: (sub_status_id: string | null) =>
      api.post(`/api/jobs/${id}/sub-status`, { sub_status_id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job', id] }),
    onError: (err) => {
      toast.error(extractApiError(err, 'Failed to set sub-status'));
    },
  });

  // R3b - cost model (D2/D8). Same PATCH shape as updateJobTypeMutation.
  const costMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/jobs/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job', id] }),
    onError: (err) => {
      toast.error(extractApiError(err, 'Could not save'));
    },
  });

  // SERV10X-60 Part B - copies the job's OWN line items/scopes into a NEW
  // job-anchored estimate; tax/discount are server-derived, so no dialog input.
  const createEstimateMutation = useMutation({
    mutationFn: () => createEstimateFromJobItems(id!),
    onSuccess: ({ estimate }) => {
      queryClient.invalidateQueries({ queryKey: ['job', id] });
      toast(`Estimate ${estimate.estimate_number} created`);
      navigate(preferV2Path(`/estimates/${estimate.id}`));
    },
    onError: (err) => {
      toast.error(extractApiError(err, 'Failed to create estimate'));
    },
  });

  // --- Loading / not-found ---------------------------------------------------

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-48" />
        <Card>
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-7 w-40" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                </div>
                <Skeleton className="h-4 w-64" />
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-9 w-28" />
                <Skeleton className="h-9 w-24" />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[104px]" />
              ))}
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex gap-4 border-b px-4 py-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-16" />
            ))}
          </div>
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  // One branch for 404, 403 and network failure alike, exactly as today.
  if (!job) {
    return (
      <Card>
        <EmptyState icon={<ClipboardX />} title="Job not found" />
      </Card>
    );
  }

  const actions = getAvailableActions(job, ability, user?.id || '', jobVisits.visits);

  // SRVW-112 - only labels parented to the CURRENT status are offerable; the API
  // 400s a mismatch.
  const subStatusOptions = (subStatuses ?? []).filter((s) => s.parent === job.status);

  // Service-location and service-type edits: managers only. This is the only raw
  // ROLE check on the page, carried over verbatim.
  const canEditLocation = user?.role === 'ADMIN' || user?.role === 'DISPATCHER';
  const canEditServiceType = user?.role === 'ADMIN' || user?.role === 'DISPATCHER';

  // View Work Order is the backing estimate document - gated so no user 403s.
  const canViewWorkOrder = Boolean(job.estimate) && ability.can('read', 'Estimate');

  // Amount-invoiced vs the estimate total (un-billed remaining).
  const estimateTotal = job.estimate ? Number(job.estimate.total_amount) : 0;
  const amountInvoiced = Number(job.amount_invoiced ?? 0);
  const remainingUnbilled = Math.max(estimateTotal - amountInvoiced, 0);
  void remainingUnbilled; // referenced by C6

  // SRVW-96 - `linked_estimates` includes the job anchor; dedupe against the
  // provenance `job.estimate`, which renders in its own card.
  const attachedEstimates = (job.linked_estimates ?? []).filter((e) => e.id !== job.estimate?.id);

  // D1: the Items tab's tax/discount follow this SAME estimate - just for the
  // helper text, since the figures come server-authoritative from the billing.
  const jobTaxSourceEstimate = job.estimate ?? job.linked_estimates?.[0] ?? null;

  const customerName = customerDisplayName(job.customer);
  const loc = job.service_location;

  // SRVW-96 - an estimate-anchored job (jobs.estimate_id NULL, Estimate.job_id
  // set by the R6 EstimateJobLink attachment) has no `job.estimate`, so without
  // this third arm the masthead reported "No contract yet" on a job that plainly
  // had one, with no balance, no contract figure and 0% collected. Conversion can
  // attach several estimates that together make up the one contract, so the live
  // ones are summed; the dead statuses are excluded rather than counted, which is
  // what makes a superseded attachment fall back to "No contract yet" for real
  // instead of by never looking.
  const DEAD_ESTIMATE_STATUSES = ['DECLINED', 'EXPIRED', 'ARCHIVED', 'SUPERSEDED'];
  const attachedContractValue = (() => {
    const live = attachedEstimates.filter((e) => !DEAD_ESTIMATE_STATUSES.includes(e.status));
    if (!live.length) return null;
    return live.reduce((sum, e) => sum + Number(e.total_amount ?? 0), 0);
  })();

  const financialsTotal =
    financials?.final_invoice != null
      ? Number(financials.final_invoice.total_amount)
      : job.estimate != null
        ? Number(job.estimate.total_amount)
        : attachedContractValue;

  const serviceAddressLine = loc
    ? [loc.address_line1, loc.city && loc.state ? `${loc.city}, ${loc.state} ${loc.zip}` : '']
        .filter(Boolean)
        .join(', ')
    : null;

  // Money summary - all derived from real financials. Contract = final-invoice
  // total or estimate total; paid = sum of recorded payments; deposit = payments
  // applied to a DEPOSIT-kind invoice.
  const contractValue = financialsTotal;
  const jobPayments = financials?.payments ?? [];
  // #948 - exclude the synthetic DEPOSIT-CREDIT mirror payment a deposit's
  // drawdown writes on the STANDARD invoice: same cash, not new money.
  const totalPaid = jobPayments
    .filter((p) => p.reference_number !== 'DEPOSIT-CREDIT')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const depositPaid = jobPayments
    .filter((p) => p.invoice_kind === 'DEPOSIT')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const balanceDue = contractValue != null ? Math.max(contractValue - totalPaid, 0) : null;
  const pctCollected =
    contractValue && contractValue > 0
      ? Math.min(Math.round((totalPaid / contractValue) * 100), 100)
      : 0;
  const isPlanVisit = !!job.source_plan;



  // Schedule tile content - authored once, worn by both the static and the
  // click-to-reschedule wrappers.
  // Spans, not divs and paragraphs: this same tree is rendered inside a kit
  // Button on the reschedulable branch, and a button may only contain phrasing
  // content.
  const scheduleTileInner = (
    <>
      <span className="mb-1.5 flex items-center gap-2">
        <span className="bg-muted text-muted-foreground flex size-7 items-center justify-center rounded-full">
          <CalendarDays className="size-3.5" />
        </span>
        <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">
          {/* D14a: the tile describes the NEXT upcoming visit. Job.scheduled_start IS that visit
              by D14's write-through mirror, which is precisely why the hero needs no new payload. */}
          Next Visit
        </span>
      </span>
      <span className="block text-[15px] font-bold leading-snug">
        {/* ORG clock, not the browser's: the visit list one tab away renders the same instants
            through formatInstant, and two contradictory times on one screen is worse than either. */}
        {job.scheduled_start ? formatInstant(job.scheduled_start, scheduleTz) : 'Not scheduled'}
      </span>
      {job.scheduled_start && (
        <span className="text-muted-foreground block text-xs">{scheduleHint(job.scheduled_start, scheduleTz)}</span>
      )}
    </>
  );

  // canComplete is deliberately absent: Mark Complete renders in the header
  // cluster, so on its own it must not conjure an otherwise-empty Actions menu.
  const overflowMenuHasItems =
    actions.canDuplicate || actions.canReopen || actions.canCancel || actions.canDelete ||
    actions.canAssign || canViewWorkOrder;

  return (
    <IconRail entityType="JOB" entityId={id!} panels={['activity']}>
      <div className="flex flex-col gap-4">

        {/* --- Command centre header ------------------------------------- */}
        <Card>
          <div className="flex flex-col gap-4 p-5">
            {/* Identity + action cluster */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {/* role/aria-level rather than an h1: the raw-tag ratchet sits
                      at its floor for headings and a v2 page may not add one.
                      The accessible heading is preserved. */}
                  <span
                    role="heading"
                    aria-level={1}
                    className="flex min-w-0 items-baseline gap-x-2 text-[23px] font-bold tracking-[-0.032em]"
                  >
                    <span className="shrink-0">
                      <RecordNumberEditor
                        entity="job"
                        id={id!}
                        number={job.job_number}
                        canEdit={ability.can('renumber', 'Job')}
                        onRenamed={() => queryClient.invalidateQueries({ queryKey: ['job', id] })}
                      />
                    </span>
                    <span aria-hidden="true" className="text-subtle-foreground shrink-0">·</span>
                    <Link
                      to={preferV2Path(`/customers/${job.customer.id}`)}
                      className="max-w-full truncate hover:underline"
                    >
                      {customerName}
                    </Link>
                  </span>
                  <StatusChip domain="job" status={job.status} />
                  {/* SRVW-112 - the sub-status sits BESIDE the parent badge. */}
                  {actions.canSetSubStatus && subStatusOptions.length > 0 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs">
                          {job.sub_status?.label ?? 'Set sub-status'}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        {subStatusOptions.map((option) => (
                          <DropdownMenuItem
                            key={option.id}
                            onClick={() => subStatusMutation.mutate(option.id)}
                          >
                            {option.label}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => subStatusMutation.mutate(null)}>
                          None
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : job.sub_status ? (
                    <Badge variant="softNeutral" size="sm">{job.sub_status.label}</Badge>
                  ) : null}
                  {job.source_plan && (
                    <Badge
                      variant="softGreen"
                      size="sm"
                      title="This job is a service-plan visit - the plan was billed upfront, so it is non-billable."
                    >
                      Plan Visit
                    </Badge>
                  )}
                </div>
                {job.customer.company_name && (
                  <p className="text-muted-foreground mt-0.5 truncate text-[13px]">
                    {job.customer.company_name}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <Button onClick={() => setNewTaskOpen(true)}>
                  <PlusCircle /> New Task
                </Button>
                {actions.canCreateInvoice && (
                  <Button onClick={() => setCreateInvoiceOpen(true)}>
                    <Receipt /> Create Invoice
                  </Button>
                )}
                {/* Mark Complete is a first-class header control, NOT an overflow
                    item. R2 consolidated it into the Actions menu and a technician
                    in the field reported the job as impossible to close, having
                    failed to find the one control the whole visit ends with; #718
                    pulled it back out. That fix was made on the unrouted v1 page,
                    so this fork shipped the buried version to every user. Keep it
                    here. */}
                {actions.canComplete && (
                  <Button
                    onClick={() => completeMutation.mutate()}
                    disabled={completeMutation.isPending}
                  >
                    <CheckCircle2 /> Mark Complete
                  </Button>
                )}
                {overflowMenuHasItems && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      {/* No aria-label: the legacy trigger's accessible name is
                          its own text, "Actions", and that name is the selector
                          surface. */}
                      <Button variant="outline">
                        Actions <ChevronDown />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {actions.canAssign && (
                        <DropdownMenuItem onClick={() => openAssignDialog('assign')}>
                          <User /> Assign
                        </DropdownMenuItem>
                      )}
                      {actions.canAssign && (
                        <DropdownMenuItem onClick={() => openAssignDialog('schedule')}>
                          {job.scheduled_start
                            ? <><CalendarDays /> Reschedule</>
                            : <><CalendarPlus /> Schedule Job</>}
                        </DropdownMenuItem>
                      )}
                      {canViewWorkOrder && (
                        <DropdownMenuItem onClick={() => setWorkOrderOpen(true)}>
                          <FileText /> View Work Order
                        </DropdownMenuItem>
                      )}

                      {(actions.canAssign || canViewWorkOrder) &&
                        (actions.canDuplicate || actions.canReopen) && <DropdownMenuSeparator />}

                      {actions.canDuplicate && (
                        <DropdownMenuItem
                          onClick={() => duplicateMutation.mutate()}
                          disabled={duplicateMutation.isPending}
                        >
                          <Copy /> Duplicate Job
                        </DropdownMenuItem>
                      )}
                      {actions.canReopen && (
                        <DropdownMenuItem
                          onClick={() => reopenMutation.mutate()}
                          disabled={reopenMutation.isPending}
                        >
                          <RotateCcw /> Reopen Job
                        </DropdownMenuItem>
                      )}

                      {(actions.canCancel || actions.canDelete) &&
                        (actions.canAssign || canViewWorkOrder ||
                          actions.canDuplicate || actions.canReopen) && <DropdownMenuSeparator />}

                      {actions.canCancel && (
                        <DropdownMenuItem variant="destructive" onClick={() => setCancelOpen(true)}>
                          <XCircle /> Cancel
                        </DropdownMenuItem>
                      )}
                      {actions.canDelete && (
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleteConfirmOpen(true)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>

            {/* The one mutation on this page whose error is rendered inline
                rather than toasted - it surfaces the no-issued-invoice 400. */}
            {reopenMutation.error && (
              <p className="text-destructive text-xs">
                {extractApiError(reopenMutation.error, 'Cannot reopen this job')}
              </p>
            )}

            {/* The ONE task signal on this page, now that the always-on chips
                below are gone - so it carries the weight they used to dilute,
                and it is RED. It was amber, which in this design system means
                "waiting on someone else, chase it when you can"; an overdue
                task on an active job is not that. Red is the only tone that
                survives being the sole thing shouting on a header this busy. */}
            {taskSummary && (taskSummary.overdue > 0 || taskSummary.at_risk > 0) && (
              <div
                data-testid="task-at-risk-strip"
                role="status"
                className="border-status-red/40 bg-status-red-subtle text-status-red-emphasis flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] font-medium"
              >
                <AlertTriangle className="size-4 shrink-0" />
                <span>
                  {taskSummary.overdue > 0
                    ? `${taskSummary.overdue} overdue task${taskSummary.overdue !== 1 ? 's' : ''} on this job`
                    : `${taskSummary.at_risk} at-risk task${taskSummary.at_risk !== 1 ? 's' : ''} on this job`}
                </span>
              </div>
            )}

            {/* Info band: contact | schedule + service | money.
                `items-stretch`, not `items-start`. Three panels of three
                different heights, each ending wherever its own content ran out,
                is most of why this header read as unfinished: the eye gets no
                shared baseline to work from, and the ragged bottom edge left a
                wedge of dead space under the two shorter tiles. Stretching them
                gives the row one top and one bottom, and each tile distributes
                its own slack internally. */}
            <div className="grid grid-cols-1 items-stretch gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]">
              {/* Zone A - contact */}
              <div className="flex min-w-0 flex-col gap-1.5">
                {serviceAddressLine && (
                  <p className="flex items-center gap-1.5 text-[14px]">
                    <MapPin className="text-subtle-foreground size-4 shrink-0" />
                    <span className="min-w-0">{serviceAddressLine}</span>
                    {canEditLocation && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 shrink-0"
                        aria-label="Edit service location"
                        onClick={() => setEditLocationOpen(true)}
                      >
                        <Pencil />
                      </Button>
                    )}
                  </p>
                )}
                {!serviceAddressLine && canEditLocation && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-fit px-0"
                    aria-label="Edit service location"
                    onClick={() => setEditLocationOpen(true)}
                  >
                    <MapPin /> No service address <Pencil />
                  </Button>
                )}
                {job.customer.phone && (
                  <p className="text-muted-foreground flex items-center gap-1.5 text-[14px]">
                    <Phone className="text-subtle-foreground size-4 shrink-0" />
                    {/* A kit Button that navigates, not an <a href="tel:">: the
                        raw-tag ratchet sits at its floor for anchors and a v2
                        page may not add one. Same destination - the precedent is
                        pages/v2/_shared/contactCell.tsx. */}
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto px-0 font-normal"
                      onClick={() => { window.location.href = `tel:${job.customer.phone}`; }}
                    >
                      {formatPhone(job.customer.phone)}
                    </Button>
                  </p>
                )}
                {/* The customer's EMAIL, beside their phone.
                    It was the one contact detail the page did not carry, which
                    meant the commonest follow-up on a finished job - send them
                    something - started by navigating to the customer record to
                    read an address off it. Same treatment as the phone above,
                    and for the same reason a link Button rather than a raw
                    <a href="mailto:">: the raw-tag ratchet is at its floor for
                    anchors. */}
                {job.customer.email && (
                  <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[14px]">
                    <Mail className="text-subtle-foreground size-4 shrink-0" />
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto min-w-0 justify-start truncate px-0 font-normal"
                      title={job.customer.email}
                      onClick={() => { window.location.href = `mailto:${job.customer.email}`; }}
                    >
                      {job.customer.email}
                    </Button>
                  </p>
                )}
                {job.estimate && (
                  <Link
                    to={preferV2Path(`/estimates/${job.estimate.id}`)}
                    className="text-brand block text-[13px] hover:underline"
                  >
                    View Estimate ({job.estimate.estimate_number})
                  </Link>
                )}
                {job.source_plan && (
                  <Link
                    to={preferV2Path('/service-plans')}
                    className="text-brand block text-[13px] hover:underline"
                  >
                    Service Plan ({job.source_plan.service_plan_number})
                  </Link>
                )}
                <div className="pt-1">
                  {/* No kit equivalent: chips plus a create-or-attach popover
                      over /api/tags. Reused as-is (ledger row). */}
                  <TagInput entityType="JOB" entityId={id!} tags={job.tags ?? []} />
                </div>
              </div>

              {/* Zone B - schedule and service tiles.
                  `self-start` is what keeps them honest. The row stretches its
                  three zones to the tallest of them, which is the contact
                  column (address, phone, email, two record links, a tag rail);
                  these two tiles hold three short lines each and were being
                  drawn at that full height, so most of each bordered box was
                  empty. Sized to their own content instead - `items-stretch`
                  still matches the two tiles to EACH OTHER, so the pair stays
                  square. */}
              <div className="grid min-w-0 grid-cols-2 items-stretch gap-3 self-start">
                {actions.canAssign ? (
                  // A kit Button, not a raw <button>: the raw-tag ratchet sits at
                  // its floor and a v2 page may not add one. Only LAYOUT is
                  // overridden here (block flow, auto height, start alignment) -
                  // Button is explicitly out of scope for the appearance ratchet.
                  <Button
                    variant="outline"
                    onClick={() => openAssignDialog('schedule')}
                    aria-label="Reschedule job"
                    className="h-full w-full flex-col items-start justify-start gap-0 p-3.5 text-left"
                  >
                    <span className="block w-full">{scheduleTileInner}</span>
                  </Button>
                ) : (
                  <div className="flex h-full flex-col rounded-lg border p-3.5">{scheduleTileInner}</div>
                )}
                <div className="flex h-full flex-col rounded-lg border p-3.5">
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="bg-muted text-muted-foreground flex size-7 items-center justify-center rounded-full">
                      <Wrench className="size-3.5" />
                    </span>
                    <span className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">
                      Service
                    </span>
                  </div>
                  {editingServiceType ? (
                    <div className="flex items-center gap-1.5">
                      <SelectField
                        value={job.job_type ?? undefined}
                        onValueChange={(v) => updateJobTypeMutation.mutate(v)}
                        className="h-8"
                        aria-label="Service type"
                        placeholder="Select..."
                        options={
                          (org?.job_type_options ?? []).length > 0
                            ? (org?.job_type_options ?? []).map((t) => ({ value: t, label: t }))
                            : [{ value: '__none__', label: 'No options - add in Settings', disabled: true }]
                        }
                      />
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-6 shrink-0"
                        aria-label="Cancel service type edit"
                        onClick={() => setEditingServiceType(false)}
                      >
                        <XCircle />
                      </Button>
                    </div>
                  ) : (
                    <p className="flex items-center gap-1.5 text-[15px] font-bold leading-snug">
                      {job.job_type ?? '-'}
                      {canEditServiceType && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-6 shrink-0"
                          aria-label="Edit service type"
                          onClick={() => setEditingServiceType(true)}
                        >
                          <Pencil />
                        </Button>
                      )}
                    </p>
                  )}
                </div>
              </div>

              {/* Zone C - money block, three mutually exclusive branches */}
              <div className="bg-muted/40 flex h-full w-full flex-col justify-center rounded-lg border p-4 lg:w-[260px] lg:justify-self-end">
                {isPlanVisit ? (
                  <>
                    <Caption>Billing</Caption>
                    <p className="text-[15px] font-bold">Plan visit</p>
                    <p className="text-muted-foreground mt-1 text-[11px]">Billed upfront - non-billable.</p>
                  </>
                ) : contractValue != null ? (
                  <>
                    <Caption>Balance due</Caption>
                    <p className="text-3xl font-extrabold leading-none tracking-tight tabular-nums">
                      {formatCurrency(balanceDue ?? 0)}
                    </p>
                    <Progress
                      className="mt-2.5"
                      value={pctCollected}
                      aria-label={`${pctCollected}% collected`}
                    />
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs tabular-nums">
                      <span className="text-muted-foreground">
                        Contract <span className="text-foreground font-semibold">{formatCurrency(contractValue)}</span>
                      </span>
                      {depositPaid > 0 && (
                        <span className="text-status-green-emphasis font-medium">
                          Deposit {formatCurrency(depositPaid)}
                        </span>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 text-[11px]">{pctCollected}% collected</p>
                  </>
                ) : (
                  <>
                    <Caption>Balance</Caption>
                    <p className="text-[15px] font-bold">No contract yet</p>
                    <p className="text-muted-foreground mt-1 text-[11px]">
                      Add an estimate or invoice to track payment.
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* The Open / Overdue / Next due chips that used to sit here are
                gone. All three were on screen at ALL times, including the
                overwhelmingly common case of "0 Open, 0 Overdue, Next due -",
                where they occupied a full row of the header to report that
                there was nothing to report. The counts they carried are not
                lost: the Tasks tab below already shows the open count in its
                label, and the one state that genuinely needs to interrupt -
                something overdue or at risk - is what the banner above says,
                once, in red. */}

            {/* The rail is a different KIND of thing from the panels above it -
                a progress readout, not a fact about the job - so it gets a rule
                and a little air rather than sitting in the same 16px rhythm as
                everything else and reading as a fourth panel. */}
            <Separator className="mt-1" />

            {/* No kit equivalent: the six-stage milestone rail with its per-node
                capability model. Reused as-is (ledger row). */}
            <JobLifecycleBar
              job={job}
              financials={financials}
              // The org's clock, not the bar's fallback. `tz` is optional and
              // defaults to DEFAULT_SCHEDULE_TIMEZONE, so omitting it does not
              // fail loudly - it silently dates every milestone on New York's
              // calendar for an org that is not in New York, off by a day at
              // either end. The hero tile and the visit list one tab away
              // already render through this same zone.
              tz={scheduleTz}
              visits={jobVisits.visits}
              visitsUnknown={jobVisits.visitsUnknown}
              visitAbilities={actions.visitAbilities}
              onVisitAction={(visitId, action) => visitLifecycle.mutate({ visitId, action })}
              can={{
                scheduled: actions.canAssign,
                started: actions.canStart,
                completed: actions.canComplete,
                // Spec A D4: per-user capabilities, never technician role
                // defaults. Gated per STATE, not by a single OR: States 3/4
                // create (needing `create Invoice`), State 2 only sends (needing
                // `send Invoice`). Service-plan visits are excluded - the plan
                // was paid upfront, so the invoice door 400s them.
                invoice_sent:
                  !job.source_plan_id &&
                  (invoiceSent.state === 1
                    ? true
                    : invoiceSent.state === 2
                      ? ability.can('send', 'Invoice')
                      : ability.can('create', 'Invoice') && ability.can('send', 'Invoice')),
                payment_received:
                  !jobPaidOff &&
                  ability.can('record_payment', 'Invoice') &&
                  // The composite path creates an invoice, so it needs create
                  // too - but only when there is no invoice to pay.
                  (financials?.final_invoice != null ||
                    (!job.source_plan_id && ability.can('create', 'Invoice'))),
              }}
              busy={startMutation.isPending || completeMutation.isPending || visitLifecycle.isPending}
              onNodeClick={(key) => {
                if (key === 'scheduled') { openAssignDialog('schedule'); return; }
                if (key === 'completed') { completeMutation.mutate(); return; }
                if (key === 'invoice_sent') {
                  // State 1 - already sent: open the invoice rather than a dialog.
                  if (invoiceSent.state === 1 && invoiceSent.invoice) {
                    navigate(preferV2Path(`/invoices/${invoiceSent.invoice.id}`));
                    return;
                  }
                  setInvoiceSentOpen(true);
                  return;
                }
                if (key === 'payment_received') { setPaymentReceivedOpen(true); }
              }}
              onStartClick={() => startMutation.mutate()}
            />
          </div>
        </Card>

        {/* --- Tabs ------------------------------------------------------- */}
        <Card className="overflow-hidden">
          <TabStrip
            value={activeTab}
            onValueChange={setActiveTab}
            tabs={[
              { value: 'overview', label: 'Overview' },
              // Multi-visit S2: a job holds its own visits now, and the hero above shows only the
              // next one. This is where the rest of them live.
              { value: 'visits', label: 'Visits' },
              { value: 'items', label: 'Items' },
              ...(canUseInventory ? [{ value: 'logistics', label: 'Logistics' }] : []),
              ...(ability.can('read', 'Estimate') ? [{ value: 'estimates', label: 'Estimates' }] : []),
              { value: 'attachments', label: 'Attachments' },
              ...(ability.can('read', 'Communication') ? [{ value: 'communication', label: 'Communication' }] : []),
              {
                value: 'tasks',
                label: (
                  <>
                    Tasks
                    {taskSummary?.open ? (
                      <span className="text-muted-foreground ms-1.5 text-xs">({taskSummary.open})</span>
                    ) : null}
                  </>
                ),
              },
              { value: 'notes', label: 'Notes' },
              ...(ability.can('read', 'Invoice') ? [{ value: 'payments', label: 'Payments' }] : []),
            ]}
          />

          {/* --- Visits ----------------------------------------------- */}
          <TabPanel value="visits" activeValue={activeTab}>
            <div className="p-5">
              <VisitsCard jobId={id!} visits={jobVisits.visits} isLoading={jobVisits.isLoading} visitsUnknown={jobVisits.visitsUnknown} onRetry={() => { void jobVisits.refetch(); }} canSchedule={actions.canReschedule} canAssignCrew={actions.canAssign} visitAbilities={actions.visitAbilities} />
            </div>
          </TabPanel>

          {/* --- Overview --------------------------------------------- */}
          <TabPanel value="overview" activeValue={activeTab}>
            <div className="p-5">
              {/* One card per cell on a plain three-up grid: four unequal
                  columns of stacked cards had every card a different width and
                  every column a different length. `items-start` keeps a short
                  card short instead of stretching it to its row's tallest. */}
              <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
                <CustomerContactCard
                  job={job}
                  onViewAllCommunications={() => setActiveTab('communication')}
                />

                {/* `overflow-hidden` so the header band stops at the card's
                    radius instead of squaring off its top corners. */}
                <Card className="overflow-hidden">
                  {/* The tinted band, the rule under it and the accent bar are
                      `components/jobs/overview/SectionCard`'s header, matched
                      here by hand. The cards sharing this grid ARE SectionCards
                      - Customer & Contact, Files, Notes, Team - so a plain kit
                      CardHeader left Details as the one title floating over its
                      content while its neighbours sat under a band.

                      `flex`, not `flex-row`: CardHeader's own display is `grid`,
                      and only a competing display utility displaces it in
                      tailwind-merge - `flex-row` would have left the bar and the
                      title stacked in two grid rows. */}
                  <CardHeader className="bg-card-header flex items-center gap-2 border-b py-3">
                    <span
                      aria-hidden="true"
                      className="bg-primary h-4 w-1 shrink-0 rounded-full"
                    />
                    <CardTitle>Details</CardTitle>
                  </CardHeader>
                  {/* `pt-4`: CardContent carries no top padding of its own - it
                      expects to follow a header that ends in one - and the band
                      above ends at its border. */}
                  <CardContent className="flex flex-col gap-4 pt-4">
                    {job.scope_notes && (
                      <div>
                        <Caption>Scope Notes</Caption>
                        <p className="whitespace-pre-wrap text-[13px]">{job.scope_notes}</p>
                      </div>
                    )}

                    {job.completion_notes && (
                      <div>
                        <Caption>Completion Notes</Caption>
                        <p className="whitespace-pre-wrap text-[13px]">{job.completion_notes}</p>
                        {job.completed_at && (
                          <p className="text-muted-foreground mt-1 text-xs">
                            Completed {formatInstant(job.completed_at, scheduleTz, COMPLETION_STAMP)}
                          </p>
                        )}
                      </div>
                    )}

                    {job.cancelled_reason && (
                      <div className="border-status-red/20 bg-status-red-subtle rounded-md border p-3">
                        <p className="text-status-red-emphasis mb-1 text-xs font-semibold">Cancellation Reason</p>
                        <p className="whitespace-pre-wrap text-[13px]">{job.cancelled_reason}</p>
                        {job.cancelled_at && (
                          <p className="text-muted-foreground mt-1 text-xs">
                            Cancelled {formatInstant(job.cancelled_at, scheduleTz, COMPLETION_STAMP)}
                          </p>
                        )}
                      </div>
                    )}

                    {job.estimate && (
                      <div>
                        <Caption>Linked Estimate</Caption>
                        <Link
                          to={preferV2Path(`/estimates/${job.estimate.id}`)}
                          className="text-brand text-[13px] hover:underline"
                        >
                          {job.estimate.estimate_number}
                        </Link>
                      </div>
                    )}

                    {/* #585 - direct Job -> Lead traceability. */}
                    {job.estimate?.lead && (
                      <div>
                        <Caption>Originating Lead</Caption>
                        <Link
                          to={preferV2Path(`/leads/${job.estimate.lead.id}`)}
                          className="text-brand text-[13px] hover:underline"
                        >
                          {job.estimate.lead.lead_number}
                        </Link>
                      </div>
                    )}

                    {job.invoices && job.invoices.length > 0 && (
                      <div>
                        <Caption>
                          {job.invoices.length === 1 ? 'Invoice' : `Invoices (${job.invoices.length})`}
                        </Caption>
                        <div className="flex flex-col gap-2 text-[13px]">
                          {job.invoices.map((inv) => (
                            <div key={inv.id} className="flex items-center justify-between gap-2">
                              <Link
                                to={preferV2Path(`/invoices/${inv.id}`)}
                                className="text-brand font-medium hover:underline"
                              >
                                {inv.invoice_number}
                              </Link>
                              <StatusChip domain="invoice" status={inv.status} />
                              <span className="font-medium tabular-nums">
                                {formatCurrency(Number(inv.total_amount))}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <TeamCard
                  job={job}
                  onAssign={actions.canAssign ? () => openAssignDialog('assign') : undefined}
                />

                <AiInsightsCard job={job} attachments={attachmentsData} financials={financials} />

                <JobFilesCard
                  jobId={id!}
                  attachments={attachmentsData}
                  onViewAll={() => setActiveTab('attachments')}
                />

                <JobNotesPreview
                  jobId={id!}
                  notes={notesData}
                  addAffordance="inline-button"
                  canAddNotes={actions.canAddNotes}
                />
              </div>

              <div id="ai-job-assistant" className="mt-4">
                <AiJobAssistantBar
                  jobNumber={job.job_number}
                  customerName={customerName}
                  service={job.job_type}
                  status={job.status}
                />
              </div>
            </div>
          </TabPanel>

          {/* --- Items: job-owned billing lines, tracked before any invoice --- */}
          <TabPanel value="items" activeValue={activeTab}>
            <div className="flex flex-col gap-5 p-5">
              {/* No JobBillingSummary: it was deleted upstream, and the
                  ReceiptCard below already carries every figure it showed. */}
              <JobScopeOfWorkCard jobId={id!} canManage={actions.canManageLines} />
              <LineItemsEditor jobId={id!} canManage={actions.canManageLines} />
              <ReceiptCard
                variant="job"
                lineItemsSubtotal={(jobLineItemsData?.lines ?? []).reduce((sum, l) => sum + netOf(l), 0)}
                scopeSubtotal={(jobScopesData?.scopes ?? [])
                  .filter((s) => s.flat_price != null)
                  .reduce((sum, s) => sum + toNum(s.flat_price), 0)}
                // D1/D2: tax and discount both follow the job's linked estimate.
                // Every figure is server-authoritative from computeJobBilling; no
                // onDiscountChange/onTaxRateChange is wired, since neither is
                // independently editable on the job.
                subtotal={jobLineItemsData?.billing?.subtotal ?? 0}
                discountAmount={jobLineItemsData?.billing?.discount_amount ?? 0}
                taxRate={jobLineItemsData?.billing?.tax_rate ?? 0}
                taxAmount={jobLineItemsData?.billing?.tax_amount ?? 0}
                taxRates={jobTaxRates}
                taxStateCode={job.service_location?.state ?? null}
                taxHelperText={jobTaxSourceEstimate ? "Follows the job's estimate" : undefined}
                total={jobLineItemsData?.billing?.total ?? 0}
              />
              {canSeePricing && (
                <InternalCostsCard
                  lineItems={jobLineItemsData?.lines ?? []}
                  scopes={jobScopesData?.scopes ?? []}
                  laborHours={job.labor_hours}
                  overheadMode={job.overhead_mode}
                  overheadValue={job.overhead_value}
                  discountedSubtotal={jobLineItemsData?.billing?.total ?? 0}
                  orgLaborRate={org?.labor_rate ?? 0}
                  orgOverheadMode={org?.overhead_mode ?? 'PERCENTAGE'}
                  orgOverheadValue={org?.overhead_value ?? 0}
                  canEditNow={job.status !== 'CANCELLED'}
                  onCommitLaborHours={(hours) => costMutation.mutate({ labor_hours: hours })}
                  onCommitOverhead={(mode, value) => costMutation.mutate({ overhead_mode: mode, overhead_value: value })}
                  materialsPurchased={
                    canReadPO && materialCost && materialCost.lineCount > 0
                      ? { amount: materialCost.materialCost, lineCount: materialCost.lineCount }
                      : null
                  }
                />
              )}
            </div>
          </TabPanel>

          {/* --- Logistics: guarded as well as its trigger, because LOList and
              JobStagesSection fetch from the Scale-gated /api/inventory routes
              and an unentitled mount is a 402. --- */}
          {canUseInventory && (
            <TabPanel value="logistics" activeValue={activeTab}>
              <div className="flex flex-col gap-5 p-5">
                {(() => {
                  const syncedLines = (jobLineItemsData?.lines ?? []).filter(
                    (l) => l.stock_status === 'SYNCED',
                  );
                  if (syncedLines.length === 0) return null;
                  return (
                    <div className="border-status-amber/20 bg-status-amber-subtle text-status-amber-emphasis flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        Legacy synced line{syncedLines.length === 1 ? '' : 's'} still deducting stock on
                        this job: {syncedLines.map((l) => l.description).join(', ')}. New logistic orders
                        will not double-count them.
                      </span>
                    </div>
                  );
                })()}
                <LOList jobId={id!} />
                <JobStagesSection jobId={id!} />
              </div>
            </TabPanel>
          )}

          {/* --- Estimates -------------------------------------------- */}
          <TabPanel value="estimates" activeValue={activeTab}>
            <div className="flex flex-col gap-4 p-5">
              {/* Workiz parity: a job can ALWAYS take another estimate, so "Add
                  estimate" is ungated; "from items" is the extra, and only has
                  anything to copy once the job HAS items. */}
              {(ability.can('create', 'Estimate') || ability.can('update', 'Estimate')) && (
                <div className="flex flex-wrap justify-end gap-2">
                  {ability.can('update', 'Estimate') && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setAttachEstimateOpen(true)}>
                      <FileText aria-hidden /> Attach estimate
                    </Button>
                  )}
                  {ability.can('create', 'Estimate') && billableLineCount > 0 && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={createEstimateMutation.isPending}
                      onClick={() => createEstimateMutation.mutate()}
                    >
                      <PlusCircle aria-hidden /> Create estimate from items
                    </Button>
                  )}
                  {ability.can('create', 'Estimate') && (
                    // `/estimates/new?job_id=` mints an empty DRAFT anchored to
                    // this job and lands on the workspace.
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => navigate(`${preferV2Path('/estimates/new')}?job_id=${id}`)}
                    >
                      <PlusCircle aria-hidden /> Add estimate
                    </Button>
                  )}
                </div>
              )}

              {job.estimate ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Estimate</CardTitle>
                    <CardAction>
                      <Link
                        to={preferV2Path(`/estimates/${job.estimate.id}`)}
                        className="text-brand inline-flex items-center gap-1 text-xs font-medium hover:underline"
                      >
                        View estimate <ArrowUpRight className="size-3.5" />
                      </Link>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <Link
                      to={preferV2Path(`/estimates/${job.estimate.id}`)}
                      className="text-[15px] font-bold hover:underline"
                    >
                      {job.estimate.estimate_number}
                    </Link>
                    <div className="mt-1.5 flex items-center gap-3">
                      <StatusChip domain="estimate" status={job.estimate.status} />
                      <span className="text-[13px] font-semibold tabular-nums">
                        {formatCurrency(Number(job.estimate.total_amount))}
                      </span>
                    </div>
                    {job.estimate.deposit && (
                      <div className="mt-4">
                        <Caption>Deposit</Caption>
                        <div className="flex flex-wrap items-center gap-2 text-[13px]">
                          <span className="font-medium tabular-nums">
                            {formatCurrency(Number(job.estimate.deposit.amount))}
                          </span>
                          {/* Sentence-cased in JS, not with a `capitalize`
                              class: the component-API ratchet counts an
                              appearance token handed to Badge from a call site
                              and sits at its floor. */}
                          <Badge variant="softNeutral" size="pill">
                            {sentenceCase(job.estimate.deposit.status)}
                          </Badge>
                          {job.estimate.deposit.paid_at && (
                            <span className="text-muted-foreground text-xs">
                              paid {formatInstant(job.estimate.deposit.paid_at, scheduleTz, { year: 'numeric', month: 'numeric', day: 'numeric' })}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ) : attachedEstimates.length === 0 ? (
                <Card>
                  <CardHeader><CardTitle>Estimate</CardTitle></CardHeader>
                  <EmptyState icon={<FileText />} title="No linked estimate" />
                </Card>
              ) : null}

              {attachedEstimates.length > 0 && (
                <Card>
                  <CardHeader><CardTitle>Attached estimates</CardTitle></CardHeader>
                  <CardContent>
                    <p className="text-muted-foreground mb-3 text-xs">
                      Attached to this job. A paid deposit on any of these is credited against this
                      job&apos;s invoices, which are billed from the job&apos;s own line items.
                    </p>
                    <div className="flex flex-col gap-3">
                      {attachedEstimates.map((e) => (
                        <div key={e.id} className="flex items-center justify-between gap-3">
                          <Link
                            to={preferV2Path(`/estimates/${e.id}`)}
                            className="text-[13px] font-bold hover:underline"
                          >
                            {e.estimate_number}
                          </Link>
                          <div className="flex items-center gap-3">
                            <StatusChip domain="estimate" status={e.status} />
                            {e.total_amount != null && (
                              <span className="text-[13px] font-semibold tabular-nums">
                                {formatCurrency(Number(e.total_amount))}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </TabPanel>

          {/* --- Attachments ------------------------------------------ */}
          <TabPanel value="attachments" activeValue={activeTab}>
            <div className="p-5">
              <AttachmentsTabBody jobId={id!} attachments={attachmentsData} />
            </div>
          </TabPanel>

          {/* --- Communication: double-gated, trigger AND content ------ */}
          {ability.can('read', 'Communication') && (
            <TabPanel value="communication" activeValue={activeTab}>
              <JobCommunicationsTab
                jobId={id!}
                jobNumber={job.job_number}
                customerId={job.customer.id}
                customerName={customerName}
                customerEmail={job.customer.email ?? undefined}
                customerPhone={job.customer.phone || undefined}
              />
            </TabPanel>
          )}

          {/* --- Tasks ------------------------------------------------- */}
          <TabPanel value="tasks" activeValue={activeTab}>
            <JobLeadTasksTab
              entity={{
                type: 'JOB',
                id: job.id,
                label: `${job.job_number} - ${customerName}`,
              }}
              refreshKey={tasksRefreshKey}
            />
          </TabPanel>

          {/* --- Notes ------------------------------------------------- */}
          <TabPanel value="notes" activeValue={activeTab}>
            <NotesTabBody jobId={id!} notes={notesData} canAddNotes={actions.canAddNotes} />
          </TabPanel>

          {/* --- Payments ---------------------------------------------- */}
          <TabPanel value="payments" activeValue={activeTab}>
            <PaymentsTab financials={financials} jobId={id!} />
          </TabPanel>
        </Card>

        {/* --- Dialogs ---------------------------------------------------- */}
        <CreateTaskModal
          open={newTaskOpen}
          onOpenChange={(open) => {
            setNewTaskOpen(open);
            if (!open) setTasksRefreshKey((k) => k + 1);
          }}
          presetEntity={{ type: 'JOB', id: job.id, label: `${job.job_number} - ${customerName}` }}
        />
        <AssignJobDialog
          open={assignOpen}
          onOpenChange={setAssignOpen}
          jobId={id!}
          mode={assignMode}
          currentAssigneeIds={job.assignees?.map((a) => a.user.id)}
          // The same rows as PEOPLE, so the picker can label a crew member the viewer's scoped
          // roster does not contain. Reading the crew is not the same permission as changing it.
          currentAssignees={job.assignees?.map((a) => a.user)}
          isScheduled={Boolean(job.scheduled_start)}
          // Seed the pickers with the schedule the job already has, so Reschedule opens on the
          // current slot to edit rather than four empty fields the user has to retype from memory.
          defaultStart={job.scheduled_start ?? undefined}
          defaultEnd={job.scheduled_end ?? undefined}
          defaultIsAllDay={job.is_all_day}
          // These describe where the job already IS, unlike the board's, which describe where
          // it is being dropped. Without this the crew-only triggers would restate the window
          // and assign() would read that as a re-booking, nulling the milestone timestamps.
          defaultsAreCurrentSchedule
        />
        {job.estimate && (
          <ViewWorkOrderDialog
            open={workOrderOpen}
            onOpenChange={setWorkOrderOpen}
            estimateId={job.estimate.id}
            customerName={customerName}
            companyName={job.customer.company_name}
          />
        )}
        <CancelJobDialog open={cancelOpen} onOpenChange={setCancelOpen} jobId={id!} />
        <ConfirmDialog
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
          destructive
          title="Delete this job?"
          // Inventory P1: job delete auto-returns SYNCED lines server-side.
          description={
            (jobLineItemsData?.lines ?? []).some((l) => l.stock_status === 'SYNCED')
              ? `${job.job_number} will be permanently removed. Synced inventory items on this job will be returned to stock.`
              : `${job.job_number} for ${customerName} will be permanently removed.`
          }
          confirmLabel="Delete"
          isPending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate()}
        />
        <EditJobLocationDialog
          open={editLocationOpen}
          onOpenChange={setEditLocationOpen}
          jobId={id!}
          customerId={job.customer.id}
          currentLocation={job.service_location}
        />
        <AttachEstimateDialog
          open={attachEstimateOpen}
          onOpenChange={setAttachEstimateOpen}
          jobId={id!}
          customerId={job.customer.id}
        />
        <CreateJobInvoiceDialog
          open={createInvoiceOpen}
          onOpenChange={setCreateInvoiceOpen}
          jobId={job.id}
          jobNumber={job.job_number}
          onCreated={goToInvoice}
        />
        <CreateJobInvoiceDialog
          open={invoiceSentOpen}
          onOpenChange={setInvoiceSentOpen}
          jobId={job.id}
          jobNumber={job.job_number}
          sendAfterCreate
          existingDraft={invoiceSent.state === 2 ? invoiceSent.invoice : null}
          initialMode={invoiceSent.state === 3 ? 'ITEMIZED' : 'AMOUNT'}
          onCreated={() => invalidateJob()}
        />
        <RecordPaymentDialog
          open={paymentReceivedOpen}
          onOpenChange={setPaymentReceivedOpen}
          invoiceId={financials?.final_invoice?.id ?? null}
          invoiceNumber={financials?.final_invoice?.invoice_number ?? ''}
          amountDue={Number(financials?.final_invoice?.amount_due ?? 0)}
          jobId={job.id}
          hasUnspentDeposit={hasUnspentDeposit}
          onSuccess={() => { invalidateJob(); setPaymentReceivedOpen(false); }}
        />
      </div>
    </IconRail>
  );
}
