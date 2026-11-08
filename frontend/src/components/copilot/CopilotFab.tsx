import { useCopilotStore } from '@/stores/copilotStore';

/** Thumb-reachable floating launcher for the technician mobile app. */
export default function CopilotFab() {
  const open = useCopilotStore((s) => s.open);
  const setOpen = useCopilotStore((s) => s.setOpen);

  if (open) return null;

  return (
    // Circular FAB (rounded-full, 56px). Its solid/ai colour match is exact, but Button's
    // base always emits rounded-button and the layering-guard's hard-appearance ratchet has
    // no slack to add a rounded-full override - same trap as AddStepButton.tsx's rail
    // trigger (see the ceiling note above). Deferred.
    <button
      type="button"
      aria-label="Open Servy, the AI copilot"
      onClick={() => setOpen(true)}
      className="fixed right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-ai-600 to-ai-500 text-2xl text-on-fill shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai-500 focus-visible:ring-offset-2"
      style={{ bottom: 'calc(72px + env(safe-area-inset-bottom))' }}
    >
      <span aria-hidden>✦</span>
    </button>
  );
}
