import { create } from 'zustand';
import type { TaskFilter, TaskDrillDown } from '@/lib/tasks/tasks-logic';
import { registerStoreReset } from '@/lib/storeReset';

interface TaskFilterState extends TaskFilter {
  // Re-declared required (inherited optional on TaskFilter; store always holds concrete values)
  overdue: boolean;
  atRisk: boolean;
  dueFrom: string;
  dueTo: string;
  createdFrom: string;
  createdTo: string;
  categoryIds: string[];
  setMember: (id: string) => void;
  setDepartment: (id: string) => void;
  /** The Category facet (task category ids + 'none'); not `setCategory`, the KPI drill-down. */
  setCategoryIds: (ids: string[]) => void;
  setCategory: (category: TaskDrillDown) => void;
  setOverdue: (v: boolean) => void;
  setAtRisk: (v: boolean) => void;
  setDueRange: (r: { from: string; to: string }) => void;
  setCreatedRange: (r: { from: string; to: string }) => void;
  reset: () => void;
}

export const useTaskFilterStore = create<TaskFilterState>((set) => ({
  memberId: 'all',
  departmentId: 'all',
  categoryIds: [],
  category: 'all',
  overdue: false,
  atRisk: false,
  dueFrom: '',
  dueTo: '',
  createdFrom: '',
  createdTo: '',
  setMember: (memberId) => set({ memberId }),
  setDepartment: (departmentId) => set({ departmentId }),
  setCategoryIds: (categoryIds) => set({ categoryIds }),
  setCategory: (category) => set({ category }),
  setOverdue: (overdue) => set({ overdue }),
  setAtRisk: (atRisk) => set({ atRisk }),
  setDueRange: ({ from, to }) => set({ dueFrom: from, dueTo: to }),
  setCreatedRange: ({ from, to }) => set({ createdFrom: from, createdTo: to }),
  reset: () => set({
    memberId: 'all', departmentId: 'all', categoryIds: [], category: 'all',
    overdue: false, atRisk: false,
    dueFrom: '', dueTo: '', createdFrom: '', createdTo: '',
  }),
}));

/**
 * A filter chosen by one account must not follow the next one into the same tab.
 *
 * Same defect class as the task list itself: a Zustand store is a module singleton and signing
 * back in is a client-side navigation, so the module is never re-evaluated. The member filter
 * is the sharp edge - it holds a user id from the OLD roster, so the incoming account gets a
 * silently narrowed list, and the chip that is supposed to name the person resolves against a
 * roster that no longer contains them and renders a bare uuid instead.
 *
 * Delegated to the store's own `reset()` rather than a hand-written `setState` so the two
 * cannot drift as fields are added. Note the no-filter sentinel is the STRING 'all' - resetting
 * these to null or '' would typecheck and change nothing a reader could see.
 */
registerStoreReset(() => {
  useTaskFilterStore.getState().reset();
});
