"use client";

import * as React from "react";
import { Lock, Send } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Avatar } from "@/ui-kit/components/ui/avatar";
import { Button } from "@/ui-kit/components/ui/button";
import { Textarea } from "@/ui-kit/components/ui/textarea";

export interface NoteEditorProps {
  authorName: string;
  onSubmit: (note: string) => void | Promise<void>;
  placeholder?: string;
  /** Shows the internal-only affordance. */
  isInternal?: boolean;
  isPending?: boolean;
  className?: string;
}

/**
 * Composer for an internal note.
 *
 * Submits on ⌘/Ctrl+Enter, which is what anyone who types all day will reach
 * for. Plain Enter deliberately inserts a newline - notes are multi-line often
 * enough that submitting on Enter loses work.
 *
 * The internal-only marker is a persistent label rather than a toggle: a note
 * that might be customer-visible depending on a switch someone forgot is a
 * liability, so this component is only ever internal.
 */
function NoteEditor({
  authorName, onSubmit, placeholder = "Add a note…",
  isInternal = true, isPending, className,
}: NoteEditorProps) {
  const [draft, setDraft] = React.useState("");
  const canSubmit = draft.trim().length > 0 && !isPending;

  const submit = async () => {
    if (!canSubmit) return;
    await onSubmit(draft.trim());
    setDraft("");
  };

  return (
    <div data-slot="note-editor" className={cn("flex gap-2.5", className)}>
      <Avatar name={authorName} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
          }}
          placeholder={placeholder}
          disabled={isPending}
          className="min-h-16 resize-none"
        />
        <div className="mt-2 flex items-center gap-2">
          {isInternal && (
            <span className="text-subtle-foreground inline-flex items-center gap-1.5 text-[11.5px] font-medium">
              <Lock className="size-3" />
              Only your team can see this
            </span>
          )}
          <span className="text-subtle-foreground ms-auto hidden text-[11px] sm:inline">⌘↵</span>
          <Button size="sm" onClick={submit} disabled={!canSubmit} isLoading={isPending}>
            {!isPending && <Send />}
            {isPending ? "Posting" : "Post note"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export { NoteEditor };
