import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { AssignTeamPopover } from '@/components/crm/AssignTeamPopover';

interface AssignLeadPopoverProps {
  leadId: string;
  currentAssignedTo?: string | null;
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Lead-owner assign popover (#361, replaces AssignLeadDialog). Owner stays SINGLE:
 * exactly one pick, posted to POST /api/leads/:id/assign with the notify toggle.
 */
export function AssignLeadPopover({ leadId, currentAssignedTo, trigger, open, onOpenChange }: AssignLeadPopoverProps) {
  const queryClient = useQueryClient();

  return (
    <AssignTeamPopover
      // the lead OWNER, written by POST /api/leads/:id/assign, which never consults the assignee pool.
      purpose="directory"
      mode="single"
      channels={['in_app']}
      initialSelected={currentAssignedTo ? [currentAssignedTo] : []}
      trigger={trigger}
      open={open}
      onOpenChange={onOpenChange}
      onAssign={async (ids, notify) => {
        await api.post(`/api/leads/${leadId}/assign`, {
          assigned_to: ids[0],
          notify: { in_app: notify.in_app },
        });
        queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
        queryClient.invalidateQueries({ queryKey: ['leads'] });
      }}
    />
  );
}
