import { useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';
import {
  usePreviewRecordNumber,
  useRenameRecordNumber,
  type RenumberableEntity,
  type RenumberComputation,
} from '@/lib/api/record-numbering';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/alert';
import { extractApiError } from '@/lib/utils';

export interface RecordNumberEditorProps {
  entity: RenumberableEntity;
  id: string;
  number: string;
  /** Only meaningful for 'estimate' — true when this estimate's number was derived from a
   *  container parent (Estimate.container_kind is set) AND it has not been custom-edited yet.
   *
   *  This does NOT change the header affordance. Every entity shows the same pencil beside
   *  its number, because a pencil that appears next to the id on four records and not the
   *  fifth teaches the user nothing except that the fifth is odd. What it changes is the
   *  first step INSIDE the dialog: a warning that has to be accepted before the input is
   *  offered, because giving a derived estimate its own number is a one-way door — the
   *  backend sets number_is_custom and the row stops following its container for ever. */
  isDerivedAndLocked?: boolean;
  /** Caller-computed `ability.can('renumber', Subject)` — no edit affordance at all (not a
   *  disabled control) is rendered when false. */
  canEdit: boolean;
  onRenamed?: (newNumber: string) => void;
}

/** Table names RENUMBER_CONFIG (backend/src/lib/record-renumber.ts) can put in `derived[]` —
 * mapped to a human, pluralizable label for the change summary. Anything not in this map
 * (there is nothing else today) falls back to its raw table name. */
const TABLE_LABEL: Record<string, [singular: string, plural: string]> = {
  estimates: ['estimate', 'estimates'],
  logistic_orders: ['logistic order', 'logistic orders'],
};

function describeCount(count: number, table: string): string {
  const [singular, plural] = TABLE_LABEL[table] ?? [table, table];
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "3 estimates, 2 logistic orders, 6 records refreshed will also be renamed." — a summary
 * line, not an enumeration of every row (the plan explicitly does not require the latter). */
function summarizeDerivedChanges(computation: RenumberComputation): string {
  const byTable = new Map<string, number>();
  for (const d of computation.derived) {
    byTable.set(d.table, (byTable.get(d.table) ?? 0) + 1);
  }
  const parts = Array.from(byTable.entries()).map(([table, count]) => describeCount(count, table));
  if (computation.labelRefreshes.length > 0) {
    const n = computation.labelRefreshes.length;
    parts.push(`${n} record${n === 1 ? '' : 's'} refreshed`);
  }
  if (parts.length === 0) return 'No other records will change.';
  return `${parts.join(', ')} will also be renamed.`;
}

/**
 * Reusable inline number editor + confirmation dialog for the 5 renumberable entities
 * (customer/lead/estimate/job/invoice). "Inline on the record header, two clicks" (plan's
 * UI section): plain number -> pencil affordance -> dialog with an input, preview-then-
 * confirm.
 */
export function RecordNumberEditor({
  entity,
  id,
  number,
  isDerivedAndLocked = false,
  canEdit,
  onRenamed,
}: RecordNumberEditorProps) {
  const [unlocked, setUnlocked] = useState(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(number);
  const [computation, setComputation] = useState<RenumberComputation | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const previewMutation = usePreviewRecordNumber(entity, id);
  const renameMutation = useRenameRecordNumber(entity, id);

  // The warning gates the dialog's CONTENT, never the pencil. `unlocked` is reset every
  // time the dialog opens so a second edit is warned about as loudly as the first — an
  // acceptance that silently persisted would make the warning a one-time toll rather than
  // a statement about the record.
  const mustWarn = isDerivedAndLocked && !unlocked;

  function openDialog() {
    setUnlocked(false);
    setDraft(number);
    setComputation(null);
    setPreviewError(null);
    setRenameError(null);
    setOpen(true);
  }

  function handleDraftChange(value: string) {
    setDraft(value);
    // A new candidate number invalidates any prior preview — the confirm button reverts to
    // "Continue" until the caller previews this value too (plan: confirm stays blocked
    // "until the number changes ... or the conflicts clear").
    if (computation) setComputation(null);
    setPreviewError(null);
    setRenameError(null);
  }

  async function handlePrimaryAction() {
    if (computation && !computation.hasConflicts) {
      setRenameError(null);
      try {
        const result = await renameMutation.mutateAsync(draft);
        setOpen(false);
        onRenamed?.(result.new_number);
      } catch (err) {
        // A race (someone else renamed something between preview and confirm) — surface it
        // inline and force a fresh preview rather than silently failing.
        setRenameError(extractApiError(err, 'Could not rename this record'));
        setComputation(null);
      }
      return;
    }

    setPreviewError(null);
    try {
      const result = await previewMutation.mutateAsync(draft);
      setComputation(result);
    } catch (err) {
      setPreviewError(extractApiError(err, 'Could not preview this ID'));
    }
  }

  const isLoading = previewMutation.isPending || renameMutation.isPending;
  const isPreviewStep = !computation;
  const confirmLabel = isPreviewStep ? 'Continue' : 'Confirm rename';
  const confirmDisabled = isLoading || !draft.trim() || (computation?.hasConflicts ?? false);

  return (
    // A <span>, never a <div>: the header call sites wrap this in role="heading" elements
    // that are literally <p>/<span> tags (the design-system raw-tag ratchet forbids adding
    // a real <h1>-<h6>), and <p> content model only permits phrasing (inline) content - a
    // <div> child forces the browser to close the <p> early, corrupting the DOM and
    // triggering a hydration mismatch. The Dialog below is unaffected: Radix portals its
    // content out to `document.body`, so it is never actually a descendant of this span.
    <span className="inline-flex items-center gap-1.5">
      <span className="text-sm font-medium text-text-secondary">{number}</span>
      {canEdit && (
        <button
          type="button"
          aria-label="Edit ID"
          title="Edit ID"
          onClick={openDialog}
          className="group rounded p-0.5 text-text-secondary transition-colors hover:bg-primary-subtle hover:text-primary"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}

      {canEdit && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent width="sm">
            <DialogHeader>
              <DialogTitle>Edit record ID</DialogTitle>
              <DialogDescription>
                {mustWarn
                  ? 'This ID follows the ID it came from.'
                  : `Renaming ${number} may also rename other records that use it.`}
              </DialogDescription>
            </DialogHeader>

            {/* "The ID it came from" is deliberate, and it is the third wording here. Naming the
                kind - "follows the customer" - reads better and is perfectly safe (container_kind
                is one value, never a set), but it is three sentences to keep true instead of one.
                "Derived" and "container" are what this actually is and mean nothing outside this
                repo. "Automatic" was true of the old E00115 counter and misses the whole point,
                which is that the ID is not merely generated, it TRACKS something. "Follows" is
                the one plain word carrying both halves: where it came from, and that it keeps
                changing along with it. And it stops at that: a permanence clause on the end
                ("for good", "there is no going back") only restates what a warning behind a
                confirm step already says, and every earlier draft here got long by adding one
                more true thing. */}
            {mustWarn ? (
              <Alert tone="warning" role="alert">
                Set your own ID and it stops following.
              </Alert>
            ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="record-number-editor-input" className="text-xs font-medium text-text-secondary">
                  New ID
                </label>
                <Input
                  id="record-number-editor-input"
                  value={draft}
                  onChange={(e) => handleDraftChange(e.target.value)}
                  maxLength={20}
                  disabled={isLoading}
                  autoFocus
                />
              </div>

              {previewError && (
                <Alert tone="danger" role="alert">
                  {previewError}
                </Alert>
              )}
              {renameError && (
                <Alert tone="danger" role="alert">
                  {renameError}
                </Alert>
              )}

              {computation && computation.hasConflicts && (
                <Alert tone="danger" role="alert">
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">This ID is already in use</span>
                    <ul className="list-disc pl-4">
                      {computation.parentConflict && (
                        <li>{computation.newNumber} is already used by another {entity}</li>
                      )}
                      {computation.derived
                        .filter((d) => d.conflict)
                        .map((d) => (
                          <li key={`${d.table}-${d.id}`}>
                            {d.newValue} is already used in {d.table}
                          </li>
                        ))}
                    </ul>
                  </div>
                </Alert>
              )}

              {computation && !computation.hasConflicts && (
                <Alert tone="neutral" role="status">
                  {summarizeDerivedChanges(computation)}
                </Alert>
              )}
            </div>
            )}

            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isLoading}>
                Cancel
              </Button>
              {mustWarn ? (
                <Button type="button" onClick={() => setUnlocked(true)}>
                  Use my own ID
                </Button>
              ) : (
                <Button type="button" onClick={handlePrimaryAction} disabled={confirmDisabled}>
                  {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {confirmLabel}
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </span>
  );
}
