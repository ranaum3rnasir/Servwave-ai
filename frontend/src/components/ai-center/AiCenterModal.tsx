import { useEffect, useMemo, useRef, useState } from 'react';
import { LayoutGrid, Search, Sparkles } from 'lucide-react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Heading } from '@/components/ui/heading';
import { cn } from '@/lib/utils';
import {
  AI_AGENTS,
  AI_CATEGORIES,
  AI_AGENT_COUNT,
  AI_IMPLEMENTATION,
  type AIAgent,
  type AICategoryKey,
} from '@/lib/ai-center/agents';
import { agentReleased, useAccessibleAgentIds } from '@/lib/ai-center/agentStatus';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { AgentCard } from './AgentCard';
import { ImplementationPromo } from './ImplementationPromo';
import { AgentDetailModal } from './AgentDetailModal';
import { BookingModal, type BookingTarget } from './BookingModal';
import { fieldKindProps } from '@/ui-kit/lib/fieldKind';

type Filter = 'all' | AICategoryKey;

const railItemCls =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai-500 focus-visible:ring-offset-2';
const railItemActive = 'bg-ai-50 font-semibold text-ai-text';
const railItemIdle = 'font-medium text-text-secondary hover:bg-background-light hover:text-text-primary';
const chipCls =
  'shrink-0 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai-500 focus-visible:ring-offset-2';
const chipActive = 'border-ai-200 bg-ai-50 text-ai-text';
const chipIdle = 'border-border bg-surface-light text-text-secondary';

/** The AI Agentic Farm: near-fullscreen catalog of all AI agents (redesign B, Compact). */
export function AiCenterModal() {
  const open = useAiCenterStore((s) => s.open);
  const setOpen = useAiCenterStore((s) => s.setOpen);
  const focusAgentId = useAiCenterStore((s) => s.focusAgentId);
  const clearFocusAgent = useAiCenterStore((s) => s.clearFocusAgent);

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [detailAgent, setDetailAgent] = useState<AIAgent | null>(null);
  const [bookingTarget, setBookingTarget] = useState<BookingTarget | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // "Coming soon" counts the agents this company cannot use and that are not released yet (a
  // released agent it does not have is not "coming"); "All AI agents" stays the total.
  const accessibleAgentIds = useAccessibleAgentIds();
  const comingSoon = AI_AGENTS.filter((a) => !accessibleAgentIds.includes(a.id) && !agentReleased(a.id)).length;

  // Deep-link: when opened with a focus agent (e.g. from the job AI assistant
  // tiles), jump straight to that agent's detail view, then clear the flag.
  useEffect(() => {
    if (!open || !focusAgentId) return;
    const agent = AI_AGENTS.find((a) => a.id === focusAgentId);
    if (agent) setDetailAgent(agent);
    clearFocusAgent();
  }, [open, focusAgentId, clearFocusAgent]);

  const q = search.trim().toLowerCase();

  const sections = useMemo(() => {
    const match = (a: AIAgent) => !q || `${a.name} ${a.role}`.toLowerCase().includes(q);
    const cats =
      filter === 'all' ? AI_CATEGORIES : AI_CATEGORIES.filter((c) => c.key === filter);
    return cats
      .map((c) => ({ cat: c, agents: AI_AGENTS.filter((a) => a.category === c.key && match(a)) }))
      .filter((s) => s.agents.length > 0);
  }, [filter, q]);

  // The grid goes back to stills while a modal covers it: nothing behind an overlay animates.
  const animate = !detailAgent && !bookingTarget;

  function pickFilter(next: Filter) {
    setFilter(next);
    contentRef.current?.scrollTo?.({ top: 0 });
  }
  function bookAgent(a: AIAgent) {
    setDetailAgent(null);
    setBookingTarget({
      agentId: a.id,
      name: a.name,
      role: a.role,
      initial: a.name.charAt(0),
      color: a.avatarColor,
    });
  }
  function bookImplementation() {
    setBookingTarget({
      name: AI_IMPLEMENTATION.title,
      role: AI_IMPLEMENTATION.kicker,
      initial: AI_IMPLEMENTATION.initial,
      color: AI_IMPLEMENTATION.color,
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent intent="content" layout="own" className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none bg-surface-light p-0 sm:h-[92dvh] sm:w-[96vw] sm:max-w-[1240px]">
          <VisuallyHidden>
            <DialogDescription>
              Browse ServWave AI agents by category and book a call.
            </DialogDescription>
          </VisuallyHidden>

          {/* Header: the title, the one status line, and search */}
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-4 pb-4 pt-[max(1rem,calc(env(safe-area-inset-top)+0.75rem))] md:flex-nowrap md:gap-4 md:px-6 md:pb-5 md:pr-14 md:pt-5">
            <div className="min-w-0 flex-1 pr-10 md:pr-0">
              {/* leading-tight dropped: no Heading prop carries line-height, and the
                  className residual must stay layout-only for the layering guard. */}
              <DialogTitle asChild>
                <Heading level={2} scale="xl" weight="bold">
                  AI Agentic Farm
                </Heading>
              </DialogTitle>
              <p className="mt-1 text-[13.5px] leading-snug text-text-secondary">
                {comingSoon} AI agents coming soon. Meet them, and book a call to be first in line.
              </p>
            </div>
            <div className="relative order-last w-full md:order-none md:w-72 md:shrink-0">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-soft" />
              <input
                {...fieldKindProps('search')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agents"
                aria-label="Search agents"
                className="w-full rounded-md border border-border bg-surface-light py-2 pl-9 pr-3 text-sm mobile:!text-base outline-none placeholder:text-text-soft focus-visible:border-ai-500 focus-visible:ring-2 focus-visible:ring-ai-500/20"
              />
            </div>
          </div>

          {/* Body */}
          <div className="flex min-h-0 flex-1">
            {/* Category rail (desktop) */}
            <nav
              aria-label="Categories"
              className="hidden w-[232px] shrink-0 flex-col gap-0.5 overflow-y-auto overscroll-contain border-r border-border px-3 py-4 md:flex"
            >
              {/* Sidebar nav-list item (segmented toggle) - not Button-shaped. Deferred. */}
              <button
                type="button"
                onClick={() => pickFilter('all')}
                aria-current={filter === 'all' ? 'true' : undefined}
                className={cn(railItemCls, filter === 'all' ? railItemActive : railItemIdle)}
              >
                <LayoutGrid className={cn('h-4 w-4 shrink-0', filter === 'all' ? 'text-ai-text' : 'text-text-soft')} />
                <span className="min-w-0 flex-1 truncate">All agents</span>
                <span className="text-[12.5px] tabular-nums">{AI_AGENT_COUNT}</span>
              </button>

              <div className="mx-2.5 my-3 h-px bg-border" />
              <p className="px-2.5 pb-1.5 pt-1 text-[12.5px] font-semibold text-text-secondary">Categories</p>
              {AI_CATEGORIES.map((c) => {
                const n = AI_AGENTS.filter((a) => a.category === c.key).length;
                const Icon = c.icon;
                const active = filter === c.key;
                return (
                  // Sidebar nav-list item (segmented toggle) - not Button-shaped. Deferred.
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => pickFilter(c.key)}
                    aria-current={active ? 'true' : undefined}
                    className={cn(railItemCls, active ? railItemActive : railItemIdle)}
                  >
                    <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-ai-text' : 'text-text-soft')} />
                    <span className="min-w-0 flex-1 truncate">{c.label}</span>
                    <span className="text-[12.5px] tabular-nums">{n}</span>
                  </button>
                );
              })}

              <div className="mx-2.5 my-3 h-px bg-border" />
              {/* Sidebar nav-list item (shares railItemCls/railItemIdle with the
                  toggle items above) - not Button-shaped. Deferred. */}
              <button type="button" onClick={bookImplementation} className={cn(railItemCls, railItemIdle)}>
                <Sparkles className="h-4 w-4 shrink-0 text-text-soft" />
                <span className="min-w-0 flex-1 truncate">AI specialist setup</span>
              </button>
            </nav>

            {/* Content */}
            <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 md:p-6">
              {/* Phone category chips */}
              <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:hidden">
                {/* Mobile category filter chip (segmented toggle) - not Button-shaped. Deferred. */}
                <button
                  type="button"
                  onClick={() => pickFilter('all')}
                  aria-pressed={filter === 'all'}
                  className={cn(chipCls, filter === 'all' ? chipActive : chipIdle)}
                >
                  All
                </button>
                {AI_CATEGORIES.map((c) => (
                  // Mobile category filter chip (segmented toggle) - not Button-shaped. Deferred.
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => pickFilter(c.key)}
                    aria-pressed={filter === c.key}
                    className={cn(chipCls, filter === c.key ? chipActive : chipIdle)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <ImplementationPromo onBook={bookImplementation} animate={animate} />

              {sections.length === 0 ? (
                <p className="py-16 text-center text-sm text-text-secondary">
                  No agents match “{search.trim()}”.
                </p>
              ) : (
                sections.map(({ cat, agents }) => (
                  <section key={cat.key} className="mt-7" aria-labelledby={`ai-farm-cat-${cat.key}`}>
                    <Heading
                      level={3}
                      scale="base"
                      weight="bold"
                      id={`ai-farm-cat-${cat.key}`}
                      className="flex items-baseline gap-2"
                    >
                      {cat.label}
                      <span className="text-sm font-medium tabular-nums text-text-secondary">
                        {agents.length}
                      </span>
                    </Heading>
                    <p className="mb-3.5 mt-0.5 text-[13px] text-text-secondary">{cat.sub}</p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {agents.map((a) => (
                        <AgentCard
                          key={a.id}
                          agent={a}
                          animate={animate}
                          onClick={() => setDetailAgent(a)}
                        />
                      ))}
                    </div>
                  </section>
                ))
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AgentDetailModal
        agent={detailAgent}
        onOpenChange={(o) => !o && setDetailAgent(null)}
        onBook={bookAgent}
      />
      <BookingModal target={bookingTarget} onOpenChange={(o) => !o && setBookingTarget(null)} />
    </>
  );
}
