import { useState, type KeyboardEvent } from 'react';
import { Mic, Square, Send } from 'lucide-react';
import { useCopilotStore } from '@/stores/copilotStore';
import { useCopilot } from './CopilotContext';

/** Text input + mic toggle on the dark glass bar. Enter sends; Shift+Enter is a newline. */
export default function Composer({ autoFocus }: { autoFocus?: boolean }) {
  const { sendText, startVoice, stopVoice } = useCopilot();
  const micActive = useCopilotStore((s) => s.micActive);
  const [value, setValue] = useState('');

  const submit = () => {
    const t = value.trim();
    if (!t) return;
    setValue('');
    void sendText(t);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-end gap-2 border-t border-on-fill/10 bg-on-fill/[0.04] p-3 backdrop-blur"
    >
      {/* Same on-dark-glass trap as the mic/send buttons below: Textarea's own default
          appearance is a light surface (bg-text-primary/5, border-transparent) - restoring
          this bar's on-fill/ai-500 theme (bg, border, text, placeholder, focus ring) at the
          call site is a wall of hard classes the layering-guard has no slack for. Deferred. */}
      <textarea
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        aria-label="Message Servy"
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask Servy, or describe what to do…"
        className="max-h-32 min-h-[42px] flex-1 resize-none rounded-xl border border-on-fill/10 bg-on-fill/[0.07] px-3.5 py-2.5 text-sm text-on-fill placeholder:text-on-fill/35 focus:border-ai-500/60 focus:outline-none focus:ring-2 focus:ring-ai-500/50"
      />
      <div className="relative">
        {micActive && (
          <span
            aria-hidden
            className="absolute -inset-1 rounded-full bg-ai-500/40 motion-safe:animate-ping"
            style={{ animationDuration: '1.6s' }}
          />
        )}
        {/* Circular (rounded-full) toggle with a custom glow shadow and a two-state colour
            swap (gradient when active, glass otherwise) - no minted cell reproduces either
            the shape (layering-guard has no slack for a rounded-full override) or the glow.
            Deferred. */}
        <button
          type="button"
          aria-label={micActive ? 'Stop voice' : 'Talk to Servy'}
          aria-pressed={micActive}
          onClick={() => (micActive ? stopVoice() : void startVoice())}
          className={
            micActive
              ? 'relative flex h-[42px] w-[42px] items-center justify-center rounded-full bg-gradient-to-br from-ai-500 to-ai-gradient-to text-on-fill shadow-[0_0_18px_rgb(var(--ai-600)/0.6)] transition-transform hover:scale-105'
              : 'relative flex h-[42px] w-[42px] items-center justify-center rounded-full border border-on-fill/15 bg-on-fill/[0.07] text-on-fill/80 transition-all hover:border-ai-500/60 hover:bg-ai-500/20 hover:text-on-fill'
          }
        >
          {micActive ? <Square className="h-4 w-4" /> : <Mic className="h-[18px] w-[18px]" />}
        </button>
      </div>
      {/* Same circular/glow trap as the mic toggle above - no minted cell reproduces a
          rounded-full shape or the custom glow shadow. Deferred. */}
      <button
        type="submit"
        aria-label="Send"
        disabled={!value.trim()}
        className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-gradient-to-br from-ai-500 to-ai-gradient-to text-on-fill shadow-[0_0_14px_rgb(var(--ai-600)/0.45)] transition-all hover:scale-105 disabled:opacity-30 disabled:shadow-none disabled:hover:scale-100"
      >
        <Send className="h-[18px] w-[18px]" />
      </button>
    </form>
  );
}
