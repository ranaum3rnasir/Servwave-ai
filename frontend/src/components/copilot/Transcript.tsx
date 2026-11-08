import { useEffect, useRef } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCopilotStore, type TranscriptTurn } from '@/stores/copilotStore';
import { stripInternalIds } from '@/components/copilot/tools/toolHandlers';
import { sendFeedback } from '@/lib/copilot/api';

function FeedbackButtons({ turn }: { turn: TranscriptTurn }) {
  const updateTurn = useCopilotStore((s) => s.updateTurn);
  if (!turn.messageId) return null;

  const give = async (value: 'UP' | 'DOWN') => {
    updateTurn(turn.id, { feedback: value });
    try {
      await sendFeedback(turn.messageId!, value);
    } catch {
      /* best-effort */
    }
  };

  return (
    <div className="mt-1 flex gap-1">
      {/* Feedback toggle pair: idle text-on-fill/35 that switches to a selected-state colour
          (sage-200 / danger-on-dark) - no onDark cell reproduces that idle opacity or a
          colour that only appears once selected, and its rounded/p-1 box doesn't match any
          icon size rung. Deferred. */}
      <button
        type="button"
        aria-label="Good response"
        aria-pressed={turn.feedback === 'UP'}
        onClick={() => give('UP')}
        className={cn(
          'rounded p-1 text-on-fill/35 transition-colors hover:bg-on-fill/10 hover:text-on-fill/70',
          turn.feedback === 'UP' && 'text-sage-200',
        )}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Bad response"
        aria-pressed={turn.feedback === 'DOWN'}
        onClick={() => give('DOWN')}
        className={cn(
          'rounded p-1 text-on-fill/35 transition-colors hover:bg-on-fill/10 hover:text-on-fill/70',
          turn.feedback === 'DOWN' && 'text-danger-on-dark',
        )}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function Bubble({ turn }: { turn: TranscriptTurn }) {
  const isUser = turn.role === 'user';
  const body = isUser ? turn.text : stripInternalIds(turn.text);
  // Never render an empty bubble: a model round can return whitespace-only text
  // (e.g. a bare function-call turn) — without this guard it shows as a blank "?".
  if (!body.trim() && !turn.label) return null;
  return (
    <div className={cn('flex flex-col motion-safe:animate-servy-in', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-gradient-to-br from-ai-500 to-ai-gradient-to text-on-fill shadow-[0_4px_18px_rgb(var(--ai-600)/0.35)]'
            : 'border border-on-fill/10 bg-on-fill/[0.07] text-on-fill/90 backdrop-blur-sm',
        )}
      >
        {turn.label === 'draft_only_not_sent' && (
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-ai-200">
            Draft · not sent
          </span>
        )}
        {turn.label === 'fallback' && (
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-warning-on-dark">
            Safety fallback
          </span>
        )}
        {body}
      </div>
      {!isUser && <FeedbackButtons turn={turn} />}
    </div>
  );
}

function Interim({ role, text }: { role: 'user' | 'assistant'; text: string }) {
  return (
    <div className={cn('flex', role === 'user' ? 'justify-end' : 'justify-start')}>
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm italic text-on-fill/45">
        {text}
      </div>
    </div>
  );
}

/** The conversation log. ARIA live so screen readers hear new turns. */
export default function Transcript() {
  const transcript = useCopilotStore((s) => s.transcript);
  const interim = useCopilotStore((s) => s.interim);
  const statusText = useCopilotStore((s) => s.statusText);
  const error = useCopilotStore((s) => s.error);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [transcript.length, interim.user, interim.assistant, statusText]);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 [scrollbar-color:rgba(255,255,255,0.18)_transparent] [scrollbar-width:thin]">
      <div role="log" aria-live="polite" aria-label="Conversation with Servy" className="flex flex-col gap-3">
        {transcript.map((turn) => (
          <Bubble key={turn.id} turn={turn} />
        ))}
        {interim.user.trim() && <Interim role="user" text={interim.user} />}
        {interim.assistant.trim() && <Interim role="assistant" text={interim.assistant} />}
      </div>

      {statusText && (
        <div role="status" className="flex items-center gap-2 motion-safe:animate-servy-in">
          <div className="flex items-center gap-1.5 rounded-2xl border border-on-fill/10 bg-on-fill/[0.07] px-3 py-2.5 backdrop-blur-sm">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                aria-hidden
                className="h-1.5 w-1.5 rounded-full bg-ai-500 shadow-[0_0_6px_rgb(var(--ai-600)/0.9)] motion-safe:animate-servy-dot"
                style={{ animationDelay: `${i * 0.18}s` }}
              />
            ))}
          </div>
          <span className="text-xs text-on-fill/50">{statusText}</span>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/15 px-3 py-2 text-xs text-danger-on-dark">
          {error}
        </p>
      )}
      <div ref={endRef} />
    </div>
  );
}
