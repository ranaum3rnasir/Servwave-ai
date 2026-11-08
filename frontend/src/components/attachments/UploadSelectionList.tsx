/**
 * What a selected-but-not-yet-finished upload looks like on every surface that
 * accepts a video (direct-to-storage PRD, slice 5).
 *
 * Three jobs, in order of importance:
 *
 *  1. Say what this is going to cost BEFORE it starts — the size, and the
 *     duration when the browser volunteered one.
 *  2. Nudge on a long or large clip, as a sentence. The nudge has no veto:
 *     this component renders text and nothing else, so there is no code path
 *     by which it could stop an upload.
 *  3. Show progress from REAL bytes. When the transport has not reported a
 *     total, this says "Uploading…" and animates a track rather than drawing
 *     a percentage nobody measured. S2 swapped the transport underneath and
 *     fed `loaded`/`total` through unchanged — no rewrite here, which is what
 *     the seam was extracted to buy.
 *  4. Since S2, offer the way out: an in-flight transfer can be cancelled, and
 *     cancelling terminates the partial upload rather than abandoning it.
 *
 * Built from div/p/span and the design-system `Button`. The RAW
 * button/input/label/image tags each carry a per-tag ceiling in
 * component-api-guard that may only ever DECREASE; several of those ceilings
 * have slack, so a raw `<button>` here would not fail the build - but spending
 * slack is how a ratchet quietly stops ratcheting. `Button` is the right
 * element for this control anyway, and it counts against nothing.
 */
import { Check, Film, FileText, Image as ImageIcon, RotateCcw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { UploadSelectionView } from '@/lib/attachments/uploadSelection';
import {
  describeSelection,
  progressPercent,
  uploadNudge,
} from '@/lib/attachments/uploadGuidance';

function SelectionIcon({ type }: { type: string }) {
  if (type.startsWith('video/')) return <Film className="h-4 w-4 shrink-0 text-text-secondary" />;
  if (type.startsWith('image/'))
    return <ImageIcon className="h-4 w-4 shrink-0 text-text-secondary" />;
  return <FileText className="h-4 w-4 shrink-0 text-text-secondary" />;
}

/**
 * The non-blocking nudge. Renders a sentence or nothing at all — deliberately
 * has no `onDismiss`, no confirm step and no callback, because every one of
 * those would be a lever someone could later turn into a gate.
 */
export function UploadNudge({
  file,
  durationSeconds,
}: {
  file: File;
  durationSeconds: number | null;
}) {
  const text = uploadNudge(file, durationSeconds);
  if (!text) return null;
  return (
    <p role="status" className="mt-1.5 text-[11px] leading-snug text-text-secondary">
      {text}
    </p>
  );
}

/**
 * Real byte progress, or an honest "we don't have a number yet" — and, since S2, the way out.
 *
 * `onCancel` is optional because not every producer of these rows can stop a transfer. Where
 * it is passed the control renders; where it is not, nothing appears, rather than a disabled
 * button that reads as "cancel is broken here".
 */
export function UploadProgress({
  loaded,
  total,
  onCancel,
}: {
  loaded: number;
  total?: number;
  onCancel?: () => void;
}) {
  const pct = progressPercent(loaded, total);
  const indeterminate = pct === null;
  return (
    <div className="mt-2 space-y-1">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        // Omitted while indeterminate, which is how a progressbar says "running, length
        // unknown" - the same honesty the visible label carries.
        aria-valuenow={indeterminate ? undefined : pct}
        aria-label="Upload progress"
        className="h-1.5 w-full overflow-hidden rounded-full bg-background-light"
      >
        <div
          className={cn(
            'h-full rounded-full',
            indeterminate
              ? // No width animation: a bar that slides without measuring
                // anything is a lie told smoothly. A pulsing full-width track
                // reads as "working", which is all we actually know.
                'w-full animate-pulse bg-primary/30'
              : 'bg-primary transition-all duration-300'
          )}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-text-secondary">
          {indeterminate ? 'Uploading…' : `${pct}%`}
        </p>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            tone="subtle"
            size="sm"
            // The accessible name says what is being cancelled. "Cancel" alone, on a row
            // beside an Upload button and inside a dialog that has its own Cancel, is three
            // controls with one name.
            aria-label="Cancel upload"
            className="h-5 shrink-0 px-1.5 text-[10px]"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export function UploadSelectionList({
  items,
  className,
  onCancel,
  onRemove,
  onRetry,
  retryDisabled = false,
}: {
  items: UploadSelectionView[];
  className?: string;
  /**
   * Stops the transfer for one row. Keyed rather than bound per item so the list stays a
   * pure function of `items` — a surface that cannot cancel simply does not pass it.
   */
  onCancel?: (key: string) => void;
  /** Drops a row that has not started. Offered only on rows still `selected`. */
  onRemove?: (key: string) => void;
  /**
   * Passed only by a surface whose rows OUTLIVE their outcome (the New Task dialog, where the
   * task already exists and a failed file must stay named until it is retried). Passing it
   * turns on the outcome line - uploaded, failed with the reason, or cancelled - and a Retry
   * on the last two. The queue surfaces never pass it, so for them nothing below changes.
   */
  onRetry?: (key: string) => void;
  /** Another row holds the upload turn; Retry shows but waits. */
  retryDisabled?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className={cn('space-y-2', className)}>
      {items.map((item) => (
        <div
          key={item.key}
          data-testid="upload-selection"
          className="rounded-lg border border-border bg-surface-light p-2.5"
        >
          <div className="flex items-center gap-2">
            <SelectionIcon type={item.file.type} />
            <p className="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
              {item.file.name}
            </p>
            <p className="shrink-0 text-[11px] tabular-nums text-text-secondary">
              {describeSelection(item.file, item.durationSeconds)}
            </p>
            {onRemove && item.status === 'selected' && (
              <Button
                type="button"
                variant="ghost"
                tone="subtle"
                size="3xs"
                aria-label={`Remove ${item.file.name}`}
                className="shrink-0"
                onClick={() => onRemove(item.key)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <UploadNudge file={item.file} durationSeconds={item.durationSeconds} />
          {item.status === 'uploading' && (
            <UploadProgress
              loaded={item.loaded}
              total={item.total}
              onCancel={onCancel ? () => onCancel(item.key) : undefined}
            />
          )}
          {/* The outcome line exists only where `onRetry` is passed. On the queue surfaces an
              errored row is cleared by the settle microtask before it can ever paint, so the
              failure reaches the user as the caller's toast instead. AttachmentSection keeps
              its OWN error row, because there the row survives and owns the Retry. */}
          {onRetry && (
            <UploadOutcome item={item} disabled={retryDisabled} onRetry={() => onRetry(item.key)} />
          )}
        </div>
      ))}
    </div>
  );
}

/** What became of a row that has finished, for surfaces that keep finished rows. */
function UploadOutcome({
  item,
  disabled,
  onRetry,
}: {
  item: UploadSelectionView;
  disabled: boolean;
  onRetry: () => void;
}) {
  if (item.status === 'done') {
    return (
      <p className="mt-1.5 flex items-center gap-1 text-[11px] text-success">
        <Check className="h-3 w-3" aria-hidden />
        Uploaded
      </p>
    );
  }
  if (item.status !== 'error' && item.status !== 'cancelled') return null;
  return (
    <div className="mt-1.5 flex items-center justify-between gap-2">
      <p className={cn('min-w-0 text-[11px]', item.status === 'error' ? 'text-danger' : 'text-text-secondary')}>
        {item.status === 'error' ? `Didn't upload: ${item.error ?? 'Upload failed.'}` : 'Upload cancelled'}
      </p>
      <Button
        type="button"
        variant="outline"
        size="3xs"
        aria-label={`Retry ${item.file.name}`}
        className="shrink-0"
        disabled={disabled}
        onClick={onRetry}
      >
        <RotateCcw className="mr-1 h-3 w-3" aria-hidden />
        Retry
      </Button>
    </div>
  );
}

/**
 * Files refused before anything was sent.
 *
 * `role="alert"` rather than the nudge's `role="status"`: this is not a suggestion, it is the
 * reason a file the user picked is not in the list. The one thing it must never be is silent.
 */
export function UploadRefusalList({
  messages,
  className,
}: {
  messages: string[];
  className?: string;
}) {
  if (messages.length === 0) return null;
  return (
    <div className={cn('space-y-1', className)}>
      {messages.map((message) => (
        <p key={message} role="alert" className="text-[11px] leading-snug text-danger">
          {message}
        </p>
      ))}
    </div>
  );
}

export type {
  UploadSelectionStatus,
  UploadSelectionView,
} from '@/lib/attachments/uploadSelection';
