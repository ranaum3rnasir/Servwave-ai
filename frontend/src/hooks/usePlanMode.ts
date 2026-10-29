import { useState, useCallback, useRef, useMemo, useEffect } from 'react';

// ─── Types ───────────────────────────────────────────────

export interface GhostEvent {
  id: string;
  sourceId: string;
  sourceType: 'job' | 'walkthrough';
  /**
   * The TRIP this draft moves, when it was made from a job's visit card (slice 02). Confirming it
   * reschedules exactly that visit, by time only. Absent for a bare-job draft (the unscheduled
   * bucket), which first-books through `/assign`, and for a draft saved before this shipped.
   */
  visitId?: string;
  isFromSidebar: boolean;
  isMovedConfirmed: boolean;
  originalPosition?: {
    start: string;   // ISO string for serialization
    end: string;
    crew?: string[];
  };
  start: string;     // ISO string for serialization
  end: string;
  crew: string[];    // performer user ids (0..N) — crew ⟂ schedule, [] is valid
  title: string;
  customerName: string;
  /**
   * Where the draft says to go. Visit-location slice 6: the TRIP'S OWN location when it has one
   * (`locationLabel` below), otherwise the parent's service address - so the "Schedule Job?"
   * confirm dialog's `Location:` line names the place the crew is actually being sent.
   */
  address: string;
  /**
   * The trip's own location, as the API resolved it, or null when it is at the parent's service
   * address. Carried separately from `address` because the ghost's CARD renders through
   * `cardAddressText`, which reads this field and falls back to the parent itself - one precedence
   * rule, stated once, shared with every live card on the board.
   *
   * OPTIONAL: ghosts are persisted to sessionStorage, so a draft written before this shipped is
   * rehydrated without the key, and absent has to read the same as null.
   */
  locationLabel?: string | null;
  raw: Record<string, unknown>;
}

export interface UsePlanModeReturn {
  isActive: boolean;
  ghosts: GhostEvent[];
  ghostCount: number;
  hiddenSidebarIds: Set<string>;
  activate: () => void;
  /** Returns false if there are pending ghosts (caller should show exit dialog) */
  deactivate: () => boolean;
  forceDeactivate: () => void;
  addGhost: (ghost: Omit<GhostEvent, 'id'>) => void;
  removeGhost: (ghostId: string) => void;
  updateGhostPosition: (ghostId: string, start: string, end: string, crew?: string[]) => void;
  discardAll: () => void;
  getGhostsForView: (viewStart: Date, viewEnd: Date) => GhostEvent[];
  getGhostById: (ghostId: string) => GhostEvent | undefined;
}

// ─── Stable tab ID (survives refresh, unique per tab) ────

function getOrCreateTabId(): string {
  let tabId = sessionStorage.getItem('plan-mode-tab-id');
  if (!tabId) {
    tabId = crypto.randomUUID();
    sessionStorage.setItem('plan-mode-tab-id', tabId);
  }
  return tabId;
}

const TAB_ID = getOrCreateTabId();
const STORAGE_KEY = `plan-mode-${TAB_ID}`;

// ─── Stale-entry cleanup (remove entries > 24 h from closed tabs) ──

(function cleanupStalePlanModeEntries() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith('plan-mode-') && key !== STORAGE_KEY) {
      try {
        const data = JSON.parse(localStorage.getItem(key) ?? '{}');
        if (data.updatedAt && Date.now() - data.updatedAt > 24 * 60 * 60 * 1000) {
          localStorage.removeItem(key);
        }
      } catch {
        localStorage.removeItem(key ?? '');
      }
    }
  }
})();

// ─── beforeunload cleanup (only if plan mode is inactive) ──

window.addEventListener('beforeunload', () => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.isActive || (parsed.ghosts && parsed.ghosts.length === 0)) {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
});

// ─── Helpers ─────────────────────────────────────────────

interface PersistedState {
  isActive: boolean;
  ghosts: GhostEvent[];
  updatedAt: number;
}

function loadState(): { isActive: boolean; ghosts: GhostEvent[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { isActive: false, ghosts: [] };
    const parsed = JSON.parse(raw) as PersistedState;
    return {
      isActive: parsed.isActive ?? false,
      // Normalize persisted ghosts: drafts saved before the crew-array migration carry a
      // single `resourceId` instead of `crew` — lift it into a one-member crew.
      ghosts: (parsed.ghosts ?? []).map((g) => {
        const legacy = g as GhostEvent & { resourceId?: string };
        return {
          ...g,
          crew: Array.isArray(g.crew) ? g.crew : legacy.resourceId ? [legacy.resourceId] : [],
        };
      }),
    };
  } catch {
    return { isActive: false, ghosts: [] };
  }
}

function saveState(isActive: boolean, ghosts: GhostEvent[]) {
  try {
    const state: PersistedState = { isActive, ghosts, updatedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

// ─── Hook ────────────────────────────────────────────────

export function usePlanMode(): UsePlanModeReturn {
  const initial = loadState();
  const [isActive, setIsActive] = useState(initial.isActive);
  const [ghosts, setGhosts] = useState<GhostEvent[]>(initial.ghosts);
  const ghostsRef = useRef(ghosts);
  ghostsRef.current = ghosts;

  // Persist state whenever isActive or ghosts change
  useEffect(() => {
    saveState(isActive, ghosts);
  }, [isActive, ghosts]);

  // Compute hidden sidebar IDs from ghosts that came from sidebar
  const hiddenSidebarIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of ghosts) {
      if (g.isFromSidebar) {
        ids.add(g.sourceId);
      }
    }
    return ids;
  }, [ghosts]);

  const activate = useCallback(() => {
    setIsActive(true);
  }, []);

  const deactivate = useCallback((): boolean => {
    if (ghostsRef.current.length > 0) {
      return false; // Caller should show confirmation dialog
    }
    setIsActive(false);
    return true;
  }, []);

  const forceDeactivate = useCallback(() => {
    setGhosts([]);
    setIsActive(false);
  }, []);

  const addGhost = useCallback((ghost: Omit<GhostEvent, 'id'>) => {
    const newGhost: GhostEvent = {
      ...ghost,
      id: crypto.randomUUID(),
    };
    setGhosts((prev) => [...prev, newGhost]);
  }, []);

  const removeGhost = useCallback((ghostId: string) => {
    setGhosts((prev) => prev.filter((g) => g.id !== ghostId));
  }, []);

  const updateGhostPosition = useCallback((ghostId: string, start: string, end: string, crew?: string[]) => {
    setGhosts((prev) =>
      prev.map((g) =>
        g.id === ghostId
          ? { ...g, start, end, crew: crew ?? g.crew }
          : g,
      ),
    );
  }, []);

  const discardAll = useCallback(() => {
    setGhosts([]);
  }, []);

  const getGhostsForView = useCallback((viewStart: Date, viewEnd: Date): GhostEvent[] => {
    return ghostsRef.current.filter((g) => {
      const gStart = new Date(g.start);
      const gEnd = new Date(g.end);
      return gStart < viewEnd && gEnd > viewStart;
    });
  }, []);

  const getGhostById = useCallback((ghostId: string): GhostEvent | undefined => {
    return ghostsRef.current.find((g) => g.id === ghostId);
  }, []);

  return {
    isActive,
    ghosts,
    ghostCount: ghosts.length,
    hiddenSidebarIds,
    activate,
    deactivate,
    forceDeactivate,
    addGhost,
    removeGhost,
    updateGhostPosition,
    discardAll,
    getGhostsForView,
    getGhostById,
  };
}
