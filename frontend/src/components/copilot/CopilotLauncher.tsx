import { useCopilotStore } from '@/stores/copilotStore';

/**
 * The "✦ Servy" launcher pill in the top header (replaces the old AI Center
 * pill). Opens the docked copilot panel. Only needs the store, so it can live in
 * the Header without the copilot context.
 */
export default function CopilotLauncher() {
  const setOpen = useCopilotStore((s) => s.setOpen);
  const micActive = useCopilotStore((s) => s.micActive);

  return (
    // Rounded-full ai-tinted pill (border-ai-200/bg-ai-50/text-ai-600) - no minted outline
    // or ghost cell carries an ai tone, and the layering-guard has no slack for a
    // rounded-full override. Deferred.
    <button
      id="servy-launcher"
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open Servy, the AI copilot"
      title="Servy — your AI copilot (⌘K)"
      className="flex items-center gap-1.5 rounded-full border border-ai-200 bg-ai-50 px-2.5 py-1.5 text-sm font-semibold text-ai-600 transition-colors hover:bg-ai-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai-500 focus-visible:ring-offset-2"
    >
      <span aria-hidden className="text-ai-600">✦</span>
      <span className="hidden lg:inline">Servy</span>
      {micActive && (
        <span
          aria-hidden
          className="ml-0.5 h-2 w-2 animate-pulse rounded-full bg-notify"
          title="Listening"
        />
      )}
    </button>
  );
}
