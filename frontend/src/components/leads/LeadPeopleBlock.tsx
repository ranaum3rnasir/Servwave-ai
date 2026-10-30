import { type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { User } from 'lucide-react';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { toast } from '@/ui-kit/components/ui/sonner';
import { AssignLeadPopover } from './AssignLeadPopover';
import { AssignLeadDispatcherPopover } from './AssignLeadDispatcherPopover';

type Person = { id: string; first_name: string; last_name: string };

interface LeadPeopleBlockProps {
  leadId: string;
  /** The lead's Owner (its commission owner), or null. */
  owner: Person | null;
  /** The lead's Dispatcher, or null. */
  dispatcher: Person | null;
  /** The viewer may change the lead's people (Assign people to leads). */
  canAssign: boolean;
}

function Slot({ label, empty, person, actions }: { label: string; empty: string; person: Person | null; actions: ReactNode }) {
  const headingId = `lead-people-${label.toLowerCase()}`;
  return (
    <section aria-labelledby={headingId} className="space-y-1.5">
      <p id={headingId} className="text-muted-foreground text-[10px] font-semibold uppercase tracking-widest">{label}</p>
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <User className="text-muted-foreground size-4 shrink-0" />
          <span className={person ? 'truncate font-medium' : 'text-muted-foreground'}>
            {person ? `${person.first_name} ${person.last_name}` : empty}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      </div>
    </section>
  );
}

/**
 * The lead page's people block (PRD 3): the lead's Owner and Dispatcher, each with Change and Clear for a
 * viewer with Assign people to leads. An empty slot is named for that slot. The server decides who may be
 * named; the pickers list only the people who can fill the slot.
 */
export function LeadPeopleBlock({ leadId, owner, dispatcher, canAssign }: LeadPeopleBlockProps) {
  const queryClient = useQueryClient();

  const clear = useMutation({
    mutationFn: async (slot: 'owner' | 'dispatcher') => {
      if (slot === 'owner') await api.post(`/api/leads/${leadId}/assign`, { assigned_to: null });
      else await api.post(`/api/leads/${leadId}/dispatcher`, { dispatcher_id: null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
    onError: (err: unknown, slot) => {
      toast.error(slot === 'owner' ? 'Could not clear the owner' : 'Could not clear the dispatcher', {
        description: extractApiError(err, 'The change was not saved'),
      });
    },
  });

  const clearButton = (slot: 'owner' | 'dispatcher') => (
    <Button variant="outline" size="sm" disabled={clear.isPending} onClick={() => clear.mutate(slot)}>Clear</Button>
  );

  return (
    <div className="space-y-4" data-testid="lead-people">
      <Slot
        label="Owner"
        empty="No owner"
        person={owner}
        actions={canAssign && (
          <>
            <AssignLeadPopover
              leadId={leadId}
              currentAssignedTo={owner?.id ?? null}
              currentAssignedPerson={owner}
              trigger={<Button variant="outline" size="sm">Change</Button>}
            />
            {owner && clearButton('owner')}
          </>
        )}
      />
      <Slot
        label="Dispatcher"
        empty="No dispatcher"
        person={dispatcher}
        actions={canAssign && (
          <>
            <AssignLeadDispatcherPopover
              leadId={leadId}
              currentDispatcherId={dispatcher?.id ?? null}
              currentDispatcher={dispatcher}
              trigger={<Button variant="outline" size="sm">Change</Button>}
            />
            {dispatcher && clearButton('dispatcher')}
          </>
        )}
      />
    </div>
  );
}
