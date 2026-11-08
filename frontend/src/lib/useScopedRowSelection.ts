import { useCallback, useMemo, useState } from 'react';
import type { OnChangeFn, RowSelectionState } from '@tanstack/react-table';

const EMPTY: RowSelectionState = {};

/**
 * Row selection that belongs to ONE query scope.
 *
 * A selected id only makes sense against the CURRENT page/sort/filter, so once any of the
 * list query's own params change the selection must drop rather than carry stale ids (or a
 * now-invisible row) forward. Pass the same values the list's `useQuery` keys on.
 *
 * The scope change is DERIVED, not reset in an effect. An effect would repaint once with the
 * stale selection still checked before clearing it, and `react-hooks/set-state-in-effect`
 * rejects the pattern outright. Holding the scope key alongside the rows makes a scope change
 * read back as empty in the same render that changed it, with no second pass.
 *
 * The rows are kept (not discarded) when the key moves, so a write that arrives against the
 * new scope rebases onto empty rather than onto whatever the previous scope had selected.
 */
export function useScopedRowSelection(scopeKey: string): {
  rowSelection: RowSelectionState;
  setRowSelection: OnChangeFn<RowSelectionState>;
  selectedIds: string[];
} {
  const [state, setState] = useState<{ key: string; rows: RowSelectionState }>({
    key: scopeKey,
    rows: EMPTY,
  });

  const rowSelection = state.key === scopeKey ? state.rows : EMPTY;

  const setRowSelection = useCallback<OnChangeFn<RowSelectionState>>(
    (updater) => {
      setState((prev) => {
        const base = prev.key === scopeKey ? prev.rows : EMPTY;
        return { key: scopeKey, rows: typeof updater === 'function' ? updater(base) : updater };
      });
    },
    [scopeKey]
  );

  const selectedIds = useMemo(
    () => Object.keys(rowSelection).filter((id) => rowSelection[id]),
    [rowSelection]
  );

  return { rowSelection, setRowSelection, selectedIds };
}
