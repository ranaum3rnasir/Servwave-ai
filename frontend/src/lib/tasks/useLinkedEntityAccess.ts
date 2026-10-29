import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import api from '@/lib/axios';
import { useAppAbility } from '@/contexts/AbilityContext';
import type { LinkedEntity } from '@/lib/tasks/types';

/** `GET /api/tasks/entity-access` (#05). `label` is already redacted for the CALLER. */
interface EntityAccessResponse {
  entity: { type: string; id: string; label: string | null; redacted: boolean };
  /** The roster the server actually evaluated. Anyone outside it has NO verdict. */
  checked_user_ids: string[];
  /** Subset of the above. Advisory: these people are still perfectly pickable. */
  without_access: string[];
}

export interface LinkedEntityAccess {
  /** Candidates to mark. Empty whenever there is nothing to say, which is the common case. */
  flaggedIds: string[];
  /** The one-line explanation, naming the entity. Null when nothing is flagged. */
  note: string | null;
  /** Short marker for the row/chip itself. */
  badge: string;
}

const NONE: LinkedEntityAccess = { flaggedIds: [], note: null, badge: 'No access' };

/**
 * Who among the assignable roster cannot open `entity`, for the assignee and watcher pickers.
 *
 * ADVISORY. Nothing here gates a write: assignment grants the TASK and nothing else, deliberately,
 * so a flagged person is still assignable and still gets the task. The point is only that the
 * person choosing finds out now rather than never.
 *
 * Pass `null` and no request is made at all - an unlinked task has nothing to warn about, and a
 * closed dialog has nobody to warn. Callers gate on their own open state so the fetch happens once
 * per opening. The roster is resolved server-side, so the WHOLE picker costs one request; both
 * pickers on a surface share this query key and TanStack dedupes them into that one.
 *
 * Fails open in every direction. A 400/404/500 leaves `data` undefined and flags nobody, which is
 * the right way round: a missing verdict must never render as "everyone is locked out". Same for a
 * candidate the server did not evaluate - `without_access` is intersected with `checked_user_ids`
 * rather than trusted on its own, so a roster the picker widened locally cannot pick up a verdict
 * that was never given for it.
 */
export function useLinkedEntityAccess(entity: LinkedEntity | null | undefined): LinkedEntityAccess {
  const type = entity?.type ?? null;
  const id = entity?.id ?? null;

  const { data } = useQuery<EntityAccessResponse>({
    queryKey: ['tasks', 'entity-access', type, id],
    queryFn: () =>
      api
        .get('/api/tasks/entity-access', { params: { entity_type: type, entity_id: id } })
        .then((r) => r.data),
    enabled: Boolean(type && id),
    staleTime: 30_000,
    // 400 and 404 are verdicts, not blips, and the answer to all three is the same: say nothing.
    retry: false,
  });

  const fallbackLabel = entity?.label ?? null;

  return useMemo(() => {
    if (!data) return NONE;
    const checked = new Set(data.checked_user_ids ?? []);
    const flaggedIds = (data.without_access ?? []).filter((userId) => checked.has(userId));
    if (flaggedIds.length === 0) return NONE;

    const label = data.entity?.label || fallbackLabel || 'the linked record';
    return {
      flaggedIds,
      note: `Flagged people cannot open ${label}. You can still add them; that link stays hidden from them.`,
      badge: NONE.badge,
    };
  }, [data, fallbackLabel]);
}

/**
 * Should this surface ask the question at all?
 *
 * The answer is NOT `can('assign', 'Task')`, and assuming it is would silently break three of the
 * four stock roles. SALES, DISPATCHER and TECHNICIAN all hold `update Task` and none holds
 * `assign Task` (defaultGrants.ts, and design section 3 says so deliberately). The assignee picker
 * is `disabled` for them - but the WATCHER picker never is, and PATCH /api/tasks/:id only 403s a
 * CHANGED assignee set, so `watcher_ids` rides on plain `update Task`. A dispatcher adding a
 * technician as a watcher of a customer-linked task is the same mistake the assignee case is, and
 * they can still make it.
 *
 * So the gate is "can this user change EITHER roster on this surface". What it actually skips is a
 * reader who can change neither - `read Task` with no write verb, which custom roles can produce -
 * and for them the scan was pure waste: one probe per permission profile per OR-arm of the read
 * grant, all of it answering a question they cannot act on.
 *
 * `write` is the verb this surface's own save needs: `create` for the New Task dialogs, `update`
 * for the detail drawers.
 */
export function useTaskRosterEditable(write: 'create' | 'update'): boolean {
  const ability = useAppAbility();
  return ability.can('assign', 'Task') || ability.can(write, 'Task');
}
