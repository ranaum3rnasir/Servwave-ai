import { useEffect, useRef } from 'react';
import { useCopilotStore } from '@/stores/copilotStore';
import { useServyCopilot } from './voice/useServyCopilot';
import { CopilotContext } from './CopilotContext';
import CopilotPanel from './CopilotPanel';
import CopilotSheet from './CopilotSheet';
import CopilotFab from './CopilotFab';

/**
 * Mounts the copilot once per layout. Owns the session hook, the ⌘K / Esc key
 * bindings, and teardown (stop mic + speech when fully closed).
 * `surface="panel"` (desktop) renders the docked panel; `surface="sheet"`
 * (technician mobile) renders the FAB + full-screen sheet.
 */
export default function CopilotProvider({ surface = 'panel' }: { surface?: 'panel' | 'sheet' }) {
  const api = useServyCopilot();
  const open = useCopilotStore((s) => s.open);
  const prevOpen = useRef(open);

  // ⌘K / Ctrl+K toggles Servy; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        useCopilotStore.getState().toggleOpen();
      } else if (e.key === 'Escape' && useCopilotStore.getState().open) {
        useCopilotStore.getState().setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // On close: disconnect (stops the mic + any speech) and return focus to the
  // header launcher.
  useEffect(() => {
    if (prevOpen.current && !open) {
      api.disconnect();
      document.getElementById('servy-launcher')?.focus();
    }
    prevOpen.current = open;
  }, [open, api]);

  return (
    <CopilotContext.Provider value={api}>
      {surface === 'sheet' ? (
        <>
          <CopilotFab />
          <CopilotSheet />
        </>
      ) : (
        <CopilotPanel />
      )}
    </CopilotContext.Provider>
  );
}
