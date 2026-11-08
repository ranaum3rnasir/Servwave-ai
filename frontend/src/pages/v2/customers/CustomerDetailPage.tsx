import { useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Briefcase, Building2, CheckCircle2, ChevronDown, ClipboardList,
  CreditCard, FileText, Mail, MapPin, MoreHorizontal, Pencil,
  Phone, Plus, Receipt, Star, Target, Trash2,
} from 'lucide-react';

import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { useAppAbility } from '@/contexts/AbilityContext';
import { RecordNumberEditor } from '@/components/crm/RecordNumberEditor';
import { purgeCustomer } from '@/lib/api/customers';
import { customerDisplayName } from '@/lib/customer-name';
import { extractApiError, formatCurrency, formatPhone } from '@/lib/utils';
import { useFeature, useModuleAccess } from '@/lib/entitlements';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import {
  useSendEmail, useSendingIdentity, PRIMARY_ACCOUNT, type ComposeState,
} from '@/lib/api/communication';
import { TagInput } from '@/components/leads/TagInput';
import { ComposeWindow } from '@/components/communication/inbox/ComposeWindow';
import { CustomerCommunicationsTab } from '@/components/communication/CustomerCommunicationsTab';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import { PlanBuilderDialog } from '../_shared/planBuilderDialog';

import { Avatar } from '@/ui-kit/components/ui/avatar';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Card } from '@/ui-kit/components/ui/card';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Input } from '@/ui-kit/components/ui/input';
import { Separator } from '@/ui-kit/components/ui/separator';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { toast } from '@/ui-kit/components/ui/sonner';

import { v2Path, preferV2Path } from '../uiV2';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { LocationFormDialog } from './components/locationFormDialog';
import { useRecordVisit } from '../pageBreadcrumbs';
import {
  EstimatesTab, InvoicesTab, JobsTab, LeadsTab, NotesTab, PaymentsTab,
  type CustomerEstimate, type CustomerInvoice, type DetailLocation, type FinancialSummary,
  type JobSummary, type LeadSummary, type NoteSummary,
} from './components/detailTabs';
import { useCustomerListPage } from './useCustomerListPage';
import {
  EventDetailDialog, ScheduleTab, type CalendarEntrySummary,
} from './components/scheduleTab';
import { projectCustomerSchedule, type CustomerSchedule } from '@/lib/customers/customerSchedule';

/** One KPI cell of the hero strip. */
function Kpi({ label, value, loading }: { label: string; value: React.ReactNode; loading?: boolean }) {
  return (
    <div>
      <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">{label}</p>
      {loading
        ? <Skeleton className="mt-1 h-7 w-16" />
        : <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>}
    </div>
  );
}

/** One label/value row of the left sidebar. */
function SidebarRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const YES = (
  <span className="text-status-green inline-flex items-center gap-1 text-xs font-medium">
    <CheckCircle2 className="size-3.5" /> Yes
  </span>
);
const NO = <span className="text-muted-foreground text-xs">No</span>;

/**
 * The native `tel:` / `mailto:` fallback, without a raw `<a>`.
 *
 * The design-system raw-tag ratchet sits at its floor for `a`, so a v2 page may
 * not add one; a kit Button that sets `window.location.href` reaches the same
 * destination. Same precedent as the leads module's ContactCell.
 */
function openHref(href: string) {
  window.location.href = href;
}

/**
 * /v2/customers/:id - the customer detail page on the CRM UI kit.
 *
 * Every query, mutation, cache key, ability gate and entitlement check is the
 * legacy page's. Five embedded sub-systems are reused rather than rebuilt -
 * TagInput, ComposeWindow, CustomerCommunicationsTab, JobLeadTasksTab and the
 * PlanBuilderDialog now promoted to `_shared/` - because each owns behaviour
 * belonging to shared infrastructure or to another module's migration, and
 * rebuilding them here would fork it. Recorded in the ledger.
 *
 * Two things are worth naming because they read like typos and are not:
 *  - polymorphic notes arrive as `activity_notes`; `customer.notes` is the
 *    scalar free-text column the edit form owns.
 *  - `effectiveTab` exists because Leads is the landing tab but is Pro-gated;
 *    it is derived per render, not seeded into state, since `useFeature` fails
 *    OPEN while org_features hydrates and the answer can flip after first paint.
 */
export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const ability = useAppAbility();
  const canAccessComms = useFeature('phone');
  const hasLeads = useFeature('leads');
  const sendEmail = useSendEmail();
  // The composer's From identity comes from the org's own connected mailbox.
  // The Gmail connect surface was deleted upstream; the org now sends from its
  // own verified sender identity.
  const { data: sendingIdentity } = useSendingIdentity();
  const [compose, setCompose] = useState<ComposeState | null>(null);

  const [purgeOpen, setPurgeOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [locationDialogOpen, setLocationDialogOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<DetailLocation | null>(null);
  const [viewingEvent, setViewingEvent] = useState<CalendarEntrySummary | null>(null);
  const [activeTab, setActiveTab] = useState('leads');
  // Only Leads is gated on the `leads` entitlement. Schedule is not: it lists every visit of the
  // customer's jobs one row each (visits slice 04), which an org without leads needs as much as
  // one with them; the server simply leaves the walkthrough rows out for such an org.
  const effectiveTab = !hasLeads && activeTab === 'leads' ? 'estimates' : activeTab;
  // Create New offers two entries belonging to Pro modules while Customers is
  // Starter core: /api/leads and /api/service-plans are both behind
  // requireFeature, so on a Starter org those actions can only 402.
  const canCreateLead = useModuleAccess('leads', 'create', 'Lead');
  const canCreateServicePlan = useModuleAccess('service_plans', 'create', 'ServicePlan');
  const [planBuilderOpen, setPlanBuilderOpen] = useState(false);

  // Query 1: core customer data (fast - no leads included).
  const { data, isLoading } = useQuery({
    queryKey: ['customer', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${id}`);
      return { customer: data.customer, summary: data.summary as FinancialSummary };
    },
    enabled: Boolean(id),
  });

  // Named from the loaded record, and called BEFORE the loading and not-found
  // early returns further down - a hook placed after a conditional return is a
  // hook that sometimes does not run. It names the crumb "Customers" until the
  // record lands and renames it in place after.
  useRecordVisit('clients', data?.customer?.name);

  // Query 2: leads, one numbered page at a time (visits slice 06) - lazy, and gated on the
  // entitlement because /api/leads is behind requireFeature('leads') while Customers is Starter core.
  const leadsPage = useCustomerListPage<LeadSummary>({
    list: 'customer-leads',
    customerId: id!,
    enabled: Boolean(id) && hasLeads && effectiveTab === 'leads',
    fetchPage: async (page, limit) => {
      const { data } = await api.get('/api/leads', { params: { customer_id: id, page, limit } });
      return { rows: data.leads, total: data.pagination.total };
    },
  });

  // Query 2a: jobs, one numbered page at a time (visits slice 06). The detail payload embeds only
  // the newest 20; this pages through all of them, row-scoped the same way as the schedule feed.
  const jobsPage = useCustomerListPage<JobSummary>({
    list: 'customer-jobs',
    customerId: id!,
    enabled: Boolean(id) && effectiveTab === 'jobs',
    fetchPage: async (page, limit) => {
      const { data } = await api.get(`/api/customers/${id}/jobs`, { params: { page, limit } });
      return { rows: data.jobs, total: data.pagination.total };
    },
  });

  // Query 2b: every visit of every job and lead (visits slice 04) - GET /api/customers/:id/schedule,
  // unpaged, row-scoped and rate-limited on the server, so it is fetched ONLY while the Schedule
  // tab is open. The Jobs and Leads tabs print their one date per row from their own pages
  // (`scheduled_start`, `next_walkthrough`), computed on the server by the rules that pick one of
  // these same visits. The server leaves lead visits out for an org without the leads entitlement.
  const {
    data: scheduleData, isError: scheduleError, refetch: refetchSchedule,
  } = useQuery({
    queryKey: ['customer-schedule', id],
    queryFn: async (): Promise<CustomerSchedule> => {
      const { data } = await api.get(`/api/customers/${id}/schedule`);
      return { jobs: data.jobs ?? [], leads: data.leads ?? [] };
    },
    enabled: Boolean(id) && effectiveTab === 'schedule',
  });
  const visitRows = useMemo(() => (scheduleData ? projectCustomerSchedule(scheduleData) : []), [scheduleData]);
  // Data wins over a failed background refetch; with no data, an error is an error, not "empty".
  const scheduleStatus = scheduleData ? 'ready' : scheduleError ? 'error' : 'loading';
  const timeZone = useScheduleTimezone();

  // Query 3: estimates - read straight from /api/estimates on the direct
  // Estimate.customer_id column, so lead-, customer- and job-anchored estimates
  // all appear. Keyed on `effectiveTab`, NOT `activeTab`.
  const { data: estimatesData, isLoading: estimatesLoading } = useQuery({
    queryKey: ['customer-estimates', id],
    queryFn: async () => {
      const { data } = await api.get('/api/estimates', { params: { customer_id: id, limit: 50 } });
      return data.estimates as CustomerEstimate[];
    },
    enabled: Boolean(id) && effectiveTab === 'estimates',
  });

  // Query 4: Events (slice 10) - GET /api/calendar-entries?customer_id=, gated on BOTH the
  // Schedule tab being open AND `read CalendarEntry`: a viewer without the grant never fires
  // this request at all (never a 403 to swallow), same shape as the existing canReadComms gate
  // on the Comms tab below.
  const canReadEvents = ability.can('read', 'CalendarEntry');
  const { data: calendarEntriesData } = useQuery({
    queryKey: ['customer-calendar-entries', id],
    queryFn: async () => {
      const { data } = await api.get('/api/calendar-entries', { params: { customer_id: id } });
      return data.calendar_entries as CalendarEntrySummary[];
    },
    enabled: Boolean(id) && canReadEvents && effectiveTab === 'schedule',
  });

  const summary = data?.summary;
  const summaryLoading = isLoading;

  // Force-purge - destructive, one-shot type-to-confirm.
  const purgeMutation = useMutation({
    mutationFn: () => purgeCustomer(id!, { confirm: confirmText }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customer-stats'] });
      navigate(v2Path('/customers'));
    },
  });

  const deleteLocationMutation = useMutation({
    mutationFn: (locId: string) => api.delete(`/api/customers/${id}/locations/${locId}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['customer', id] }); },
  });

  const setPrimaryLocationMutation = useMutation({
    mutationFn: (locId: string) =>
      api.patch(`/api/customers/${id}/locations/${locId}`, { is_primary: true }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['customer', id] }); },
  });

  const canEdit = user?.role === 'ADMIN' || user?.role === 'DISPATCHER' || user?.role === 'SALES';
  // Service-location delete stays role-gated.
  const canDeleteLocation = user?.role === 'ADMIN' || user?.role === 'DISPATCHER';
  const canReadComms = ability.can('read', 'Communication');
  // The in-app dialer / email composer render only for comms-enabled orgs with
  // create Communication; everyone else falls back to tel:/mailto:, which can
  // never 403.
  const canUseComms = canAccessComms && ability.can('create', 'Communication');
  const canForcePurge = ability.can('force_purge', 'Customer');
  const showActionsMenu = canEdit || canForcePurge;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-64" />
        {/* Padding lives on an inner div, never as a className on Card: the
            component-API ratchet counts appearance handed to a shared primitive
            from a call site, and Card exposes no padding prop. */}
        <Card>
          <div className="p-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-4">
                <Skeleton className="size-16 rounded-full" />
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-8 w-52" />
                  <Skeleton className="h-4 w-36" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-8 w-8" />
              </div>
            </div>
            <Separator className="my-5" />
            <div className="grid grid-cols-2 gap-6 lg:grid-cols-5">
              {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="mt-1 h-7 w-16" />
                </div>
              ))}
            </div>
          </div>
        </Card>
        <Card className="overflow-hidden">
          <div className="flex flex-col lg:flex-row">
            <div className="flex w-full shrink-0 flex-col gap-4 border-b p-5 lg:w-72 lg:border-b-0 lg:border-r">
              <Skeleton className="h-3 w-28" />
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3">
                  <Skeleton className="mt-0.5 size-4 shrink-0" />
                  <Skeleton className="h-4 w-36" />
                </div>
              ))}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex gap-1 border-b px-2 py-2">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-20" />)}
              </div>
              <div className="flex flex-col gap-3 p-4">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
              </div>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  // No error-specific branch: a failed query falls into this case, exactly as
  // the legacy page.
  if (!data) {
    return (
      <Card>
        <div className="p-5 text-center">
          <p className="text-muted-foreground">Customer not found.</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate(v2Path('/customers'))}>
            Back to Customers
          </Button>
        </div>
      </Card>
    );
  }

  const customer = data.customer;

  const estimates: CustomerEstimate[] = estimatesData ?? [];
  const invoices: CustomerInvoice[] = customer.invoices ?? [];
  // Polymorphic Note rows arrive under `activity_notes`; the scalar `notes`
  // column is a separate free-text field the edit form owns.
  const notes: NoteSummary[] = customer.activity_notes ?? [];
  const invoiceCount = invoices.length;
  // archived_at set OR is_active explicitly false => archived (reversible).
  const isArchived = Boolean(customer.archived_at) || customer.is_active === false;

  function sendCompose() {
    if (!compose) return;
    const to = compose.to.trim();
    if (!to) {
      toast('Add a recipient first');
      return;
    }
    const body = compose.body.trim() ? compose.body.split(/\n{2,}/) : ['(no content)'];
    sendEmail.mutate(
      {

        to,
        subject: compose.subject.trim() || '(no subject)',
        body,
        customer_id: customer.id,
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['customer-communications', id] });
          toast(`Email sent to ${to}`);
          setCompose(null);
        },
        // A 403, a validation error or the customer-guard 404 must not leave the
        // composer open with no feedback. Surface it and KEEP the composer open
        // so the draft is not lost.
        onError: (err) => {
          toast.error('Email not sent', {
            description: extractApiError(err, 'Your email could not be sent. Please try again.'),
          });
        },
      },
    );
  }

  const displayName = customerDisplayName(customer);

  // No hand-assembled trail is pushed to child pages any more: the breadcrumb
  // is derived from the pages actually visited, so a child page ends up rooted
  // at this customer because the user came through it, not because this page
  // told it to say so. See `navHistory.store`.
  const navTo = (url: string) => navigate(preferV2Path(url));

  const phoneLabel = (value: string, ext?: string | null) =>
    `${formatPhone(value)}${ext ? ` ext. ${ext}` : ''}`;

  return (
    <div className="flex flex-col gap-4">

      {/* Hero */}
      <Card>
        <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <Avatar size="lg" name={displayName} />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                {/* role/aria-level rather than an <h1>: the design-system
                    raw-tag ratchet sits at its floor for h1-h6. */}
                <p role="heading" aria-level={1} className="flex items-baseline gap-2 text-xl font-semibold">
                  <RecordNumberEditor
                    entity="customer"
                    id={id!}
                    number={customer.customer_number}
                    canEdit={ability.can('renumber', 'Customer')}
                    onRenamed={() => queryClient.invalidateQueries({ queryKey: ['customer', id] })}
                  />
                  <span aria-hidden="true" className="text-muted-foreground">·</span>
                  <span>{displayName}</span>
                </p>
                {isArchived && <Badge variant="softAmber" size="pill">Archived</Badge>}
                {customer.ad_source && (
                  <Badge variant="softNeutral" size="pill">{customer.ad_source}</Badge>
                )}
              </div>
              {customer.company_name && (customer.first_name || customer.last_name) && (
                <p className="text-muted-foreground mt-1 text-sm">{customer.company_name}</p>
              )}
              <p className="text-muted-foreground mt-1 text-xs">
                Member since{' '}
                {new Date(customer.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
              </p>
              <div className="mt-2">
                <TagInput entityType="CUSTOMER" entityId={id!} tags={customer.tags ?? []} />
              </div>
            </div>
          </div>

          {/* Exactly two controls: Create New + the three-dot menu. */}
          <div className="flex shrink-0 items-center gap-2">
            {canEdit && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm">
                    <Plus />
                    Create New
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canCreateLead && (
                    <DropdownMenuItem onClick={() => navTo((`/leads/new?customer_id=${id}`))}>
                      <Target /> Lead
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => navTo((`/estimates/new?customer_id=${id}`))}>
                    <ClipboardList /> Estimate
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navTo((`/jobs/new?customer_id=${id}`))}>
                    <Briefcase /> Job
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navTo((`/invoices/new?customer_id=${id}`))}>
                    <Receipt /> Invoice
                  </DropdownMenuItem>
                  {canCreateServicePlan && (
                    <DropdownMenuItem onClick={() => setPlanBuilderOpen(true)}>
                      <CreditCard /> Service Plan
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {showActionsMenu && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon-sm" aria-label="Customer actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canEdit && (
                    <DropdownMenuItem onClick={() => navigate(v2Path(`/customers/${id}/edit`))}>
                      <Pencil /> Edit client
                    </DropdownMenuItem>
                  )}
                  {canForcePurge && (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => { setConfirmText(''); setPurgeOpen(true); }}
                    >
                      <Trash2 /> Delete client
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>

        <Separator className="my-5" />

        <div className="grid grid-cols-2 gap-6 lg:grid-cols-5">
          <Kpi label="Lifetime Revenue" loading={summaryLoading}
            value={formatCurrency(summary?.financials.lifetime_revenue ?? 0)} />
          <Kpi label="Past Due" loading={summaryLoading}
            value={(summary?.financials.past_due_balance ?? 0) > 0
              ? formatCurrency(summary!.financials.past_due_balance)
              : 'None'} />
          <Kpi label="Due" loading={summaryLoading}
            value={(summary?.financials.due_balance ?? 0) > 0
              ? formatCurrency(summary!.financials.due_balance)
              : 'Paid up'} />
          {/* Counted on the server across every page (the list itself is paged). */}
          <Kpi label="Active Jobs" loading={summaryLoading} value={summary?.jobs?.active ?? 0} />
          <Kpi label="Pending Estimates" loading={summaryLoading} value={summary?.estimates.pending ?? 0} />
          <Kpi label="Total Jobs" value={customer._count?.jobs ?? 0} />
          <Kpi label="Open Leads" loading={summaryLoading} value={summary?.leads?.open ?? 0} />
          <Kpi label="Active Leads" loading={summaryLoading} value={summary?.leads?.active ?? 0} />
          <Kpi label="Open Tasks" loading={summaryLoading} value={summary?.tasks?.open ?? 0} />
          <Kpi label="Invoices" value={invoiceCount} />
        </div>
        </div>
      </Card>

      {/* Body: sidebar + tabs in one connected card */}
      <Card className="overflow-hidden">
        <div className="flex flex-col lg:flex-row">
          {/* Left sidebar */}
          <div className="w-full shrink-0 lg:w-72 lg:border-r">
            <div className="flex flex-col gap-4 p-5">
              <p role="heading" aria-level={2} className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                Contact Details
              </p>

              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <Phone className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <div className="text-sm">
                    {canUseComms ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0 font-normal"
                        disabled={!customer.phone}
                        onClick={() =>
                          requestCall(customer.phone, { customerId: customer.id, customerName: displayName })
                        }
                      >
                        {phoneLabel(customer.phone, customer.phone_ext)}
                      </Button>
                    ) : customer.phone ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0 font-normal"
                        onClick={() => openHref(`tel:${customer.phone}`)}
                      >
                        {phoneLabel(customer.phone, customer.phone_ext)}
                      </Button>
                    ) : (
                      <span>{formatPhone(customer.phone)}</span>
                    )}
                    <p className="text-muted-foreground text-xs">Primary</p>
                  </div>
                </div>

                {customer.secondary_phone && (
                  <div className="flex items-start gap-3">
                    <Phone className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                    <div className="text-sm">
                      {canUseComms ? (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto px-0 font-normal"
                          onClick={() =>
                            requestCall(customer.secondary_phone, {
                              customerId: customer.id, customerName: displayName,
                            })
                          }
                        >
                          {phoneLabel(customer.secondary_phone, customer.secondary_phone_ext)}
                        </Button>
                      ) : (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto px-0 font-normal"
                          onClick={() => openHref(`tel:${customer.secondary_phone}`)}
                        >
                          {phoneLabel(customer.secondary_phone, customer.secondary_phone_ext)}
                        </Button>
                      )}
                      <p className="text-muted-foreground text-xs">Secondary</p>
                    </div>
                  </div>
                )}

                {customer.email && (
                  <div className="flex items-start gap-3">
                    <Mail className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                    <div className="flex min-w-0 flex-col gap-1">
                      {canUseComms ? (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto justify-start px-0 font-normal break-all"
                          onClick={() => setCompose({ mode: 'new', account: PRIMARY_ACCOUNT.id, to: customer.email, subject: '', body: '' })}
                        >
                          {customer.email}
                        </Button>
                      ) : (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto justify-start px-0 font-normal break-all"
                          onClick={() => openHref(`mailto:${customer.email}`)}
                        >
                          {customer.email}
                        </Button>
                      )}
                      {customer.extra_emails?.map((e: { id: string; email: string; label?: string | null }) => (
                        <div key={e.id} className="flex items-center gap-1.5">
                          {canUseComms ? (
                            <Button
                              variant="link"
                              size="sm"
                              className="h-auto justify-start px-0 font-normal break-all"
                              onClick={() => setCompose({ mode: 'new', account: PRIMARY_ACCOUNT.id, to: e.email, subject: '', body: '' })}
                            >
                              {e.email}
                            </Button>
                          ) : (
                            <Button
                              variant="link"
                              size="sm"
                              className="h-auto justify-start px-0 font-normal break-all"
                              onClick={() => openHref(`mailto:${e.email}`)}
                            >
                              {e.email}
                            </Button>
                          )}
                          {e.label && <Badge variant="softNeutral" size="sm">{e.label}</Badge>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {customer.company_name && (
                  <div className="flex items-start gap-3">
                    <Building2 className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                    <span className="text-sm">{customer.company_name}</span>
                  </div>
                )}
              </div>

              {(customer.ad_source || customer.payment_type || customer.allow_billing || customer.tax_exempt) && (
                <>
                  <Separator />
                  <div className="flex flex-col gap-2.5">
                    {customer.ad_source && (
                      <SidebarRow label="Ad Source">
                        <Badge variant="softNeutral" size="pill">{customer.ad_source}</Badge>
                      </SidebarRow>
                    )}
                    {customer.payment_type && (
                      <SidebarRow label="Form of Payment">
                        <span className="text-xs font-medium">{customer.payment_type}</span>
                      </SidebarRow>
                    )}
                    <SidebarRow label="Allow Billing">{customer.allow_billing ? YES : NO}</SidebarRow>
                    <SidebarRow label="Tax Exempt">{customer.tax_exempt ? YES : NO}</SidebarRow>
                  </div>
                </>
              )}
            </div>

            <Separator />

            <div className="flex flex-col gap-4 p-5">
              <div className="flex items-center justify-between">
                <p role="heading" aria-level={2} className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                  Service Locations
                </p>
                {canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setEditingLocation(null); setLocationDialogOpen(true); }}
                  >
                    <Plus />
                    Add
                  </Button>
                )}
              </div>

              {customer.service_locations?.length === 0 ? (
                <p className="text-muted-foreground text-sm">No locations added.</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {customer.service_locations?.map((loc: DetailLocation) => (
                    <div key={loc.id} className="flex items-start justify-between rounded-lg border p-3">
                      <div className="flex min-w-0 items-start gap-2">
                        <MapPin className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm">
                            {loc.address_line1}{loc.address_line2 ? `, ${loc.address_line2}` : ''}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {loc.city}, {loc.state} {loc.zip}
                          </p>
                          {loc.is_primary && (
                            <Badge variant="softBlue" size="sm" className="mt-1">
                              <Star /> Primary
                            </Badge>
                          )}
                        </div>
                      </div>
                      {canEdit && (
                        <div className="flex shrink-0 gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={loc.is_primary || setPrimaryLocationMutation.isPending}
                            aria-label={loc.is_primary ? 'Primary location' : 'Set as primary location'}
                            title={loc.is_primary ? 'Primary location' : 'Set as primary'}
                            onClick={() => setPrimaryLocationMutation.mutate(loc.id)}
                          >
                            <Star />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Edit location"
                            onClick={() => { setEditingLocation(loc); setLocationDialogOpen(true); }}
                          >
                            <Pencil />
                          </Button>
                          {canDeleteLocation && (
                            // No confirmation: one click deletes. That is the
                            // legacy behaviour and adding a confirm here would be
                            // a behaviour change - see the ledger.
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Delete location"
                              onClick={() => deleteLocationMutation.mutate(loc.id)}
                            >
                              <Trash2 />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="min-w-0 flex-1 border-t lg:border-t-0">
            {/* Text-only labels, like every other TabStrip in v2 - no glyphs
                and no counts. A rail that looks different here than on Jobs or
                Leads reads as a different KIND of rail rather than the same
                one, and the parenthesised counts were the last thing setting
                this one apart. Nothing is lost: every count was a restatement
                of the row count of the table the tab opens, and half of them
                ("Invoices", "Payments") counted only the page of records
                already loaded, so they disagreed with the table they labelled
                as soon as a customer had more than twenty. */}
            <TabStrip
              value={effectiveTab}
              onValueChange={setActiveTab}
              tabs={[
                ...(hasLeads ? [{ value: 'leads', label: 'Leads' }] : []),
                { value: 'estimates', label: 'Estimates' },
                { value: 'jobs', label: 'Jobs' },
                // Aggregates Jobs (+ walkthroughs + Events), so it sits right after it. Shown to
                // every org - see the effectiveTab note.
                { value: 'schedule', label: 'Schedule' },
                { value: 'invoices', label: 'Invoices' },
                { value: 'payments', label: 'Payments' },
                { value: 'notes', label: 'Notes' },
                { value: 'tasks', label: 'Tasks' },
                ...(canReadComms ? [{ value: 'communications', label: 'Comms' }] : []),
              ]}
            />

            <TabPanel value="leads" activeValue={effectiveTab}>
              <LeadsTab
                view={leadsPage}
                timeZone={timeZone}
                onNavigate={(lid) => navTo((`/leads/${lid}`))}
              />
            </TabPanel>
            <TabPanel value="estimates" activeValue={effectiveTab}>
              <EstimatesTab
                estimates={estimates}
                isLoading={estimatesLoading}
                onNavigate={(eid) => navTo((`/estimates/${eid}`))}
              />
            </TabPanel>
            <TabPanel value="jobs" activeValue={effectiveTab}>
              <JobsTab
                view={jobsPage}
                onNavigate={(jid) => navTo((`/jobs/${jid}`))}
              />
            </TabPanel>
            {/* Only the active panel is mounted, so the Events query (Query 4) is naturally
                deferred until this tab opens - same reasoning as the Comms tab below. Events
                rows are hidden entirely without `read CalendarEntry` (canReadEvents gates the
                query itself, so an ungranted viewer never even requests them); jobs and
                walkthroughs still render, same as every other tab on this page. */}
            <TabPanel value="schedule" activeValue={effectiveTab}>
              <ScheduleTab
                visitRows={visitRows}
                status={scheduleStatus}
                onRetry={() => { void refetchSchedule(); }}
                timeZone={timeZone}
                calendarEntries={canReadEvents ? (calendarEntriesData ?? []) : []}
                onNavigateJob={(jid) => navTo(`/jobs/${jid}`)}
                onNavigateWalkthrough={(lid) => navTo(`/leads/${lid}?tab=walkthrough`)}
                onOpenEvent={(entry) => setViewingEvent(entry)}
              />
            </TabPanel>
            <TabPanel value="invoices" activeValue={effectiveTab}>
              {ability.can('read', 'Invoice') && (
                <div className="flex justify-end px-4 pt-4">
                  <Button asChild variant="outline" size="sm">
                    <Link to={v2Path(`/customers/${id}/statement`)} >
                      <FileText />
                      View Statement
                    </Link>
                  </Button>
                </div>
              )}
              <InvoicesTab invoices={invoices} />
            </TabPanel>
            <TabPanel value="payments" activeValue={effectiveTab}>
              <PaymentsTab invoices={invoices} />
            </TabPanel>
            <TabPanel value="notes" activeValue={effectiveTab}>
              <NotesTab notes={notes} customerId={id!} />
            </TabPanel>
            <TabPanel value="tasks" activeValue={effectiveTab}>
              <JobLeadTasksTab entity={{ type: 'CUSTOMER', id: customer.id, label: displayName }} />
            </TabPanel>
            {/* Only the active panel is mounted, so the communications query is
                naturally deferred until the tab opens. */}
            {canReadComms && (
              <TabPanel value="communications" activeValue={effectiveTab}>
                <div className="p-5">
                  <CustomerCommunicationsTab customerId={id!} />
                </div>
              </TabPanel>
            )}
          </div>
        </div>
      </Card>

      {/* Dialogs */}
      <LocationFormDialog
        open={locationDialogOpen}
        onOpenChange={setLocationDialogOpen}
        customerId={id!}
        location={editingLocation}
      />

      {/* Event detail (slice 10) - read-only stand-in for slice 04's not-yet-built Event
          dialog. `open` keys off `viewingEvent` rather than a separate boolean so there is
          only one source of truth for "which Event, if any, is being viewed". */}
      <EventDetailDialog
        timeZone={timeZone}
        entry={viewingEvent}
        open={viewingEvent !== null}
        onOpenChange={(open) => { if (!open) setViewingEvent(null); }}
      />

      {compose && (
        <ComposeWindow
          state={compose}
          onChange={setCompose}
          onSend={sendCompose}
          onClose={() => setCompose(null)}
          onDiscard={() => setCompose(null)}
          onToast={(m) => toast(m)}
          fromAddress={sendingIdentity?.address}
          sendingEnabled={sendingIdentity?.sendingEnabled ?? true}
        />
      )}

      {/* Force-purge - type the customer number to confirm. One-shot: the
          backend warns about financial records AND deletes in the same call. */}
      <Dialog open={purgeOpen} onOpenChange={setPurgeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogIcon tone="danger"><Trash2 /></DialogIcon>
            <div>
              <DialogTitle>Delete Customer</DialogTitle>
              <DialogDescription>
                This permanently destroys {displayName} and ALL associated financial records
                (leads, estimates, jobs, invoices, payments). This cannot be undone.
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              Type the customer number{' '}
              <span className="text-foreground font-mono font-semibold">
                {customer.customer_number ?? '-'}
              </span>{' '}
              to confirm.
            </p>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={customer.customer_number ?? 'Customer number'}
              aria-label="Customer number confirmation"
            />
            {purgeMutation.error && (
              <p className="text-destructive text-sm">
                {extractApiError(purgeMutation.error, 'Failed to purge')}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurgeOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => purgeMutation.mutate()}
              disabled={purgeMutation.isPending || confirmText !== customer.customer_number}
            >
              {purgeMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Service Plan - reuses the Service Plans page builder with this
          customer preset. key={id} remounts it when navigating between
          customer profiles, so the preset state is never stale. */}
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
