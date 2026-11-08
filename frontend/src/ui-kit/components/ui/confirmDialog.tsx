"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/ui-kit/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from "@/ui-kit/components/ui/dialog";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Name the exact record and what is lost. "Are you sure?" tells nobody anything. */
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Held true while the action is in flight; both buttons lock. */
  isPending?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
  /**
   * Body between the description and the footer - the input a destructive action needs before it
   * can be confirmed, e.g. the reason cancelling a visit requires. The app's own
   * `components/ui/confirm-dialog` has carried this slot and the flag below all along; the kit
   * copy was the one prop short that `pages/v2/schedule/components/confirmDialog` forked over.
   */
  children?: React.ReactNode;
  /** Holds Confirm disabled while that body's own precondition is unmet. Cancel stays enabled. */
  confirmDisabled?: boolean;
}

/**
 * Destructive confirmation, wrapped so a delete is one call site instead of
 * fifteen lines of Dialog parts repeated across the app.
 *
 *   const remove = useDisclosure();
 *   <ConfirmDialog {...remove.props} destructive
 *     title="Delete this job?"
 *     description={`${job.no} for ${job.customer} will be permanently removed.`}
 *     isPending={mutation.isPending}
 *     onConfirm={() => mutation.mutate(job.id)} />
 */
function ConfirmDialog({
  open, onOpenChange, title, description,
  confirmLabel = "Confirm", cancelLabel = "Cancel",
  isPending = false, destructive = false, onConfirm,
  children, confirmDisabled = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      // Don't let a stray Escape or backdrop click abandon an in-flight action.
      onOpenChange={(next) => { if (!isPending) onOpenChange(next); }}
    >
      <DialogContent showClose={!isPending}>
        <DialogHeader>
          <DialogIcon tone={destructive ? "danger" : "brand"}>
            <AlertTriangle />
          </DialogIcon>
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
        </DialogHeader>
        {children && <DialogBody>{children}</DialogBody>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            isLoading={isPending}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { ConfirmDialog };
