import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DialogClose } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/ui-kit/components/ui/switch';
import { cn } from '@/lib/utils';
import type { AIAgent } from '@/lib/ai-center/agents';
import { NOT_AVAILABLE_COPY, type AgentStatus, type AgentSwitchControl } from '@/lib/ai-center/agentStatus';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { AgentStatusChip } from './AgentStatusChip';

/*
 * The detail pop-up's controls for an agent this company can use (the 14 Oct controls design,
 * option A): a control row under the header that says where the agent stands and, for someone
 * who may manage it, switches it; and the footer, whose main button follows the switch. Nothing
 * here names an agent: the words come from the agent's registry entry and its catalog name.
 *
 * The switch says whether the agent is applied, and an Admin can always use it, set up or not.
 * The footer's button is the way in ("Open", or "Set up" before it is set up), and only while the
 * switch is on: while off it is locked, with "Turn it on" under it (Ran, 14 Oct).
 */

interface ControlsProps {
  agent: AIAgent;
  status: AgentStatus;
  control: AgentSwitchControl;
}

interface RowProps extends ControlsProps {
  /** The control row's own spacing, which a page may replace (the pop-up keeps a gap under it). */
  className?: string;
  /**
   * Set by a page whose form holds changes that are not saved yet, which turning the agent off
   * throws away (its page locks): the sentence that says so. While it is set, turning off always
   * asks first, set up or not, and the question leads with it.
   */
  unsavedWarning?: string;
}

/** The row's two lines, for the agent's state and the person looking. */
function rowLines({ status, isSetUp, canManage, copy }: AgentStatus, name: string): [string, string] | null {
  if (status === 'not_available') return [NOT_AVAILABLE_COPY.title(name), NOT_AVAILABLE_COPY.detail];
  if (!copy) return null;
  switch (status) {
    case 'on':
      return [
        `${name} is on`,
        isSetUp ? copy.onDetail : canManage ? copy.onNotSetUpDetail : copy.notSetUpMemberDetail,
      ];
    case 'off':
      return [
        `${name} is off`,
        isSetUp ? copy.offDetail : canManage ? copy.offNotSetUpDetail : copy.notSetUpMemberDetail,
      ];
    default:
      return null;
  }
}

/**
 * Turning the agent on saves at once. Turning it off asks first when it was set up, because it
 * stops the agent's work; the question says what is kept. An agent that was never set up does no
 * work yet, so it switches straight off. Shared by the row's switch and the footer's "Turn it on".
 */
function useSwitchFlow(control: AgentSwitchControl, isSetUp: boolean) {
  const [confirmOff, setConfirmOff] = useState(false);
  return {
    confirmOff,
    setConfirmOff,
    request(next: boolean) {
      if (!control.setActive) return;
      if (next) control.setActive(true);
      else if (isSetUp) setConfirmOff(true);
      else control.setActive(false);
    },
    turnOff() {
      setConfirmOff(false);
      control.setActive?.(false);
    },
  };
}

/**
 * The one on/off control for an agent, shared by the AI Agentic Farm pop-up and the agent's own
 * page: where it stands in words (a polite live region) and, for someone who may manage it, the
 * switch, which asks before turning off an agent that was set up.
 */
export function AgentControlRow({ agent, status, control, className, unsavedWarning }: RowProps) {
  const detailId = useId();
  const flow = useSwitchFlow(control, status.isSetUp || !!unsavedWarning);

  if (status.status === 'loading') {
    // The row's own shape and height, so nothing below it moves when the switch is read.
    return (
      <div
        data-agent-control-row="loading"
        aria-hidden
        className={cn('mb-4 flex min-h-[58px] items-center gap-3 rounded-[14px] border border-border py-1.5 pl-3.5 pr-1.5', className)}
      >
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-48 max-w-full" />
        </div>
        <Skeleton className="mr-2 h-[30px] w-[52px]" />
      </div>
    );
  }

  const lines = rowLines(status, agent.name);
  // The switch could not be read: claim nothing.
  if (!lines) return null;

  const isOn = status.status === 'on';
  const notAvailable = status.status === 'not_available';
  const canSwitch = !notAvailable && status.canManage && !!control.setActive;
  return (
    <>
      <div
        data-agent-control-row={status.status}
        data-agent-set-up={status.isSetUp}
        className={cn(
          'mb-4 flex min-h-[58px] items-center gap-3 rounded-[14px] border py-1.5 pl-3.5 pr-1.5 transition-colors duration-200 motion-reduce:transition-none',
          !isOn
            ? 'border-border bg-surface-light'
            : status.isSetUp
              ? 'border-success-border bg-gradient-to-r from-success-surface via-surface-light/60 to-surface-light'
              : // On but not set up yet: applied, not working yet. The amber of the card's strip.
                'border-warning-border bg-gradient-to-r from-warning-surface via-surface-light/60 to-surface-light',
          className,
        )}
      >
        <div className="min-w-0 flex-1 py-1">
          {/* A polite live region: a screen reader hears "Spider is off" when the switch settles,
              including after the turn-off question, with no toast needed. */}
          <p role="status" className="text-[14.5px] font-bold leading-snug text-text-primary">
            {lines[0]}
          </p>
          <p id={detailId} className="text-pretty text-[12.5px] leading-snug text-text-secondary">
            {lines[1]}
          </p>
        </div>
        {canSwitch ? (
          // Always usable by someone who may manage the agent, set up or not.
          <Switch
            size="lg"
            tone="success"
            stateLabel
            checked={isOn}
            busy={control.saving}
            aria-label={`Switch ${agent.name} on or off`}
            aria-describedby={detailId}
            onCheckedChange={flow.request}
          />
        ) : notAvailable ? null : (
          <span className="mr-2">
            <AgentStatusChip state={isOn ? 'on' : 'off'} />
          </span>
        )}
      </div>
      {canSwitch && status.copy && (
        <TurnOffConfirm
          name={agent.name}
          // "...are all kept" speaks of what was saved, so it stays only for an agent that was set up.
          warning={
            unsavedWarning
              ? [unsavedWarning, ...(status.isSetUp ? status.copy.turnOffWarning : [])]
              : status.copy.turnOffWarning
          }
          open={flow.confirmOff}
          onOpenChange={flow.setConfirmOff}
          onConfirm={flow.turnOff}
        />
      )}
    </>
  );
}

function TurnOffConfirm({
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
      title={`Turn off ${name}?`}
      description={warning.map((p, i) => (
        <span key={i} className={cn('block', i > 0 && 'mt-2')}>
          {p}
        </span>
      ))}
      cancelLabel="Keep it on"
      confirmLabel="Turn off"
      onConfirm={onConfirm}
    />
  );
}

/**
 * The footer for an agent this company can use. Someone who may manage it gets the way to its
 * page: "Open" once it is set up, "Set up" before. Either follows the switch: usable while on,
 * locked while off (with a way to turn it on right there). Everyone else gets one line on how they
 * hear from it.
 */
export function AgentFooter({ agent, status, control, onClose }: ControlsProps & { onClose: () => void }) {
  const navigate = useNavigate();
  const closeCatalog = useAiCenterStore((s) => s.setOpen);
  const hintId = useId();

  const openPage = () => {
    if (!status.managePath) return;
    onClose();
    closeCatalog(false);
    navigate(status.managePath);
  };

  const close = (
    <DialogClose asChild>
      <Button variant="outline" tone="neutral">
        Close
      </Button>
    </DialogClose>
  );

  if (!status.canManage || !status.managePath) {
    const note =
      status.status === 'on'
        ? status.isSetUp
          ? status.copy?.memberOnNote
          : status.copy?.memberOnNotSetUpNote
        : status.status === 'off'
          ? status.copy?.memberOffNote
          : undefined;
    return note ? (
      <p data-agent-footer-note className="py-1.5 text-center text-sm text-text-secondary">
        {note}
      </p>
    ) : (
      <div className="flex">{close}</div>
    );
  }

  if (status.status === 'loading') {
    return (
      <div className="flex gap-2.5">
        {close}
        <Skeleton data-agent-footer-placeholder className="h-10 min-w-0 flex-1" />
      </div>
    );
  }

  // The way in is its page: "Set up" until it is set up, "Open" after. When the switch could not
  // be read ("unknown") it is "Open": the page shows the real state itself.
  const setUpFirst = (status.status === 'on' || status.status === 'off') && !status.isSetUp;
  const pageLabel = setUpFirst ? `Set up ${agent.name}` : `Open ${agent.name}`;

  if (status.status === 'off') {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
        <div className="flex min-w-0 gap-2.5">
          {close}
          {/* Locked while the agent is off: it stays in the tab order so the reason under it is
              found, and does nothing. */}
          <Button
            variant="solid"
            tone="neutral"
            aria-disabled="true"
            aria-describedby={hintId}
            data-agent-locked
            className="min-w-0 flex-1 cursor-not-allowed"
            onClick={(e) => e.preventDefault()}
          >
            <span className="inline-flex min-w-0 max-w-full items-center gap-2 overflow-hidden opacity-60">
              <Lock aria-hidden />
              <span className="truncate">{pageLabel}</span>
            </span>
          </Button>
        </div>
        <p id={hintId} className="text-balance text-center text-sm text-text-secondary">
          {agent.name} is off.{' '}
          {/* Inline in the sentence: no control height of its own (touch included), so the note
              stays one line of text. The hit area grows past the words through a transparent
              ::after instead, which changes no line height. */}
          <Button
            variant="link"
            className="relative h-auto px-0.5 py-0 align-baseline after:absolute after:-inset-x-2 after:-inset-y-3 after:content-['']"
            disabled={control.saving}
            onClick={() => control.setActive?.(true)}
          >
            <span className="text-ai-text underline decoration-ai-text/40 underline-offset-[3px]">Turn it on</span>
          </Button>{' '}
          {setUpFirst ? 'to set it up' : 'to open it'}.
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5">
      {close}
      <Button variant="solid" tone="ai" className="min-w-0 flex-1" onClick={openPage}>
        <span className="truncate">{pageLabel}</span>
        <ArrowRight aria-hidden />
      </Button>
    </div>
  );
}
