import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Search } from 'lucide-react';
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
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { AgentCard } from './AgentCard';
import { ImplementationPromo } from './ImplementationPromo';
import { AgentDetailModal } from './AgentDetailModal';
import { BookingModal, type BookingTarget } from './BookingModal';

type Filter = 'all' | AICategoryKey;

const navItemCls =
  'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors';
const navItemActive = 'bg-ai-50 text-ai-600 font-semibold';
const navItemIdle = 'text-text-secondary hover:bg-background-light hover:text-text-primary';
const countCls = 'rounded-full bg-background-light px-1.5 py-0.5 text-[11px] font-semibold text-text-soft';
const chipCls = 'shrink-0 rounded-full border px-3 py-1 text-xs font-semibold transition-colors';
const chipActive = 'border-ai-600 bg-ai-600 text-on-fill';
const chipIdle = 'border-border bg-surface-light text-text-secondary';

/** The AI Agentic Farm — near-fullscreen catalog of all AI agents. */
export function AiCenterModal() {
  const navigate = useNavigate();
  const open = useAiCenterStore((s) => s.open);
  const setOpen = useAiCenterStore((s) => s.setOpen);
  const focusAgentId = useAiCenterStore((s) => s.focusAgentId);
  const clearFocusAgent = useAiCenterStore((s) => s.clearFocusAgent);

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [detailAgent, setDetailAgent] = useState<AIAgent | null>(null);
  const [bookingTarget, setBookingTarget] = useState<BookingTarget | null>(null);

  // Deep-link: when opened with a focus agent (e.g. from the job AI assistant
  // tiles), jump straight to that agent's detail view, then clear the flag.
  useEffect(() => {
    if (!open || !focusAgentId) return;
    const agent = AI_AGENTS.find((a) => a.id === focusAgentId);
    if (agent) setDetailAgent(agent);
    clearFocusAgent();
  }, [open, focusAgentId, clearFocusAgent]);

  function handleAgentClick(a: AIAgent) {
    setDetailAgent(a);
  }

  const q = search.trim().toLowerCase();

  const sections = useMemo(() => {
    const match = (a: AIAgent) => !q || `${a.name} ${a.role}`.toLowerCase().includes(q);
    const cats =
      filter === 'all' ? AI_CATEGORIES : AI_CATEGORIES.filter((c) => c.key === filter);
    return cats
      .map((c) => ({ cat: c, agents: AI_AGENTS.filter((a) => a.category === c.key && match(a)) }))
      .filter((s) => s.agents.length > 0);
  }, [filter, q]);

  function bookAgent(a: AIAgent) {
    setDetailAgent(null);
    setBookingTarget({ name: a.name, role: a.role, initial: a.name.charAt(0), color: a.avatarColor });
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
        <DialogContent className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden p-0 sm:h-[92vh] sm:w-[96vw] sm:max-w-[1240px]">
          <VisuallyHidden>
            <DialogTitle>AI Agentic Farm</DialogTitle>
            <DialogDescription>
              Browse ServWave AI agents by category and book a call.
            </DialogDescription>
          </VisuallyHidden>

          {/* Header */}
          <div className="flex items-center gap-3 border-b border-border bg-surface-light px-6 py-4 pr-14">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-ai-600 to-ai-500 text-on-fill">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              {/* leading-tight dropped: no Heading prop carries line-height, and the
                  className residual must stay layout-only for the layering guard. */}
              <Heading level={2} scale="lg" weight="bold">
                AI Agentic Farm
              </Heading>
              <p className="text-xs text-text-secondary">
                {AI_AGENT_COUNT} AI agents in development. Browse them all and book a call.
              </p>
            </div>
          </div>

          {/* Body */}
          <div className="flex min-h-0 flex-1">
            {/* Left sub-nav (desktop) */}
            <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface-light md:flex">
              <div className="p-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-soft" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search AI agents…"
                    aria-label="Search AI agents"
                    className="w-full rounded-sm border border-border bg-surface-light py-2 pl-9 pr-3 text-sm outline-none placeholder:text-text-soft focus-visible:ring-2 focus-visible:ring-ai-500 focus-visible:ring-offset-2"
                  />
                </div>
              </div>
              <nav className="flex-1 overflow-y-auto px-3 pb-4">
                {/* Sidebar nav-list item (segmented toggle) - not Button-shaped. Deferred. */}
                <button
                  onClick={() => setFilter('all')}
                  className={cn(navItemCls, filter === 'all' ? navItemActive : navItemIdle)}
                >
                  <span>All AI agents</span>
                  <span className={countCls}>{AI_AGENT_COUNT}</span>
                </button>

                <p className="mb-1 mt-4 px-2 text-[11px] font-bold uppercase tracking-widest text-text-soft">
                  Browse by category
                </p>
                {AI_CATEGORIES.map((c) => {
                  const n = AI_AGENTS.filter((a) => a.category === c.key).length;
                  const Icon = c.icon;
                  return (
                    // Sidebar nav-list item (segmented toggle) - not Button-shaped. Deferred.
                    <button
                      key={c.key}
                      onClick={() => setFilter(c.key)}
                      className={cn(navItemCls, filter === c.key ? navItemActive : navItemIdle)}
                    >
                      <span className="flex items-center gap-2">
                        <Icon className="h-3.5 w-3.5 shrink-0 text-ai-600" />
                        {c.label}
                      </span>
                      <span className={countCls}>{n}</span>
                    </button>
                  );
                })}

                <p className="mb-1 mt-4 px-2 text-[11px] font-bold uppercase tracking-widest text-text-soft">
                  Pro services
                </p>
                {/* Sidebar nav-list item (shares navItemCls/navItemIdle with the
                    toggle items above) - not Button-shaped. Deferred. */}
                <button onClick={bookImplementation} className={cn(navItemCls, navItemIdle)}>
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-ai-600" />
                    AI Specialist Implementation
                  </span>
                </button>
              </nav>
            </aside>

            {/* Content */}
            <div className="min-w-0 flex-1 overflow-y-auto p-5 sm:p-6">
              {/* Mobile category chips */}
              <div className="mb-4 flex gap-2 overflow-x-auto pb-1 md:hidden">
                {/* Mobile category filter chip (segmented toggle) - not Button-shaped. Deferred. */}
                <button
                  onClick={() => setFilter('all')}
                  className={cn(chipCls, filter === 'all' ? chipActive : chipIdle)}
                >
                  All
                </button>
                {AI_CATEGORIES.map((c) => {
                  const Icon = c.icon;
                  return (
                    // Mobile category filter chip (segmented toggle) - not Button-shaped. Deferred.
                    <button
                      key={c.key}
                      onClick={() => setFilter(c.key)}
                      className={cn(chipCls, 'flex items-center gap-1.5', filter === c.key ? chipActive : chipIdle)}
                    >
                      <Icon className="h-3.5 w-3.5 shrink-0" />
                      {c.label}
                    </button>
                  );
                })}
              </div>

              <ImplementationPromo onBook={bookImplementation} />

              {sections.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-light text-text-soft shadow-card">
                    <Search className="h-5 w-5" />
                  </span>
                  <p className="text-sm text-text-secondary">No agents match “{search}”.</p>
                </div>
              ) : (
                <div className="space-y-8">
                  {sections.map(({ cat, agents }) => (
                    <section key={cat.key}>
                      <div className="mb-3">
                        <Heading level={3} scale="base" weight="bold" className="flex items-center gap-2">
                          <cat.icon className="h-4 w-4 shrink-0 text-ai-600" />
                          {cat.label} <span className="text-text-soft">· {agents.length}</span>
                        </Heading>
                        <p className="text-xs text-text-secondary">{cat.sub}</p>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {agents.map((a) => (
                          <AgentCard key={a.id} agent={a} onClick={() => handleAgentClick(a)} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
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
