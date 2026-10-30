import { useState, type JSX } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone, MessageSquare, Plus, Loader2, type LucideIcon } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn, extractApiError, getInitials } from '@/lib/utils';
import { SectionCard, SectionLabel } from '@/components/jobs/overview/SectionCard';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AssigneeSelect } from '@/components/crm/AssigneeSelect';
import { setJobDispatcher, setJobSoldBy } from '@/lib/api/jobs';
import { toast } from '@/components/ui/use-toast';
import { PhoneContactActions } from '@/components/contact/PhoneContactActions';
import { DeactivatedMark } from '@/components/people/DeactivatedMark';
import type { DialerEntityContext } from '@/stores/dialer.store';

// ─── Helpers ────────────────────────────────────────────────────────────────

function titleCase(str?: string | null): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function roleTitle(user: { role?: string | null; department?: { name?: string | null } | null }): string {
  return [user.department?.name, titleCase(user.role)].filter(Boolean).join(' ');
}

function fullNameOf(person: TeamPerson): string {
  return [person.first_name, person.last_name].filter(Boolean).join(' ') || '-';
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamPerson {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  role?: string | null;
  /** False for a person who has been deactivated: their name stays on the job, marked (P19). */
  is_active?: boolean;
  phone?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  department?: { name?: string | null } | null;
}

interface TeamCardProps {
  job: {
    id: string;
    job_number?: string | null;
    dispatcher?: TeamPerson | null;
    // The Sold By stored on the job. Empty shows a dash; it is never read from the lead the job came from.
    salesperson?: TeamPerson | null;
    assignees?: Array<{ user: TeamPerson }> | null;
  };
  /**
   * Opens the assign-technicians flow; affordances render only when provided.
   *
   * This is ALSO the card's authority signal for the dispatcher affordance below - see the
   * `canAssign` derivation in the component. The parent has already answered "may this user assign
   * THIS job"; the card must not re-derive it.
   */
  onAssign?: () => void;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DisabledContactButton({ label, icon: Icon }: { label: string; icon: LucideIcon }) {
  // No phone on file - show the affordance, disabled. Not a control (nothing happens on a tap), so it is
  // a named image: aria-label and aria-disabled on a bare span are not allowed (axe aria-prohibited-attr).
  return (
    <span
      role="img"
      aria-label={label}
      title="No phone on file"
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-light transition-colors',
        'text-text-secondary opacity-50 cursor-not-allowed',
      )}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

// Call + Text are always shown (for dispatcher, sold-by, and every technician). With a phone they follow the
// contact display policy as a crew phone: the in-app dialer and composer with the job attached, the digits alone
// without Contact customers, or the device's own links in a company without the phone service.
function PersonActions({ person, label, context }: { person: TeamPerson; label: string; context: DialerEntityContext }) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {person.phone ? (
        <PhoneContactActions kind="crew_phone" phone={person.phone} name={label} context={context} variant="outline" />
      ) : (
        <>
          <DisabledContactButton label={`Call ${label}`} icon={Phone} />
          <DisabledContactButton label={`Text ${label}`} icon={MessageSquare} />
        </>
      )}
    </div>
  );
}

function PersonRow({
  person,
  subtitle,
  context,
}: {
  person: TeamPerson;
  subtitle?: string;
  /** The job a call from this row is attached to. */
  context: DialerEntityContext;
}) {
  const fullName = fullNameOf(person);

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <Avatar ring="stack" className="h-11 w-11 shrink-0">
          {person.avatar_url && (
            <AvatarImage src={person.avatar_url} alt={fullName} loading="lazy" decoding="async" className="object-cover" />
          )}
          <AvatarFallback tone="solid" className="text-xs font-semibold">
            {getInitials(fullName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <span className="truncate">{fullName}</span>
            <DeactivatedMark person={person} />
          </p>
          {subtitle && <p className="text-xs text-text-secondary mt-0.5 truncate">{subtitle}</p>}
        </div>
      </div>
      <PersonActions person={person} label={fullName} context={context} />
    </div>
  );
}

// ─── Dispatcher and Sold By assign dialogs (#291, S03.11) ─────────────────────

// The two people fields on the card that are set, changed and cleared the same way. Each names the slot
// its picker lists (the roster answers from the person's own switch), the sentence under the title, and
// the write; the labels are derived from `noun`.
interface PersonSlotDialogConfig {
  slot: 'dispatcher' | 'owner';
  /** What the field is called, as in "Change Dispatcher" and "Clear dispatcher". */
  noun: string;
  description: string;
  save: (jobId: string, personId: string | null) => Promise<unknown>;
}

const DISPATCHER_DIALOG: PersonSlotDialogConfig = {
  slot: 'dispatcher',
  noun: 'Dispatcher',
  description: 'Only people who can be a dispatcher are listed.',
  save: setJobDispatcher,
};

const SOLD_BY_DIALOG: PersonSlotDialogConfig = {
  slot: 'owner',
  noun: 'Sold By',
  description: 'Only people who can be Sold By are listed.',
  save: setJobSoldBy,
};

function AssignPersonDialog({
  config,
  open,
  onOpenChange,
  jobId,
  currentPersonId,
  currentPerson,
}: {
  config: PersonSlotDialogConfig;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  currentPersonId: string | null;
  /** The same person the id names, when the card has their row - a LABEL source only. */
  currentPerson?: TeamPerson | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{currentPersonId ? `Change ${config.noun}` : `Assign ${config.noun}`}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while the dialog is open, so the choice starts from the current holder each time. */}
        <PersonSlotForm
          config={config}
          jobId={jobId}
          currentPersonId={currentPersonId}
          currentPerson={currentPerson}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function PersonSlotForm({
  config,
  jobId,
  currentPersonId,
  currentPerson,
  onDone,
}: {
  config: PersonSlotDialogConfig;
  jobId: string;
  currentPersonId: string | null;
  currentPerson?: TeamPerson | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(currentPersonId);
  const noun = config.noun;

  const mutation = useMutation({
    mutationFn: (personId: string | null) => config.save(jobId, personId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      onDone();
    },
    onError: (err) =>
      toast({
        title: `Could not set ${noun.toLowerCase()}`,
        description: extractApiError(err, `Failed to set job ${noun.toLowerCase()}`),
        variant: 'destructive',
      }),
  });

  return (
    <>
      <div className="space-y-4">
        <AssigneeSelect
          eligibleFor={config.slot}
          // `directory`, not `jobCrew`: neither the job DISPATCHER nor its Sold By is job crew. Their
          // doors (POST /api/jobs/:id/dispatcher and /sold-by, gated `assign Job`) never reach
          // `isAssigneeSetPermitted` - that runs on the CREW door alone - so `assign User`
          // governs nothing here, and scoping by it hid people the API would have
          // accepted. `read User` is the grant that has always gated this list.
          purpose="directory"
          value={selected}
          onChange={setSelected}
          placeholder={`Select ${noun.toLowerCase()}...`}
          // The person already in the field, when the caller could name them. Without it a
          // viewer whose scoped roster excludes that person sees an EMPTY trigger on a job
          // that plainly has one - Combobox reads its label out of `options`.
          knownPeople={
            currentPerson?.id
              ? [{
                  id: currentPerson.id,
                  first_name: currentPerson.first_name,
                  last_name: currentPerson.last_name,
                }]
              : undefined
          }
        />
      </div>

      <DialogFooter className="gap-3">
        {currentPersonId && (
          <Button
            variant="outline"
            onClick={() => mutation.mutate(null)}
            disabled={mutation.isPending}
          >
            {`Clear ${config.slot === 'dispatcher' ? noun.toLowerCase() : noun}`}
          </Button>
        )}
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          onClick={() => mutation.mutate(selected)}
          disabled={!selected || mutation.isPending}
        >
          {mutation.isPending ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</>
          ) : (
            'Save'
          )}
        </Button>
      </DialogFooter>
    </>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function TeamCard({ job, onAssign }: TeamCardProps): JSX.Element {
  const { dispatcher, salesperson, assignees } = job;
  // Derived from the parent's answer, NOT from `ability.can('assign','Job')`. That subject-level
  // question is true for every technician since the technician-ownership spec (Part C) scoped
  // `assign Job` to `created_by_id`, and it cannot see which job is on screen - so it rendered the
  // dispatcher Assign/Change control on jobs the API refuses. JobDetailPage already computes the
  // per-instance answer (canOnJob) and passes it as `onAssign`; re-deriving it here threw that away.
  const canAssign = !!onAssign;
  const callContext: DialerEntityContext = { jobId: job.id, ...(job.job_number ? { jobLabel: job.job_number } : {}) };
  const [dispatcherOpen, setDispatcherOpen] = useState(false);
  const [soldByOpen, setSoldByOpen] = useState(false);

  return (
    <SectionCard title="Team" bodyClassName="space-y-5">
      {/* Dispatcher */}
      <section>
        <SectionLabel
          action={
            canAssign && (
              // Left raw: idle text-primary / hover text-ocean-700 with no underline -
              // no minted Button cell reproduces this exact idle/hover pair (link/brand
              // hovers via underline, not a colour shift; ghost/subtle's hover targets
              // text-text-primary, not the brand ocean-700 shade).
              <button
                type="button"
                onClick={() => setDispatcherOpen(true)}
                className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-ocean-700"
              >
                {dispatcher ? 'Change' : 'Assign'}
              </button>
            )
          }
        >
          Dispatcher
        </SectionLabel>
        {dispatcher ? (
          <PersonRow person={dispatcher} subtitle={roleTitle(dispatcher) || 'Dispatcher'} context={callContext} />
        ) : (
          <p className="text-sm text-text-secondary">No dispatcher</p>
        )}
        {canAssign && (
          <AssignPersonDialog
            config={DISPATCHER_DIALOG}
            open={dispatcherOpen}
            onOpenChange={setDispatcherOpen}
            jobId={job.id}
            currentPersonId={dispatcher?.id ?? null}
            currentPerson={dispatcher}
          />
        )}
      </section>

      {/* Sold By */}
      <section>
        <SectionLabel
          action={
            // Sold By rides the Dispatcher's switch (Assign people to jobs), so the same per-job answer.
            canAssign && (
              <button
                type="button"
                onClick={() => setSoldByOpen(true)}
                className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-ocean-700"
              >
                {salesperson ? 'Change' : 'Assign'}
              </button>
            )
          }
        >
          Sold By
        </SectionLabel>
        {salesperson ? (
          <PersonRow person={salesperson} subtitle={roleTitle(salesperson) || undefined} context={callContext} />
        ) : (
          <p className="text-sm text-text-secondary">{'\u2014'}</p>
        )}
        {canAssign && (
          <AssignPersonDialog
            config={SOLD_BY_DIALOG}
            open={soldByOpen}
            onOpenChange={setSoldByOpen}
            jobId={job.id}
            currentPersonId={salesperson?.id ?? null}
            currentPerson={salesperson}
          />
        )}
      </section>

      {/* Assigned Technicians */}
      <section>
        <SectionLabel
          action={
            onAssign && (
              // Left raw: same idle text-primary / hover text-ocean-700 shape as the
              // dispatcher action above - no minted cell reproduces it (see that comment).
              <button
                type="button"
                onClick={onAssign}
                className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-ocean-700"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Assign
              </button>
            )
          }
        >
          Assigned Technicians
        </SectionLabel>
        {assignees && assignees.length > 0 ? (
          <div className="space-y-3">
            {assignees.map((assignee, idx) => (
              <PersonRow
                key={assignee.user.id ?? idx}
                person={assignee.user}
                subtitle={roleTitle(assignee.user) || undefined}
                context={callContext}
              />
            ))}
          </div>
        ) : onAssign ? (
          // Left raw: same idle text-primary / hover text-ocean-700 shape as the two
          // action links above - no minted cell reproduces it.
          <button
            type="button"
            onClick={onAssign}
            className="text-sm font-medium text-primary hover:text-ocean-700"
          >
            + Add technician
          </button>
        ) : (
          <p className="text-sm text-text-secondary">No technicians assigned</p>
        )}
      </section>
    </SectionCard>
  );
}
