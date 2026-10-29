import { Lock } from 'lucide-react';

import { cn } from '@/ui-kit/lib/utils';
import { Badge } from '@/ui-kit/components/ui/badge';
import { STATUS_REGISTRY, type StatusIntent } from '@/design-system/status-registry';
import { canOpenLinkedEntity, REDACTED_ENTITY_HINT } from '@/lib/tasks/linkedEntity';
import type { TaskPriority, TaskStatus, LinkedEntity } from '@/lib/tasks/types';
import type { RiskResult } from '@/lib/tasks/tasks-logic';

import { ELLIPSIS, WARN } from './glyphs';

/**
 * The task module's four presentational atoms, rebuilt on kit primitives.
 *
 * All four legacy originals (`components/tasks/PriorityDot`, `RiskBadge`,
 * `LinkedEntityChip` and the `data/status-badge` call for the task domain)
 * already resolved their meaning through `design-system/status-registry`. That
 * registry is domain logic, not presentation - it is the single answer to "what
 * does TODO mean" for the whole app - so it is imported here unchanged and only
 * the painting moves onto the kit.
 */

/** Registry intent -> kit Badge variant. Same mapping leads' statusChip uses. */
const SOLID_VARIANT: Record<StatusIntent, 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'purple'> = {
  success: 'green',
  warning: 'amber',
  danger: 'red',
  info: 'blue',
  neutral: 'slate',
  brand: 'purple',
};

/**
 * Task lifecycle painting.
 *
 * `TODO` and `DONE` both resolve to a registry intent that leads the eye
 * nowhere on a board (neutral and success respectively), and `IN_PROGRESS` /
 * `BLOCKED` share `warning`, so painting straight off intent would make two of
 * the four board columns look identical. The v2 layer decides only HOW a state
 * is painted, never what it means - the same carve-out that
 * `pages/v2/_shared/statusChip.tsx` documents, and anything unlisted still
 * falls back to intent.
 *
 * `CANCELLED` is deliberately NOT carved out. It has no board column to be
 * confused with, and its registry intent (`danger`) already paints it red -
 * the furthest thing on the chip scale from DONE's green, which is exactly
 * what the History tab needs to keep the two apart.
 */
const TASK_STATUS_VARIANT: Record<string, 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'purple'> = {
  TODO: 'slate',
  IN_PROGRESS: 'blue',
  BLOCKED: 'amber',
  DONE: 'green',
};

export function TaskStatusChip({ status }: { status: TaskStatus }) {
  const entry = STATUS_REGISTRY.task[status] ?? { label: status, intent: 'neutral' as const };
  const variant = TASK_STATUS_VARIANT[status] ?? SOLID_VARIANT[entry.intent];
  return <Badge variant={variant} size="sm">{entry.label}</Badge>;
}

/**
 * Priority.
 *
 * The legacy control was a coloured dot plus its label. On the kit it becomes a
 * SOFT badge: the kit's locked rule is that the solid fill belongs to the one
 * value that defines a row (status), and everything qualifying it sits beside
 * it tinted. A dot and a soft chip carry the same four-step scale; a second
 * solid chip on the same row would compete with the status for the eye.
 */
const PRIORITY_VARIANT: Record<StatusIntent, 'softGreen' | 'softAmber' | 'softRed' | 'softBlue' | 'softNeutral' | 'softPurple'> = {
  success: 'softGreen',
  warning: 'softAmber',
  danger: 'softRed',
  info: 'softBlue',
  neutral: 'softNeutral',
  brand: 'softPurple',
};

export function PriorityDot({ priority }: { priority: TaskPriority }) {
  // Unmapped values cannot occur through the TaskPriority type, but the wire
  // can still carry one - route the fallback through the same StatusEntry
  // shape so no class string is ever spelled out for an unknown value.
  const entry = STATUS_REGISTRY.taskPriority[priority] ?? { label: priority, intent: 'neutral' as const };
  return <Badge variant={PRIORITY_VARIANT[entry.intent]} size="sm">{entry.label}</Badge>;
}

/**
 * Risk.
 *
 * Renders ONLY when `result.atRisk`, exactly as the legacy badge did - the
 * score and reason are computed for every task but shown for none that are
 * under the threshold. `title` carries the reason, unchanged.
 */
export function RiskBadge({ result }: { result: RiskResult }) {
  if (!result.atRisk) return null;
  return (
    <Badge variant="softAmber" size="sm" title={result.reason ?? ''}>
      {WARN} At risk
    </Badge>
  );
}

const MAX_LABEL = 24;

function truncate(s: string): string {
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + ELLIPSIS : s;
}

/**
 * Linked entity chip. `null` when there is no entity, the type word in bold
 * then the label truncated at 24 characters with the full text in `title` -
 * all three rules carried over from the original.
 *
 * A reader who may not open the entity gets the server's neutral placeholder as
 * the label, and this chip has to make that read as WITHHELD rather than as a
 * chip that failed to load: the recessed `softNeutral` fill instead of the
 * normal outlined one, a padlock, and the reason in the tooltip in place of the
 * identity. Redaction is carried by the variant, NOT by extra appearance
 * classes, so the Badge override ceiling in component-api-guard is untouched.
 *
 * It stays a bare Badge span too - no role, no handler, no href - so a redacted
 * link has nothing to click through to a 403. `canOpenLinkedEntity` is the only
 * gate, and a surface cannot make this navigable without going through it.
 */
export function LinkedEntityChip({ entity, className }: { entity: LinkedEntity | null; className?: string }) {
  if (!entity) return null;
  const openable = canOpenLinkedEntity(entity);
  return (
    <Badge
      variant={openable ? 'outline' : 'softNeutral'}
      size="sm"
      className={cn('max-w-[180px]', className)}
      data-redacted={openable ? undefined : 'true'}
      aria-disabled={openable ? undefined : true}
    >
      {!openable && <Lock aria-hidden="true" />}
      <span className="shrink-0">{entity.type}</span>
      <span className="truncate" title={openable ? entity.label : REDACTED_ENTITY_HINT}>
        {truncate(entity.label)}
      </span>
    </Badge>
  );
}
