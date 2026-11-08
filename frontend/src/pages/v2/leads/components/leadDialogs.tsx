import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, Trash2 } from 'lucide-react';

import api from '@/lib/axios';
import { refreshAfterVisitWrite } from '@/lib/refreshAfterVisitWrite';
import { cancelLead, deleteLead } from '@/lib/api/leads';
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
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon tone="danger"><AlertTriangle /></DialogIcon>
          <div>
            <DialogTitle>Mark Lead as Lost</DialogTitle>
            <DialogDescription>This action cannot be undone. Please provide a reason.</DialogDescription>
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

function CancelLeadDialog({ open, onOpenChange, leadId }: ReasonDialogProps) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: () => cancelLead(leadId, { cancelled_reason: reason }),
    onSuccess: () => {
      // Leaving the lead auto-cancels its scheduled walkthrough visit (lead.controller).
      refreshAfterVisitWrite(queryClient, { leadId });
      onOpenChange(false);
      setReason('');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogIcon tone="danger"><Ban /></DialogIcon>
          <div>
            <DialogTitle>Cancel Lead</DialogTitle>
            <DialogDescription>
              Administratively void this lead. Use this for duplicates or leads created in
              error. Please provide a reason.
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="v2-cancel-lead-reason">Reason *</Label>
            <Textarea
              id="v2-cancel-lead-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this lead being cancelled?"
            />
          </div>
          {mutation.error && (
            <p className="text-destructive mt-2 text-sm">
              {extractApiError(mutation.error, 'Failed to cancel lead')}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={!reason.trim() || mutation.isPending}
          >
            {mutation.isPending ? 'Cancelling...' : 'Cancel Lead'}
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
      <DialogContent>
        <DialogHeader>
          <DialogIcon tone="danger"><Ban /></DialogIcon>
          <div>
            <DialogTitle>Cancel Walkthrough</DialogTitle>
            <DialogDescription>
              This will cancel the scheduled walkthrough. Please provide a reason.
            </DialogDescription>
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
      <DialogContent>
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
      <DialogContent>
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

export { MarkLostDialog, CancelLeadDialog, CancelWalkthroughDialog, DeleteLeadDialog, TaxWarningDialog };
