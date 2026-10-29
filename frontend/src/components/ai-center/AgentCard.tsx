import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { agentDisplayRole, type AIAgent } from '@/lib/ai-center/agents';
import { NOT_AVAILABLE_COPY, useAgentStatus, type AgentStatus } from '@/lib/ai-center/agentStatus';
import { AgentPortrait } from './AgentPortrait';

interface AgentCardProps {
  agent: AIAgent;
  onClick: () => void;
  /** Let the portrait play its idle loop (off while a modal covers the grid). */
  animate?: boolean;
}

/** A small mark next to the name: a dot plus one word ("New"). */
export function AgentNameTag({ children }: { children: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-bold text-ai-text">
      <span aria-hidden className="size-1.5 rounded-full bg-ai-600" />
      {children}
    </span>
  );
}

type StripTone = 'on' | 'off' | 'setup' | 'soon' | 'none';

const STRIP_TONE: Record<StripTone, { strip: string; text: string; dot: string }> = {
  on: { strip: 'bg-success-surface', text: 'text-success-text', dot: 'bg-success' },
  off: { strip: '', text: 'text-text-secondary', dot: 'bg-text-soft' },
  setup: { strip: '', text: 'text-warning-text', dot: 'bg-warning' },
  soon: { strip: '', text: 'text-ai-text', dot: 'bg-ai-600' },
  none: { strip: '', text: '', dot: '' },
};

/**
 * What the card's strip says, from the agent's status. The strip follows the switch: an agent that
 * is on before it is set up says so in amber, and an agent that is off is plainly "Off", set up or
 * not. Reading the switch claims nothing until it is read, and nothing at all when it cannot be.
 */
function stripFor({ status, isSetUp, copy }: AgentStatus): { tone: StripTone; words: string | null } {
  switch (status) {
    case 'coming_soon':
      return { tone: 'soon', words: 'Coming soon' };
    // Released, but not on this company's account: the same indigo as "Coming soon", and a way to add it.
    case 'not_available':
      return { tone: 'soon', words: NOT_AVAILABLE_COPY.card };
    case 'on':
      return isSetUp
        ? { tone: 'on', words: copy?.cardOn ?? 'On' }
        : { tone: 'setup', words: copy?.cardOnNotSetUp ?? 'On' };
    case 'off':
      return { tone: 'off', words: 'Off' };
    default:
      return { tone: 'none', words: null };
  }
}

/**
 * One agent in the catalog grid (redesign B, Compact, with the status strip of the 14 Oct controls
 * design, option B): the animated circle portrait, the name, the role without "AI", a three-line
 * blurb, and a strip along the card's foot that says where the agent stands ("Coming soon", or
 * On / Off (or On, not set up yet) for an agent this company can use). The whole card is ONE button that
 * opens the detail pop-up, so the strip holds no control of its own. Its status comes from
 * useAgentStatus, never from this card.
 */
export function AgentCard({ agent, onClick, animate = true }: AgentCardProps) {
  const agentStatus = useAgentStatus(agent.id);
  const { tone, words } = stripFor(agentStatus);
  const t = STRIP_TONE[tone];
  return (
    // Agent card: rich structured content (portrait, name, role, description, status strip) - a
    // grid-tile click target, not Button-shaped. Deferred.
    <button
      type="button"
      onClick={onClick}
      data-agent-card={agent.id}
      className="group relative flex h-full min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface-light p-4 pb-0 text-left shadow-soft transition-[transform,box-shadow,border-color] duration-200 ease-out hover:-translate-y-0.5 hover:border-ai-200 hover:shadow-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai-500 focus-visible:ring-offset-2 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
    >
      {/* Spans only: a <button> may hold phrasing content alone. */}
      <span data-agent-card-header className="flex min-w-0 items-center gap-3">
        <AgentPortrait
          agentId={agent.id}
          name={agent.name}
          size={48}
          animate={animate}
          decorative
          className="ring-1 ring-border"
        />
        <span data-agent-card-text className="block min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-[15px] font-bold leading-snug text-text-primary">
            <span className="truncate">{agent.name}</span>
            {agent.isNew && <AgentNameTag>New</AgentNameTag>}
          </span>
          <span className="block truncate text-[13px] font-medium text-text-secondary">{agentDisplayRole(agent.role)}</span>
        </span>
      </span>

      <span className="mb-3.5 mt-2.5 line-clamp-3 text-[13px] leading-normal text-text-secondary">
        {agent.shortDescription}
      </span>

      {/* The status strip: the card's full width along its foot, the same height in every state
          (a placeholder while the switch is read), so nothing moves when the answer arrives. */}
      <span
        data-agent-strip={agentStatus.status}
        data-agent-set-up={agentStatus.isSetUp}
        className={cn(
          '-mx-4 mt-auto flex min-h-[46px] items-center gap-2 border-t border-border pl-4 pr-2.5 transition-colors duration-200 motion-reduce:transition-none',
          t.strip,
          tone === 'on' && 'border-success-border',
        )}
      >
        {agentStatus.status === 'loading' ? (
          // The kit Skeleton is a <div>, which a <button> may not hold: the same placeholder, as a span.
          <span
            data-agent-strip-placeholder
            aria-hidden
            className="block h-3.5 w-28 animate-pulse rounded-full bg-background-light motion-reduce:animate-none"
          />
        ) : (
          words && (
            <span className={cn('flex min-w-0 flex-1 items-center gap-2 text-[13px] font-bold', t.text)}>
              <span aria-hidden className={cn('size-2 shrink-0 rounded-full', t.dot)} />
              <span className="truncate">{words}</span>
            </span>
          )
        )}
        <ChevronRight
          aria-hidden
          className="ml-auto size-4 shrink-0 text-text-soft transition-[transform,color] duration-200 group-hover:translate-x-0.5 group-hover:text-ai-text motion-reduce:transition-none"
        />
      </span>
    </button>
  );
}
