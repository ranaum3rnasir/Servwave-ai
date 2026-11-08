import { type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { AssignTeamPopover } from '@/components/crm/AssignTeamPopover';

interface AssignJobCrewPopoverProps {
  jobId: string;
  currentAssigneeIds?: string[] | null;
  trigger: ReactNode;
}

/**
 * Job-crew assign popover (#361). Crew REPLACE semantics via the crew-only endpoint
 * POST /api/jobs/:id/assignees — never touches schedule or status (the Schedule
 * Job / Reschedule modal owns those).
 */
export function AssignJobCrewPopover({ jobId, currentAssigneeIds, trigger }: AssignJobCrewPopoverProps) {
  const queryClient = useQueryClient();

  return (
    <AssignTeamPopover
      // job CREW, which the assignee pool does govern.
      purpose="jobCrew"
      mode="multi"
      channels={['in_app', 'email']}
      initialSelected={currentAssigneeIds ?? []}
      trigger={trigger}
      onAssign={async (ids, notify) => {
        await api.post(`/api/jobs/${jobId}/assignees`, {
          assignee_ids: ids,
          notify: { in_app: notify.in_app, email: notify.email },
        });
        // Since S3 the crew lives on visit_assignees (setJobCrewOnCurrentVisit), so a crew
        // replace is a visit write even though "schedule" was untouched.
        refreshAfterVisitWrite(queryClient, { jobId });
      }}
    />
  );
}
