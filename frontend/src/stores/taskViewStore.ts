import { create } from 'zustand';

import type { CompletionRange, CompletionScope } from '@/lib/tasks/tasks-logic';
import type { CalendarMode } from '@/lib/tasks/taskViewRows';
import { registerStoreReset } from '@/lib/storeReset';

/**
 * The Tasks tabs' own toolbar state - the part of "which rows does this tab show" that is not
 * the shared Filter: the List's search, the Calendar's period, and History's scope, range and
 * search.
 *
 * It lives here, not in each view's `useState`, because the Filter popover counts tasks per
 * category over exactly the rows the open tab shows (slice 10), and the popover sits in the hub
 * header, outside the view. Module-level like `taskFilterStore`, so it also survives a tab switch.
 */
interface TaskViewState {
  listSearch: string;
  calendarMode: CalendarMode;
  /** Any instant inside the period the Calendar shows. */
  calendarAnchor: Date;
  historyScope: CompletionScope;
  historyRange: CompletionRange;
  historySearch: string;
  setListSearch: (v: string) => void;
  setCalendarMode: (v: CalendarMode) => void;
  setCalendarAnchor: (v: Date | ((prev: Date) => Date)) => void;
  setHistoryScope: (v: CompletionScope) => void;
  setHistoryRange: (v: CompletionRange) => void;
  setHistorySearch: (v: string) => void;
  reset: () => void;
}

const initial = () => ({
  listSearch: '',
  calendarMode: 'month' as CalendarMode,
  calendarAnchor: new Date(),
  historyScope: 'mine' as CompletionScope,
  historyRange: '30d' as CompletionRange,
  historySearch: '',
});

export const useTaskViewStore = create<TaskViewState>((set) => ({
  ...initial(),
  setListSearch: (listSearch) => set({ listSearch }),
  setCalendarMode: (calendarMode) => set({ calendarMode }),
  setCalendarAnchor: (v) => set((s) => ({ calendarAnchor: typeof v === 'function' ? v(s.calendarAnchor) : v })),
  setHistoryScope: (historyScope) => set({ historyScope }),
  setHistoryRange: (historyRange) => set({ historyRange }),
  setHistorySearch: (historySearch) => set({ historySearch }),
  reset: () => set(initial()),
}));

/** A search typed by one account must not greet the next one on the same tab. */
registerStoreReset(() => {
  useTaskViewStore.getState().reset();
});
