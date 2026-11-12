import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DialogClose } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { HelpIcon } from '@/components/permissions/HelpIcon';
import { cn } from '@/lib/utils';
import type { AIAgent } from '@/lib/ai-center/agents';
import { NOT_AVAILABLE_COPY, type AgentStatus, type AgentDeactivateControl } from '@/lib/ai-center/agentStatus';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { AgentStatusChip } from './AgentStatusChip';

/*
 * The detail pop-up's controls for an agent on this company's account (mockup M1, "AI Agentic Farm
 * card and pop-up", Ran 10 Nov): a status row under the header with the Not active / Active badge,
 * and the footer: Close and "Set up {name}" while Not active; Close, Deactivate and "Open {name}"
 * while Active. There is no switch: an agent is activated only on its own page, after its review.
 * Someone who may not manage the agent sees the status without the buttons. Nothing here names an
 * agent: the words come from the agent's registry entry and its catalog name.
 */

interface ControlsProps {
  agent: AIAgent;
  status: AgentStatus;
  control: AgentDeactivateControl;
}

const ROW = 'mb-4 flex items-center gap-2 rounded-[14px] border border-border bg-surface-light py-1.5 pl-3.5 pr-3';

/**
 * The pop-up's status row. Active or Not active as a badge (a polite live region, so a screen reader
 * hears the change after Deactivate), with the ? that says what Not active means for someone who
 * may activate it. A released agent the company does not have says so in two lines, as before.
 */
export function AgentStatusRow({ agent, status }: Omit<ControlsProps, 'control'>) {
  const detailId = useId();
  if (status.status === 'loading') {
    // The row's own shape and height, so nothing below it moves when the status is read.
    return (
      <div data-agent-control-row="loading" aria-hidden className={cn(ROW, 'min-h-[48px]')}>
        <Skeleton className="h-3.5 w-16" />
        <Skeleton className="ml-auto h-[26px] w-24 rounded-full" />
      </div>
    );
  }

  if (status.status === 'not_available') {
    // Exactly as before #3433 (the ticket keeps "Book a call to add it" agents as they were): its own padding and
    // transition, and the title as a polite live region.
    return (
      <div
        data-agent-control-row="not_available"
        className="mb-4 flex min-h-[58px] items-center gap-3 rounded-[14px] border border-border bg-surface-light py-1.5 pl-3.5 pr-1.5 transition-colors duration-200 motion-reduce:transition-none"
      >
        <div className="min-w-0 flex-1 py-1">
          <p role="status" className="text-[14.5px] font-bold leading-snug text-text-primary">
            {NOT_AVAILABLE_COPY.title(agent.name)}
          </p>
          <p id={detailId} className="text-pretty text-[12.5px] leading-snug text-text-secondary">
            {NOT_AVAILABLE_COPY.detail}
          </p>
        </div>
      </div>
    );
  }

  // Not read ("unknown"): claim nothing.
  if (status.status !== 'active' && status.status !== 'not_active') return null;

  const active = status.status === 'active';
  return (
    <div data-agent-control-row={active ? 'active' : 'not_active'} className={cn(ROW, 'min-h-[48px]')}>
      <span className="flex-1 text-sm font-bold text-text-primary">Status</span>
      <span role="status">
        <AgentStatusChip state={active ? 'active' : 'not_active'} />
      </span>
      {!active && status.canManage && status.copy && <HelpIcon label="Not active" text={status.copy.notActiveHelp} />}
    </div>
  );
}

/**
 * "Deactivate {name}?", asked before Deactivate on the agent's page (#3432) and in the AI Agentic
 * Farm pop-up (#3433), Ran 10 Nov Q3 A: one question for both. The agent's own words for what
 * Deactivate does and keeps, "Keep it active" and "Deactivate".
 */
export function DeactivateConfirm({
  name,
  warning,
  open,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  warning: readonly string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      alert
      open={open}
      onOpenChange={onOpenChange}
      tone="danger"
      title={`Deactivate ${name}?`}
      description={warning.map((p, i) => (
        <span key={i} className={cn('block', i > 0 && 'mt-2')}>
          {p}
        </span>
      ))}
      cancelLabel="Keep it active"
      confirmLabel="Deactivate"
      onConfirm={onConfirm}
    />
  );
}

/**
 * The footer for an agent on this company's account, for someone who may manage it: Close and
 * "Set up {name}" while Not active; Close, Deactivate (asked first, with the same question as the
 * agent's page) and "Open {name}" while Active. Both "Set up" and "Open" go to the agent's page,
 * where Activate lives. Everyone else gets no footer: the tag and the status, without the buttons.
 */
export function AgentFooter({ agent, status, control, onClose }: ControlsProps & { onClose: () => void }) {
  const navigate = useNavigate();
  const closeCatalog = useAiCenterStore((s) => s.setOpen);
  const [confirmOff, setConfirmOff] = useState(false);

  if (!status.canManage || !status.managePath) return null;
  const managePath = status.managePath;

  const openPage = () => {
    onClose();
    closeCatalog(false);
    navigate(managePath);
  };

  const close = (
    <DialogClose asChild>
      <Button variant="outline" tone="neutral">
        Close
      </Button>
    </DialogClose>
  );

  if (status.status === 'loading') {
    return (
      <div className="flex gap-2.5">
        {close}
        <Skeleton data-agent-footer-placeholder className="h-10 min-w-0 flex-1" />
      </div>
    );
  }

  const active = status.status === 'active';
  const deactivate = control.setActive;
  // Not active: "Set up". Active, or a status that could not be read: "Open" (the page shows the real state).
  const pageLabel = status.status === 'not_active' ? `Set up ${agent.name}` : `Open ${agent.name}`;

  return (
    <div className="flex gap-2.5">
      {close}
      {active && deactivate && (
        <>
          <Button
            variant="outline"
            tone="danger"
            disabled={control.saving}
            onClick={() => setConfirmOff(true)}
          >
            Deactivate
          </Button>
          <DeactivateConfirm
            name={agent.name}
            warning={status.copy?.deactivateWarning ?? []}
            open={confirmOff}
            onOpenChange={setConfirmOff}
            onConfirm={() => {
              setConfirmOff(false);
              deactivate(false);
            }}
          />
        </>
      )}
      <Button variant="solid" tone="ai" className="min-w-0 flex-1" onClick={openPage}>
        <span className="truncate">{pageLabel}</span>
        <ArrowRight aria-hidden />
      </Button>
    </div>
  );
}
