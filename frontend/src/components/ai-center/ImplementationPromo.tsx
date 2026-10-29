import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { AI_AGENTS, AI_IMPLEMENTATION } from '@/lib/ai-center/agents';
import { AgentPortrait } from './AgentPortrait';

/** The animals that front the done-for-you card: a mix of sales, marketing and books. */
const CLUSTER_IDS = ['jordan', 'spider', 'ruby', 'naomi'] as const;
const CLUSTER = CLUSTER_IDS.map((id) => AI_AGENTS.find((a) => a.id === id)).filter(
  (a): a is (typeof AI_AGENTS)[number] => !!a,
);

/**
 * The pinned "done-for-you" services card at the top of the catalog (redesign D6): a light card
 * with a small group of the animals, the offer, and "Book a call".
 */
export function ImplementationPromo({
  onBook,
  animate = true,
}: {
  onBook: () => void;
  /** Let the animals play their loops (off while a modal covers the catalog). */
  animate?: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-card border border-border bg-ai-50 p-4 sm:flex-row sm:items-center sm:gap-5 sm:px-5">
      <div className="flex shrink-0" aria-hidden>
        {CLUSTER.map((a, i) => (
          <AgentPortrait
            key={a.id}
            agentId={a.id}
            name={a.name}
            size={52}
            zoom={1.35}
            animate={animate}
            decorative
            className={i === 0 ? 'shadow-soft ring-2 ring-surface-light' : '-ml-3.5 shadow-soft ring-2 ring-surface-light'}
          />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <Heading level={3} scale="base" weight="bold">
          {AI_IMPLEMENTATION.title}
        </Heading>
        <p className="mt-0.5 max-w-[62ch] text-[13.5px] leading-normal text-text-secondary">
          {AI_IMPLEMENTATION.description}
        </p>
      </div>
      <Button variant="outline" className="shrink-0" onClick={onBook}>
        Book a call
      </Button>
    </div>
  );
}
