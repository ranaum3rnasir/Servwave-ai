"use client";

import { ConfirmDialog } from "@/ui-kit/components/ui/confirmDialog";

export interface DiscardConfirmProps {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
  title?: string;
  description?: string;
}

/**
 * The one "you have unsaved work" question: Keep editing / Discard. It is a kit dialog, never a
 * browser dialog. Spread `useDirtyGuard().confirmProps` onto it.
 */
export function DiscardConfirm({
  open,
  onKeepEditing,
  onDiscard,
  title = "Discard your changes?",
  description = "You have unsaved changes. If you leave now they will be lost.",
}: DiscardConfirmProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeepEditing();
      }}
      title={title}
      description={description}
      cancelLabel="Keep editing"
      confirmLabel="Discard"
      destructive
      onConfirm={onDiscard}
    />
  );
}
