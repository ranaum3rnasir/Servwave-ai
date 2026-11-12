import { useRef } from 'react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { agentDisplayRole, type AIAgent } from '@/lib/ai-center/agents';
import { worksWithFor } from '@/lib/ai-center/worksWith';
import { NOT_AVAILABLE_COPY, useAgentStatus, useAgentDeactivateControl } from '@/lib/ai-center/agentStatus';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { AgentVideoSlot } from './AgentVideoSlot';
import { AgentPortrait } from './AgentPortrait';
import { AgentNameTag } from './AgentCard';
import { AgentStatusChip } from './AgentStatusChip';
import { AgentFooter, AgentStatusRow } from './AgentControls';

interface AgentDetailModalProps {
  agent: AIAgent | null;
  onOpenChange: (open: boolean) => void;
  onBook: (agent: AIAgent) => void;
}

/**
 * Modal-on-modal: one agent's portrait, status, video slot, tagline, story, and the agents and
 * ServWave modules it works with. The 29 Sep redesign (direction B, compact, white), with the
 * controls of mockup M1 (Ran, 10 Nov): for an agent on this company's account, a status row
 * (Not active / Active) under the header and, for someone who may manage it, a footer with the way
 * to its page (and Deactivate while Active); for a released agent it does not have, a row that says
 * so and a booking call to turn it on; for every other agent, "Coming soon" and a booking call.
 */
export function AgentDetailModal({ agent, onOpenChange, onBook }: AgentDetailModalProps) {
  // The status, Deactivate and the footer all come from the agent registry
  // (lib/ai-center/agentStatus.ts), never from here.
  const status = useAgentStatus(agent?.id);
  const control = useAgentDeactivateControl(agent?.id);
  const comingSoon = status.status === 'coming_soon';
  // Released, but not on this company's account (layer 1): a row that says so, and a booking call.
  const notAvailable = status.status === 'not_available';
  // Someone who may not manage an agent on the account gets no footer: the status without the buttons.
  const hasFooter = comingSoon || notAvailable || (status.canManage && !!status.managePath);
  const headerRef = useRef<HTMLDivElement>(null);
  // A "Works with" chip opens that agent through the catalog's own deep link (the path the job
  // page's AI tiles take), so the catalog stays the one owner of which agent is open.
  const openAgent = useAiCenterStore((s) => s.openModal);

  const works = agent ? worksWithFor(agent) : null;
  const [intro, ...points] = agent?.longDescription ?? [];

  return (
    <Dialog open={!!agent} onOpenChange={onOpenChange}>
      <DialogContent
        intent="content"
        layout="own"
        overlayClassName="bg-ocean-900/40"
        className="flex w-[94vw] max-w-[720px] flex-col gap-0 overflow-hidden p-0"
        // Open on the header (the agent's name and role), not on the first control, which a stray
        // Space would press. Not on the frame either, which would draw a focus ring round the whole
        // pop-up.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          headerRef.current?.focus({ preventScroll: true });
        }}
      >
        {agent && works && (
          <>
            <VisuallyHidden>
              <DialogDescription>{agent.shortDescription}</DialogDescription>
            </VisuallyHidden>

            {/* Header */}
            <div
              ref={headerRef}
              tabIndex={-1}
              data-agent-detail-header
              className="flex shrink-0 items-center gap-4 pb-3 pl-4 pr-14 outline-none pt-[max(1rem,calc(env(safe-area-inset-top)+0.75rem))] sm:pb-4 sm:pl-6 sm:pt-5">
              {/* The same animated portrait as the agent's card. Decorative: the name is beside it. */}
              <AgentPortrait agentId={agent.id} name={agent.name} size={64} decorative className="ring-1 ring-border" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                  <DialogTitle asChild>
                    <Heading level={2} scale="xl" weight="bold">
                      {agent.name}
                    </Heading>
                  </DialogTitle>
                  {agent.isNew && <AgentNameTag>New</AgentNameTag>}
                </div>
                <p className="mt-0.5 text-sm font-medium text-text-secondary">{agentDisplayRole(agent.role)}</p>
                {comingSoon && (
                  <div data-agent-status="coming_soon" className="mt-2 flex">
                    <AgentStatusChip state="coming_soon" />
                  </div>
                )}
              </div>
            </div>

            {/* Body. Keyed by agent so a "Works with" chip lands at the top of the next agent. */}
            <div
              key={agent.id}
              data-testid="agent-detail-body"
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5 sm:px-6 sm:pb-6"
            >
              {!comingSoon && <AgentStatusRow agent={agent} status={status} />}
              <AgentVideoSlot agent={agent} />

              <p className="mb-2 mt-5 text-lg font-bold leading-snug tracking-tight text-text-primary sm:mt-6 sm:text-[19px]">
                {agent.tagline}
              </p>
              {intro && (
                <p className="mb-3.5 max-w-[68ch] text-[15px] leading-relaxed text-text-secondary">{intro}</p>
              )}
              {points.length > 0 && (
                <ul className="grid gap-2.5">
                  {points.map((line, i) => (
                    <li key={i} className="relative max-w-[70ch] pl-[18px] text-sm leading-relaxed text-text-secondary">
                      <span aria-hidden className="absolute left-0.5 top-[0.62em] size-1.5 rounded-full bg-ai-500" />
                      {line}
                    </li>
                  ))}
                </ul>
              )}

              {(works.agents.length > 0 || works.modules.length > 0) && (
                <section aria-labelledby={`works-with-${agent.id}`} className="mt-6">
                  <Heading level={3} scale="sm" weight="bold" id={`works-with-${agent.id}`}>
                    Works with
                  </Heading>
                  {works.agents.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Agents">
                      {works.agents.map((other) => (
                        <li key={other.id}>
                          {/* Pill chip with a portrait: Button has no pill shape, and a radius at
                              the call site is the appearance override the layering guard bans. Deferred. */}
                          <button
                            type="button"
                            onClick={() => openAgent(other.id)}
                            className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-light py-1 pl-1 pr-3 text-[13px] font-semibold text-text-primary transition-colors hover:border-ai-200 hover:bg-ai-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ai-500 focus-visible:ring-offset-2"
                          >
                            {/* Still at chip size: the header and the slot already move. */}
                            <AgentPortrait agentId={other.id} name={other.name} size={26} animate={false} decorative />
                            {other.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {works.modules.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-2" aria-label="ServWave modules">
                      {works.modules.map(({ key, label, icon: Icon }) => (
                        <li
                          key={key}
                          className="inline-flex items-center gap-1.5 rounded-full bg-background-light px-3 py-1 text-[13px] font-medium text-text-secondary"
                        >
                          <Icon aria-hidden className="size-3.5 shrink-0 text-text-soft" />
                          {label}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </div>

            {/* Footer CTA */}
            {hasFooter && (
              <div className="shrink-0 border-t border-border bg-surface-light px-4 py-3 pb-[max(0.75rem,var(--safe-bottom,0px))] sm:px-6 sm:py-3.5">
                {comingSoon || notAvailable ? (
                  <div className="flex gap-2.5">
                    <DialogClose asChild>
                      <Button variant="outline" tone="neutral">
                        Close
                      </Button>
                    </DialogClose>
                    <Button variant="solid" tone="ai" className="min-w-0 flex-1" onClick={() => onBook(agent)}>
                      <span className="truncate">{notAvailable ? NOT_AVAILABLE_COPY.book : `Book a call about ${agent.name}`}</span>
                    </Button>
                  </div>
                ) : (
                  <AgentFooter agent={agent} status={status} control={control} onClose={() => onOpenChange(false)} />
                )}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
