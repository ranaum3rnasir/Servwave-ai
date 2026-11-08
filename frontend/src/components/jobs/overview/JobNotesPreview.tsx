import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { StickyNote, Plus, X } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Collapse } from '@/components/ui/collapse';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import api from '@/lib/axios';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface JobNote {
  id: string;
  content: string;
  created_at: string;
  creator: { id: string; first_name: string; last_name: string };
  source?: string | null;
}

interface JobNotesPreviewProps {
  jobId: string;
  notes: JobNote[] | null | undefined;
  /**
   * How adding a note is offered.
   *
   * `header-icon` - a bare "+" in the card's meta slot. The original, and still
   * the DEFAULT: it is what the other hosts of this card render, and changing a
   * default is not the way to restyle them. (It was the default because the
   * legacy job page mounted this card and had to keep rendering unchanged; that
   * page is deleted, but the other callers still take the default.)
   *
   * `inline-button` — a full-width labelled button under the notes. The v2 job
   * page asks for this one: a 24px unlabelled glyph tucked into a card header
   * is both the smallest target on the panel and the least legible, and "+"
   * beside a heading reads as "expand this section" at least as readily as
   * "write something". A button that says Add note says it once and says it
   * where the eye already is, at the end of the list it appends to.
   */
  addAffordance?: 'header-icon' | 'inline-button';
  /**
   * `update Job` - the API gate on the note endpoint. False hides the affordance
   * rather than offering a composer whose submit is guaranteed to 403.
   *
   * Independent of `addAffordance`: this decides WHETHER adding is offered, that
   * decides WHICH control offers it. A false value hides both shapes, so the
   * permission gate cannot be sidestepped by asking for the other one.
   */
  canAddNotes?: boolean;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function JobNotesPreview({
  jobId,
  notes,
  addAffordance = 'header-icon',
  canAddNotes = true,
}: JobNotesPreviewProps) {
  const queryClient = useQueryClient();
  // Composer is hidden by default and revealed by the header "+" — saves space
  // when no one is mid-note (the always-on textarea is gone).
  const [composerOpen, setComposerOpen] = useState(false);
  const [noteContent, setNoteContent] = useState('');

  const closeComposer = () => {
    setComposerOpen(false);
    setNoteContent('');
  };

  // Mirror ActivityPanel's addNoteMutation pattern
  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const { data } = await api.post(`/api/jobs/${jobId}/notes`, { content });
      return data.note;
    },
    onSuccess: () => {
      setNoteContent('');
      setComposerOpen(false);
      // Invalidate the overview notes query (with include_lead)
      queryClient.invalidateQueries({ queryKey: ['job-notes-wt', jobId] });
      // Also invalidate the standard notes panel query in case ActivityPanel is visible
      queryClient.invalidateQueries({ queryKey: ['notes', 'JOB', jobId] });
    },
  });

  const latestNotes = notes?.slice(0, 3) ?? [];

  return (
    <SectionCard
      title="Job Notes"
      titleSuffix={<span className="ml-1 text-xs font-normal text-text-secondary">(Internal)</span>}
      meta={
        canAddNotes && addAffordance === 'header-icon' ? (
          // Left raw: idle text-text-secondary, hover fills bg-primary-subtle and
          // recolours to text-primary - no ghost+brand tone is minted on Button, and
          // ghost/subtle's hover instead targets bg-background-light and text-text-primary,
          // not this brand-tinted pair.
          <button
            type="button"
            onClick={() => (composerOpen ? closeComposer() : setComposerOpen(true))}
            aria-label={composerOpen ? 'Close note composer' : 'Add note'}
            aria-expanded={composerOpen}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-primary-subtle hover:text-primary"
          >
            {composerOpen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          </button>
        ) : undefined
      }
      bodyClassName="space-y-4"
    >
      {/* Composer — revealed by the header "+" */}
      <Collapse open={composerOpen}>
        <div className="space-y-2">
          <Textarea
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'Enter' &&
                noteContent.trim() &&
                !addNoteMutation.isPending
              ) {
                e.preventDefault();
                addNoteMutation.mutate(noteContent.trim());
              }
            }}
            placeholder="Type internal note…"
            rows={2}
            autoFocus
            // Deferred: no Textarea size rung keeps the default (md, 80px) min-height while
            // also forcing text-sm - `sm` bundles text-sm with a shorter 64px min-height, which
            // would shrink this composer. No prop reproduces this combo.
            className="text-sm resize-none"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-text-secondary/70">⌘↵ to add</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={closeComposer} disabled={addNoteMutation.isPending}>
                Cancel
              </Button>
              <Button
                variant="solid" tone="business"
                size="sm"
                disabled={!noteContent.trim() || addNoteMutation.isPending}
                onClick={() => addNoteMutation.mutate(noteContent.trim())}
              >
                {addNoteMutation.isPending ? 'Adding…' : 'Add Note'}
              </Button>
            </div>
          </div>
          {addNoteMutation.error && <p className="text-xs text-danger">Failed to add note</p>}
        </div>
      </Collapse>

      {/* Latest notes */}
      {latestNotes.length === 0 ? (
        canAddNotes && addAffordance === 'inline-button' ? (
          // The empty state carries the affordance itself: a "+" standing where
          // the decorative sticky-note glyph used to. An icon whose only message
          // is "nothing here" spends the card's most prominent pixels saying
          // what the caption already says, in the one state where the reader
          // most needs somewhere to click. Plain `variant="outline" size="icon"`
          // with no className: the design-system guard ratchets both raw
          // <button> tags and appearance overrides, and neither is needed here.
          <div className="flex flex-col items-center gap-2 py-4">
            {!composerOpen && (
              <Button
                variant="outline"
                size="icon"
                aria-label="Add note"
                aria-expanded={false}
                onClick={() => setComposerOpen(true)}
              >
                <Plus />
              </Button>
            )}
            <p className="text-xs text-text-secondary">No notes yet</p>
          </div>
        ) : (
          <EmptyState density="compact" icon={StickyNote} title="No notes yet" />
        )
      ) : (
        <div className="space-y-2">
          {latestNotes.map((note) => (
            <div key={note.id} className="rounded-lg bg-background-light/40 p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-text-primary">
                  {note.creator.first_name} {note.creator.last_name}
                </span>
                {note.source === 'LEAD' && (
                  <span className="rounded-full bg-info-surface px-1.5 py-0.5 text-[10px] font-medium text-info-text">
                    Lead
                  </span>
                )}
                <span className="ml-auto text-[10px] text-text-secondary whitespace-nowrap">
                  {formatDistanceToNow(new Date(note.created_at), { addSuffix: true })}
                </span>
              </div>
              <p className="text-xs text-text-secondary whitespace-pre-wrap break-words">
                {note.content}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* The v2 affordance: one labelled, full-width button, under the list it
          appends to. Hidden while the composer is open - the composer has its
          own Add note and Cancel, and a third button saying the same thing a
          few pixels away is a question, not an invitation. Hidden on an empty
          card too, where the "+" above already is the invitation. */}
      {canAddNotes && addAffordance === 'inline-button' && !composerOpen && latestNotes.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          aria-expanded={false}
          onClick={() => setComposerOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Add note
        </Button>
      )}
    </SectionCard>
  );
}
