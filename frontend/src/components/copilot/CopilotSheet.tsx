import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCopilotStore } from '@/stores/copilotStore';
import Transcript from './Transcript';
import Composer from './Composer';
import ApprovalCard from './ApprovalCard';
import VoiceOrb from './VoiceOrb';
import { COPILOT_SURFACE } from './surface';

/** Mobile (technician) full-screen, voice-first sheet — same AI night glass. */
export default function CopilotSheet() {
  const open = useCopilotStore((s) => s.open);
  const setOpen = useCopilotStore((s) => s.setOpen);
  const transcriptEmpty = useCopilotStore((s) => s.transcript.length === 0);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Servy copilot"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden"
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

      <VoiceOrb />

      {transcriptEmpty ? (
        <div className="flex-1 overflow-y-auto px-6 py-6 text-center">
          <p className="text-sm leading-relaxed text-on-fill/50">
            Tap the orb and talk — ask about your jobs, add a note, or update a status. I'll confirm
            before changing anything.
          </p>
        </div>
      ) : (
        <Transcript />
      )}

      <ApprovalCard />
      <Composer autoFocus />
    </div>
  );
}
