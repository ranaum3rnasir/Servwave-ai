import { create } from 'zustand';
import type { InventoryAlert } from '@/lib/inventory/inventory-alerts';

// Zustand replacement for Emanuel's module-level pub/sub `alert-bus.ts`.
//
// The TopBar bell (NotificationsDropdown) calls `emit(alert)` to fan out a
// "navigate to this alert" intent; InventoryPage reads `pending`/`nonce` and
// decides which view/filter/dialog the intent maps to, then calls `clear()`.
// `nonce` bumps on every emit so a repeat-emit of the same alert still
// triggers the consumer's effect (replaces Emanuel's `nonce`-remount hack).

interface InventoryAlertState {
  pending: InventoryAlert | null;
  nonce: number;
  emit: (alert: InventoryAlert) => void;
  clear: () => void;
}

export const useInventoryAlertStore = create<InventoryAlertState>((set) => ({
  pending: null,
  nonce: 0,
  emit: (alert: InventoryAlert) =>
    set((state) => ({ pending: alert, nonce: state.nonce + 1 })),
  clear: () => set({ pending: null }),
}));
