import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { summariseBulkResult } from '@/lib/bulk-result';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useConfirm } from '@/hooks/useConfirm';
import { BulkCancelJobsDialog, type BulkCancelResult } from '@/components/jobs/BulkCancelJobsDialog';
import { CompleteWithOpenVisitsDialog } from '@/components/jobs/CompleteWithOpenVisitsDialog';
import { openVisitsConflict, type OpenVisitsJob } from '@/components/jobs/openVisitsConflict';
import { BulkActionBar } from '@/ui-kit/components/crm/bulkActionBar';
import { Button } from '@/ui-kit/components/ui/button';
import { ChoiceMenu } from '@/ui-kit/components/ui/choiceMenu';
import { PickerFullscreen, usePickerFullscreen } from '@/ui-kit/components/ui/pickerFullscreen';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
  CommandSeparator,
} from '@/ui-kit/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { toast } from '@/ui-kit/components/ui/sonner';

import {
  BULK_STATUS_MENU, allowedBulkStatusActions, canBulkAssign, type BulkStatusAction,
} from '../bulkActions';

interface Assignee {
  id: string;
  first_name: string;
  last_name: string;
}

type BulkResult = {
  updated: string[];
  failed: { id: string; error: string }[];
  voided_invoice_ids?: string[];
};

const ACTION_LABEL: Record<Exclude<BulkStatusAction, 'cancel' | 'complete'>, string> = {
  arrive: 'On site',
  start: 'In progress',
};

/**
 * The jobs list's bulk-selection strip.
 *
 * The selection itself lives on the page in `useScopedRowSelection` - the
 * legacy list's own hook - and reaches the table through
 * `rowSelection`/`onRowSelectionChange`, so the "a selection only makes sense
 * against the CURRENT page, sort and filter" rule is enforced where the state
 * is held rather than by an effect reaching into the table instance.
 *
 * The two mutations, their endpoints, their invalidation set, the confirm copy
 * (including the Automations warning on a bulk Complete) and the toast summary
 * are `pages/JobsPage.tsx`'s, moved here unchanged - including its `useConfirm`
 * dialogs, which is what that page already uses: a browser `window.confirm`
 * cannot be themed and cannot be driven by the tools that drive the rest of the
 * app, so `src/__tests__/no-browser-dialogs.guard.test.ts` bans it outright.
 */
export function BulkBar({
  selectedJobIds, onClear, assignees, jobNumbers,
}: {
  selectedJobIds: string[];
  onClear: () => void;
  assignees: Assignee[];
  /** Job numbers by id, to name the jobs a bulk cancel refused. */
  jobNumbers?: Record<string, string>;
}) {
  const ability = useAppAbility();
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  // S04.17: the jobs the server named when it refused a bulk Completed over open visits (it completed none of them);
  // the confirmation is open while set.
  const [openVisitsJobs, setOpenVisitsJobs] = useState<OpenVisitsJob[] | null>(null);
  // S06.15: what a bulk cancel did when it refused some jobs. The cancel dialog stays open and lists each refused job with
  // its reason (the selection is kept until it is closed, because the bar goes with an empty selection).
  const [cancelResult, setCancelResult] = useState<BulkCancelResult | null>(null);

  // Every bulk door (the status verbs, cancel, crew assign) writes the selected jobs' visits.
  function reportBulkResult(result: BulkResult) {
    refreshAfterVisitWrite(queryClient, { jobIds: result.updated });
    queryClient.invalidateQueries({ queryKey: ['logistic-orders'] });
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
    onClear();
    const voidedCount = result.voided_invoice_ids?.length ?? 0;
    const voidedSuffix = voidedCount > 0
      ? ` ${voidedCount} invoice${voidedCount === 1 ? '' : 's'} on those jobs were voided.`
      : '';
    const { title, description } = summariseBulkResult({
      okCount: result.updated.length,
      failed: result.failed,
      noun: 'job',
      nounPlural: 'jobs',
      verbPast: 'updated',
    });
    toast(title, { description: description + voidedSuffix });
  }

  const bulkStatusMutation = useMutation({
    mutationFn: async (body: {
      ids: string[]; action: string; cancel_reason_code?: string; cancelled_reason?: string; void_invoices?: boolean; cancel_open_visits?: boolean;
    }) => {
      const { data } = await api.post('/api/jobs/bulk-status', body);
      return data as BulkResult;
    },
    onSuccess: (result, body) => {
      setOpenVisitsJobs(null);
      if (body.action === 'cancel' && result.failed.length > 0) {
        refreshAfterVisitWrite(queryClient, { jobIds: result.updated });
        queryClient.invalidateQueries({ queryKey: ['logistic-orders'] });
        queryClient.invalidateQueries({ queryKey: ['inventory'] });
        setCancelResult({ cancelledCount: result.updated.length, refused: result.failed });
        return;
      }
      if (body.action === 'cancel') setCancelDialogOpen(false);
      reportBulkResult(result);
    },
    onError: (err) => {
      const openVisits = openVisitsConflict(err);
      if (openVisits) {
        setOpenVisitsJobs(openVisits);
        return;
      }
      setOpenVisitsJobs(null);
      toast.error('Update failed', { description: 'Failed to update jobs. Please try again.' });
    },
  });

  const bulkAssignMutation = useMutation({
    mutationFn: async (body: { ids: string[]; assignee_ids: string[] }) => {
      const { data } = await api.post('/api/jobs/bulk-assign', body);
      return data as BulkResult;
    },
    onSuccess: reportBulkResult,
    onError: () => {
      toast.error('Assign failed', { description: 'Failed to assign jobs. Please try again.' });
    },
  });

  const handleStatusChoice = async (action: BulkStatusAction) => {
    if (selectedJobIds.length === 0) return;
    if (action === 'cancel') {
      setCancelDialogOpen(true);
      return;
    }
    const count = selectedJobIds.length;
    const plural = count === 1 ? '' : 's';
    const confirmed = await confirm(
      action === 'complete'
        ? {
            title: `Complete ${count} job${plural}?`,
            description: `Each job goes to office review. This will fire any customer follow-ups configured in Automations for job completion, one per job.`,
            confirmLabel: `Complete job${plural}`,
          }
        : {
            title: `Update ${count} job${plural} to ${ACTION_LABEL[action]}?`,
            confirmLabel: 'Update',
          },
    );
    if (!confirmed) return;
    bulkStatusMutation.mutate({ ids: selectedJobIds, action });
  };

  const handleCancelConfirm = (reasonCode: string, note: string, voidInvoices: boolean) => {
    bulkStatusMutation.mutate({
      ids: selectedJobIds, action: 'cancel', cancel_reason_code: reasonCode, ...(note ? { cancelled_reason: note } : {}), void_invoices: voidInvoices,
    });
    // The dialog stays open until the batch has answered: it lists the jobs the cancel refused.
  };

  const handleCancelDialogOpenChange = (next: boolean) => {
    setCancelDialogOpen(next);
    if (!next && cancelResult) {
      setCancelResult(null);
      onClear();
    }
  };

  const handleAssign = async (userId: string | null) => {
    const count = selectedJobIds.length;
    if (count === 0) return;
    const confirmed = await confirm(
      userId
        ? {
            title: `Assign 1 technician to ${count} job${count === 1 ? '' : 's'}?`,
            description: `This replaces the current crew on ${count === 1 ? 'that job' : 'those jobs'}, and the newly-assigned technician is emailed an assignment notice.`,
            confirmLabel: 'Assign',
          }
        : {
            title: `Clear the crew on ${count} job${count === 1 ? '' : 's'}?`,
            description: 'Removed technicians are emailed a removal notice.',
            confirmLabel: 'Clear crew',
            tone: 'danger' as const,
          },
    );
    if (!confirmed) return;
    bulkAssignMutation.mutate({ ids: selectedJobIds, assignee_ids: userId ? [userId] : [] });
  };

  const allowedActions = allowedBulkStatusActions(ability);
  const statusChoices = BULK_STATUS_MENU.filter((item) => allowedActions.includes(item.action));
  const canAssign = canBulkAssign(ability);

  // Below md the crew list is a full-screen sheet (mobile slice 44).
  const fullscreen = usePickerFullscreen();
  const crewPicker = (
    <>
        <Command className={fullscreen ? 'min-h-0 flex-1' : undefined}>
          <CommandInput placeholder="Search people..." />
          <CommandList className={fullscreen ? 'max-h-none min-h-0 flex-1' : undefined}>
            <CommandEmpty>No one found.</CommandEmpty>
            <CommandGroup heading="Assign to">
              {assignees.map((t) => {
                const name = `${t.first_name} ${t.last_name}`;
                return (
                  // `value` is the NAME, not the id - cmdk filters on the
                  // value, and filtering a person list by uuid matches
                  // nothing a user would ever type.
                  <CommandItem
                    key={t.id}
                    value={name}
                    onSelect={() => { setAssignOpen(false); void handleAssign(t.id); }}
                  >
                    {name}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="Clear crew"
                onSelect={() => { setAssignOpen(false); void handleAssign(null); }}
              >
                Clear crew
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
    </>
  );

  if (selectedJobIds.length === 0) return null;

  return (
    <>
      <BulkActionBar
        count={selectedJobIds.length}
        noun={['job', 'jobs']}
        onClear={onClear}
      >
        {statusChoices.length > 0 && (
          // A bottom sheet below md, the menu it was from md up (mobile slice 44).
          <ChoiceMenu
            title="Change status"
            align="end"
            trigger={
              <Button variant="outline" size="sm" disabled={bulkStatusMutation.isPending}>
                Change status
              </Button>
            }
            options={statusChoices.map((item) => ({
              key: item.action,
              label: item.label,
              onSelect: () => { void handleStatusChoice(item.action); },
            }))}
          />
        )}
        {canAssign && (
          /* A Command list in a Popover rather than a DropdownMenu, so the crew
             can be found by TYPING. An org with thirty technicians turned this
             menu into a scroll, and a dropdown cannot hold a text field: Radix's
             menu routes every keystroke into its own typeahead, so an input
             inside it never sees what you type.

             `assignOpen` is controlled only so choosing someone can close the
             popover - the confirm and the mutation are unchanged. */
          <Popover open={assignOpen} onOpenChange={setAssignOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" disabled={bulkAssignMutation.isPending}>
                Assign
              </Button>
            </PopoverTrigger>
            {fullscreen ? (
              <PickerFullscreen open={assignOpen} onOpenChange={setAssignOpen} title="Assign to">
                {crewPicker}
              </PickerFullscreen>
            ) : (
              <PopoverContent align="end" className="w-60 p-0">
                {crewPicker}
              </PopoverContent>
            )}
          </Popover>
        )}
      </BulkActionBar>

      {/* No kit equivalent: a required free-text reason plus the voided-invoice
          warning. The app component is reused as-is (ledger row). */}
      <CompleteWithOpenVisitsDialog
        open={openVisitsJobs !== null}
        onOpenChange={(next) => { if (!next) setOpenVisitsJobs(null); }}
        jobs={openVisitsJobs ?? []}
        completeCount={selectedJobIds.length}
        isPending={bulkStatusMutation.isPending}
        onConfirm={() => bulkStatusMutation.mutate({ ids: selectedJobIds, action: 'complete', cancel_open_visits: true })}
      />
      <BulkCancelJobsDialog
        open={cancelDialogOpen}
        onOpenChange={handleCancelDialogOpenChange}
        count={selectedJobIds.length}
        jobIds={selectedJobIds}
        isPending={bulkStatusMutation.isPending}
        onConfirm={handleCancelConfirm}
        result={cancelResult}
        jobNumbers={jobNumbers}
      />
      {confirmDialog}
    </>
  );
}
