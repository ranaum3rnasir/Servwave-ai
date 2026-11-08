import { Sparkles, ArrowRight, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { AI_AGENTS, type AIAgent } from '@/lib/ai-center/agents';
import { useAiCenterStore } from '@/stores/aiCenterStore';

// The job AI assistant doesn't run on its own — it's a launch pad into the AI
// Farm. Each tile is a real agent from the catalog, paired with a
// job-contextual suggestion; clicking deep-links straight to that agent's
// detail view, where the user can book a call. Keep these ids in sync with
// `@/lib/ai-center/agents`.

export interface JobAssistantContext {
  /** e.g. "J00051" — falls back to "this job" when absent. */
  jobNumber?: string | null;
  /** Display name of the customer — falls back to "the customer". */
  customerName?: string | null;
  /** The job type / service, e.g. "Access Control Installation". */
  service?: string | null;
  /** Job status (UNSCHEDULED · SCHEDULED · IN_PROGRESS · COMPLETED · …). */
  status?: string | null;
}

export interface JobAgentTile {
  id: string;
  prompt: string;
}

/**
 * Build the five agent suggestions for a specific job. Pure + fully guarded so
 * the bar reads differently per job (job number, customer, service, stage)
 * while still rendering sensible copy when context is missing.
 */
export function buildJobAgentTiles(ctx: JobAssistantContext = {}): JobAgentTile[] {
  const jobLabel = ctx.jobNumber?.trim() || 'this job';
  const customer = ctx.customerName?.trim() || 'the customer';
  const service = ctx.service?.trim() ? ctx.service.trim().toLowerCase() : null;
  const isDone = ctx.status === 'COMPLETED';

  return [
    {
      id: 'carlos',
      prompt: isDone
        ? `Audit ${jobLabel}'s photos, signatures & line items before you invoice ${customer}.`
        : `Pre-check ${jobLabel}'s photos & line items so it's invoice-ready.`,
    },
    { id: 'hannah', prompt: `Check parts & truck stock for ${jobLabel} before the crew rolls.` },
    { id: 'mike', prompt: `Suggest a tech for ${jobLabel} without double-booking the crew.` },
    {
      id: 'emily',
      prompt: service
        ? `Suggest a service plan or add-on for ${customer} after this ${service}.`
        : `Suggest a service plan or add-on for ${customer}.`,
    },
    { id: 'iris', prompt: `Summarize every call & note logged on ${jobLabel}.` },
  ];
}

export function AiJobAssistantBar(ctx: JobAssistantContext = {}) {
  const openModal = useAiCenterStore((s) => s.openModal);
  const jobLabel = ctx.jobNumber?.trim() || 'this job';

  const tiles = buildJobAgentTiles(ctx)
    .map((t) => {
      const agent = AI_AGENTS.find((a) => a.id === t.id);
      return agent ? { agent, prompt: t.prompt } : null;
    })
    .filter(Boolean) as Array<{ agent: AIAgent; prompt: string }>;

  return (
    <div className="rounded-card border border-ai-600/20 bg-gradient-to-b from-surface-light to-ai-600/[0.05] shadow-card p-5">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ai-600/10">
            <Sparkles className="h-5 w-5 text-ai-600" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Heading level={3} scale="base">AI Job Assistant</Heading>
              <span className="rounded-full bg-ai-600/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-ai-600">
                Coming soon
              </span>
            </div>
            <p className="mt-0.5 text-xs text-text-secondary">
              Meet the AI agents that work {jobLabel}
            </p>
          </div>
        </div>
        <Button
          variant="solid" tone="ai"
          size="sm"
          className="hidden sm:inline-flex"
          onClick={() => openModal()}
        >
          Browse all AI agents <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Agent tiles — each deep-links into the AI Agentic Farm to book a call */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map(({ agent, prompt }) => (
          // Left raw: a whole agent tile (avatar + name/role + prompt copy) is a
          // heterogeneous card click target, not Button-shaped.
          <button
            key={agent.id}
            type="button"
            onClick={() => openModal(agent.id)}
            className="group flex flex-col rounded-xl border border-ai-600/15 bg-surface-light/70 p-4 text-left transition-all hover:border-ai-600/40 hover:bg-surface-light hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai-500 focus-visible:ring-offset-2"
          >
            <div className="mb-2 flex items-center gap-2.5">
              <Avatar ring="ai" className="h-9 w-9 shrink-0">
                <AvatarImage src={agent.image} alt={agent.name} className="object-cover" />
                <AvatarFallback
                  tone="custom"
                  style={{ backgroundColor: agent.avatarColor }}
                  className="text-xs font-bold"
                >
                  {agent.name[0]}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-xs font-bold leading-tight text-text-primary">
                  {agent.name}
                </p>
                <p className="truncate text-[10px] font-semibold uppercase tracking-wide leading-tight text-ai-600">
                  {agent.role}
                </p>
              </div>
            </div>
            <p className="text-[11px] leading-snug text-text-secondary">{prompt}</p>
            <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-ai-600/70 transition-colors group-hover:text-ai-600">
              Meet {agent.name}
              <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
            </span>
          </button>
        ))}
      </div>

      {/* Ask bar — the conversational assistant itself is still in the works */}
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-ai-600/15 bg-surface-light/60 px-4 py-3">
        <Lock className="h-4 w-4 shrink-0 text-ai-600/60" />
        <span className="flex-1 text-sm text-text-secondary/70">Ask anything about {jobLabel}…</span>
        <span className="rounded-full bg-ai-600/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-ai-600">
          Soon
        </span>
      </div>

      <p className="mt-2 text-[11px] text-text-secondary/70">
        The conversational AI Job Assistant is coming soon. Click any agent to meet them in the{' '}
        {/* Left raw: idle text-ai-600, hover:underline - link/brand's hover:underline
            shape matches but its idle colour is text-primary, not the AI-surface
            text-ai-600 accent; no link/ai tone is minted. */}
        <button
          type="button"
          onClick={() => openModal()}
          className="font-semibold text-ai-600 hover:underline"
        >
          AI Agentic Farm
        </button>{' '}
        and book a call.
      </p>
    </div>
  );
}
