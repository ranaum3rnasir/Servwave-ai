import { cn } from '@/lib/utils';

export type AgentChipState = 'on' | 'off' | 'coming_soon';

const CHIP: Record<AgentChipState, { label: string; cls: string; dot: string }> = {
  on: { label: 'On', cls: 'border-success-border bg-success-surface text-success-text', dot: 'bg-success' },
  off: { label: 'Off', cls: 'border-neutral-border bg-neutral-surface text-neutral-text', dot: 'bg-text-soft' },
  coming_soon: { label: 'Coming soon', cls: 'border-ai-200 bg-ai-50 text-ai-text', dot: 'bg-ai-600' },
};

/**
 * A read-only status chip: "On", "Off" or "Coming soon". It never links anywhere and never acts:
 * someone who may switch an agent gets the switch itself instead. Which state an agent is in comes
 * from useAgentStatus, never from the call site.
 */
export function AgentStatusChip({ state }: { state: AgentChipState }) {
  const { label, cls, dot } = CHIP[state];
  return (
    <span
      data-agent-chip={state}
      className={cn(
        'inline-flex h-[26px] w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-xs font-bold',
        cls,
      )}
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dot)} />
      {label}
    </span>
  );
}
