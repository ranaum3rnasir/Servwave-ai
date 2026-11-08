import { useEffect, useState, type JSX } from 'react';
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
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AssigneeSelect } from '@/components/crm/AssigneeSelect';
import { setJobDispatcher } from '@/lib/api/jobs';
import { toast } from '@/components/ui/use-toast';

// ─── Helpers ────────────────────────────────────────────────────────────────

function titleCase(str?: string | null): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function roleTitle(user: { role?: string | null; department?: { name?: string | null } | null }): string {
  return [user.department?.name, titleCase(user.role)].filter(Boolean).join(' ');
}

function fullNameOf(person: TeamPerson): string {
  return [person.first_name, person.last_name].filter(Boolean).join(' ') || '—';
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface TeamPerson {
  id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  role?: string | null;
  phone?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  department?: { name?: string | null } | null;
}

interface TeamCardProps {
  job: {
    id: string;
    dispatcher?: TeamPerson | null;
    estimate?: { lead?: { commission_owner?: TeamPerson | null } | null } | null;
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

function ContactButton({ href, label, icon: Icon }: { href?: string; label: string; icon: LucideIcon }) {
  const base =
    'flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-light transition-colors';
  if (href) {
    return (
      <a
        href={href}
        aria-label={label}
        className={cn(base, 'text-text-secondary hover:text-primary hover:border-primary/40')}
      >
        <Icon className="h-4 w-4" />
      </a>
    );
  }
  // No phone on file — show the affordance, disabled.
  return (
    <span
      aria-label={label}
      aria-disabled="true"
      title="No phone on file"
      className={cn(base, 'text-text-secondary opacity-50 cursor-not-allowed')}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

// Call + Text are always shown (for dispatcher, sold-by, and every technician).
function PersonActions({ person, label }: { person: TeamPerson; label: string }) {
  const tel = person.phone ? `tel:${person.phone}` : undefined;
  const sms = person.phone ? `sms:${person.phone}` : undefined;
  return (
    <div className="flex items-center gap-2 shrink-0">
      <ContactButton href={tel} label={`Call ${label}`} icon={Phone} />
      <ContactButton href={sms} label={`Text ${label}`} icon={MessageSquare} />
    </div>
  );
}

function PersonRow({
  person,
  subtitle,
}: {
  person: TeamPerson;
  subtitle?: string;
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
          <p className="text-sm font-semibold text-text-primary truncate">{fullName}</p>
          {subtitle && <p className="text-xs text-text-secondary mt-0.5 truncate">{subtitle}</p>}
        </div>
      </div>
      <PersonActions person={person} label={fullName} />
    </div>
  );
}

// ─── Dispatcher assign dialog (#291) ──────────────────────────────────────────

function AssignDispatcherDialog({
  open,
  onOpenChange,
  jobId,
  currentDispatcherId,
  currentDispatcher,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  currentDispatcherId: string | null;
  /** The same person the id names, when the card has their row - a LABEL source only. */
  currentDispatcher?: TeamPerson | null;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);

  // Seed from the current dispatcher each time the dialog opens.
  useEffect(() => {
    if (open) setSelected(currentDispatcherId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mutation = useMutation({
    mutationFn: (dispatcherId: string | null) => setJobDispatcher(jobId, dispatcherId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['job', jobId] });
      onOpenChange(false);
    },
    onError: (err) =>
      toast({
        title: 'Could not set dispatcher',
        description: extractApiError(err, 'Failed to set job dispatcher'),
        variant: 'destructive',
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{currentDispatcherId ? 'Change Dispatcher' : 'Assign Dispatcher'}</DialogTitle>
          <DialogDescription>Only dispatchers and admins can be selected.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <AssigneeSelect
            eligibleFor="dispatcher"
            // `directory`, not `jobCrew`: the job DISPATCHER is not job crew. `setJobDispatcher`
            // (POST /api/jobs/:id/dispatcher, gated `assign Job`) never reaches
            // `isAssigneeSetPermitted` - that runs on the CREW door alone - so `assign User`
            // governs nothing here, and scoping by it hid dispatchers the API would have
            // accepted. `read User` is the grant that has always gated this list.
            purpose="directory"
            value={selected}
            onChange={setSelected}
            placeholder="Select dispatcher..."
            enabled={open}
            // The dispatcher already on the job, when the caller could name them. Without it a
            // viewer whose scoped roster excludes that person sees an EMPTY trigger on a job
            // that plainly has a dispatcher - Combobox reads its label out of `options`.
            knownPeople={
              currentDispatcher?.id
                ? [{
                    id: currentDispatcher.id,
                    first_name: currentDispatcher.first_name,
                    last_name: currentDispatcher.last_name,
                  }]
                : undefined
            }
          />

          <div className="flex justify-end gap-3">
            {currentDispatcherId && (
              <Button
                variant="outline"
                onClick={() => mutation.mutate(null)}
                disabled={mutation.isPending}
              >
                Clear dispatcher
              </Button>
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function TeamCard({ job, onAssign }: TeamCardProps): JSX.Element {
  const { dispatcher, estimate, assignees } = job;
  const commissionOwner = estimate?.lead?.commission_owner ?? null;
  // Derived from the parent's answer, NOT from `ability.can('assign','Job')`. That subject-level
  // question is true for every technician since the technician-ownership spec (Part C) scoped
  // `assign Job` to `created_by_id`, and it cannot see which job is on screen - so it rendered the
  // dispatcher Assign/Change control on jobs the API refuses. JobDetailPage already computes the
  // per-instance answer (canOnJob) and passes it as `onAssign`; re-deriving it here threw that away.
  const canAssign = !!onAssign;
  const [dispatcherOpen, setDispatcherOpen] = useState(false);

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
          <PersonRow person={dispatcher} subtitle={roleTitle(dispatcher) || 'Dispatcher'} />
        ) : (
          <p className="text-sm text-text-secondary">Unassigned</p>
        )}
        {canAssign && (
          <AssignDispatcherDialog
            open={dispatcherOpen}
            onOpenChange={setDispatcherOpen}
            jobId={job.id}
            currentDispatcherId={dispatcher?.id ?? null}
            currentDispatcher={dispatcher}
          />
        )}
      </section>

      {/* Sold By */}
      <section>
        <SectionLabel>Sold By</SectionLabel>
        {commissionOwner ? (
          <PersonRow person={commissionOwner} subtitle={roleTitle(commissionOwner) || undefined} />
        ) : (
          <p className="text-sm text-text-secondary">—</p>
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
