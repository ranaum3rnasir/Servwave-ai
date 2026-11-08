import { ArrowRight } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import type { AIAgent } from '@/lib/ai-center/agents';
import { comingSoonPillCls } from './comingSoonPill';

interface AgentCardProps {
  agent: AIAgent;
  onClick: () => void;
}

/** A single agent in the catalog grid. The whole card opens the detail modal. */
export function AgentCard({ agent, onClick }: AgentCardProps) {
  const isSpider = agent.id === 'spider' || agent.name.toLowerCase() === 'spider';

  return (
    // Agent card: rich structured content (avatar, name, description) - a
    // grid-tile click target, not Button-shaped. Deferred.
    <button
      type="button"
      onClick={onClick}
      className="group relative flex h-full flex-col rounded-card border border-border bg-surface-light p-4 text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-ai-200 hover:shadow-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai-500 focus-visible:ring-offset-2"
    >
      {agent.isNew && (
        <span className="absolute right-3 top-3 rounded-full border border-ai-200 bg-ai-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ai-600">
          New
        </span>
      )}

      <div className="flex items-center gap-3">
        <Avatar ring="stack" className="h-12 w-12 shrink-0">
          {agent.image && (
            <AvatarImage
              src={agent.image}
              alt={agent.name}
              loading="lazy"
              decoding="async"
              className="object-cover"
            />
          )}
          <AvatarFallback
            tone="custom"
            style={{ backgroundColor: agent.avatarColor }}
          >
            {agent.name[0]}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate font-bold text-text-primary">{agent.name}</p>
          <p className="truncate text-xs font-semibold uppercase tracking-wide text-ai-600">
            {agent.role}
          </p>
        </div>
      </div>

      {!isSpider && (
        <span className={cn(comingSoonPillCls, 'mt-2 w-fit')}>
          Coming soon
        </span>
      )}

      <p className="mt-2 line-clamp-3 flex-1 text-sm leading-relaxed text-text-secondary">
        {agent.shortDescription}
      </p>

      <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-text-soft transition-colors group-hover:text-ai-600">
        Learn more
        <ArrowRight aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );
}

