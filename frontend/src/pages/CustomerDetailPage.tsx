import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/heading';
import type { BreadcrumbItem } from '@/components/ui/breadcrumb';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import { purgeCustomer } from '@/lib/api/customers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { TabsContent } from '@/components/ui/tabs';
import { TabStrip } from '@/components/patterns/TabStrip';
import { StatusBadge } from '@/components/data/status-badge';
import { Breadcrumb } from '@/components/ui/breadcrumb';
import { RecordNumberEditor } from '@/components/crm/RecordNumberEditor';
import { LocationFormDialog } from '@/components/customers/LocationFormDialog';
import { TagInput } from '@/components/leads/TagInput';
import { CustomerCommunicationsTab } from '@/components/communication/CustomerCommunicationsTab';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { useFeature, useModuleAccess } from '@/lib/entitlements';
import { ComposeWindow, UNDO_SEND_WINDOW_MS, useUndoSend } from '@/components/communication/inbox/ComposeWindow';
import { useSendEmail, useSendingIdentity, PRIMARY_ACCOUNT, type ComposeState } from '@/lib/api/communication';
import { useToast } from '@/components/ui/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { ExtraInfoPanel } from '@/components/custom-fields/ExtraInfoPanel';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import { PlanBuilderDialog } from '@/pages/service-plans/ServicePlansPage';
import { formatExactDay } from '@/lib/format-date';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Pencil,
  Trash2,
  Plus,
  ChevronDown,
  MapPin,
  Star,
  Phone,
  Mail,
  Building2,
  CheckCircle2,
  Briefcase,
  MoreHorizontal,
  ClipboardList,
  CreditCard,
  MessageSquare,
  Receipt,
  StickyNote,
  Send,
  Target,
  FileText,
  CheckSquare,
} from 'lucide-react';
import { cn, formatCurrency, formatPhone, extractApiError, getInitials } from '@/lib/utils';
import { EmptyState } from '@/components/ui/empty-state';
import { customerDisplayName } from '@/lib/customer-name';

// ─── Types ────────────────────────────────────────────────────

interface Location {
  id: string;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state: string;
  zip: string;
  is_primary: boolean;
}

// Exactly what GET /api/leads nests per lead - `leadListSelect` selects `{ id, total_amount }`
// and nothing else. LeadsTab wants only the count and the summed value, which is all this can
// answer; the Estimates tab reads `CustomerEstimate` below instead.
interface LeadEstimateSummary {
  id: string;
  total_amount: string | number;
}

// One row of GET /api/estimates (`estimateListSelect`), which the Estimates tab reads directly
// rather than digging estimates out of the leads response. Two reasons that matters:
//   1. /api/leads sits behind requireFeature('leads') (Pro) while Estimates is Starter core, so
//      a Starter org could never populate the tab through leads.
//   2. The leads nesting carries no estimate number, status or created date (see above), so
//      those columns rendered as em-dashes on every plan.
interface CustomerEstimate {
  id: string;
  estimate_number: string;
  status: string;
  total_amount: string | number;
  created_at: string;
  // Null for a customer-anchored estimate - R6 relaxed Estimate.lead_id to optional. Where a
  // lead does exist, Lead.service_request is NOT NULL.
  lead: { id: string; service_request: string } | null;
}

interface LeadSummary {
  id: string;
  lead_number?: string;
  status: string;
  service_request: string;
  created_at: string;
  // Lead owner mirror (M2M). From the /api/leads list shape.
  lead_assignees?: { user: { id: string; first_name: string; last_name: string } }[];
  estimates?: LeadEstimateSummary[];
}

interface JobSummary {
  id: string;
  job_number: string;
  status: string;
  scope_notes: string | null;
  scheduled_start: string | null;
  completed_at: string | null;
  created_at: string;
  // Job crew (M2M). From the customer-detail nested jobs shape.
  assignees?: { user: { id: string; first_name: string; last_name: string } }[];
  service_location?: { address_line1: string; city: string; state: string } | null;
  estimate?: { estimate_number: string; total_amount: string | number } | null;
  invoices?: Array<{
    id: string;
    invoice_number: string;
    status: string;
    total_amount: string | number;
    amount_due: string | number;
    due_date: string | null;
    created_at: string;
    payments?: Array<{
      id: string;
      amount: string | number;
      method: string;
      paid_at: string;
      notes: string | null;
      collector: { id: string; first_name: string; last_name: string } | null;
    }>;
  }>;
}

interface NoteSummary {
  id: string;
  content: string;
  created_at: string;
  creator: { id: string; first_name: string; last_name: string };
}

interface FinancialSummary {
  financials: {
    lifetime_revenue: number;
    total_invoiced: number;
    past_due_balance: number;
    due_balance: number;
    paid_invoice_count: number;
    unpaid_invoice_count: number;
  };
  estimates: {
    total: number;
    pending: number;
    approved: number;
    total_value: number;
  };
  deposits: {
    collected: number;
    pending: number;
  };
  leads?: { open: number; active: number };
  tasks?: { open: number };
}

interface CustomerInvoice {
  id: string;
  invoice_number: string;
  status: string;
  kind: string;
  total_amount: number | string;
  amount_due: number | string;
  due_date: string | null;
  created_at: string;
  job_number: string | null;
  job_id: string | null;
  payments: Array<{
    id: string;
    amount: number | string;
    method: string;
    paid_at: string;
    notes: string | null;
    collector: { id: string; first_name: string | null; last_name: string | null } | null;
  }>;
}

// ─── Helpers ──────────────────────────────────────────────────

const AD_SOURCE_STYLES: Record<string, string> = {
  Google:         'bg-info-surface text-info-text border-info-border',
  Facebook:       'bg-info-surface text-info-text border-info-border',
  Referral:       'bg-success-surface text-success-text border-success-border',
  Yelp:           'bg-danger-surface text-danger-text border-danger-border',
  Instagram:      'bg-ai-surface text-ai-text border-ai-border',
  'Direct Mail':  'bg-warning-surface text-warning-text border-warning-border',
  'Door Hanger':  'bg-warning-surface text-warning-text border-warning-border',
  Other:          'bg-neutral-surface text-neutral-text border-neutral-border',
};

function getAdSourceStyle(source: string | null | undefined): string {
  if (!source) return '';
  return AD_SOURCE_STYLES[source] ?? 'bg-neutral-surface text-neutral-text border-neutral-border';
}

// S4 (D17): EN_ROUTE/ON_SITE retired from JobStatus - such a job now reads SCHEDULED or
// IN_PROGRESS, so it is still counted as active here.
const ACTIVE_JOB_STATUSES = new Set(['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS']);

function formatDate(date: string) {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

// Same rendering as formatDate above, for a value that is a calendar day and not an instant, so it is read in UTC.
function formatDay(date: string) {
  return formatExactDay(date, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Tab: Leads ───────────────────────────────────────────────

function LeadsTab({
  leads,
  onNavigate,
}: {
  leads: LeadSummary[];
  onNavigate: (id: string) => void;
}) {
  if (leads.length === 0) {
    return <EmptyState title="No leads yet." />;
  }

  return (
    <div className="flex flex-col min-h-[400px] overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
            <th className="pb-3 pr-4 font-medium">Status</th>
            <th className="pb-3 pr-4 font-medium">Service Request</th>
            <th className="pb-3 pr-4 font-medium">Estimates</th>
            <th className="pb-3 pr-4 font-medium">Est. Value</th>
            <th className="pb-3 pr-4 font-medium">Assigned To</th>
            <th className="pb-3 font-medium">Date</th>
          </tr>
        </thead>
        <tbody>
          {leads.map(lead => {
            const estCount = lead.estimates?.length ?? 0;
            const estValue = (lead.estimates ?? []).reduce((sum, e) => sum + parseFloat(String(e.total_amount)), 0);
            return (
              <tr
                key={lead.id}
                className="cursor-pointer border-b border-border/50 hover:bg-background-light/50 transition-colors"
                onClick={() => onNavigate(lead.id)}
              >
                <td className="py-3 pr-4"><StatusBadge domain="lead" status={lead.status} neutral /></td>
                <td className="py-3 pr-4 max-w-xs">
                  <span className="block truncate">
                    {lead.service_request.length > 50 ? lead.service_request.slice(0, 50) + '...' : lead.service_request}
                  </span>
                </td>
                <td className="py-3 pr-4">
                  {estCount > 0 ? (
                    <span className="rounded-full bg-info-surface px-2 py-0.5 text-xs text-info-text font-medium">
                      {estCount}
                    </span>
                  ) : (
                    <span className="text-text-secondary">—</span>
                  )}
                </td>
                <td className="py-3 pr-4 text-text-secondary">
                  {estValue > 0 ? formatCurrency(estValue) : '—'}
                </td>
                <td className="py-3 pr-4 text-text-secondary">
                  {lead.lead_assignees && lead.lead_assignees.length > 0
                    ? lead.lead_assignees.map((a) => `${a.user.first_name} ${a.user.last_name}`).join(', ')
                    : <span className="italic">Unassigned</span>}
                </td>
                <td className="py-3 text-text-secondary">{formatDate(lead.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-auto pt-3 text-xs text-text-secondary text-right">
        Showing up to 20 most recent leads
      </p>
    </div>
  );
}

// ─── Tab: Jobs ────────────────────────────────────────────────

function JobsTab({
  jobs,
  onNavigate,
}: {
  jobs: JobSummary[];
  onNavigate: (id: string) => void;
}) {
  if (jobs.length === 0) {
    return <EmptyState icon={Briefcase} title="No jobs yet." />;
  }

  return (
    <div className="flex flex-col min-h-[400px] overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
            <th className="pb-3 pr-4 font-medium">Job #</th>
            <th className="pb-3 pr-4 font-medium">Status</th>
            <th className="pb-3 pr-4 font-medium">Location</th>
            <th className="pb-3 pr-4 font-medium">Technician</th>
            <th className="pb-3 pr-4 font-medium">Scheduled</th>
            <th className="pb-3 font-medium">Invoice</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map(job => (
            <tr
              key={job.id}
              className="cursor-pointer border-b border-border/50 hover:bg-background-light/50 transition-colors"
              onClick={() => onNavigate(job.id)}
            >
              <td className="py-3 pr-4">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-text-primary">{job.job_number}</span>
                </div>
              </td>
              <td className="py-3 pr-4"><StatusBadge domain="job" status={job.status} /></td>
              <td className="py-3 pr-4 text-text-secondary max-w-[150px] truncate">
                {job.service_location
                  ? `${job.service_location.address_line1}, ${job.service_location.city}`
                  : '—'}
              </td>
              <td className="py-3 pr-4 text-text-secondary">
                {job.assignees && job.assignees.length > 0
                  ? job.assignees.map((a) => `${a.user.first_name} ${a.user.last_name}`).join(', ')
                  : <span className="italic">Unassigned</span>}
              </td>
              <td className="py-3 pr-4 text-text-secondary">
                {job.scheduled_start ? formatDate(job.scheduled_start) : '—'}
              </td>
              <td className="py-3">
                {(() => {
                  const active = (job.invoices ?? []).filter((i: { status: string }) => i.status !== 'VOIDED');
                  const latest = active[active.length - 1];
                  if (!latest) return <span className="text-text-secondary">—</span>;
                  return (
                    <div className="flex items-center gap-1.5">
                      <StatusBadge domain="job" status={latest.status} />
                      {active.length > 1 && <span className="text-xs text-text-secondary">+{active.length - 1}</span>}
                    </div>
                  );
                })()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-auto pt-3 text-xs text-text-secondary text-right">
        Showing up to 20 most recent jobs
      </p>
    </div>
  );
}

// ─── Tab: Invoices ────────────────────────────────────────────

// ─── Tab: Estimates ───────────────────────────────────────────

function EstimatesTab({
  estimates,
  isLoading,
  onNavigate,
}: {
  estimates: CustomerEstimate[];
  isLoading: boolean;
  onNavigate: (id: string) => void;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2 py-2">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-10 w-full" />)}
      </div>
    );
  }

  if (estimates.length === 0) {
    return <EmptyState icon={ClipboardList} title="No estimates yet." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
            <th className="pb-3 pr-4 font-medium">Estimate #</th>
            <th className="pb-3 pr-4 font-medium">Service Request</th>
            <th className="pb-3 pr-4 font-medium">Status</th>
            <th className="pb-3 pr-4 font-medium">Total</th>
            <th className="pb-3 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {/* Rendered in API order, which is newest-first (the estimate list's
              parseSortParams defaults to created_at desc) - no client-side re-sort. */}
          {estimates.map(est => (
            <tr
              key={est.id}
              className="cursor-pointer border-b border-border/50 hover:bg-background-light/50 transition-colors"
              onClick={() => onNavigate(est.id)}
            >
              <td className="py-3 pr-4 font-medium text-primary">{est.estimate_number}</td>
              <td className="py-3 pr-4 max-w-xs">
                {/* Lead-less (customer-anchored) estimates have no originating request to show. */}
                {est.lead ? (
                  <span className="block truncate text-text-secondary">
                    {est.lead.service_request.length > 50
                      ? est.lead.service_request.slice(0, 50) + '...'
                      : est.lead.service_request}
                  </span>
                ) : (
                  <span className="text-text-secondary">—</span>
                )}
              </td>
              <td className="py-3 pr-4">{est.status ? <StatusBadge domain="estimate" status={est.status} /> : '—'}</td>
              <td className="py-3 pr-4 text-text-primary font-medium">{formatCurrency(est.total_amount)}</td>
              <td className="py-3 text-text-secondary">{formatDate(est.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tab: Payments ────────────────────────────────────────────

function PaymentsTab({ invoices }: { invoices: CustomerInvoice[] }) {
  const payments = invoices
    .flatMap(inv =>
      (inv.payments ?? []).map(p => ({
        ...p,
        invoice_number: inv.invoice_number,
      }))
    )
    .sort((a, b) => new Date(b.paid_at).getTime() - new Date(a.paid_at).getTime());

  if (payments.length === 0) {
    return <EmptyState icon={CreditCard} title="No payments yet." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
            <th className="pb-3 pr-4 font-medium">Invoice #</th>
            <th className="pb-3 pr-4 font-medium">Date</th>
            <th className="pb-3 pr-4 font-medium">Amount</th>
            <th className="pb-3 pr-4 font-medium">Method</th>
            <th className="pb-3 font-medium">Collected By</th>
          </tr>
        </thead>
        <tbody>
          {payments.map(p => (
            <tr key={p.id} className="border-b border-border/50">
              <td className="py-3 pr-4 font-medium text-text-primary">{p.invoice_number}</td>
              <td className="py-3 pr-4 text-text-secondary">{formatDate(p.paid_at)}</td>
              <td className="py-3 pr-4 text-text-primary font-medium">{formatCurrency(p.amount)}</td>
              <td className="py-3 pr-4">
                <Badge variant="outline" className="capitalize">
                  {p.method.toLowerCase()}
                </Badge>
              </td>
              <td className="py-3 text-text-secondary">
                {p.collector
                  ? `${p.collector.first_name} ${p.collector.last_name}`
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvoicesTab({ invoices }: { invoices: CustomerInvoice[] }) {
  if (invoices.length === 0) {
    return <EmptyState icon={Receipt} title="No invoices yet." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
            <th className="pb-3 pr-4 font-medium">Invoice #</th>
            <th className="pb-3 pr-4 font-medium">Job #</th>
            <th className="pb-3 pr-4 font-medium">Status</th>
            <th className="pb-3 pr-4 font-medium">Total</th>
            <th className="pb-3 pr-4 font-medium">Amount Due</th>
            <th className="pb-3 font-medium">Due Date</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map(inv => {
            const isOverdue =
              inv.due_date &&
              (inv.status === 'SENT' || inv.status === 'PARTIAL') &&
              new Date(inv.due_date) < new Date();
            return (
              <tr key={inv.id} className="border-b border-border/50">
                <td className="py-3 pr-4 font-medium">
                  <Link to={`/invoices/${inv.id}`} className="text-primary hover:underline">
                    {inv.invoice_number}
                  </Link>
                </td>
                <td className="py-3 pr-4 text-text-secondary">{inv.job_number ?? '—'}</td>
                <td className="py-3 pr-4"><StatusBadge domain="invoice" status={inv.status} /></td>
                <td className="py-3 pr-4 text-text-secondary">{formatCurrency(inv.total_amount)}</td>
                <td className="py-3 pr-4">
                  <span className={cn(parseFloat(String(inv.amount_due)) > 0 ? 'text-danger font-medium' : 'text-success')}>
                    {parseFloat(String(inv.amount_due)) > 0 ? formatCurrency(inv.amount_due) : 'Paid'}
                  </span>
                </td>
                <td className="py-3">
                  {inv.due_date ? (
                    <span className={cn(isOverdue ? 'text-danger-text font-medium' : 'text-text-secondary')}>
                      {formatDay(inv.due_date)}
                    </span>
                  ) : (
                    <span className="text-text-secondary">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tab: Notes ───────────────────────────────────────────────

function NotesTab({
  notes,
  customerId,
}: {
  notes: NoteSummary[];
  customerId: string;
}) {
  const [content, setContent] = useState('');
  const queryClient = useQueryClient();

  const addNoteMutation = useMutation({
    mutationFn: (body: { content: string }) => api.post(`/api/customers/${customerId}/notes`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] });
      setContent('');
    },
  });

  return (
    <div className="space-y-4">
      {/* Add note form */}
      <div className="space-y-2">
        <Textarea
          className="resize-none"
          rows={3}
          placeholder="Add a note about this customer..."
          value={content}
          onChange={e => setContent(e.target.value)}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!content.trim() || addNoteMutation.isPending}
            onClick={() => addNoteMutation.mutate({ content: content.trim() })}
          >
            <Send className="mr-1.5 h-3.5 w-3.5" />
            {addNoteMutation.isPending ? 'Adding...' : 'Add Note'}
          </Button>
        </div>
      </div>

      {addNoteMutation.error && (
        <p className="text-sm text-danger">Failed to add note. Please try again.</p>
      )}

      {/* Notes list */}
      {notes.length === 0 ? (
        <EmptyState density="compact" icon={StickyNote} title="No notes yet." />
      ) : (
        <div className="space-y-3">
          {notes.map(note => (
            <div key={note.id} className="rounded-lg border border-border p-4">
              <p className="text-sm text-text-primary whitespace-pre-wrap">{note.content}</p>
              <p className="text-xs text-text-secondary mt-2">
                {note.creator.first_name} {note.creator.last_name} · {formatDate(note.created_at)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const ability = useAppAbility();
  const canAccessComms = useFeature('phone');
  const hasLeads = useFeature('leads');
  const sendEmail = useSendEmail();
  // This page's compose window used to pass neither of these, so it showed the
  // stale "No mailbox connected" placeholder long after every org had a real
  // sending identity - the same lie the Inbox already stopped telling.
  const { data: sendingIdentity } = useSendingIdentity();
  const { toast } = useToast();
  const [compose, setCompose] = useState<ComposeState | null>(null);
  // Undo-send (email slice 7) - see ComposeWindow.tsx's useUndoSend doc.
  const undoComposeSend = useUndoSend<ComposeState>();

  const [purgeOpen, setPurgeOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [activeTab, setActiveTab] = useState('leads');
  // Leads is the landing tab but it is Pro-gated, and its trigger is hidden without
  // the entitlement - falling back to Estimates (Starter core) keeps a Starter org
  // off a tab it cannot see, which would otherwise render as a blank panel.
  // Derived per render, not a useState initializer: useFeature fails OPEN while
  // org_features is still hydrating, so the answer can flip after first paint.
  const effectiveTab = !hasLeads && activeTab === 'leads' ? 'estimates' : activeTab;
  // Create New offers two entries that belong to Pro modules while Customers is
  // Starter core: /api/leads and /api/service-plans are both behind requireFeature,
  // so on a Starter org those actions can only 402. Hide them on the host surface
  // rather than mount them and let the write fail.
  const canCreateLead = useModuleAccess('leads', 'create', 'Lead');
  const canCreateServicePlan = useModuleAccess('service_plans', 'create', 'ServicePlan');
  const [planBuilderOpen, setPlanBuilderOpen] = useState(false);

  // Query 1: Core customer data (fast — no leads included)
  const { data, isLoading } = useQuery({
    queryKey: ['customer', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${id}`);
      return { customer: data.customer, summary: data.summary as FinancialSummary };
    },
    enabled: Boolean(id),
  });

  // Query 2: Leads - lazy-loaded when the leads tab is active. Two guards, from two fixes:
  // `hasLeads` because /api/leads is behind requireFeature('leads') (Pro) and Customers is
  // Starter core, so without the entitlement the request can only 402 - a module the org
  // lacks must not degrade one it has. And only the leads tab, because the estimates tab no
  // longer rides along on this query (see Query 3).
  const { data: leadsData } = useQuery({
    queryKey: ['customer-leads', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/leads`, { params: { customer_id: id, limit: 20 } });
      return data.leads as LeadSummary[];
    },
    enabled: Boolean(id) && hasLeads && effectiveTab === 'leads',
  });

  // Query 3: Estimates - read straight from /api/estimates, filtered on the direct
  // Estimate.customer_id column (R6 made it NOT NULL), so lead-anchored, customer-anchored and
  // job-anchored estimates all appear. Ungated by design: Estimates is Starter core.
  // Keyed on `effectiveTab`, NOT `activeTab`: an unentitled org landing on the hidden Leads tab
  // is redirected to Estimates above while `activeTab` still reads 'leads', so keying on the raw
  // state would leave exactly the Starter case this fixes without a fetch.
  const { data: estimatesData, isLoading: estimatesLoading } = useQuery({
    queryKey: ['customer-estimates', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/estimates`, { params: { customer_id: id, limit: 50 } });
      return data.estimates as CustomerEstimate[];
    },
    enabled: Boolean(id) && effectiveTab === 'estimates',
  });

  const summary = data?.summary;
  const summaryLoading = isLoading;

  // Force-purge (destructive, one-shot type-to-confirm).
  const purgeMutation = useMutation({
    mutationFn: () => purgeCustomer(id!, { confirm: confirmText }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customer-stats'] });
      navigate('/customers');
    },
  });

  const deleteLocationMutation = useMutation({
    mutationFn: (locId: string) => api.delete(`/api/customers/${id}/locations/${locId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', id] });
    },
  });

  const setPrimaryLocationMutation = useMutation({
    mutationFn: (locId: string) =>
      api.patch(`/api/customers/${id}/locations/${locId}`, { is_primary: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customer', id] });
    },
  });

  // SRVW-114 slice 3 - Extra Info panel's custom-field values, riding the customer's existing
  // PATCH the same way JobDetailPage's customFieldsMutation rides the job's.
  const customFieldsMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/api/customers/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customer', id] }),
    onError: (err: unknown) => {
      toast({ title: extractApiError(err, 'Could not save'), variant: 'destructive' });
    },
  });

  const canEdit = user?.role === 'ADMIN' || user?.role === 'DISPATCHER' || user?.role === 'SALES';
  // Service-location delete stays role-gated (unchanged from before the lifecycle refactor).
  const canDeleteLocation = user?.role === 'ADMIN' || user?.role === 'DISPATCHER';
  const canReadComms = ability.can('read', 'Communication');
  // Comms affordances (E5): the in-app dialer / email compose render only for
  // comms-enabled orgs + users with create Communication; everyone else falls
  // back to native tel: / mailto: links, which can never 403.
  const canUseComms = canAccessComms && ability.can('create', 'Communication');
  const canForcePurge = ability.can('force_purge', 'Customer');
  // The actions menu trigger is shown only when at least one item is available.
  const showActionsMenu = canEdit || canForcePurge;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-3" />
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="rounded-xl bg-surface-light p-6 shadow-card border border-border">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              <Skeleton shape="circle" className="h-16 w-16 shrink-0" />
              <div className="space-y-2">
                <Skeleton className="h-8 w-52" />
                <Skeleton className="h-4 w-36" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-16" />
            </div>
          </div>
          <div className="my-5 h-px bg-border" />
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4 lg:grid-cols-8">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-16 mt-1" />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl bg-surface-light shadow-card border border-border overflow-hidden">
          <div className="flex flex-col lg:flex-row">
            <div className="w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-border p-5 space-y-4">
              <Skeleton className="h-3 w-28" />
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3">
                  <Skeleton className="h-4 w-4 mt-0.5 shrink-0" />
                  <Skeleton className="h-4 w-36" />
                </div>
              ))}
              <div className="border-t border-border pt-4 space-y-2.5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <Skeleton className="h-3.5 w-24" />
                    <Skeleton shape="circle" className="h-5 w-16" />
                  </div>
                ))}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex gap-1 border-b border-border px-4 pt-2">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="px-3 py-2.5 space-y-1">
                    <Skeleton className="h-3.5 w-14" />
                    <Skeleton className="h-2.5 w-10" />
                  </div>
                ))}
              </div>
              <div className="p-4 space-y-0">
                <div className="flex gap-4 pb-3 border-b border-border">
                  {[40, 140, 60, 80, 100, 72].map((w, i) => (
                    <Skeleton key={i} className="h-3" style={{ width: w }} />
                  ))}
                </div>
                {Array.from({ length: 5 }).map((_, row) => (
                  <div key={row} className="flex gap-4 py-3 border-b border-border/50">
                    {[40, 140, 60, 80, 100, 72].map((w, col) => (
                      <Skeleton key={col} className="h-4" style={{ width: w }} />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl bg-surface-light p-6 shadow-card border border-border text-center">
        <p className="text-text-secondary">Customer not found.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/customers')}>
          Back to Customers
        </Button>
      </div>
    );
  }

  const customer = data.customer;
  const leads: LeadSummary[] = leadsData ?? [];
  const estimates: CustomerEstimate[] = estimatesData ?? [];
  const jobs: JobSummary[] = customer.jobs ?? [];
  const invoices: CustomerInvoice[] = customer.invoices ?? [];
  // Polymorphic Note rows now arrive under `activity_notes` (the scalar `notes`
  // column is a separate free-text field the edit form owns).
  const notes: NoteSummary[] = customer.activity_notes ?? [];
  const activeJobCount = jobs.filter(j => ACTIVE_JOB_STATUSES.has(j.status)).length;
  const invoiceCount = invoices.length;
  // archived_at set OR is_active explicitly false => archived (reversible state).
  const isArchived = Boolean(customer.archived_at) || customer.is_active === false;

  // Undo-send (email slice 7): Send closes the composer immediately and
  // queues the real POST behind a cancellable window instead of firing it on
  // click - see useUndoSend's doc in ComposeWindow.tsx. A send that ultimately
  // fails (after the window elapses) can no longer reopen the composer with
  // the draft intact the way the old synchronous error path did - the window
  // already closed by then, same as real Gmail undo-send - so it surfaces as
  // a destructive toast instead.
  function sendCompose() {
    if (!compose) return;
    const to = compose.to.trim();
    if (!to) {
      toast({ description: 'Add a recipient first' });
      return;
    }
    const draft = compose;
    setCompose(null);
    const body = draft.body.trim() ? draft.body.split(/\n{2,}/) : ['(no content)'];
    const atts = draft.attachments ?? [];

    undoComposeSend.schedule(draft, () => {
      sendEmail.mutate(
        {
          to,
          cc: draft.cc || undefined,
          bcc: draft.bcc || undefined,
          subject: draft.subject.trim() || '(no subject)',
          body,
          customer_id: customer.id,
          files: atts.map((a) => a.file).filter((f): f is File => Boolean(f)),
        },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['customer-communications', id] });
            toast({ description: `Email sent to ${to}` });
          },
          onError: (err) => {
            // A 403 (caller lacks `create Communication`), a validation error,
            // or the customer-guard 404 must not fail silently.
            toast({
              title: 'Email not sent',
              description: extractApiError(err, 'Your email could not be sent. Please try again.'),
              variant: 'destructive',
            });
          },
        },
      );
    });

    toast({
      description: `Sending to ${to} in 10s`,
      // The undo button must stay on screen for the FULL cancellable window -
      // the shadcn toast's own default (4s) is shorter than
      // UNDO_SEND_WINDOW_MS (10s), which would silently make Undo unclickable
      // for the last 6 seconds while the toast still claimed "in 10s".
      duration: UNDO_SEND_WINDOW_MS,
      action: (
        <ToastAction
          altText="Undo send"
          onClick={() => {
            const restored = undoComposeSend.undo();
            if (restored) setCompose(restored);
          }}
        >
          Undo
        </ToastAction>
      ),
    });
  }

  // Breadcrumb context to pass when navigating to child entities
  const displayName = customerDisplayName(customer);
  const customerBreadcrumbs: BreadcrumbItem[] = [
    { label: 'Customers', href: '/customers' },
    { label: displayName, href: `/customers/${id}` },
  ];
  const navWithBreadcrumbs = (path: string) =>
    navigate(path, { state: { breadcrumbs: customerBreadcrumbs } });

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <Breadcrumb items={[
        { label: 'Customers', href: '/customers' },
        { label: displayName },
      ]} />

      {/* ── Hero Header ───────────────────────────────────── */}
      <div className="rounded-xl bg-surface-light p-6 shadow-card border border-border">
        <div className="flex items-start justify-between gap-4">
          {/* Avatar + name block */}
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16 shrink-0">
              <AvatarFallback tone="solid" className="text-xl font-bold">
                {customer.first_name || customer.last_name
                  ? getInitials(`${customer.first_name || ''} ${customer.last_name || ''}`)
                  : (customer.company_name?.[0] ?? '?').toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div>
              <Heading level={1} scale="2xl" className="flex items-baseline gap-2">
                <RecordNumberEditor
                  entity="customer"
                  id={id!}
                  number={customer.customer_number}
                  canEdit={ability.can('renumber', 'Customer')}
                  onRenamed={() => queryClient.invalidateQueries({ queryKey: ['customer', id] })}
                />
                <span aria-hidden="true" className="text-text-soft">·</span>
                <span>{displayName}</span>
              </Heading>
              <div className="flex flex-wrap items-center gap-2 mt-1">
                {customer.company_name && (customer.first_name || customer.last_name) && (
                  <p className="text-sm text-text-secondary">{customer.company_name}</p>
                )}
                {isArchived && (
                  <Badge intent="warning">
                    Archived
                  </Badge>
                )}
                {customer.ad_source && (
                  <Badge
                    variant="outline"
                    className={cn(getAdSourceStyle(customer.ad_source))}
                  >
                    {customer.ad_source}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-text-secondary mt-1">
                Member since {new Date(customer.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
              </p>
              <div className="mt-2">
                <TagInput entityType="CUSTOMER" entityId={id!} tags={customer.tags ?? []} />
              </div>
            </div>
          </div>

          {/* Action buttons — exactly two controls: Create New + three-dot menu */}
          <div className="flex items-center gap-2 shrink-0">
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="solid" tone="business" size="sm">
                    <Plus className="mr-2 h-4 w-4" />
                    Create New
                    <ChevronDown className="ml-2 h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canCreateLead && (
                    <DropdownMenuItem onClick={() => navWithBreadcrumbs(`/leads/new?customer_id=${id}`)}>
                      <Target className="mr-2 h-4 w-4" />
                      Lead
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => navWithBreadcrumbs(`/estimates/new?customer_id=${id}`)}>
                    <ClipboardList className="mr-2 h-4 w-4" />
                    Estimate
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navWithBreadcrumbs(`/jobs/new?customer_id=${id}`)}>
                    <Briefcase className="mr-2 h-4 w-4" />
                    Job
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navWithBreadcrumbs(`/invoices/new?customer_id=${id}`)}>
                    <Receipt className="mr-2 h-4 w-4" />
                    Invoice
                  </DropdownMenuItem>
                  {canCreateServicePlan && (
                    <DropdownMenuItem onClick={() => setPlanBuilderOpen(true)}>
                      <CreditCard className="mr-2 h-4 w-4" />
                      Service Plan
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {showActionsMenu && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" className="h-8 w-8">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canEdit && (
                    <DropdownMenuItem onClick={() => navigate(`/customers/${id}/edit`)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit client
                    </DropdownMenuItem>
                  )}
                  {canForcePurge && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => { setConfirmText(''); setPurgeOpen(true); }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete client
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        {/* KPI strip — 10 metrics */}
        <Separator className="my-5" />
        <div className="grid grid-cols-2 gap-6 lg:grid-cols-5">
          <div>
            <p className="text-xs text-text-secondary uppercase tracking-wide font-medium">
              Lifetime Revenue
            </p>
            {summaryLoading ? (
              <div className="h-7 w-20 bg-background-light rounded animate-pulse mt-1" />
            ) : (
              <p className="text-2xl font-bold text-success mt-1">
                {formatCurrency(summary?.financials.lifetime_revenue ?? 0)}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-text-secondary uppercase tracking-wide font-medium">
              Past Due
            </p>
            {summaryLoading ? (
              <div className="h-7 w-20 bg-background-light rounded animate-pulse mt-1" />
            ) : (
              <p className={cn('text-2xl font-bold mt-1',
                (summary?.financials.past_due_balance ?? 0) > 0 ? 'text-danger' : 'text-success'
              )}>
                {(summary?.financials.past_due_balance ?? 0) > 0
                  ? formatCurrency(summary!.financials.past_due_balance)
                  : 'None'}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-text-secondary uppercase tracking-wide font-medium">
              Due
            </p>
            {summaryLoading ? (
              <div className="h-7 w-20 bg-background-light rounded animate-pulse mt-1" />
            ) : (
              <p className={cn('text-2xl font-bold mt-1',
                (summary?.financials.due_balance ?? 0) > 0 ? 'text-text-primary' : 'text-success'
              )}>
                {(summary?.financials.due_balance ?? 0) > 0
                  ? formatCurrency(summary!.financials.due_balance)
                  : 'Paid up'}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-text-secondary uppercase tracking-wide font-medium">
              Active Jobs
            </p>
            <p className="text-2xl font-bold text-text-primary mt-1">{activeJobCount}</p>
          </div>
          <div>
            <p className="text-xs text-text-secondary uppercase tracking-wide font-medium">
              Pending Estimates
            </p>
            {summaryLoading ? (
              <div className="h-7 w-10 bg-background-light rounded animate-pulse mt-1" />
            ) : (
              <p className="text-2xl font-bold text-text-primary mt-1">
                {summary?.estimates.pending ?? 0}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-text-secondary uppercase tracking-wide font-medium">
              Total Jobs
            </p>
            <p className="text-2xl font-bold text-text-primary mt-1">
              {customer._count?.jobs ?? 0}
            </p>
          </div>
          <div>
            <p className="text-xs text-text-secondary uppercase tracking-wide font-medium">
              Open Leads
            </p>
            {summaryLoading ? (
              <div className="h-7 w-10 bg-background-light rounded animate-pulse mt-1" />
            ) : (
              <p className="text-2xl font-bold text-text-primary mt-1">
                {summary?.leads?.open ?? 0}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-text-secondary uppercase tracking-wide font-medium">
              Active Leads
            </p>
            {summaryLoading ? (
              <div className="h-7 w-10 bg-background-light rounded animate-pulse mt-1" />
            ) : (
              <p className="text-2xl font-bold text-text-primary mt-1">
                {summary?.leads?.active ?? 0}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-text-secondary uppercase tracking-wide font-medium">
              Open Tasks
            </p>
            {summaryLoading ? (
              <div className="h-7 w-10 bg-background-light rounded animate-pulse mt-1" />
            ) : (
              <p className="text-2xl font-bold text-text-primary mt-1">
                {summary?.tasks?.open ?? 0}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-text-secondary uppercase tracking-wide font-medium">
              Invoices
            </p>
            <p className="text-2xl font-bold text-text-primary mt-1">{invoiceCount}</p>
          </div>
        </div>
      </div>

      {/* ── Body: sidebar + main in one connected card ──── */}
      <div className="rounded-xl bg-surface-light shadow-card border border-border overflow-hidden">
        <div className="flex flex-col lg:flex-row">

          {/* Left Sidebar */}
          <div className="w-full shrink-0 lg:w-72 lg:border-r border-border">

            {/* Contact Details */}
            <div className="p-5 space-y-4">
              {/* eyebrow style, no matching Heading variant - left raw */}
              <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                Contact Details
              </h2>

              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <Phone className="h-4 w-4 text-text-secondary mt-0.5 shrink-0" />
                  <div className="text-sm">
                    {canUseComms ? (
                      // hover-to-primary+underline contact trigger with a no-underline (not faded) disabled
                      // state - no matching Button variant/tone cell, Button's disabled treatment differs - left raw
                      <button
                        type="button"
                        disabled={!customer.phone}
                        onClick={() =>
                          requestCall(customer.phone, {
                            customerId: customer.id,
                            customerName: displayName,
                          })
                        }
                        className="text-left text-text-primary hover:text-primary hover:underline underline-offset-2 disabled:no-underline disabled:cursor-default"
                      >
                        {formatPhone(customer.phone)}
                        {customer.phone_ext ? ` ext. ${customer.phone_ext}` : ''}
                      </button>
                    ) : customer.phone ? (
                      <a
                        href={`tel:${customer.phone}`}
                        className="block text-left text-text-primary hover:text-primary hover:underline underline-offset-2"
                      >
                        {formatPhone(customer.phone)}
                        {customer.phone_ext ? ` ext. ${customer.phone_ext}` : ''}
                      </a>
                    ) : (
                      <span className="block text-left text-text-primary">
                        {formatPhone(customer.phone)}
                      </span>
                    )}
                    <p className="text-xs text-text-secondary">Primary</p>
                  </div>
                </div>

                {customer.secondary_phone && (
                  <div className="flex items-start gap-3">
                    <Phone className="h-4 w-4 text-text-secondary mt-0.5 shrink-0" />
                    <div className="text-sm">
                      {canUseComms ? (
                        // hover-to-primary+underline contact trigger, no matching Button variant/tone cell - left raw
                        <button
                          type="button"
                          onClick={() =>
                            requestCall(customer.secondary_phone, {
                              customerId: customer.id,
                              customerName: displayName,
                            })
                          }
                          className="text-left text-text-primary hover:text-primary hover:underline underline-offset-2"
                        >
                          {formatPhone(customer.secondary_phone)}
                          {customer.secondary_phone_ext ? ` ext. ${customer.secondary_phone_ext}` : ''}
                        </button>
                      ) : (
                        <a
                          href={`tel:${customer.secondary_phone}`}
                          className="block text-left text-text-primary hover:text-primary hover:underline underline-offset-2"
                        >
                          {formatPhone(customer.secondary_phone)}
                          {customer.secondary_phone_ext ? ` ext. ${customer.secondary_phone_ext}` : ''}
                        </a>
                      )}
                      <p className="text-xs text-text-secondary">Secondary</p>
                    </div>
                  </div>
                )}

                {/* Gated on EITHER source, not on the primary alone: extra_emails[] rows
                    used to be nested inside a `customer.email &&`, so a customer whose
                    only addresses were secondary rendered no email row at all - and with
                    the per-address opt-in, one of those can be the sole recipient of the
                    org's automated mail. Boolean() keeps a 0-length array from leaking a
                    literal "0" into the card. */}
                {Boolean(customer.email || customer.extra_emails?.length) && (
                  <div className="flex items-start gap-3">
                    <Mail className="h-4 w-4 text-text-secondary mt-0.5 shrink-0" />
                    <div className="space-y-1 min-w-0">
                      {customer.email &&
                        (canUseComms ? (
                          // hover-to-primary+underline contact trigger, no matching Button variant/tone cell - left raw
                          <button
                            type="button"
                            onClick={() => setCompose({ mode: 'new', account: PRIMARY_ACCOUNT.id, to: customer.email, subject: '', body: '', customerId: customer.id })}
                            className="text-left text-sm text-text-primary break-all hover:text-primary hover:underline underline-offset-2"
                          >
                            {customer.email}
                          </button>
                        ) : (
                          <a
                            href={`mailto:${customer.email}`}
                            className="block text-left text-sm text-text-primary break-all hover:text-primary hover:underline underline-offset-2"
                          >
                            {customer.email}
                          </a>
                        ))}
                      {customer.extra_emails?.map((e: { id: string; email: string; label?: string | null; receives_emails?: boolean }) => (
                        <div key={e.id} className="flex items-center gap-1.5">
                          {canUseComms ? (
                            // hover-to-primary+underline contact trigger, no matching Button variant/tone cell - left raw
                            <button
                              type="button"
                              onClick={() => setCompose({ mode: 'new', account: PRIMARY_ACCOUNT.id, to: e.email, subject: '', body: '', customerId: customer.id })}
                              className="text-left text-sm text-text-primary break-all hover:text-primary hover:underline underline-offset-2"
                            >
                              {e.email}
                            </button>
                          ) : (
                            <a
                              href={`mailto:${e.email}`}
                              className="text-left text-sm text-text-primary break-all hover:text-primary hover:underline underline-offset-2"
                            >
                              {e.email}
                            </a>
                          )}
                          {e.label && (
                            <span className="text-[10px] px-1.5 py-0 rounded bg-background-light text-text-secondary font-medium">
                              {e.label}
                            </span>
                          )}
                          {/* Without this the only way to tell who gets the walkthrough
                              confirmation is to open the edit form. Same tag treatment as
                              the label above; absent (not a greyed "off" tag) when opted
                              out, so the card stays quiet in the common case. */}
                          {e.receives_emails && (
                            <span className="text-[10px] px-1.5 py-0 rounded bg-background-light text-text-secondary font-medium">
                              Auto-emails
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {customer.company_name && (
                  <div className="flex items-start gap-3">
                    <Building2 className="h-4 w-4 text-text-secondary mt-0.5 shrink-0" />
                    <span className="text-sm text-text-primary">{customer.company_name}</span>
                  </div>
                )}
              </div>

              {(customer.ad_source || customer.payment_type || customer.allow_billing || customer.tax_exempt) && (
                <>
                  <Separator />
                  <div className="space-y-2.5">
                    {customer.ad_source && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text-secondary">Ad Source</span>
                        <Badge
                          variant="outline"
                          className={cn(getAdSourceStyle(customer.ad_source))}
                        >
                          {customer.ad_source}
                        </Badge>
                      </div>
                    )}
                    {customer.payment_type && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-text-secondary">Form of Payment</span>
                        <span className="text-text-primary text-xs font-medium">{customer.payment_type}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-text-secondary">Allow Billing</span>
                      {customer.allow_billing ? (
                        <span className="flex items-center gap-1 text-success text-xs font-medium">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Yes
                        </span>
                      ) : (
                        <span className="text-text-secondary text-xs">No</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-text-secondary">Tax Exempt</span>
                      {customer.tax_exempt ? (
                        <span className="flex items-center gap-1 text-success text-xs font-medium">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Yes
                        </span>
                      ) : (
                        <span className="text-text-secondary text-xs">No</span>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Divider */}
            <div className="border-t border-border" />

            {/* Service Locations */}
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                {/* eyebrow style, no matching Heading variant - left raw */}
                <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">
                  Service Locations
                </h2>
                {canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditingLocation(null);
                      setLocationDialogOpen(true);
                    }}
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Add
                  </Button>
                )}
              </div>

              {customer.service_locations?.length === 0 ? (
                <p className="text-sm text-text-secondary">No locations added.</p>
              ) : (
                <div className="space-y-3">
                  {customer.service_locations?.map((loc: Location) => (
                    <div
                      key={loc.id}
                      className="flex items-start justify-between rounded-lg border border-border p-3"
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        <MapPin className="mt-0.5 h-4 w-4 text-text-secondary shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm text-text-primary">
                            {loc.address_line1}
                            {loc.address_line2 ? `, ${loc.address_line2}` : ''}
                          </p>
                          <p className="text-xs text-text-secondary">
                            {loc.city}, {loc.state} {loc.zip}
                          </p>
                          {loc.is_primary && (
                            <span className="mt-1 inline-flex items-center gap-1 text-xs text-primary font-medium">
                              <Star className="h-3 w-3" /> Primary
                            </span>
                          )}
                        </div>
                      </div>
                      {canEdit && (
                        <div className="flex gap-1 shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            disabled={loc.is_primary || setPrimaryLocationMutation.isPending}
                            aria-label={loc.is_primary ? 'Primary location' : 'Set as primary location'}
                            title={loc.is_primary ? 'Primary location' : 'Set as primary'}
                            onClick={() => setPrimaryLocationMutation.mutate(loc.id)}
                          >
                            <Star className={cn('h-3 w-3', loc.is_primary && 'fill-current text-primary')} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => {
                              setEditingLocation(loc);
                              setLocationDialogOpen(true);
                            }}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          {canDeleteLocation && (
                            <Button
                              variant="ghost" tone="danger"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => deleteLocationMutation.mutate(loc.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Org-defined custom fields. Renders nothing at all unless this org has defined
                at least one CUSTOMER-scoped field, so the sidebar is unchanged for everyone
                else - it draws its own top divider rather than relying on a sibling. */}
            <ExtraInfoPanel
              entityType="CUSTOMER"
              entityId={id!}
              values={(customer.custom_fields as Record<string, unknown> | undefined) ?? {}}
              onSave={(patch) => customFieldsMutation.mutateAsync({ custom_fields: patch })}
              variant="plain"
            />
          </div>

          {/* Main Content — Tabs. Phase 11.6 retired DetailPageShell's
              `railWrapperClassName`/`listClassName` - TabStrip has no
              equivalent. `railWrapperClassName="border-b border-border"` is
              dropped without a replacement: TabsList's own default
              `variant="line"` already carries that exact border-b itself, so
              the wrapper was a redundant, visually-overlapping second copy
              of the same line, not a distinct one. `-mb-px`/`h-auto`/`w-full`
              /`p-0` from `listClassName` are likewise redundant with the
              defaults TabStrip already renders (no wrapper div sizing to
              reconcile, no padding prop passed). `gap-0` is the one real,
              disclosed loss: this tab row is `flex-1` triggers meant to sit
              flush against each other with no gutter, and TabsList's default
              `gap-[26px]` has no override path on TabStrip, so a 26px gap
              between tabs reappears here - a genuine, accepted visual
              difference, not a no-op. */}
          <div className="flex-1 min-w-0 lg:border-t-0 border-t border-border">
          <TabStrip
            active={effectiveTab}
            onChange={setActiveTab}
            triggerVariant="underline-fill"
            triggerClassName="flex-1 px-4"
            tabs={[
              ...(hasLeads
                ? [
                    {
                      value: 'leads',
                      label: (
                        <>
                          <span className="inline-flex items-center gap-1.5">
                            <Target className="h-3.5 w-3.5" />
                            <span>Leads</span>
                          </span>
                          <span className="text-[10px] font-normal opacity-70">
                            {customer._count?.leads ?? 0} lead{(customer._count?.leads ?? 0) !== 1 ? 's' : ''}
                          </span>
                        </>
                      ),
                    },
                  ]
                : []),
              {
                value: 'estimates',
                label: (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <ClipboardList className="h-3.5 w-3.5" />
                      <span>Estimates</span>
                    </span>
                    <span className="text-[10px] font-normal opacity-70">
                      {/* From the customer summary (a direct COUNT over Estimate.customer_id), not
                          from the lazily-loaded list - so the count is right on first paint and
                          does not depend on the Pro-gated leads query. Mirrors how the Leads and
                          Jobs triggers above read customer._count. */}
                      {summary ? `${summary.estimates.total} estimate${summary.estimates.total !== 1 ? 's' : ''}` : '—'}
                    </span>
                  </>
                ),
              },
              {
                value: 'jobs',
                label: (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <Briefcase className="h-3.5 w-3.5" />
                      <span>Jobs</span>
                    </span>
                    <span className="text-[10px] font-normal opacity-70">
                      {customer._count?.jobs ?? 0} job{(customer._count?.jobs ?? 0) !== 1 ? 's' : ''}
                    </span>
                  </>
                ),
              },
              {
                value: 'invoices',
                label: (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <Receipt className="h-3.5 w-3.5" />
                      <span>Invoices</span>
                    </span>
                    <span className="text-[10px] font-normal opacity-70">
                      {(() => { const n = invoices.length; return `${n} invoice${n !== 1 ? 's' : ''}`; })()}
                    </span>
                  </>
                ),
              },
              {
                value: 'payments',
                label: (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <CreditCard className="h-3.5 w-3.5" />
                      <span>Payments</span>
                    </span>
                    <span className="text-[10px] font-normal opacity-70">
                      {(() => { const n = invoices.reduce((sum, inv) => sum + (inv.payments?.length ?? 0), 0); return `${n} payment${n !== 1 ? 's' : ''}`; })()}
                    </span>
                  </>
                ),
              },
              {
                value: 'notes',
                label: (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <StickyNote className="h-3.5 w-3.5" />
                      <span>Notes</span>
                    </span>
                    <span className="text-[10px] font-normal opacity-70">
                      {notes.length} note{notes.length !== 1 ? 's' : ''}
                    </span>
                  </>
                ),
              },
              {
                value: 'tasks',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <CheckSquare className="h-3.5 w-3.5" />
                    <span>Tasks</span>
                  </span>
                ),
              },
              ...(canReadComms
                ? [
                    {
                      value: 'communications',
                      label: (
                        <>
                          <span className="inline-flex items-center gap-1.5">
                            <MessageSquare className="h-3.5 w-3.5" />
                            <span>Comms</span>
                          </span>
                          <span className="text-[10px] font-normal opacity-70">across channels</span>
                        </>
                      ),
                    },
                  ]
                : []),
            ]}
          >
            <TabsContent value="leads" className="p-6 mt-0">
              <LeadsTab leads={leads} onNavigate={(lid) => navWithBreadcrumbs(`/leads/${lid}`)} />
            </TabsContent>
            <TabsContent value="estimates" className="p-6 mt-0">
              <EstimatesTab
                estimates={estimates}
                isLoading={estimatesLoading}
                onNavigate={(eid) => navWithBreadcrumbs(`/estimates/${eid}`)}
              />
            </TabsContent>
            <TabsContent value="jobs" className="p-6 mt-0">
              <JobsTab jobs={jobs} onNavigate={(jid) => navWithBreadcrumbs(`/jobs/${jid}`)} />
            </TabsContent>
            <TabsContent value="invoices" className="p-6 mt-0">
              {ability.can('read', 'Invoice') && (
                <div className="mb-4 flex justify-end">
                  <Link
                    to={`/customers/${id}/statement`}
                    state={{ breadcrumbs: customerBreadcrumbs }}
                  >
                    <Button variant="outline" size="sm">
                      <FileText className="mr-2 h-4 w-4" />
                      View Statement
                    </Button>
                  </Link>
                </div>
              )}
              <InvoicesTab invoices={invoices} />
            </TabsContent>
            <TabsContent value="payments" className="p-6 mt-0">
              <PaymentsTab invoices={invoices} />
            </TabsContent>
            <TabsContent value="notes" className="p-6 mt-0">
              <NotesTab notes={notes} customerId={id!} />
            </TabsContent>
            <TabsContent value="tasks" className="mt-0">
              <JobLeadTasksTab
                entity={{ type: 'CUSTOMER', id: customer.id, label: displayName }}
              />
            </TabsContent>
            {/* Radix only mounts the active TabsContent (no forceMount), so the
                communications query is naturally deferred until the tab opens. */}
            {canReadComms && (
              <TabsContent value="communications" className="p-6 mt-0">
                <CustomerCommunicationsTab customerId={id!} />
              </TabsContent>
            )}
          </TabStrip>
          </div>
        </div>
      </div>

      {/* ── Dialogs ───────────────────────────────────────── */}
      <LocationFormDialog
        open={locationDialogOpen}
        onOpenChange={setLocationDialogOpen}
        customerId={id!}
        location={editingLocation}
      />

      {compose && (
        <ComposeWindow
          state={compose}
          onChange={setCompose}
          onSend={sendCompose}
          onClose={() => setCompose(null)}
          onDiscard={() => setCompose(null)}
          onToast={(m) => toast({ description: m })}
          fromAddress={sendingIdentity?.address}
          sendingEnabled={sendingIdentity?.sendingEnabled ?? true}
        />
      )}

      {/* Force-purge — type the customer number to confirm. One-shot: the backend
          warns about financial records AND deletes in the same call (no dry-run). */}
      <Dialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Customer</DialogTitle>
            <DialogDescription>
              This permanently destroys {displayName} and ALL associated financial
              records (leads, estimates, jobs, invoices, payments). This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Type the customer number{' '}
              <span className="font-mono font-semibold text-text-primary">
                {customer.customer_number ?? '—'}
              </span>{' '}
              to confirm.
            </p>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={customer.customer_number ?? 'Customer number'}
            />
            {purgeMutation.error && (
              <p className="text-sm text-danger">
                {extractApiError(purgeMutation.error, 'Failed to purge')}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => setPurgeOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="solid" tone="danger"
              onClick={() => purgeMutation.mutate()}
              disabled={purgeMutation.isPending || confirmText !== customer.customer_number}
            >
              {purgeMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* New Service Plan — reuses the Service Plans page builder with this customer preset.
          key={id} remounts (fresh preset state) when navigating between customer profiles. */}
      {canCreateServicePlan && (
        <PlanBuilderDialog
          key={id}
          open={planBuilderOpen}
          onOpenChange={setPlanBuilderOpen}
          presetCustomerId={id}
          presetCustomerLabel={displayName}
        />
      )}
    </div>
  );
}
