import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AI_IMPLEMENTATION } from '@/lib/ai-center/agents';

/** The pinned "done-for-you" services upsell at the top of the catalog. */
export function ImplementationPromo({ onBook }: { onBook: () => void }) {
  return (
    <div className="relative mb-6 overflow-hidden rounded-card bg-gradient-to-br from-ocean-900 to-ocean-800 p-5 ring-1 ring-ai-500/20">
      <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-ai-600/20 blur-2xl" />
      <div className="relative flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-ai-600/30 text-ai-200">
            <Sparkles className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-ai-50">
              {AI_IMPLEMENTATION.kicker}
            </p>
            {/* Raw h3, deferred: font-extrabold has no Heading weight (semibold/bold only);
                text-on-fill also has no matching Heading tone. */}
            <h3 className="text-base font-extrabold text-on-fill">{AI_IMPLEMENTATION.title}</h3>
            <p className="mt-1 max-w-md text-sm text-on-fill/70">{AI_IMPLEMENTATION.description}</p>
          </div>
        </div>
        <Button variant="solid" tone="ai" className="shrink-0" onClick={onBook}>
          Book a call
        </Button>
      </div>
    </div>
  );
}
