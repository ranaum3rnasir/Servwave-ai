import { create } from 'zustand';

/**
 * Controls the global AI Agentic Farm modal. The modal is mounted once in AppLayout;
 * the sidebar AI Agentic Farm launcher calls openModal().
 *
 * `focusAgentId` lets a caller deep-link straight to one agent's detail view
 * (e.g. the per-job AI assistant tiles). The modal consumes it on open, then
 * clears it so a later plain open() lands on the catalog as usual.
 */
interface AiCenterState {
  open: boolean;
  focusAgentId: string | null;
  /** Open the catalog, or jump straight to one agent's detail when an id is passed. */
  openModal: (focusAgentId?: string) => void;
  setOpen: (open: boolean) => void;
  clearFocusAgent: () => void;
}

export const useAiCenterStore = create<AiCenterState>((set) => ({
  open: false,
  focusAgentId: null,
  openModal: (focusAgentId) => set({ open: true, focusAgentId: focusAgentId ?? null }),
  setOpen: (open) => set((state) => ({ open, focusAgentId: open ? state.focusAgentId : null })),
  clearFocusAgent: () => set({ focusAgentId: null }),
}));
