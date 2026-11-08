import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { summariseBulkResult } from '@/lib/bulk-result';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useConfirm } from '@/hooks/useConfirm';
import { BulkCancelJobsDialog } from '@/components/jobs/BulkCancelJobsDialog';
import { BulkActionBar } from '@/ui-kit/components/crm/bulkActionBar';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
  CommandSeparator,
} from '@/ui-kit/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { toast } from '@/ui-kit/components/ui/sonner';

interface Assignee {
  id: string;
  first_name: string;
  last_name: string;
}

type BulkAction = 'arrive' | 'start' | 'complete' | 'cancel';

type BulkResult = {
  updated: string[];
  failed: { id: string; error: string }[];
  voided_invoice_ids?: string[];
};

const STATUS_MENU: { label: string; action: BulkAction }[] = [
  { label: 'On site', action: 'arrive' },
  { label: 'In progress', action: 'start' },
  { label: 'Completed', action: 'complete' },
  { label: 'Cancelled', action: 'cancel' },
];

const ACTION_LABEL: Record<Exclude<BulkAction, 'cancel'>, string> = {
  arrive: 'On site',
  start: 'In progress',
  complete: 'Completed',
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
  selectedJobIds, onClear, assignees,
}: {
  selectedJobIds: string[];
  onClear: () => void;
  assignees: Assignee[];
}) {
  const ability = useAppAbility();
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);

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
    mutationFn: async (body: { ids: string[]; action: string; cancelled_reason?: string }) => {
      const { data } = await api.post('/api/jobs/bulk-status', body);
      return data as BulkResult;
    },
    onSuccess: reportBulkResult,
    onError: () => {
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

  const handleStatusChoice = async (action: BulkAction) => {
    if (selectedJobIds.length === 0) return;
    if (action === 'cancel') {
      setCancelDialogOpen(true);
      return;
    }
    const count = selectedJobIds.length;
    const consequence = action === 'complete'
      ? ` Completing ${count} job${count === 1 ? '' : 's'} will fire any customer follow-ups configured in Automations for job completion, one per job.`
      : '';
    const confirmed = await confirm({
      title: `Update ${count} job${count === 1 ? '' : 's'} to ${ACTION_LABEL[action]}?`,
      description: consequence.trim() || undefined,
      confirmLabel: 'Update',
    });
    if (!confirmed) return;
    bulkStatusMutation.mutate({ ids: selectedJobIds, action });
  };

  const handleCancelConfirm = (reason: string) => {
    bulkStatusMutation.mutate({ ids: selectedJobIds, action: 'cancel', cancelled_reason: reason });
    setCancelDialogOpen(false);
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

  const statusChoices = STATUS_MENU.filter((item) => ability.can(item.action, 'Job'));
  const canAssign = ability.can('assign', 'Job');

  if (selectedJobIds.length === 0) return null;

  return (
    <>
      <BulkActionBar
        count={selectedJobIds.length}
        noun={['job', 'jobs']}
        onClear={onClear}
      >
        {statusChoices.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={bulkStatusMutation.isPending}>
                Change status
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {statusChoices.map((item) => (
                <DropdownMenuItem key={item.action} onClick={() => { void handleStatusChoice(item.action); }}>
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
            <PopoverContent align="end" className="w-60 p-0">
              <Command>
                <CommandInput placeholder="Search people..." />
                <CommandList>
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
            </PopoverContent>
          </Popover>
        )}
      </BulkActionBar>

      {/* No kit equivalent: a required free-text reason plus the voided-invoice
          warning. The app component is reused as-is (ledger row). */}
      <BulkCancelJobsDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        count={selectedJobIds.length}
        isPending={bulkStatusMutation.isPending}
        onConfirm={handleCancelConfirm}
      />
      {confirmDialog}
    </>
  );
}
