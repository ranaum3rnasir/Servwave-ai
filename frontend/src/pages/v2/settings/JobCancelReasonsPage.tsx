import { useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';
import { GripVertical } from 'lucide-react';

import NotAuthorizedPage from '@/components/NotAuthorizedPage';
import { MoveButtons } from '@/components/form/MoveButtons';
import { moveInList, type MoveDirection } from '@/lib/moveInList';
import { useAppAbility } from '@/contexts/AbilityContext';

import {
  useJobCancelReasons,
  useCreateJobCancelReason,
  useUpdateJobCancelReason,
  useReorderJobCancelReasons,
  type JobCancelReason,
} from '@/lib/api/jobCancelReasons';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Switch } from '@/ui-kit/components/ui/switch';
import { cn } from '@/ui-kit/lib/utils';

import { Section } from './components/section';

/** Longest label the server will accept - mirrored so the field stops the keystroke, not the save. */
const LABEL_MAX = 60;

/**
 * The one reason that cannot be switched off, mirrored from the server's `UNDEACTIVATABLE_JOB_CANCEL_REASON_CODE` so the
 * row renders as un-switchable on first paint. The server refuses the write either way.
 */
const UNDEACTIVATABLE_CODE = 'OTHER';

/**
 * Settings > Job Cancel Reasons.
 *
 * The job twin of Estimate Decline Reasons, beside it in ADVANCED: a per-organisation list of words the cancel dialogs
 * then offer. Every row saves immediately through its own request, so this page does NOT register with the settings save
 * bar. Nothing can be removed - a cancelled job holds its reason's code - only switched off.
 *
 * THIS PAGE GATES ITSELF, because nothing above it does: `/settings/*` carries no route-level guard and the layout
 * filters only the nav list. Gated on Company settings (`update Organization`), the pair the list's four writes are
 * gated on, not on a role name, so a custom role holding the switch manages the list exactly as an admin does. The gate
 * is a wrapper so a refused user fires no request at all.
 */
export default function JobCancelReasonsPage() {
  const ability = useAppAbility();
  if (!ability.can('update', 'Organization')) return <NotAuthorizedPage />;
  return <JobCancelReasonsSettings />;
}

function JobCancelReasonsSettings() {
  const { data } = useJobCancelReasons();
  const reasons = data ?? [];
  const [draft, setDraft] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const createReason = useCreateJobCancelReason();
  const reorderReasons = useReorderJobCancelReasons();

  const add = () => {
    const label = draft.trim();
    if (!label) return;
    createReason.mutate({ label });
    setDraft('');
  };

  // Same id-list reorder as JobSubStatusesPage, keyed by `code` rather than by a row id: an
  // organisation that has never saved has no ids at all (its list is still the built-ins), and
  // the code is unique per organisation anyway.
  const handleDrop = (srcCode: string, targetCode: string) => {
    const from = reasons.findIndex((r) => r.code === srcCode);
    const to = reasons.findIndex((r) => r.code === targetCode);
    if (from === -1 || to === -1 || from === to) return;
    const ordered = arrayMove(reasons.map((r) => r.code), from, to);
    reorderReasons.mutate({ ordered_codes: ordered });
  };

  // Move up / Move down (mobile slice 48): one step, saved as the same whole code list a drag sends.
  const moveReason = (index: number, direction: MoveDirection) => {
    const ordered = moveInList(reasons.map((r) => r.code), index, direction);
    if (ordered) reorderReasons.mutate({ ordered_codes: ordered });
  };

  const activeCount = reasons.filter((r) => r.is_active).length;

  return (
    <div className="space-y-5">
      {/* No page-level heading: the settings bar above already names the page. */}
      <p className="text-muted-foreground max-w-prose text-sm">
        Choose the reasons a job can be cancelled for. Whoever cancels a job picks one of these, so every cancelled job
        says why in words your office can count. Rename the ones ServWave ships with, add your own, and drag them (or use
        the arrows) into the order you want them offered in. Switching one off stops it being offered from then on and
        leaves every job already cancelled for it reading exactly as it does today.
      </p>

      <Section
        title="Cancel reasons"
        description="Drag or use the arrows to reorder. Switch one off to retire it without losing the jobs that used it."
        action={
          reasons.length > 0 ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {activeCount} of {reasons.length} offered
            </span>
          ) : undefined
        }
      >
        <div className="space-y-1">
          {reasons.map((reason, index) => (
            <div
              key={reason.code}
              draggable
              onDragStart={(e) => {
                setDragging(reason.code);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', reason.code);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (dragging && dragging !== reason.code) {
                  e.preventDefault();
                  setOver(reason.code);
                }
              }}
              onDragLeave={() => setOver((c) => (c === reason.code ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                const src = e.dataTransfer.getData('text/plain') || dragging;
                if (src && src !== reason.code) handleDrop(src, reason.code);
                setDragging(null);
                setOver(null);
              }}
              className={cn(
                'group/row -mx-1.5 flex flex-wrap items-center gap-1.5 rounded-md px-1.5 py-0.5',
                'transition-colors duration-150',
                dragging === reason.code && 'opacity-40',
                over === reason.code ? 'ring-brand/50 bg-selected ring-2' : 'hover:bg-muted/60',
              )}
            >
              {/* Always present, gaining contrast on hover - revealing it from nothing would
                  leave the row with no affordance at rest and shift the input sideways the
                  moment the pointer arrived. */}
              <GripVertical
                aria-hidden
                className={cn(
                  'size-4 shrink-0 cursor-grab transition-colors duration-150 active:cursor-grabbing',
                  'text-border group-hover/row:text-muted-foreground',
                )}
              />
              <MoveButtons
                name={reason.label}
                canMoveUp={index > 0}
                canMoveDown={index < reasons.length - 1}
                onMoveUp={() => moveReason(index, 'up')}
                onMoveDown={() => moveReason(index, 'down')}
                busy={reorderReasons.isPending}
              />
              <ReasonRow reason={reason} />
            </div>
          ))}
        </div>

        <div className="flex gap-2 border-t pt-3">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            aria-label="New cancel reason"
            placeholder="New reason (press Enter or Add)"
            className="flex-1"
            maxLength={LABEL_MAX}
          />
          <Button type="button" size="sm" onClick={add} disabled={!draft.trim()}>
            Add
          </Button>
        </div>
      </Section>
    </div>
  );
}

/** One renameable, switchable row. Local draft so a rename commits on blur/Enter, not per keystroke. */
function ReasonRow({ reason }: { reason: JobCancelReason }) {
  const [label, setLabel] = useState(reason.label);
  const updateReason = useUpdateJobCancelReason();

  const commit = () => {
    const next = label.trim();
    if (!next || next === reason.label) {
      setLabel(reason.label);
      return;
    }
    updateReason.mutate({ code: reason.code, label: next });
  };

  const locked = reason.code === UNDEACTIVATABLE_CODE;

  return (
    <>
      {/* A rename field drawn flat, taking a visible border only on hover/focus - the same
          treatment the job sub-status rows use, and for the same reason: a column of bordered
          inputs is a wall of boxes when the text is the content. */}
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label={`Rename ${reason.label}`}
        className={cn(
          'h-8 min-w-40 flex-1 border-transparent bg-transparent hover:border-border focus:bg-kit-card',
          // A retired reason reads as retired without being hidden - an admin has to be able to
          // find it in order to switch it back on.
          !reason.is_active && 'text-muted-foreground line-through',
        )}
        maxLength={LABEL_MAX}
      />

      {reason.is_builtin && (
        <Badge variant="softNeutral" size="sm" className="shrink-0">
          Built-in
        </Badge>
      )}

      {/* No Remove button on any row: a cancelled job stores the reason's code, so a reason is switched off, never deleted. */}
      <Switch
        checked={reason.is_active}
        disabled={locked}
        onCheckedChange={(next) => updateReason.mutate({ code: reason.code, is_active: next })}
        aria-label={
          locked
            ? `${reason.label} is always offered`
            : `Offer ${reason.label} when a job is cancelled`
        }
        className="ml-1 shrink-0"
      />
    </>
  );
}
