/**
 * Session memory for the last stock location the user deducted from (Inventory P1 §2f).
 * Backs the SyncStockDialog / AddLineDialog default-location resolution:
 * last session pick → org default → empty (user must pick). sessionStorage access is
 * try/catch-wrapped — jsdom (and locked-down browsers) may not expose the Storage API.
 */
const KEY = 'sw.lastStockLocationId';

export function getLastStockLocationId(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setLastStockLocationId(id: string): void {
  try {
    window.sessionStorage.setItem(KEY, id);
  } catch {
    // Best-effort session convenience only — ignore storage failures.
  }
}
