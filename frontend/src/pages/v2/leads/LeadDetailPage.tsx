import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Briefcase, Calendar, CheckCircle2, Clock,
  FileText, MapPin, Paperclip, Pencil, RotateCcw, Trash2, User,
} from 'lucide-react';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { useAppAbility } from '@/contexts/AbilityContext';
import { RecordNumberEditor } from '@/components/crm/RecordNumberEditor';
import { customerDisplayName } from '@/lib/customer-name';
import {
  isConvertibleEstimate, leadConvertBlockedReason,
} from '@/features/estimate-workspace/lib/convertToJob';
import { CustomerContactBlock } from '@/components/contact/CustomerContactBlock';
import type { RecordContactEntry } from '@/lib/api/recordContactEntries';
import { LEAD_STATUSES, isTerminalLeadStatus } from '@/lib/filters/registries/leads';
import { useSpiderAvailable } from '@/lib/spider/gate';
import { spiderDraftFrom } from '@/lib/spider/followUp';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { AttachmentSection } from '@/components/crm/AttachmentSection';
import { IconRail } from '@/components/crm/IconRail';
import { AssignLeadPopover } from '@/components/leads/AssignLeadPopover';
import { LeadPeopleBlock } from '@/components/leads/LeadPeopleBlock';
import { TagInput } from '@/components/leads/TagInput';
import { DetailHeader, type DetailHeaderAction } from '@/components/detail/DetailHeader';
import { JobLeadTasksTab } from '@/components/tasks/JobLeadTasksTab';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';
import { Separator } from '@/ui-kit/components/ui/separator';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';

import { preferV2Path, v2Path } from '../uiV2';
import { CreateJobFromLeadDialog } from './components/createJobFromLeadDialog';
import {
  CancelWalkthroughDialog, DeleteLeadDialog, MarkLostDialog, ReopenLeadDialog,
} from './components/leadDialogs';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { formatDate, formatDateTime, isWalkthroughActive, leadOffers, type UserSummary, type VisitHistoryRow } from './components/leadShared';
import { LoadError } from '../_shared/loadError';
import NotAuthorizedPage from '@/components/NotAuthorizedPage';
import { isForbiddenError, isNotFoundError, retryUnlessRefused } from '../_shared/loadErrorState';
import { RecordCards } from '../_shared/recordCards';
import { useRecordCards } from '../_shared/useRecordCards';
import { StatusChip } from '../_shared/statusChip';
import { ProcessingBadge } from '@/components/invoices/ProcessingBadge';
import { StatusMenu, type StatusMenuOption } from '../_shared/statusMenu';
import { LEAD_STATUS_MEANING, type LeadStatusOptionFromServer } from './leadStatusMeaning';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { LeadWalkthroughNotes } from './components/leadWalkthroughNotes';
import { RecordNotesTab, type RecordNoteItem } from '@/components/notes/RecordNotesTab';
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
  scheduledAt, completedAt, cancelledAt, toBeScheduled = false,
}: {
  scheduledAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  /** A live walkthrough with performers and no time: in progress, so the same blue as a booked one. */
  toBeScheduled?: boolean;
}) {
  if (completedAt) {
    return <span data-testid="walkthrough-dot" className="bg-status-green inline-block size-2 rounded-full" />;
  }
  if (isWalkthroughActive(scheduledAt, completedAt, cancelledAt) || toBeScheduled) {
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
/** The tabs a `?tab=` link may open (the contractor's list). */
const LEAD_TABS = ['overview', 'walkthrough', 'estimates', 'attachments', 'communication', 'tasks', 'notes'] as const;

export default function LeadDetailPage() {
  const tz = useScheduleTimezone();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  // Spider (#2619; the contractor's click, Ran 15 Oct D4): a lead opened from a Spider alert card at
  // New starts its text box with his draft. The page never marks the alert read: the server ends it
  // once a real contact moves the lead on (D1, Ran 20 Oct; SPEC-6).
  const spiderAvailable = useSpiderAvailable();
  const spiderDraft = spiderAvailable ? spiderDraftFrom(location.state) : undefined;
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  const phone = useRecordCards();

  const [lostOpen, setLostOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cancelWtOpen, setCancelWtOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  /**
   * Deep links: `?createJob=<estimateId>` opens the convert dialog with that
   * estimate preselected, `?tab=<tab>` opens that tab (the contractor's list, so
   * a Spider alert card can open Communication, Walkthrough or Overview). Both
   * are consumed and then stripped with `{ replace: true }`, so a reload lands on
   * the default tab with no dialog. The strip keeps the router state, which
   * carries a Spider card's draft.
   *
   * The legacy page read them in an effect and wrote state from it. Here they
   * seed state through lazy initialisers and the effect only strips the params -
   * `setState` inside an effect body is a react-hooks error, and this keeps the
   * same observable behaviour for every real entry point (both links arrive on a
   * fresh mount, from the leads list or from an estimate).
   *
   * `?tab=` is whitelisted to the page's tabs so an arbitrary value cannot
   * select an invalid tab. A link that arrives while the page is already open
   * (another lead's Spider card) switches the tab during render, the same
   * observable behaviour without an effect writing state.
   */
  const [createJobOpen, setCreateJobOpen] = useState(() => Boolean(searchParams.get('createJob')));
  const [preselectEstimateId, setPreselectEstimateId] = useState<string | null>(
    () => searchParams.get('createJob'),
  );
  const tabParam = searchParams.get('tab');
  const requestedTab = tabParam && (LEAD_TABS as readonly string[]).includes(tabParam) ? tabParam : null;
  const [activeTab, setActiveTab] = useState(() => requestedTab ?? 'overview');
  const [seenTabRequest, setSeenTabRequest] = useState(requestedTab);
  if (requestedTab !== seenTabRequest) {
    setSeenTabRequest(requestedTab);
    if (requestedTab) setActiveTab(requestedTab);
  }

  useEffect(() => {
    const hasCreateJob = searchParams.has('createJob');
    const hasTab = searchParams.has('tab');
    if (!hasCreateJob && !hasTab) return;
    const next = new URLSearchParams(searchParams);
    if (hasCreateJob) next.delete('createJob');
    if (hasTab) next.delete('tab');
    setSearchParams(next, { replace: true, state: location.state });
  }, [searchParams, setSearchParams, location.state]);

  const { data: lead, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['lead', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/leads/${id}`);
      return data.lead;
    },
    enabled: Boolean(id),
    retry: retryUnlessRefused,
    // Estimate work (send, recall, payment, a new estimate) changes the lead's status, its menu and its estimates
    // on the server, and none of it refreshes this key. Re-read on every open so a cached copy shows first and the
    // server's answer replaces it (#2755).
    refetchOnMount: 'always',
  });

  useRecordVisit('leads', lead?.lead_number as string | undefined);

  const { data: leadAttachments } = useQuery({
    queryKey: ['attachments', 'LEAD', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/attachments/lead/${id}`);
      return (data.attachments ?? []) as unknown[];
    },
    // After the lead's own answer, so a lead the person may not open costs one refused request and not two.
    enabled: Boolean(id) && Boolean(lead),
  });
  // The lead's own notes, for the Notes tab. Same key and answer as the Activity panel's list, so the two share one fetch.
  const { data: leadNotes } = useQuery({
    queryKey: ['notes', 'LEAD', id],
    queryFn: async () => {
      const { data } = await api.get(`/api/leads/${id}/notes`);
      return data.notes as RecordNoteItem[];
    },
    enabled: Boolean(id) && Boolean(lead),
  });
  // Every attachment on the lead: its Attachments tab is the lead's ONE list, so the count
  // must match what that list renders.
  const attachmentCount = (leadAttachments ?? []).length;

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
      // A refusal usually means this page's copy of the lead is stale: re-read it so the menu shows the server's options (#2756).
      queryClient.invalidateQueries({ queryKey: ['lead', id] });
    },
  });

  // Convert to Job - the backend turns one or several WON estimates into a job. Exactly one id
  // posts the byte-identical `{ estimate_id }` request already in prod; more than one posts
  // `{ estimate_ids }` (job.controller.ts's pre-existing multi path, #2048).
  const createJobMutation = useMutation({
    mutationFn: async (estimateIds: string[]) => {
      const body = estimateIds.length === 1 ? { estimate_id: estimateIds[0] } : { estimate_ids: estimateIds };
      const { data } = await api.post('/api/jobs', body);
      // The server also says whether the new job opens for this person (S04.21). An older answer without it opens.
      return { job: data.job, openable: data.job_openable !== false };
    },
    onSuccess: ({ job, openable }) => {
      // A new job on the lead's customer.
      refreshAfterVisitWrite(queryClient, { jobId: job.id });
      // The converted estimate(s) stop being offered as convertible - refetch the lead.
      queryClient.invalidateQueries({ queryKey: ['lead', id] });
      if (openable) {
        navigate(preferV2Path(`/jobs/${job.id}`));
        return;
      }
      // The person is not on the new job (a walkthrough crew is not carried to it), so its page would refuse
      // them. They stay on the lead and are told the job exists.
      setCreateJobOpen(false);
      toast.success(`Job ${job.job_number} was created`, {
        description: 'You are not on it, so it does not open for you. You stay on this lead.',
      });
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
  // The server's per-record list says whether this person edits THIS lead (Edit leads, or the lead's creator while
  // they are still on it) and whether they may set its status by hand.
  const mayEditLeads = ability.can('update', 'Lead');
  const canEdit = leadOffers(lead, 'edit', mayEditLeads);
  // Add note: Add notes or Edit leads, with the lead in reach - the server's per-lead answer.
  const canAddNote = leadOffers(lead, 'add_note', ability.can('add_note', 'Lead') || mayEditLeads);
  // Walkthrough capabilities are split from `update Lead` to mirror the backend
  // routes: a strict TECHNICIAN holds `perform_walkthrough` but NOT
  // `update`/`schedule`, so gating these on `update Lead` would lock a tech out.
  // Noting and finishing are per walkthrough: the server lists the step only for a person on the crew of the
  // walkthrough the step would change (or holding Update any visit's status), so the lead's Owner who is not on that
  // crew is not offered a step the route would refuse.
  const mayPerformWalkthroughs = ability.can('perform_walkthrough', 'Lead');
  const canPerformWalkthrough = leadOffers(lead, 'walkthrough_notes', mayPerformWalkthroughs);
  const canFinishWalkthrough = leadOffers(lead, 'walkthrough_finish', mayPerformWalkthroughs);
  // Book walkthroughs: book, move, re-crew and cancel a walkthrough.
  const canScheduleWalkthrough = ability.can('schedule_walkthrough', 'Lead');
  const canChangeStatus = leadOffers(lead, 'change_status', mayEditLeads);
  // Setting Lost here does what "Mark lost" does, and the server asks for the same ability on it, so a user
  // without that ability is not offered the choice. A status the lead pipeline does not have (an older server still
  // listing a retired one) is never offered.
  const mayPickStatus = (s: string) => LEAD_STATUSES.includes(s) && (s !== 'LOST' || ability.can('mark_lost', 'Lead'));
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
  // A `?tab=communication` link opened by someone who cannot read communications lands on Overview.
  const visibleTab = activeTab === 'communication' && !canReadComms ? 'overview' : activeTab;
  const isNotTerminal = lead && !isTerminalLeadStatus(lead.status);
  const canMarkLost = isNotTerminal && ability.can('mark_lost', 'Lead');
  const isTerminal = lead && isTerminalLeadStatus(lead.status);
  // Reopen lead (S05.19): on a Won or Lost lead only, for a person the server lists it for (Reopen leads, and the lead
  // opens for them). An older answer with no action list falls back to what the person holds.
  const canReopen = Boolean(isTerminal) && leadOffers(lead, 'reopen', ability.can('reopen', 'Lead'));
  const canCreateEstimate = ability.can('create', 'Estimate') && !isTerminal;
  const isWalkthroughScheduled = isWalkthroughActive(
    lead?.walkthrough_scheduled_at,
    lead?.walkthrough_completed_at,
    lead?.walkthrough_cancelled_at,
  );
  // Performers on a live walkthrough with no time yet: the lead has a walkthrough that no date describes.
  const isWalkthroughToBeScheduled = !isWalkthroughScheduled && lead?.walkthrough_to_be_scheduled === true;

  const estimates = (lead?.estimates ?? []) as Array<{
    id: string; estimate_number: string; status: string;
    // Left out of the lead answer for a person who may not see this lead's estimate money.
    total_amount?: string; created_at: string;
    creator?: { id: string; first_name: string; last_name: string };
    deposit?: { id: string; status: string; amount: number | string } | null;
    job?: { id: string; job_number: string; status: string } | null;
    job_id?: string | null;
    job_link?: { id: string; job_number: string; status: string } | null;
    // #2188 slice 16 - the kind=DEPOSIT invoice, status only. The convert dialog reads it to
    // apply the same deposit gate POST /api/jobs enforces; declared here because this cast is
    // where the lead payload's estimate shape is stated.
    invoices?: Array<{ kind: string; status: string; processing_amount?: number | string }> | null;
  }>;
  // Slice 28b: the estimate's deposit, read off the kind=DEPOSIT invoice the payload carries (the
  // payload has no separate `deposit` object), with the bank money still clearing on it.
  const depositOf = (est: (typeof estimates)[number]) => {
    const invoice = est.invoices?.find((inv) => inv.kind === 'DEPOSIT');
    return invoice
      ? { status: invoice.status, processing: invoice.processing_amount }
      : est.deposit
        ? { status: est.deposit.status, processing: undefined }
        : null;
  };
  const renderDeposit = (est: (typeof estimates)[number]) => {
    const deposit = depositOf(est);
    return deposit
      ? (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <StatusChip domain="deposit" status={deposit.status} />
          <ProcessingBadge amount={deposit.processing} />
        </span>
      )
      : <span className="text-muted-foreground">{'-'}</span>;
  };
  // With the estimate money left out of the answer the page draws no total, in the tile or in the estimates list.
  const showEstimateMoney = estimates.every((e) => e.total_amount != null);
  const estimateTotal = estimates.reduce((sum, e) => sum + parseFloat(String(e.total_amount || '0')), 0);
  const estimateCount = estimates.length;
  const canConvertToJob = ability.can('create', 'Job');
  // #2048 - the ONE convertibility predicate, shared with the dialog and the estimate page
  // (convertToJob.ts). No `!isTerminal` term here (R3): approving an estimate moves the lead to
  // WON, which IS terminal, and that is exactly the state this button must still render in.
  const convertibleEstimates = estimates.filter(isConvertibleEstimate);
  const hasConvertibleEstimate = convertibleEstimates.length > 0;
  // #2188 slice 16 - the ONE-CLICK case: a single candidate, so there is nothing to choose and
  // the header posts without opening the dialog. That shortcut skipped the deposit gate, so a
  // lone deposit-blocked estimate got a live button that collected a 400 in a toast. It now asks
  // the SAME shared question the dialog's rows ask, and renders the SAME sentence - what an
  // operator learns about an estimate must not depend on how many siblings the lead has.
  const loneConvertible = convertibleEstimates.length === 1 ? convertibleEstimates[0]! : null;
  const loneConvertibleBlockedReason = loneConvertible
    ? leadConvertBlockedReason(loneConvertible)
    : null;
  // Read once per mount: `Date.now()` in the render body is an impure call
  // (react-hooks/purity), and "days open" does not need to tick.
  const [nowMs] = useState(() => Date.now());
  // Slice 03: re-pointing the lead's anchor from the lead itself, so a CSR can correct a
  // wrong site while the customer is still on the phone.
  const daysOpen = lead ? Math.floor((nowMs - new Date(lead.created_at).getTime()) / (1000 * 60 * 60 * 24)) : 0;
  // Delete is available only with zero estimates, and gated by ability.
  const canDelete = ability.can('delete', 'Lead') && estimateCount === 0;

  const tags: Tag[] = (lead?.tags ?? []) as Tag[];

  // The header's menu items (mobile slice 55), in the order the kebab always had.
  const leadHeaderActions: DetailHeaderAction[] = [
    ...(canCreateEstimate
      ? [{ key: 'create-estimate', label: 'Create Estimate', icon: <FileText />, onSelect: () => navTo(`/estimates/new?lead_id=${id}`) }]
      : []),
    ...(canEdit
      ? [{ key: 'edit', label: 'Edit', icon: <Pencil />, onSelect: () => navigate(v2Path(`/leads/${id}/edit`)) }]
      : []),
    ...(canAssign ? [{ key: 'assign', label: 'Assign', icon: <User />, onSelect: () => setAssignOpen(true) }] : []),
    ...(canConvertToJob
      ? [{ key: 'convert', label: 'Convert to job', icon: <Briefcase />, onSelect: () => setCreateJobOpen(true) }]
      : []),
    ...((isWalkthroughScheduled || isWalkthroughToBeScheduled) && canScheduleWalkthrough
      ? [{ key: 'cancel-walkthrough', label: 'Cancel Walkthrough', variant: 'destructive' as const, onSelect: () => setCancelWtOpen(true) }]
      : []),
    ...(canReopen
      ? [{
          key: 'reopen', label: 'Reopen lead', icon: <RotateCcw />, onSelect: () => setReopenOpen(true),
          inline: true, buttonVariant: 'outline' as const, buttonSize: 'sm' as const,
        }]
      : []),
    ...(canMarkLost
      ? [{ key: 'mark-lost', label: 'Mark Lost', icon: <AlertTriangle />, variant: 'destructive' as const, onSelect: () => setLostOpen(true) }]
      : []),
    ...(canDelete
      ? [{ key: 'delete', label: 'Delete', icon: <Trash2 />, variant: 'destructive' as const, onSelect: () => setDeleteOpen(true) }]
      : []),
  ];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  // The server refused the lead: the person may not open it (the page never decides that itself).
  if (!lead && isForbiddenError(error)) return <NotAuthorizedPage />;

  // A failed request is an error with a Retry (mobile slice 68): only a real 404, or a response
  // with no lead in it, is "not found". A dropped connection says nothing about the lead.
  if (!lead && isError && !isNotFoundError(error)) {
    return (
      <Card>
        <LoadError title="Couldn't load this lead." onRetry={() => { void refetch(); }} retrying={isFetching} />
      </Card>
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
    company_name: string | null; email: string | null; phone: string | null;
    // The full contact set the lead detail answers: every phone and every email on file.
    phones?: { phone: string; label: string | null; extension: string | null; is_primary: boolean }[];
    emails?: { email: string; label: string | null; is_primary: boolean }[];
    service_locations?: Array<{
      id: string; address_line1: string; address_line2?: string | null;
      city: string; state: string; zip: string; is_primary: boolean;
    }>;
  };

  // Lead Owner = the SINGLE commission_owner; the Dispatcher is the lead's own slot (PRD 3).
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
          <div className="relative p-5">
            {/* Mobile slice 55: the shared detail header (this page was its prior art). Below sm:
                Back + the lead on one row (the name wraps), the status and meta rows, the one
                primary action full width and the rest inside "Lead actions"; from sm up the
                primary and the kebab sit right of the title as before.

                #2048 primary control - direct-converts at exactly one convertible estimate
                (mirrors the estimate page's own "Create Job" button, R1); opens the
                multi-select dialog above one; falls back to "Create Estimate" (unchanged
                kebab-item behaviour) when nothing is convertible. Deliberately NOT gated on
                `!isTerminal` (R3) - a lead with a WON estimate IS terminal, and that is
                exactly the state this button must still render in. */}
            <DetailHeader
              backTo={preferV2Path('/leads')}
              backLabel="Back to leads"
              menuLabel="Lead actions"
              menuIconOnly
              // Assign opens a follow-up popover; keep focus with it instead of restoring focus to
              // the menu trigger (which would dismiss the popover).
              onMenuCloseAutoFocus={(e) => {
                if (assignOpen) e.preventDefault();
              }}
              identity={
                <>
                  {/* role/aria-level rather than an <h1>: the design-system
                      raw-tag ratchet sits at its floor for h1-h6, so a v2 page
                      may not add one. The accessible heading is preserved. */}
                  <p role="heading" aria-level={1} className="flex flex-wrap items-baseline gap-x-2 text-xl font-semibold">
                    <span className="shrink-0">
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
                    </span>
                    <span className="min-w-0 break-words" title={customerLabel}>- {customerLabel}</span>
                  </p>
                </>
              }
              meta={
                <div className="flex min-w-0 basis-full flex-col gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                    <StatusMenu
                      domain="lead"
                      label="Lead status"
                      value={lead.status as string}
                      options={statusOptions}
                      onValueChange={(s) => {
                        // Closing a lead always asks why: Lost opens the same dialog as the Mark Lost
                        // button instead of sending a bare PATCH.
                        // Picking the status the lead already has changes nothing, so it asks nothing.
                        if (s === lead.status) return;
                        if (s === 'LOST') setLostOpen(true);
                        else statusMutation.mutate(s);
                      }}
                      disabled={!canChangeStatus || statusMutation.isPending}
                    />
                    <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      {customer.company_name && <span className="break-words">{customer.company_name}</span>}
                      <span>Created {formatDate(lead.created_at, tz)}</span>
                    </div>
                  </div>
                  <TagInput leadId={id!} tags={tags} readOnly={!canEdit} />
                </div>
              }
              primary={
                canConvertToJob && loneConvertible ? (
                  loneConvertibleBlockedReason ? (
                    /* Shown and disabled, never hidden: the estimate itself is fine and the
                       deposit is the thing the operator can go and fix. `title` is the same
                       affordance the estimate page's own blocked header button uses (slice 15),
                       carrying the same sentence from the same helper. */
                    <Button size="sm" disabled disabledReason={loneConvertibleBlockedReason}>
                      <Briefcase />
                      Convert to job
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => createJobMutation.mutate([loneConvertible.id])}
                      disabled={createJobMutation.isPending}
                    >
                      {createJobMutation.isPending ? <Spinner label={null} /> : <Briefcase />}
                      Convert to job
                    </Button>
                  )
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
                ) : undefined
              }
              secondary={leadHeaderActions}
            />
            {canAssign && (
              <AssignLeadPopover
                leadId={id!}
                currentAssignedTo={(lead.commission_owner as { id: string } | null)?.id ?? null}
                currentAssignedPerson={assignedUser}
                open={assignOpen}
                onOpenChange={setAssignOpen}
                // A zero-size anchor at the card's top right corner, where the kebab sits wide.
                // Absolute, so it takes no part in the header's layout (and no gap of its own).
                trigger={<span aria-hidden="true" tabIndex={-1} className="pointer-events-none absolute right-5 top-14 size-0" />}
              />
            )}
          </div>

          {/* KPI strip */}
          {/* Two to a row below sm (four across never fit 320 px); one row from sm up. */}
          <div className="grid grid-cols-2 border-t sm:flex">
            {showEstimateMoney && (
              <>
                <div className="min-w-0 flex-1 px-5 py-4">
                  <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">Estimated Value</p>
                  <p className="mt-0.5 text-xl font-bold">{estimateTotal > 0 ? formatCurrency(estimateTotal) : '-'}</p>
                </div>
                <Separator orientation="vertical" className="hidden h-auto sm:block" />
              </>
            )}
            <div className="min-w-0 flex-1 px-5 py-4">
              <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">Estimates</p>
              <p className="mt-0.5 text-xl font-bold">{estimateCount}</p>
            </div>
            <Separator orientation="vertical" className="hidden h-auto sm:block" />
            <div className="min-w-0 flex-1 px-5 py-4">
              <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">Days Open</p>
              <p className="mt-0.5 text-xl font-bold">{daysOpen}</p>
            </div>
            <Separator orientation="vertical" className="hidden h-auto sm:block" />
            <div className="min-w-0 flex-1 px-5 py-4">
              <p className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">Source</p>
              <p className="mt-0.5 break-words text-xl font-bold">
                {(lead.customer as { ad_source?: string | null })?.ad_source || '-'}
              </p>
            </div>
          </div>

          {/* Tabs */}
          <TabStrip
            className="border-t"
            value={visibleTab}
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
                      toBeScheduled={isWalkthroughToBeScheduled}
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
              { value: 'notes', label: 'Notes' },
            ]}
          />

          <TabPanel value="overview" activeValue={visibleTab}>
            <div className="flex flex-col lg:flex-row">
              {/* Left column (~65%) */}
              <div className="min-w-0 flex-[65]">
                <div className="p-5">
                  <p className="text-muted-foreground mb-3 text-xs font-semibold uppercase">Service Request</p>
                  <p className="whitespace-pre-wrap text-sm">{lead.service_request as string}</p>

                  {/* No "Lead Notes" block (#3104): the lead's general note is the first note on the Notes tab. */}
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

                  {(lead.status as string) === 'LOST' && (
                    <div className="bg-status-red-subtle mt-3 rounded-lg border p-3">
                      <p className="text-destructive text-xs font-semibold">Lost Reason</p>
                      {/* A lead that was Cancelled from the old status menu became Lost with no reason (S05.18). */}
                      <p className="mt-1 text-sm">{(lead.lost_reason as string) || 'No reason recorded'}</p>
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
                    ) : isWalkthroughToBeScheduled ? (
                      <>
                        <Clock className="text-status-blue" />
                        <span className="flex flex-col items-start">
                          <span className="text-sm font-medium">To be scheduled</span>
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
                            Finished {formatDateTime(lead.walkthrough_completed_at as string, tz)}
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
                          {canScheduleWalkthrough ? 'No walkthrough scheduled yet - click to schedule' : 'No walkthrough scheduled yet'}
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
                  {/* Name, company, every phone and every email, drawn through the contact display policy (PRD 5), with the lead's own entries and the pencil (S05.13). */}
                  <CustomerContactBlock
                    customer={customer}
                    context={{ leadId: id!, leadLabel: lead.lead_number as string, textCarriesLead: true }}
                    record={{ kind: 'lead', id: id!, mayEdit: canEdit, closed: Boolean(isTerminal), onReopen: canReopen ? () => setReopenOpen(true) : undefined }}
                    entries={lead.contact_entries as RecordContactEntry[] | undefined}
                    editCustomer
                  />
                </div>

                <div className="border-t p-5">
                  <LeadPeopleBlock
                    leadId={id!}
                    owner={assignedUser}
                    dispatcher={(lead.dispatcher as UserSummary | null | undefined) ?? null}
                    canAssign={canAssign}
                  />
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

          <TabPanel value="walkthrough" activeValue={visibleTab}>
            <WalkthroughTabContent
              key={walkthroughSyncKey(lead)}
              lead={lead}
              leadId={id!}
              canPerformWalkthrough={canPerformWalkthrough}
              canFinishWalkthrough={canFinishWalkthrough}
              canScheduleWalkthrough={canScheduleWalkthrough}
              // Slice 09: the row's Cancel opens the SAME dialog the header menu opens, gated on
              // Book walkthroughs - what POST /walkthrough/cancel rides - so it is absent, never
              // present-and-failing, for a viewer without it.
              onCancelWalkthrough={canScheduleWalkthrough ? () => setCancelWtOpen(true) : undefined}
            />
          </TabPanel>

          <TabPanel value="attachments" activeValue={visibleTab}>
            <div className="p-5">
              <AttachmentSection entityType="LEAD" entityId={id!} />
            </div>
          </TabPanel>

          <TabPanel value="estimates" activeValue={visibleTab}>
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
                <EmptyState icon={<FileText />} title="No estimates yet." description={canCreateEstimate ? 'Create one to get started.' : undefined} />
              ) : phone ? (
                <RecordCards
                  label="Estimates"
                  items={estimates.map((est) => ({
                    key: est.id,
                    title: est.estimate_number,
                    aside: <StatusChip domain="estimate" status={est.status} />,
                    onOpen: () => navTo(`/estimates/${est.id}`),
                    fields: [
                      {
                        label: 'Deposit',
                        value: renderDeposit(est),
                      },
                      { label: 'Created By', value: est.creator ? `${est.creator.first_name} ${est.creator.last_name}` : '-' },
                      { label: 'Date', value: formatDateTime(est.created_at, tz) },
                      ...(showEstimateMoney ? [{ label: 'Total', value: formatCurrency(est.total_amount!) }] : []),
                    ],
                  }))}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Number</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Deposit</TableHead>
                      <TableHead>Created By</TableHead>
                      <TableHead>Date</TableHead>
                      {showEstimateMoney && <TableHead>Total</TableHead>}
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
                          {renderDeposit(est)}
                        </TableCell>
                        <TableCell>
                          {est.creator ? `${est.creator.first_name} ${est.creator.last_name}` : '-'}
                        </TableCell>
                        <TableCell>{formatDateTime(est.created_at, tz)}</TableCell>
                        {showEstimateMoney && <TableCell>{formatCurrency(est.total_amount!)}</TableCell>}
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

          <TabPanel value="tasks" activeValue={visibleTab}>
            <JobLeadTasksTab
              entity={{ type: 'LEAD', id: lead.id, label: `Lead from ${customerDisplayName(customer)}` }}
              jobType={(lead.job_type as string | null) ?? undefined}
            />
          </TabPanel>

          <TabPanel value="notes" activeValue={visibleTab}>
            <RecordNotesTab recordType="LEAD" recordId={lead.id as string} notes={leadNotes} canAddNotes={canAddNote} />
            <div className="px-5 pb-5">
              <LeadWalkthroughNotes leadId={lead.id as string} history={lead.walkthrough_history as VisitHistoryRow[] | undefined} tz={tz} />
            </div>
          </TabPanel>

          {canReadComms && (
            <TabPanel value="communication" activeValue={visibleTab}>
              <div className="p-5">
                <LeadCommunicationsTab
                  key={spiderDraft ? location.key : 'communication'}
                  leadId={lead.id as string}
                  leadLabel={lead.lead_number as string}
                  customerId={customer.id}
                  customerName={customerLabel}
                  customerPhone={customer.phone ?? undefined}
                  customerEmail={customer.email ?? undefined}
                  initialMessage={spiderDraft}
                  onSent={
                    spiderDraft
                      ? () => {
                          // The text went out: the card's draft is used up, so a reload starts clean. The alert
                          // itself is ended by the server (the lead left New), never by this page (D1, SPEC-6).
                          navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
                        }
                      : undefined
                  }
                />
              </div>
            </TabPanel>
          )}
        </Card>

        {/* Dialogs */}
        <MarkLostDialog open={lostOpen} onOpenChange={setLostOpen} leadId={id!} />
        <ReopenLeadDialog open={reopenOpen} onOpenChange={setReopenOpen} leadId={id!} />
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
