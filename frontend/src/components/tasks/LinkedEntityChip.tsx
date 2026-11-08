import { Lock } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { LinkedEntity } from '@/lib/tasks/types';
import { canOpenLinkedEntity, REDACTED_ENTITY_HINT } from '@/lib/tasks/linkedEntity';

const MAX_LABEL = 24;

function truncate(s: string): string {
  return s.length > MAX_LABEL ? s.slice(0, MAX_LABEL - 1) + '…' : s;
}

export function LinkedEntityChip({ entity }: { entity: LinkedEntity | null }) {
  if (!entity) return null;
  const openable = canOpenLinkedEntity(entity);
  return (
    // A redacted chip has to read as WITHHELD, not as a chip that failed to load: dashed rule,
    // recessed ink and a padlock, with the reason in the tooltip in place of the identity. It also
    // stays a bare span - no role, no handler, no href - so there is nothing to click through to a
    // 403. `canOpenLinkedEntity` is the only gate; a surface cannot make this navigable past it.
    <span
      data-redacted={openable ? undefined : 'true'}
      aria-disabled={openable ? undefined : true}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs max-w-[180px]',
        openable
          ? 'border-border bg-background-light text-text-secondary'
          : 'cursor-default border-dashed border-border bg-surface-light text-text-soft',
      )}
    >
      {!openable && <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />}
      <span className="font-semibold shrink-0">{entity.type}</span>
      <span className="truncate" title={openable ? entity.label : REDACTED_ENTITY_HINT}>
        {truncate(entity.label)}
      </span>
    </span>
  );
}
