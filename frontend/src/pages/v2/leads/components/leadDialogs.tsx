import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, RotateCcw, Trash2 } from 'lucide-react';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { deleteLead } from '@/lib/api/leads';
import { extractApiError } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';

/**
 * The leads module's own dialogs, rebuilt on the kit's Dialog.
 *
 * Every endpoint, payload, invalidation and piece of copy is the legacy
 * component's; only the surface changed. They stay separate components (rather
 * than one generic "reason dialog") because their copy, their button labels and
 * their disabled rules differ, exactly as they do today.
 *
 * Declared then exported at the bottom, the kit's own style.
 */

interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
}

function MarkLostDialog({ open, onOpenChange, leadId }: ReasonDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/leads/${leadId}/mark-lost`, { lost_reason: reason });
      return data;
    },
    onSuccess: () => {
      // Leaving the lead auto-cancels its scheduled walkthrough visit (lead.controller).
      refreshAfterVisitWrite(queryClient, { leadId });
      onOpenChange(false);
      setReason('');
    },
    // A refusal usually means the page's copy of the lead is stale (it closed elsewhere): re-read it (#2756).
    onError: () => queryClient.invalidateQueries({ queryKey: ['lead', leadId] }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form">
        <DialogHeader>
          <DialogIcon tone="danger"><AlertTriangle /></DialogIcon>
          <div>
            <DialogTitle>Mark Lead as Lost</DialogTitle>
            <DialogDescription>A lost lead can be reopened by someone allowed to reopen leads. Please provide a reason.</DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="v2-mark-lost-reason">Reason *</Label>
            <Textarea
              id="v2-mark-lost-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why was this lead lost?"
            />
          </div>
          {mutation.error && (
            <p className="text-destructive mt-2 text-sm">
              {extractApiError(mutation.error, 'Failed to mark as lost')}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={!reason.trim() || mutation.isPending}
          >
            {mutation.isPending ? 'Marking...' : 'Mark Lost'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Reopen a Won or Lost lead (PRD 5, S05.19). The server picks where the lead lands (the status it had before it closed,
 * or the furthest its data supports) and logs the reason in History; this asks only why. Reopen stays disabled until a
 * reason is typed.
 */
function ReopenLeadDialog({ open, onOpenChange, leadId }: ReasonDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/leads/${leadId}/reopen`, { reason: reason.trim() });
      return data;
    },
    onSuccess: () => {
      // The lead is open again: its status, the lists it sits in, the customer page's Leads tab and its History.
      queryClient.invalidateQueries({ queryKey: ['lead', leadId] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['customer'] });
      queryClient.invalidateQueries({ queryKey: ['customer-leads'] });
      queryClient.invalidateQueries({ queryKey: ['timeline', 'LEAD', leadId] });
      onOpenChange(false);
      setReason('');
    },
    // A refusal usually means the page's copy of the lead is stale (it was reopened elsewhere): re-read it (#2756).
    onError: () => queryClient.invalidateQueries({ queryKey: ['lead', leadId] }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form">
        <DialogHeader>
          <DialogIcon tone="brand"><RotateCcw /></DialogIcon>
          <div>
            <DialogTitle>Reopen this lead?</DialogTitle>
          </div>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="v2-reopen-lead-reason">Why is this lead being reopened?</Label>
            <Textarea
              id="v2-reopen-lead-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
            />
          </div>
          {mutation.error && (
            <p className="text-destructive mt-2 text-sm">
              {extractApiError(mutation.error, 'Failed to reopen the lead')}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Go back</Button>
          <Button onClick={() => mutation.mutate()} disabled={!reason.trim() || mutation.isPending}>
            {mutation.isPending ? 'Reopening...' : 'Reopen'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelWalkthroughDialog({ open, onOpenChange, leadId }: ReasonDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(`/api/leads/${leadId}/walkthrough/cancel`, {
        cancelled_reason: reason.trim(),
      });
      return data;
    },
    onSuccess: () => {
      refreshAfterVisitWrite(queryClient, { leadId });
      onOpenChange(false);
      setReason('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form">
        <DialogHeader>
          <DialogIcon tone="danger"><Ban /></DialogIcon>
          <div>
            <DialogTitle>Cancel Walkthrough</DialogTitle>
          </div>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="v2-cancel-wt-reason">Reason *</Label>
            <Textarea
              id="v2-cancel-wt-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this walkthrough being cancelled?"
            />
          </div>
          {mutation.error && (
            <p className="text-destructive mt-2 text-sm">
              {extractApiError(mutation.error, 'Failed to cancel walkthrough')}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Back</Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={!reason.trim() || mutation.isPending}
          >
            {mutation.isPending ? 'Cancelling...' : 'Cancel Walkthrough'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Hard delete. Only reachable when the lead has no estimates - the gate lives
 * on the caller, exactly as it does today.
 */
function DeleteLeadDialog({
  open, onOpenChange, leadId, onDeleted,
}: ReasonDialogProps & { onDeleted: () => void }) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => deleteLead(leadId),
    onSuccess: () => {
      // A hard delete takes the lead's walkthrough visits with it; the lead's own query is dropped.
      refreshAfterVisitWrite(queryClient, { leadId }, { deleted: true });
      onDeleted();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="choice">
        <DialogHeader>
          <DialogIcon tone="danger"><Trash2 /></DialogIcon>
          <div>
            <DialogTitle>Delete Lead</DialogTitle>
            <DialogDescription>
              Permanently delete this lead? This is only possible because it has no
              estimates. This cannot be undone.
            </DialogDescription>
          </div>
        </DialogHeader>
        {mutation.error && (
          <DialogBody>
            <p className="text-destructive text-sm">
              {extractApiError(mutation.error, 'Failed to delete lead')}
            </p>
          </DialogBody>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Changing the service location's STATE changes the tax rate applied to new
 * estimates, so the edit form confirms it before the PATCH fires.
 */
function TaxWarningDialog({
  open, onOpenChange, oldState, newState, onConfirm, confirmLabel = 'Change Location', isPending = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  oldState?: string | null;
  newState?: string | null;
  onConfirm: () => void;
  confirmLabel?: string;
  isPending?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="choice">
        <DialogHeader>
          <DialogIcon tone="warning"><AlertTriangle /></DialogIcon>
          <div>
            <DialogTitle>Tax Rate Change</DialogTitle>
            <DialogDescription>
              You are moving the service location from{' '}
              <span className="font-semibold">{oldState || '-'}</span> to{' '}
              <span className="font-semibold">{newState || '-'}</span>.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          <p className="text-muted-foreground text-sm">
            Changing the service location&apos;s state changes the tax rate applied to
            estimates and invoices for this lead. Existing documents are not retroactively
            re-taxed, but new estimates will use the new state&apos;s rate.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={onConfirm} disabled={isPending}>
            {isPending ? 'Saving...' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { MarkLostDialog, ReopenLeadDialog, CancelWalkthroughDialog, DeleteLeadDialog, TaxWarningDialog };
