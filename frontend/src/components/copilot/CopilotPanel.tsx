import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCopilotStore } from '@/stores/copilotStore';
import { useCopilot } from './CopilotContext';
import Transcript from './Transcript';
import Composer from './Composer';
import ApprovalCard from './ApprovalCard';
import VoiceOrb from './VoiceOrb';
import { COPILOT_SURFACE } from './surface';

const EXAMPLES = [
  "What's my morning briefing?",
  'What jobs are scheduled today?',
  'Which invoices are overdue?',
  'Create a lead for a new customer',
];

/**
 * Desktop docked-right panel — the "AI night glass" surface. The app stays
 * light; Servy is a deliberate dark AI moment (lavender = AI per the design
 * system). Non-modal (role=complementary, no backdrop) so the app behind it
 * stays usable. Closed → renders nothing (no idle voice session).
 */
export default function CopilotPanel() {
  const open = useCopilotStore((s) => s.open);
  const setOpen = useCopilotStore((s) => s.setOpen);
  const mode = useCopilotStore((s) => s.mode);
  const micActive = useCopilotStore((s) => s.micActive);
  const transcriptEmpty = useCopilotStore((s) => s.transcript.length === 0);
  const { sendText } = useCopilot();

  if (!open) return null;

  return (
    <aside
      role="complementary"
      aria-label="Servy copilot"
      className="fixed right-0 top-[57px] bottom-0 z-40 flex w-full max-w-[420px] flex-col overflow-hidden border-l border-on-fill/10 shadow-2xl"
      style={{ background: COPILOT_SURFACE }}
    >
      <header className="relative flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className="inline-block text-lg text-ai-500 [text-shadow:0_0_12px_rgb(var(--ai-600)/0.9)] motion-safe:animate-servy-breathe"
            aria-hidden
          >
            ✦
          </span>
          <span className="font-semibold text-on-fill">Servy</span>
          <span className="text-xs text-on-fill/40">AI copilot</span>
        </div>
        <Button
          variant="onDark"
          size="icon"
          aria-label="Close Servy"
          onClick={() => setOpen(false)}
        >
          <X className="h-5 w-5" />
        </Button>
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-ai-500/70 via-ai-500/20 to-transparent"
        />
      </header>

      {(mode === 'voice' || micActive) && <VoiceOrb />}

      {transcriptEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-8 text-center">
          {mode !== 'voice' && !micActive && (
            <div className="relative flex h-20 w-20 items-center justify-center motion-safe:animate-servy-breathe" aria-hidden>
              <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_35%_30%,rgb(var(--ai-300)/0.9),rgb(var(--ai-600)/0.55)_55%,rgb(var(--ai-600)/0.12))] shadow-[0_0_40px_rgb(var(--ai-600)/0.45)]" />
              <span className="relative text-3xl text-on-fill drop-shadow">✦</span>
            </div>
          )}
          <div>
            <p className="text-lg font-semibold text-on-fill">Hey, I'm Servy</p>
            <p className="mt-1.5 text-sm leading-relaxed text-on-fill/50">
              Ask me anything about your CRM, or tell me what to do — I'll always confirm before
              changing anything.
            </p>
          </div>
          <div className="flex w-full flex-col gap-2">
            {EXAMPLES.map((ex, i) => (
              // Suggestion-prompt row: left-aligned text, a staggered per-index animation
              // delay via inline style, and border/bg tokens no minted cell carries together.
              // Deferred.
              <button
                key={ex}
                type="button"
                onClick={() => void sendText(ex)}
                className="rounded-xl border border-on-fill/10 bg-on-fill/[0.05] px-4 py-2.5 text-left text-sm text-on-fill/80 backdrop-blur transition-all hover:border-ai-500/50 hover:bg-ai-500/15 hover:text-on-fill motion-safe:animate-servy-in"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Transcript />
      )}

      <ApprovalCard />
      <Composer autoFocus />
    </aside>
  );
}
