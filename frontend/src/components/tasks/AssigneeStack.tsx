import { cn, getInitials } from '@/lib/utils';
import type { TaskPersonRef } from '@/lib/tasks/types';
import { UNKNOWN_ASSIGNEE_LABEL, assigneeLabel } from '@/lib/tasks/assignees';

interface AssigneeStackProps {
  assignees: TaskPersonRef[];
  /** Tiles rendered before the overflow chip takes over. */
  max?: number;
  /** Show the single assignee's name beside the tile (cards, not dense rows). */
  showSoleName?: boolean;
  className?: string;
}

/**
 * The overlapping avatar stack every task surface shows its assignees with.
 *
 * Shared by BOTH live task trees (`components/tasks/*` on the entity detail
 * tabs, `pages/v2/tasks/*` on the hub) so a task cannot read as two different
 * crews depending on where you look at it. It renders initials tiles rather
 * than photos: the task payload carries names only, and the 2026-08-04 avatar
 * decision forbids synthesising a face from an id.
 *
 * The kit's `ui-kit/components/ui/avatar` `AvatarGroup` was the reuse candidate
 * and does not fit: it takes `names: string[]` and keys its children on the
 * NAME, so two unresolved assignees - both rendering "Unknown user", the exact
 * case this feature has to survive - collide on one React key. Keying on the
 * stable user id is the whole reason this takes refs instead of strings.
 *
 * Every name may be null. `assigneeLabel` is the single place that decides what
 * shows instead, and `getInitials` already has a fallback glyph, so nothing
 * here dereferences a name.
 */
export function AssigneeStack({
  assignees,
  max = 3,
  showSoleName = false,
  className,
}: AssigneeStackProps) {
  if (assignees.length === 0) {
    return <p className="text-xs italic text-text-secondary/70">Unassigned</p>;
  }

  const shown = assignees.slice(0, max);
  const overflow = assignees.length - shown.length;
  // Names the FULL set, not the visible slice: hovering an overflowing stack is
  // how you find out who the "+2" are.
  const everyone = assignees.map(assigneeLabel).join(', ');

  return (
    <div
      className={cn('flex items-center gap-1.5 text-xs text-text-secondary', className)}
      data-testid="assignee-stack"
      title={everyone}
    >
      <div className="flex items-center -space-x-1.5">
        {shown.map((person) => {
          const label = assigneeLabel(person);
          return (
            <span
              key={person.id}
              role="img"
              aria-label={label}
              title={label}
              className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-subtle text-[9px] font-bold text-primary ring-2 ring-surface-light"
            >
              {person.name ? getInitials(person.name) : '?'}
            </span>
          );
        })}
        {overflow > 0 && (
          <span
            aria-label={`${overflow} more`}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-text-secondary ring-2 ring-surface-light"
          >
            +{overflow}
          </span>
        )}
      </div>
      {showSoleName && assignees.length === 1 && (
        <span className="font-medium text-text-primary">
          {assignees[0]?.name ?? UNKNOWN_ASSIGNEE_LABEL}
        </span>
      )}
    </div>
  );
}
