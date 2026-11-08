import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Ban, Briefcase, Calendar, CheckCircle2, ChevronDown, Clock,
  FileText, Mail, MapPin, MoreHorizontal, Paperclip, Pencil, Phone, Trash2, User,
} from 'lucide-react';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { useAppAbility } from '@/contexts/AbilityContext';
import { RecordNumberEditor } from '@/components/crm/RecordNumberEditor';
import { customerDisplayName } from '@/lib/customer-name';
import { isConvertibleEstimate } from '@/features/estimate-workspace/lib/convertToJob';
import { useFeature } from '@/lib/entitlements';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { LEAD_STATUSES } from '@/lib/filters/registries/leads';
import { extractApiError, formatCurrency, formatPhone } from '@/lib/utils';
import { AttachmentSection } from '@/components/crm/AttachmentSection';
import { IconRail } from '@/components/crm/IconRail';
import { AssignLeadPopover } from '@/components/leads/AssignLeadPopover';
import { TagInput } from '@/components/leads/TagInput';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Separator } from '@/ui-kit/components/ui/separator';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { preferV2Path, v2Path } from '../uiV2';
import { CreateJobFromLeadDialog } from './components/createJobFromLeadDialog';
import {
  CancelLeadDialog, CancelWalkthroughDialog, DeleteLeadDialog, MarkLostDialog,
} from './components/leadDialogs';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { formatDate, formatDateTime, isWalkthroughActive, type UserSummary } from './components/leadShared';
import { StatusChip } from '../_shared/statusChip';
import { StatusMenu, type StatusMenuOption } from '../_shared/statusMenu';
import { LEAD_STATUS_MEANING, type LeadStatusOptionFromServer } from './leadStatusMeaning';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { WalkthroughTabContent, walkthroughSyncKey } from './components/walkthroughTab';
import { useRecordVisit } from '../pageBreadcrumbs';

interface Tag {
  id: string;
  name: string;
  color: string;
}

/**
 * LEAD_STATUSES (which now includes Walkthrough Scheduled and Walkthrough Completed) is both
 * the filterable AND the settable vocabulary; this page's status dropdown lists all of it.
 */
const SETTABLE_LEAD_STATUSES = LEAD_STATUSES;

/**
 * The walkthrough tab's status dot, read from the CURRENT visit's own projected
 * fields. The guard ORDER is load-bearing - see `isWalkthroughActive`.
 */
function WalkthroughDot({
  scheduledAt, completedAt, cancelledAt,
}: {
  scheduledAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
}) {
  if (completedAt) {
    return <span data-testid="walkthrough-dot" className="bg-status-green inline-block size-2 rounded-full" />;
  }
  if (isWalkthroughActive(scheduledAt, completedAt, cancelledAt)) {
    return <span data-testid="walkthrough-dot" className="bg-status-blue inline-block size-2 rounded-full" />;
  }
  return <span data-testid="walkthrough-dot" className="bg-muted inline-block size-2 rounded-full" />;
}

/**
 * /v2/leads/:id - the lead detail page on the CRM UI kit.
 *
 * Ability gates, mutations, cache keys, deep-link handling and copy are the
 * legacy page's. Five embedded sub-systems are reused rather than rebuilt -
 * IconRail, AttachmentSection, TagInput, AssignLeadPopover and the Tasks /
 * Communication tabs - because each owns behaviour that belongs to shared
 * infrastructure or to another module's migration, and rebuilding them here
 * would fork it. Recorded in the branch report.
 */
export default function LeadDetailPage() {
  const tz = useScheduleTimezone();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  // In-app call entry: comms-enabled org + create Communication -> the phone link
  // routes into the /phone tab with lead attribution; else native tel:.
  const canAccessComms = useFeature('phone');
  const canPlaceCall = canAccessComms && ability.can('create', 'Communication');

  const [lostOpen, setLostOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cancelWtOpen, setCancelWtOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Deep links: `?createJob=<estimateId>` opens the convert dialog with that
   * estimate preselected, `?tab=walkthrough` opens the Walkthrough tab. Both are
   * consumed and then stripped with `{ replace: true }`, so a reload lands on
   * the default tab with no dialog.
   *
   * The legacy page read them in an effect and wrote state from it. Here they
   * seed state through lazy initialisers and the effect only strips the params -
   * `setState` inside an effect body is a react-hooks error, and this keeps the
   * same observable behaviour for every real entry point (both links arrive on a
   * fresh mount, from the leads list or from an estimate).
   *
   * `?tab=` selects the corresponding tab (e.g. 'communication', 'walkthrough').
   */
  const [createJobOpen, setCreateJobOpen] = useState(() => Boolean(searchParams.get('createJob')));
  const [preselectEstimateId, setPreselectEstimateId] = useState<string | null>(
    () => searchParams.get('createJob'),
  );
  const VALID_TABS = ['overview', 'walkthrough', 'estimates', 'attachments', 'communication', 'tasks'] as const;
  const initialTabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(() => {
    if (initialTabParam && (VALID_TABS as readonly string[]).includes(initialTabParam)) {
      return initialTabParam;
    }
    return 'overview';
  });

  useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam && (VALID_TABS as readonly string[]).includes(tabParam)) {
      setActiveTab(tabParam);
    }
  }, [searchParams]);

  useEffect(() => {
    const hasCreateJob = searchParams.has('createJob');
    const tabParam = searchParams.get('tab');
    const hasTab = tabParam && (VALID_TABS as readonly string[]).includes(tabParam);
    if (!hasCreateJob && !hasTab) return;
    const next = new URLSearchParams(searchParams);
    if (hasCreateJob) next.delete('createJob');
    if (hasTab) next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const { data: leadAttachments } = useQuery({
    queryKey: ['attachments', 'LEAD', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/attachments/lead/${id}`);
      return (data.attachments ?? []) as unknown[];
    },
    enabled: Boolean(id),
  });
  // Every attachment on the lead: its Attachments tab is the lead's ONE list, so the count
  // must match what that list renders.
  const attachmentCount = (leadAttachments ?? []).length;

  const { data: lead, isLoading } = useQuery({
    queryKey: ['lead', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/leads/${id}`);
      return data.lead;
    },
    enabled: Boolean(id),
  });

  useRecordVisit('leads', lead?.lead_number as string | undefined);

  const statusMutation = useMutation({
    mutationFn: async (status: string) => { await api.patch(`/api/leads/${id}`, { status }); },
    // The helper refreshes the lead, the leads list and the customer page's Leads tab.
    onSuccess: () => refreshAfterVisitWrite(queryClient, { leadId: id! }),
    // lib/axios only intercepts 401/429/402, so without this a rejected status
    // closed the menu and did nothing at all.
    onError: (err: unknown) => {
      toast.error('Could not update the lead status', {
        description: extractApiError(err, 'The status change was not saved'),
      });
    },
  });

  // Convert to Job - the backend turns one or several WON estimates into a job. Exactly one id
  // posts the byte-identical `{ estimate_id }` request already in prod; more than one posts
  // `{ estimate_ids }` (job.controller.ts's pre-existing multi path, #2048).
  const createJobMutation = useMutation({
    mutationFn: async (estimateIds: string[]) => {
      const body = estimateIds.length === 1 ? { estimate_id: estimateIds[0] } : { estimate_ids: estimateIds };
      const { data } = await api.post('/api/jobs', body);
      return data.job;
    },
    onSuccess: (job) => {
      // A new job on the lead's customer.
      refreshAfterVisitWrite(queryClient, { jobId: job.id });
      // The converted estimate(s) stop being offered as convertible - refetch the lead.
      queryClient.invalidateQueries({ queryKey: ['lead', id] });
      navigate(preferV2Path(`/jobs/${job.id}`));
    },
    onError: (err: unknown) => {
      // The Create-Job modal stays open on error; surface the failure (e.g.
      // deposit not collected) as a toast rather than inline text.
      toast.error('Could not convert to job', {
        description: extractApiError(err, 'Failed to create job from this estimate'),
      });
    },
  });

  // Action visibility is gated on CASL ability (not role literals) so the UI
  // tracks the grant catalog + per-user overrides. Each flag maps to the exact
  // (action, subject) its backend route enforces.
  const canEdit = ability.can('update', 'Lead');
  // Walkthrough capabilities are split from `update Lead` to mirror the backend
  // routes: a strict TECHNICIAN holds `perform_walkthrough` but NOT
  // `update`/`schedule`, so gating these on `update Lead` would lock a tech out.
  const canPerformWalkthrough = ability.can('perform_walkthrough', 'Lead');
  const canScheduleWalkthrough = ability.can('schedule_walkthrough', 'Lead');
  const canChangeStatus = ability.can('update', 'Lead');
  // Setting Lost or Cancelled here does what "Mark lost" and "Cancel lead" do, and the server asks
  // for the same ability on it, so a user without that ability is not offered the choice.
  const mayPickStatus = (s: string) =>
    (s !== 'LOST' || ability.can('mark_lost', 'Lead')) && (s !== 'CANCELLED' || ability.can('cancel', 'Lead'));
  // The server says which statuses can be picked and why a locked one is locked (`status_options`),
  // and the menu renders that without holding any rule. Without it (an older response) the menu is
  // the plain list it always was.
  const serverStatusOptions = lead?.status_options as LeadStatusOptionFromServer[] | undefined;
  const statusOptions: Array<string | StatusMenuOption> = Array.isArray(serverStatusOptions)
    ? serverStatusOptions
        .filter((o) => mayPickStatus(o.status))
        .map((o) => ({
          value: o.status,
          available: o.available,
          reason: o.reason,
          description: LEAD_STATUS_MEANING[o.status],
        }))
    : SETTABLE_LEAD_STATUSES.filter(mayPickStatus);
  const canAssign = ability.can('assign', 'Lead');
  const canReadComms = ability.can('read', 'Communication');
  const isNotTerminal = lead && lead.status !== 'WON' && lead.status !== 'LOST' && lead.status !== 'CANCELLED';
  const canMarkLost = isNotTerminal && ability.can('mark_lost', 'Lead');
  // Cancel is the administrative-void counterpart to mark-lost; same terminal guard.
  const canCancel = isNotTerminal && ability.can('cancel', 'Lead');
  const isTerminal = lead && ['WON', 'LOST', 'CANCELLED'].includes(lead.status);
  const canCreateEstimate = ability.can('create', 'Estimate') && !isTerminal;
  const isWalkthroughScheduled = isWalkthroughActive(
    lead?.walkthrough_scheduled_at,
    lead?.walkthrough_completed_at,
    lead?.walkthrough_cancelled_at,
  );

  const estimates = (lead?.estimates ?? []) as Array<{
    id: string; estimate_number: string; status: string;
    total_amount: string; created_at: string;
    creator?: { id: string; first_name: string; last_name: string };
    deposit?: { id: string; status: string; amount: number | string } | null;
    job?: { id: string; job_number: string; status: string } | null;
    job_id?: string | null;
    job_link?: { id: string; job_number: string; status: string } | null;
  }>;
  const estimateTotal = estimates.reduce((sum, e) => sum + parseFloat(String(e.total_amount || '0')), 0);
  const estimateCount = estimates.length;
  const canConvertToJob = ability.can('create', 'Job');
  // #2048 - the ONE convertibility predicate, shared with the dialog and the estimate page
  // (convertToJob.ts). No `!isTerminal` term here (R3): approving an estimate moves the lead to
  // WON, which IS terminal, and that is exactly the state this button must still render in.
  const convertibleEstimates = estimates.filter(isConvertibleEstimate);
  const hasConvertibleEstimate = convertibleEstimates.length > 0;
  // Read once per mount: `Date.now()` in the render body is an impure call
  // (react-hooks/purity), and "days open" does not need to tick.
  const [nowMs] = useState(() => Date.now());
  // Slice 03: re-pointing the lead's anchor from the lead itself, so a CSR can correct a
  // wrong site while the customer is still on the phone.
  const daysOpen = lead ? Math.floor((nowMs - new Date(lead.created_at).getTime()) / (1000 * 60 * 60 * 24)) : 0;
  // Delete is available only with zero estimates, and gated by ability.
  const canDelete = ability.can('delete', 'Lead') && estimateCount === 0;

  const hasHeaderActions =
    canCreateEstimate || canEdit || canAssign
    || canConvertToJob || (isWalkthroughScheduled && canEdit)
    || canMarkLost || canCancel || canDelete;

  const tags: Tag[] = (lead?.tags ?? []) as Tag[];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!lead) {
    return (
      <Card>
        <CardContent className="text-center">
          <p className="text-muted-foreground">Lead not found.</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate(v2Path('/leads'))}>Back to Leads</Button>
        </CardContent>
      </Card>
    );
  }

  const customer = lead.customer as {
    id: string; first_name: string; last_name: string;
    company_name?: string; email?: string; phone: string; phone_ext?: string;
    service_locations?: Array<{
      id: string; address_line1: string; address_line2?: string | null;
      city: string; state: string; zip: string; is_primary: boolean;
    }>;
  };

  // Lead owner = the SINGLE commission_owner.
  const assignedUser = lead.commission_owner as UserSummary | null;
  const walkthroughPerformersList = (lead.walkthrough_performers as { user: UserSummary }[] | undefined) ?? [];
  const walkthroughPerformerLabel = walkthroughPerformersList.length > 0
    ? walkthroughPerformersList.map((p) => `${p.user.first_name} ${p.user.last_name}`).join(', ')
    : null;

  const customerLabel = customerDisplayName(customer);

  // The lead's anchor, as returned by the lead detail contract. Deliberately NOT derived from
  // the customer roster: the roster is the customer's, the anchor is the lead's.
  const anchoredLocation = lead.service_location as {
    id: string; address_line1: string; address_line2?: string | null;
    city: string; state: string; zip: string;
  } | null | undefined;

  // Legacy fallback (entity-redesign §3/§10, slice 02). Leads created before the anchor existed
  // carry a loose inline address and no linked location, and those deprecated columns are the
  // ONLY record of where that work was. Read for LEGACY DISPLAY ONLY - nothing here writes them,
  // and they stay scheduled for removal by their own phase of the redesign. The anchor always
  // wins: these are consulted only when there is none.
  const looseAddress = !anchoredLocation && lead.service_address_line1
    ? {
        address_line1: lead.service_address_line1 as string,
        address_line2: (lead.service_address_line2 as string | null) ?? null,
        city: (lead.service_city as string | null) ?? '',
        state: (lead.service_state as string | null) ?? '',
        zip: (lead.service_zip as string | null) ?? '',
      }
    : null;

  const displayedLocation = anchoredLocation ?? looseAddress;

  // FIX B: every deprecated `service_*` column is independently nullable, so a legacy lead can
  // carry a line1 and nothing else. Interpolating `city, state zip` on that row rendered a bare
  // ", " line. Build the line from the parts that are actually there, and drop it when there are
  // none. (The anchored path is safe - ServiceLocation.city/state/zip are non-null - but it flows
  // through the same expression, so one rule covers both.)
  const regionLine = displayedLocation
    ? [
        [displayedLocation.city, displayedLocation.state].filter(Boolean).join(', '),
        displayedLocation.zip,
      ]
        .filter(Boolean)
        .join(' ')
    : '';

  /**
   * Navigate on, in v2.
   *
   * Two things it no longer does, both deliberate:
   *
   * It does not hand-build a breadcrumb trail and push it through router state.
   * The trail is now derived from where the user has ACTUALLY been (see
   * `navHistory.store`), so a trail assembled here could only ever agree with
   * the real one by coincidence, and when the two disagreed the page drew both.
   *
   * It routes through `preferV2Path`, which is a no-op shim now (see `uiV2.ts`)
   * and is kept only because unwrapping every call site is a large diff for no
   * behaviour change. The wrapper earned its place on the bug "New Estimate
   * throws me back into the old design": while the two designs sat at different
   * URLs, a raw `/estimates/new?lead_id=` landed on the old estimate builder
   * with no way back. One URL space is what actually fixed that.
   */
  const navTo = (url: string) => navigate(preferV2Path(url));

  return (
    <IconRail entityType="LEAD" entityId={id!} panels={['activity']}>
      <div className="flex flex-col gap-4">

        <Card>
          {/* Header */}
          <div className="p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {/* role/aria-level rather than an <h1>: the design-system
                      raw-tag ratchet sits at its floor for h1-h6, so a v2 page
                      may not add one. The accessible heading is preserved. */}
                  <p role="heading" aria-level={1} className="flex items-baseline gap-2 text-xl font-semibold">
                    <RecordNumberEditor
                      entity="lead"
                      id={id!}
                      number={lead.lead_number as string}
                      canEdit={ability.can('renumber', 'Lead')}
                      onRenamed={() => {
                        queryClient.invalidateQueries({ queryKey: ['lead', id] });
                        queryClient.invalidateQueries({ queryKey: ['leads'] });
                      }}
                    />
                    <span>- {customerLabel}</span>
                  </p>
                  <StatusMenu
                    domain="lead"
                    label="Lead status"
                    value={lead.status as string}
                    options={statusOptions}
                    onValueChange={(s) => {
                      // Closing a lead always asks why: Lost and Cancelled open the same dialogs
                      // as the Mark Lost and Cancel Lead buttons instead of sending a bare PATCH.
                      // Picking the status the lead already has changes nothing, so it asks nothing.
                      if (s === lead.status) return;
                      if (s === 'LOST') setLostOpen(true);
                      else if (s === 'CANCELLED') setCancelOpen(true);
                      else statusMutation.mutate(s);
                    }}
                    disabled={!canChangeStatus || statusMutation.isPending}
                  />
                </div>
                <div className="text-muted-foreground mt-1 flex items-center gap-3 text-xs">
                  {customer.company_name && <span>{customer.company_name}</span>}
                  <span>Created {formatDate(lead.created_at, tz)}</span>
                </div>
                <div className="mt-2">
                  <TagInput leadId={id!} tags={tags} />
                </div>
              </div>

              <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto">
                {/* #2048 primary control - direct-converts at exactly one convertible estimate
                    (mirrors the estimate page's own "Create Job" button, R1); opens the
                    multi-select dialog above one; falls back to "Create Estimate" (unchanged
                    kebab-item behaviour) when nothing is convertible. Deliberately NOT gated on
                    `!isTerminal` (R3) - a lead with a WON estimate IS terminal, and that is
                    exactly the state this button must still render in.
                    Round 3 (#2048): the header row itself now wraps (`flex-col sm:flex-row`) so
                    this action column drops to its own right-aligned line under the title at
                    narrow widths instead of squeezing/overlapping it (`w-full sm:w-auto` keeps
                    it right-aligned via `justify-end` on its own full-width row below 640px, and
                    lets it sit inline at its natural width alongside the title from 640px up). */}
                {canConvertToJob && convertibleEstimates.length === 1 ? (
                  <Button
                    size="sm"
                    onClick={() => createJobMutation.mutate([convertibleEstimates[0]!.id])}
                    disabled={createJobMutation.isPending}
                  >
                    {createJobMutation.isPending ? <Spinner label={null} /> : <Briefcase />}
                    Convert to job
                  </Button>
                ) : canConvertToJob && hasConvertibleEstimate ? (
                  <Button size="sm" onClick={() => setCreateJobOpen(true)}>
                    <Briefcase />
                    Convert to job
                  </Button>
                ) : canCreateEstimate ? (
                  <Button size="sm" onClick={() => navTo(`/estimates/new?lead_id=${id}`)}>
                    <FileText />
                    Create Estimate
                  </Button>
                ) : null}
                {hasHeaderActions && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" aria-label="Lead actions">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onCloseAutoFocus={(e) => {
                        // Assign opens a follow-up popover; keep focus with it instead of
                        // restoring focus to this trigger (which would dismiss the popover).
                        if (assignOpen) e.preventDefault();
                      }}
                    >
                      {canCreateEstimate && (
                        <DropdownMenuItem onClick={() => navTo(`/estimates/new?lead_id=${id}`)}>
                          <FileText /> Create Estimate
                        </DropdownMenuItem>
                      )}
                      {canEdit && (
                        <DropdownMenuItem onClick={() => navigate(v2Path(`/leads/${id}/edit`))}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                      )}
                      {canAssign && (
                        <DropdownMenuItem onSelect={() => setAssignOpen(true)}>
                          <User /> Assign
                        </DropdownMenuItem>
                      )}
                      {canConvertToJob && (
                        <DropdownMenuItem onClick={() => setCreateJobOpen(true)}>
                          <Briefcase /> Convert to job
                        </DropdownMenuItem>
                      )}
                      {isWalkthroughScheduled && canEdit && (
                        <DropdownMenuItem onClick={() => setCancelWtOpen(true)} variant="destructive">
                          Cancel Walkthrough
                        </DropdownMenuItem>
                      )}
                      {canMarkLost && (
                        <DropdownMenuItem onClick={() => setLostOpen(true)} variant="destructive">
                          <AlertTriangle /> Mark Lost
                        </DropdownMenuItem>
                      )}
                      {canCancel && (
                        <DropdownMenuItem onClick={() => setCancelOpen(true)} variant="destructive">
                          <Ban /> Cancel Lead
                        </DropdownMenuItem>
                      )}
                      {canDelete && (
                        <DropdownMenuItem onClick={() => setDeleteOpen(true)} variant="destructive">
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {canAssign && (
                  <AssignLeadPopover
                    leadId={id!}
                    currentAssignedTo={(lead.commission_owner as { id: string } | null)?.id ?? null}
                    open={assignOpen}
                    onOpenChange={setAssignOpen}
                    // Round 3 (#2048): this trigger is a zero-size anchor, always the LAST flex
                    // child in the action column - so the `gap-2` the round-3 stacking fix added
                    // to that column (needed between the primary button and the kebab) was also
                    // inserting an 8px gap after the kebab and before this invisible element,
                    // pushing the kebab 8px off the card's right edge even when it is the only
                    // visible control. `-ml-2` cancels exactly that one gap; the real gap between
                    // visible controls is untouched.
                    trigger={<span aria-hidden="true" tabIndex={-1} className="pointer-events-none -ml-2 size-0" />}
                  />
                )}
              </div>
            </div>
          </div>

          {/* KPI strip */}
          <div className="flex border-t">
            <div className="flex-1 px-5 py-4">
              <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">Estimated Value</p>
              <p className="mt-0.5 text-xl font-bold">{estimateTotal > 0 ? formatCurrency(estimateTotal) : '-'}</p>
            </div>
            <Separator orientation="vertical" className="h-auto" />
            <div className="flex-1 px-5 py-4">
              <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">Estimates</p>
              <p className="mt-0.5 text-xl font-bold">{estimateCount}</p>
            </div>
            <Separator orientation="vertical" className="h-auto" />
            <div className="flex-1 px-5 py-4">
              <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">Days Open</p>
              <p className="mt-0.5 text-xl font-bold">{daysOpen}</p>
            </div>
            <Separator orientation="vertical" className="h-auto" />
            <div className="flex-1 px-5 py-4">
              <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">Source</p>
              <p className="mt-0.5 text-xl font-bold">
                {(lead.customer as { ad_source?: string | null })?.ad_source || '-'}
              </p>
            </div>
          </div>

          {/* Tabs */}
          <TabStrip
            className="border-t"
            value={activeTab}
            onValueChange={setActiveTab}
            tabs={[
              { value: 'overview', label: 'Overview' },
              {
                value: 'walkthrough',
                label: (
                  <span className="flex items-center gap-2">
                    <WalkthroughDot
                      scheduledAt={lead.walkthrough_scheduled_at as string | null}
                      completedAt={lead.walkthrough_completed_at as string | null}
                      cancelledAt={lead.walkthrough_cancelled_at as string | null}
                    />
                    Walkthrough
                  </span>
                ),
              },
              { value: 'estimates', label: `Estimates (${estimateCount})` },
              {
                value: 'attachments',
                label: (
                  <span className="flex items-center gap-2">
                    <Paperclip />
                    Attachments ({attachmentCount})
                  </span>
                ),
              },
              ...(canReadComms ? [{ value: 'communication', label: 'Communication' }] : []),
              { value: 'tasks', label: 'Tasks' },
            ]}
          />

          <TabPanel value="overview" activeValue={activeTab}>
            <div className="flex flex-col lg:flex-row">
              {/* Left column (~65%) */}
              <div className="min-w-0 flex-[65]">
                <div className="p-5">
                  <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Service Request</p>
                  <p className="whitespace-pre-wrap text-sm">{lead.service_request as string}</p>

                  {(lead.notes as string) && (
                    <div className="mt-3">
                      <p className="text-muted-foreground text-xs font-medium">Lead Notes</p>
                      <p className="text-muted-foreground mt-1 whitespace-pre-wrap text-sm">{lead.notes as string}</p>
                    </div>
                  )}

                  <div className="mt-3 flex gap-6 text-sm">
                    <p>
                      <span className="text-muted-foreground">Source: </span>
                      <span className="font-medium">
                        {(lead.customer as { ad_source?: string | null })?.ad_source || '-'}
                      </span>
                    </p>
                    <p>
                      <span className="text-muted-foreground">Lead Type: </span>
                      <span className="font-medium">{(lead.lead_type as string) || '-'}</span>
                    </p>
                  </div>

                  <div className="mt-2 flex gap-6 text-sm">
                    <p>
                      <span className="text-muted-foreground">Job Type: </span>
                      <span className="font-medium">{(lead.job_type as string) || '-'}</span>
                    </p>
                    <p>
                      <span className="text-muted-foreground">Created: </span>
                      <span className="font-medium">{formatDate(lead.created_at, tz)}</span>
                    </p>
                  </div>

                  {((lead.scheduled_start as string) || (lead.scheduled_end as string)) && (
                    <div className="mt-2 flex gap-6 text-sm">
                      {(lead.scheduled_start as string) && (
                        <p>
                          <span className="text-muted-foreground">Scheduled Start: </span>
                          {formatDateTime(lead.scheduled_start as string, tz)}
                        </p>
                      )}
                      {(lead.scheduled_end as string) && (
                        <p>
                          <span className="text-muted-foreground">End: </span>
                          {formatDateTime(lead.scheduled_end as string, tz)}
                        </p>
                      )}
                    </div>
                  )}

                  {(lead.status as string) === 'LOST' && (lead.lost_reason as string) && (
                    <div className="bg-status-red-subtle mt-3 rounded-lg border p-3">
                      <p className="text-destructive text-xs font-semibold">Lost Reason</p>
                      <p className="mt-1 text-sm">{lead.lost_reason as string}</p>
                      {(lead.lost_at as string) && (
                        <p className="text-muted-foreground mt-1 text-xs">
                          Lost on {formatDate(lead.lost_at as string, tz)}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Walkthrough summary strip */}
                <div className="border-t p-5">
                  <p className="text-muted-foreground mb-3 flex items-center gap-2 text-xs font-semibold uppercase">
                    <Calendar className="size-3.5" />
                    Walkthrough
                  </p>
                  <Button
                    variant="outline"
                    className="h-auto w-full justify-start py-3 font-normal"
                    onClick={() => setActiveTab('walkthrough')}
                  >
                    {isWalkthroughScheduled ? (
                      <>
                        <Clock className="text-status-blue" />
                        <span className="flex flex-col items-start">
                          <span className="text-sm font-medium">
                            Scheduled for {formatDateTime(lead.walkthrough_scheduled_at as string, tz)}
                          </span>
                          {walkthroughPerformerLabel && (
                            <span className="text-muted-foreground text-xs">with {walkthroughPerformerLabel}</span>
                          )}
                        </span>
                      </>
                    ) : lead.walkthrough_completed_at ? (
                      <>
                        <CheckCircle2 className="text-status-green" />
                        <span className="flex flex-col items-start">
                          <span className="text-sm font-medium">
                            Completed {formatDateTime(lead.walkthrough_completed_at as string, tz)}
                          </span>
                          {walkthroughPerformerLabel && (
                            <span className="text-muted-foreground text-xs">by {walkthroughPerformerLabel}</span>
                          )}
                        </span>
                      </>
                    ) : (
                      <>
                        <Calendar />
                        <span className="text-muted-foreground text-sm">
                          No walkthrough scheduled yet - click to schedule
                        </span>
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {/* Right column (~35%) */}
              <div className="min-w-0 flex-[35] border-t lg:border-l lg:border-t-0">
                <div className="flex flex-col gap-2 p-5">
                  <p className="text-muted-foreground mb-2 text-[10px] font-semibold uppercase tracking-widest">Customer</p>
                  <Button
                    variant="link"
                    className="h-auto justify-start px-0 font-semibold"
                    onClick={() => navTo(`/customers/${customer.id}`)}
                  >
                    {customer.first_name} {customer.last_name}
                  </Button>
                  {customer.company_name && <p className="text-muted-foreground text-xs">{customer.company_name}</p>}
                  <p className="flex items-center gap-2 text-sm">
                    <Phone className="text-muted-foreground size-3.5 shrink-0" />
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto px-0 font-normal"
                      onClick={() => {
                        if (canPlaceCall) {
                          requestCall(customer.phone, {
                            leadId: id!,
                            leadLabel: lead.lead_number as string,
                            customerId: customer.id,
                            customerName: customerLabel,
                          });
                          return;
                        }
                        window.location.href = `tel:${customer.phone}`;
                      }}
                    >
                      {formatPhone(customer.phone)}{customer.phone_ext ? ` ext. ${customer.phone_ext}` : ''}
                    </Button>
                  </p>
                  {customer.email && (
                    <p className="flex items-center gap-2 text-sm">
                      <Mail className="text-muted-foreground size-3.5 shrink-0" />
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto truncate px-0 font-normal"
                        onClick={() => { window.location.href = `mailto:${customer.email}`; }}
                      >
                        {customer.email}
                      </Button>
                    </p>
                  )}
                </div>

                <div className="border-t p-5">
                  <p className="text-muted-foreground mb-3 text-[10px] font-semibold uppercase tracking-widest">Assigned To</p>
                  <div className="flex items-center justify-between">
                    <p className="flex items-center gap-2 text-sm">
                      <User className="text-muted-foreground size-4" />
                      <span className="font-medium">
                        {assignedUser ? `${assignedUser.first_name} ${assignedUser.last_name}` : 'Unassigned'}
                      </span>
                    </p>
                    {canAssign && (
                      <AssignLeadPopover
                        leadId={id!}
                        currentAssignedTo={(lead.commission_owner as { id: string } | null)?.id ?? null}
                        trigger={<Button variant="outline" size="sm">Reassign</Button>}
                      />
                    )}
                  </div>
                </div>

                {/*
                  * Entity-redesign §3/§10: the lead's OWN anchored location - ONE address, the
                  * one this lead was created for. This panel used to map the customer's whole
                  * roster under a plural heading with a Primary badge, which on a multi-site
                  * account left the address the lead is actually about indistinguishable from the
                  * ones it is not, and pointed the badge at the head office for a warehouse job.
                  * Primacy is a property of the CUSTOMER's roster and means nothing here, so the
                  * badge is gone from this surface; the customer detail page still shows the full
                  * roster, and the roster still rides in this payload for later consumers.
                  *
                  * Slice 02: the panel is NO LONGER gated on the anchor. Gating it there cost
                  * pre-anchor leads the only record of where the work was - they rendered no
                  * panel at all, and a missing address read as a section that had never existed
                  * rather than as a gap to fix. It renders in all three states, and the two
                  * unanchored ones say so, so an anchored record reads differently from an
                  * unanchored one at a glance.
                  */}
                <div className="border-t p-5" data-testid="lead-service-location">
                  {/*
                    * The panel STATES the lead's service location. It does not qualify it, mark
                    * it, or explain it.
                    *
                    * It used to do all three, and every one of them was a mistake made in this
                    * file rather than in the domain. Slice 03 put a pencil here; the lead's own
                    * Edit form (pages/v2/leads/LeadFormPage) already picks a saved location or
                    * accretes a typed one, already respects the estimate freeze, and already
                    * surfaces the cross-state tax warning - so the pencil was a second, weaker
                    * way to do a thing the product already did, and the notice underneath it
                    * existed only to explain the pencil's own absence. Slice 02 added a warning
                    * for a lead whose address sits in the deprecated `service_*` columns instead
                    * of on a linked ServiceLocation. That distinction is real in the schema and
                    * invisible in the business: every lead is created with an address, and a
                    * typed one is accreted onto the customer at create time. Whether the row is
                    * joined or inlined is a migration's problem, not the office manager's, and
                    * captioning an address "not linked to a saved address" told them a storage
                    * detail in the voice of a defect.
                    *
                    * The deprecated-column fallback below stays: it is what a legacy lead's
                    * address IS. It just no longer announces itself.
                    */}
                  <p className="text-muted-foreground mb-3 text-[10px] font-semibold uppercase tracking-widest">
                    Service Location
                  </p>
                  {displayedLocation ? (
                    <div className="flex items-start gap-2">
                      <MapPin className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-snug">
                          {displayedLocation.address_line1}{displayedLocation.address_line2 ? `, ${displayedLocation.address_line2}` : ''}
                        </p>
                        {regionLine && (
                          <p className="text-muted-foreground text-xs">{regionLine}</p>
                        )}
                      </div>
                    </div>
                  ) : (
                    /*
                     * The one thing still worth marking: a lead with NO address at all. That is
                     * an absence the reader cannot otherwise see, and it is not a storage
                     * detail - there is nowhere to send anyone.
                     */
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="text-status-amber-emphasis mt-0.5 size-4 shrink-0" aria-hidden />
                      <p className="text-status-amber-emphasis text-sm font-medium leading-snug">
                        No service location on this lead
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </TabPanel>

          <TabPanel value="walkthrough" activeValue={activeTab}>
            <WalkthroughTabContent
              key={walkthroughSyncKey(lead)}
              lead={lead}
              leadId={id!}
              canPerformWalkthrough={canPerformWalkthrough}
              canScheduleWalkthrough={canScheduleWalkthrough}
              // Slice 09: the row's Cancel opens the SAME dialog the header menu opens, gated on
              // `cancel Lead` - what POST /walkthrough/cancel rides - so it is absent, never
              // present-and-failing, for a viewer without it.
              onCancelWalkthrough={ability.can('cancel', 'Lead') ? () => setCancelWtOpen(true) : undefined}
            />
          </TabPanel>

          <TabPanel value="attachments" activeValue={activeTab}>
            <div className="p-5">
              <AttachmentSection entityType="LEAD" entityId={id!} />
            </div>
          </TabPanel>

          <TabPanel value="estimates" activeValue={activeTab}>
            <div className="p-5">
              <div className="mb-4 flex items-center justify-between">
                <p className="text-muted-foreground text-xs font-semibold uppercase">
                  Estimates ({estimateCount})
                </p>
                {canCreateEstimate && (
                  <Button size="sm" onClick={() => navTo(`/estimates/new?lead_id=${id}`)}>
                    + New Estimate
                  </Button>
                )}
              </div>

              {estimates.length === 0 ? (
                <EmptyState icon={<FileText />} title="No estimates yet." description="Create one to get started." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Number</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Deposit</TableHead>
                      <TableHead>Created By</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Total</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {estimates.map((est) => (
                      <TableRow
                        key={est.id}
                        className="group cursor-pointer"
                        onClick={() => navTo(`/estimates/${est.id}`)}
                      >
                        <TableCell>{est.estimate_number}</TableCell>
                        <TableCell><StatusChip domain="estimate" status={est.status} /></TableCell>
                        <TableCell>
                          {est.deposit
                            ? <StatusChip domain="deposit" status={est.deposit.status} />
                            : <span className="text-muted-foreground">{'-'}</span>}
                        </TableCell>
                        <TableCell>
                          {est.creator ? `${est.creator.first_name} ${est.creator.last_name}` : '-'}
                        </TableCell>
                        <TableCell>{formatDateTime(est.created_at, tz)}</TableCell>
                        <TableCell>{formatCurrency(est.total_amount)}</TableCell>
                        <TableCell>
                          <Pencil className="text-muted-foreground size-3.5 opacity-0 group-hover:opacity-100" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabPanel>

          <TabPanel value="tasks" activeValue={activeTab}>
            <JobLeadTasksTab
              entity={{ type: 'LEAD', id: lead.id, label: `Lead from ${customerDisplayName(customer)}` }}
              jobType={(lead.job_type as string | null) ?? undefined}
            />
          </TabPanel>

          {canReadComms && (
            <TabPanel value="communication" activeValue={activeTab}>
              <div className="p-5">
                <LeadCommunicationsTab
                  leadId={lead.id as string}
                  leadLabel={lead.lead_number as string}
                  customerId={customer.id}
                  customerName={customerLabel}
                  customerPhone={customer.phone}
                />
              </div>
            </TabPanel>
          )}
        </Card>

        {/* Dialogs */}
        <MarkLostDialog open={lostOpen} onOpenChange={setLostOpen} leadId={id!} />
        <CancelLeadDialog open={cancelOpen} onOpenChange={setCancelOpen} leadId={id!} />
        <DeleteLeadDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          leadId={id!}
          onDeleted={() => navigate(v2Path('/leads'))}
        />
        <CancelWalkthroughDialog open={cancelWtOpen} onOpenChange={setCancelWtOpen} leadId={id!} />
        <CreateJobFromLeadDialog
          open={createJobOpen}
          onOpenChange={(open) => {
            setCreateJobOpen(open);
            // Clear the deep-link preselect on close so a later manual open starts
            // from a clean selection, not the previously-linked estimate.
            if (!open) setPreselectEstimateId(null);
          }}
          leadId={id!}
          estimates={estimates}
          canCreateEstimate={canCreateEstimate}
          preselectEstimateId={preselectEstimateId}
          isConverting={createJobMutation.isPending}
          onConvert={(estimateIds) => createJobMutation.mutate(estimateIds)}
        />
      </div>
    </IconRail>
  );
}
