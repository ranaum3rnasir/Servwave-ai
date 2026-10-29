"use client";

import { Button } from "@/ui-kit/components/ui/button";

export interface DraftRestoredNoteProps {
  /** `useFieldDraft().restored`. False renders nothing. */
  restored: boolean;
  /** `useFieldDraft().clear`: throws the restored text away and empties the field. */
  onDiscard: () => void;
}

/**
 * The quiet line under a field whose text came back from the device after an interruption
 * (backgrounding, the camera, a locked screen, a killed tab): "Draft restored" and a Discard
 * control. Plain words, no vendor, no account. Discard is a text button that grows to a 44 px
 * target on touch like every kit button.
 */
export function DraftRestoredNote({ restored, onDiscard }: DraftRestoredNoteProps) {
  if (!restored) return null;
  return (
    <div role="status" className="text-muted-foreground flex items-center gap-1 text-xs">
      <span>Draft restored</span>
      <Button type="button" variant="ghost" size="sm" onClick={onDiscard}>
        Discard
      </Button>
    </div>
  );
}
