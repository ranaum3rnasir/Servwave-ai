import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { updateEstimate } from '@/lib/api/estimates';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

interface EstimateNameTitleProps {
  estimateId: string;
  leadId: string;
  name: string | null | undefined;
  estimateNumber: string;
  /** Whether the user may rename (cosmetic — allowed even on a locked estimate). */
  canEdit: boolean;
  /** Rendered in place of the bare number - the page passes its RecordNumberEditor here so
   *  the id carries the pencil, exactly as it does on every other record. Left out (tests,
   *  and any caller with no renumber capability) the number renders as plain text. */
  numberSlot?: ReactNode;
}

/**
 * The estimate's customer-visible title. Shows the custom name (or a placeholder)
 * with the estimate number underneath; click to rename inline. The status pill lives
 * in the parent page (§E-4 — one pill, one source), not here.
 * Saves via PATCH and refreshes the estimate + the lead's tab strip.
 */
export function EstimateNameTitle({
  estimateId,
  leadId,
  name,
  estimateNumber,
  canEdit,
  numberSlot,
}: EstimateNameTitleProps) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name ?? '');
  const [numberCopied, setNumberCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-seed when switching estimates (the component stays mounted across tabs).
  useEffect(() => {
    setDraft(name ?? '');
    setEditing(false);
  }, [estimateId, name]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const rename = useMutation({
    mutationFn: (next: string) => updateEstimate(estimateId, { name: next || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      queryClient.invalidateQueries({ queryKey: ['estimates', { lead_id: leadId }] });
      setEditing(false);
    },
    onError: (err) =>
      toast({
        title: 'Could not rename estimate',
        description: extractApiError(err, 'Failed to save the estimate name'),
        variant: 'destructive',
      }),
  });

  function commit() {
    const next = draft.trim();
    if (next === (name ?? '').trim()) {
      setEditing(false);
      return;
    }
    rename.mutate(next);
  }

  const display = name?.trim() || `Estimate ${estimateNumber}`;

  function handleCopyNumber() {
    navigator.clipboard.writeText(estimateNumber).then(() => {
      setNumberCopied(true);
      setTimeout(() => setNumberCopied(false), 2000);
    });
  }

  return (
    <div className="flex items-center gap-3">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(name ?? '');
              setEditing(false);
            }
          }}
          maxLength={200}
          placeholder="Name this estimate (e.g. Door repair)"
          className="h-9 w-72 rounded-lg border border-primary bg-surface-light px-2 text-xl font-bold text-text-primary outline-none"
        />
      ) : (
        // Click-to-edit page title (renders the actual heading text at xl/bold) -
        // not Button-shaped. Deferred.
        <button
          type="button"
          disabled={!canEdit}
          onClick={() => canEdit && setEditing(true)}
          title={canEdit ? 'Rename estimate' : undefined}
          className={cn(
            'group flex items-center gap-2 text-left',
            canEdit && 'cursor-text',
          )}
        >
          <span
            className={cn(
              'text-xl font-bold',
              name?.trim() ? 'text-text-primary' : 'text-text-secondary',
            )}
          >
            {display}
          </span>
        </button>
      )}
      <div className="flex items-center gap-1">
        {numberSlot ?? (
          <span className="text-sm font-medium text-text-secondary">{estimateNumber}</span>
        )}
        {/* Tiny icon-only copy affordance - no ghost cell reproduces this hover
            (hover:bg-primary-subtle/hover:text-primary vs ghost/neutral's
            hover:bg-background-light) or this padding (p-0.5, smaller than the
            3xs rung). Deferred. */}
        <button
          type="button"
          onClick={handleCopyNumber}
          aria-label="Copy estimate number"
          title="Copy estimate number"
          className="rounded p-0.5 text-text-secondary transition-colors hover:bg-primary-subtle hover:text-primary"
        >
          {numberCopied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
