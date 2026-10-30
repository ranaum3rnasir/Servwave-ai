import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { AssignTeamPopover } from '@/components/crm/AssignTeamPopover';

interface AssignLeadDispatcherPopoverProps {
  leadId: string;
  currentDispatcherId?: string | null;
  /** The Dispatcher's name, so the popover still shows them when the roster no longer lists them. */
  currentDispatcher?: { id: string; first_name: string; last_name: string } | null;
  trigger: ReactNode;
}

/**
 * Lead Dispatcher popover (PRD 3). The Dispatcher stays SINGLE like the Owner: exactly one pick, posted to
 * POST /api/leads/:id/dispatcher. Nobody is notified, so the popover offers no notify toggles. The roster lists
 * only the people who may be a dispatcher; the server asks again for a newly named person.
 */
export function AssignLeadDispatcherPopover({ leadId, currentDispatcherId, currentDispatcher, trigger }: AssignLeadDispatcherPopoverProps) {
  const queryClient = useQueryClient();

  return (
    <AssignTeamPopover
      // The route never consults the assignee pool, so this is a `directory` list, scoped by `read User`.
      purpose="directory"
      eligibleFor="dispatcher"
      knownPeople={currentDispatcher ? [currentDispatcher] : undefined}
      mode="single"
      channels={[]}
      initialSelected={currentDispatcherId ? [currentDispatcherId] : []}
      trigger={trigger}
      onAssign={async (ids) => {
        await api.post(`/api/leads/${leadId}/dispatcher`, { dispatcher_id: ids[0] });
        queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
        queryClient.invalidateQueries({ queryKey: ['leads'] });
      }}
    />
  );
}
