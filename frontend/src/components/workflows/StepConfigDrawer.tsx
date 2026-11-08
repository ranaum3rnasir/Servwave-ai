/**
 * StepConfigDrawer — the per-step config surface. Opens on node select with the
 * node's icon + the live plain-English sentence; the body is the right form for
 * the selected type (trigger picker, or one of the five step forms). Every form
 * propagates its parsed config up via `onUpdateStepConfig` / `onSetTrigger` and
 * the builder's autosave (Task 13) persists it — this drawer holds no draft of
 * its own. Rendered as a right-side shadcn Sheet so pick ↔ configure never
 * leaves the builder.
 */

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { describeWorkflow } from '@/lib/workflows/describeWorkflow';
import { stepSentence, sentenceText } from '@/lib/workflows/stepSentence';
import { RETIRED_IN_APP_STEP_BODY, RETIRED_IN_APP_STEP_HEADLINE } from '@/lib/workflows/retiredStep';
import { StepTypeTile, STEP_TYPE_META } from './workflow-visuals';
import TriggerForm from './TriggerForm';
import WaitForm from './WaitForm';
import SendTextForm from './SendTextForm';
import SendEmailForm from './SendEmailForm';
import StopIfForm from './StopIfForm';
import type { DraftStep } from './useWorkflowDraft';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';
import type { TriggerConfig } from '@/lib/workflows/triggerModel';

/** Read-only body for a legacy in-app step, whose authoring form is deleted. */
function RetiredInAppStepNotice() {
  return (
    <div className="rounded-lg border border-border bg-muted p-4">
      <p className="text-sm font-semibold text-foreground">{RETIRED_IN_APP_STEP_HEADLINE}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{RETIRED_IN_APP_STEP_BODY}</p>
    </div>
  );
}

export interface StepConfigDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'trigger' | 'step' | null;
  step?: DraftStep;
  triggerType: AutomationTriggerType;
  triggerConfig: TriggerConfig | null;
  /** False only for a brand-new draft's still-unseen placeholder trigger — see
   *  useWorkflowDraft's WorkflowDraftState docblock. Defaults true. */
  triggerConfigured?: boolean;
  stepCount: number;
  catalog?: WorkflowCatalog;
  onUpdateStepConfig: (uid: string, config: Record<string, unknown>) => void;
  onSetTrigger: (type: AutomationTriggerType, config: TriggerConfig | null) => void;
  onRemoveStep: (uid: string) => void;
}

export default function StepConfigDrawer({
  open,
  onOpenChange,
  mode,
  step,
  triggerType,
  triggerConfig,
  triggerConfigured = true,
  stepCount,
  catalog,
  onUpdateStepConfig,
  onSetTrigger,
  onRemoveStep,
}: StepConfigDrawerProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);

  let kicker = '';
  let title = '';
  let tile: React.ReactNode = null;

  if (mode === 'trigger') {
    kicker = 'Trigger';
    title = triggerConfigured ? describeWorkflow(triggerType, triggerConfig, [], catalog) : 'Choose what starts this automation';
    tile = <StepTypeTile type="TRIGGER" size="lg" />;
  } else if (mode === 'step' && step) {
    const meta = STEP_TYPE_META[step.step_type];
    kicker = meta.label;
    const sentence = stepSentence(step, catalog);
    title = sentence.configured ? sentenceText(sentence) : `Set up this ${meta.label.toLowerCase()} step`;
    tile = <StepTypeTile type={step.step_type} size="lg" />;
  }

  function handleClose(next: boolean) {
    if (!next) setConfirmRemove(false);
    onOpenChange(next);
  }

  function renderBody() {
    if (mode === 'trigger') {
      return (
        <TriggerForm
          triggerType={triggerType}
          triggerConfig={triggerConfig}
          triggerConfigured={triggerConfigured}
          stepCount={stepCount}
          catalog={catalog}
          onSetTrigger={onSetTrigger}
        />
      );
    }
    if (mode === 'step' && step) {
      const onChange = (config: Record<string, unknown>) => onUpdateStepConfig(step.uid, config);
      switch (step.step_type) {
        case 'WAIT': {
          const entity = catalog?.triggers[triggerType]?.entity;
          const anchor = entity ? catalog?.anchors[entity]?.[0] ?? null : null;
          return <WaitForm key={step.uid} config={step.config} onChange={onChange} anchor={anchor} />;
        }
        case 'SEND_TEXT':
          return <SendTextForm key={step.uid} config={step.config} triggerType={triggerType} catalog={catalog} onChange={onChange} />;
        case 'SEND_EMAIL':
          return <SendEmailForm key={step.uid} config={step.config} triggerType={triggerType} catalog={catalog} onChange={onChange} />;
        case 'NOTIFY_TEAM':
          return <RetiredInAppStepNotice key={step.uid} />;
        case 'STOP_IF':
          return <StopIfForm key={step.uid} config={step.config} triggerType={triggerType} catalog={catalog} onChange={onChange} />;
      }
    }
    return null;
  }

  return (
    <Sheet open={open} onOpenChange={handleClose}>
      <SheetContent className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-[440px]">
        <SheetHeader divider className="flex-row items-start gap-3 space-y-0 p-4 text-left">
          {tile}
          <div className="min-w-0 flex-1 pr-6">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-primary-light">{kicker}</p>
            <SheetTitle className="mt-0.5 truncate text-base font-bold tracking-tight">
              {title || 'Set this up'}
            </SheetTitle>
            <SheetDescription className="sr-only">Configure this {mode === 'trigger' ? 'trigger' : 'step'}.</SheetDescription>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-5">{renderBody()}</div>

        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          {mode === 'step' && step ? (
            <Button
              variant="ghost" tone="danger"
              className="h-11"
              onClick={() => {
                if (!confirmRemove) {
                  setConfirmRemove(true);
                } else {
                  onRemoveStep(step.uid);
                  handleClose(false);
                }
              }}
            >
              <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
              {confirmRemove ? 'Really remove?' : 'Remove step'}
            </Button>
          ) : (
            <span />
          )}
          <Button className="h-11" onClick={() => handleClose(false)}>
            Done
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
