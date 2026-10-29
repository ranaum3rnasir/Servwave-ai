import { create } from 'zustand';
import { registerStoreReset } from '@/lib/storeReset';

interface TaskDetailState {
  openTaskId: string | null;
  open: (id: string) => void;
  close: () => void;
}

export const useTaskDetailStore = create<TaskDetailState>((set) => ({
  openTaskId: null,
  open: (id) => set({ openTaskId: id }),
  close: () => set({ openTaskId: null }),
}));

// A task id belonging to the account that just signed out must not stay open for the next one.
registerStoreReset(() => {
  useTaskDetailStore.setState({ openTaskId: null });
});
