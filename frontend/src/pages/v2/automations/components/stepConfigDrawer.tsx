import { Trash2 } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/ui-kit/components/ui/sheet';
import { useConfirm } from '@/hooks/useConfirm';
import { removeStepPrompt } from '@/lib/confirmPrompts';
import { describeWorkflow } from '@/lib/workflows/describeWorkflow';
import { stepSentence, sentenceText } from '@/lib/workflows/stepSentence';
import { RETIRED_IN_APP_STEP_BODY, RETIRED_IN_APP_STEP_HEADLINE } from '@/lib/workflows/retiredStep';
import type { DraftStep } from '@/components/workflows/useWorkflowDraft';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';
import type { TriggerConfig } from '@/lib/workflows/triggerModel';

import SendEmailForm from './sendEmailForm';
import SendTextForm from './sendTextForm';
import StopIfForm from './stopIfForm';
import TriggerForm from './triggerForm';
import WaitForm from './waitForm';
import { StepTypeTile, STEP_TYPE_META } from './workflowVisuals';

/** Read-only body for a legacy in-app step, whose authoring form is deleted. */
function RetiredInAppStepNotice() {
  return (
    <div className="border-border bg-muted rounded-lg border p-4">
      <p className="text-foreground text-sm font-semibold">{RETIRED_IN_APP_STEP_HEADLINE}</p>
      <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{RETIRED_IN_APP_STEP_BODY}</p>
    </div>
  );
}

/**
 * The per-step config surface. Opens on node select with the node's tile and
 * the live plain-English sentence; the body is the right form for the selected
 * type.
 *
 * This drawer holds NO draft of its own. Every form calls
 * `onUpdateStepConfig(uid, config)` or `onSetTrigger(type, config)` on each
 * edit, and the page's autosave persists it.
 *
 * `key={step.uid}` on each form is semantic, not incidental: the forms seed
 * local state from `config` once, so without the key, switching from one step
 * to another of the SAME type would show the previous step's values.
 */
export interface StepConfigDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'trigger' | 'step' | null;
  step?: DraftStep;
  triggerType: AutomationTriggerType;
  triggerConfig: TriggerConfig | null;
  /** False only for a brand-new draft's still-unseen placeholder trigger. Defaults true. */
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
  const { confirm, confirmDialog } = useConfirm();

  let kicker = '';
  let title = '';
  let tile: React.ReactNode = null;

  if (mode === 'trigger') {
    kicker = 'Trigger';
    title = triggerConfigured
      ? describeWorkflow(triggerType, triggerConfig, [], catalog)
      : 'Choose what starts this automation';
    tile = <StepTypeTile type="TRIGGER" size="lg" />;
  } else if (mode === 'step' && step) {
    const meta = STEP_TYPE_META[step.step_type];
    kicker = meta.label;
    const sentence = stepSentence(step, catalog);
    title = sentence.configured ? sentenceText(sentence) : `Set up this ${meta.label.toLowerCase()} step`;
    tile = <StepTypeTile type={step.step_type} size="lg" />;
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
          const anchor = entity ? (catalog?.anchors[entity]?.[0] ?? null) : null;
          return <WaitForm key={step.uid} config={step.config} onChange={onChange} anchor={anchor} />;
        }
        case 'SEND_TEXT':
          return (
            <SendTextForm key={step.uid} config={step.config} triggerType={triggerType} catalog={catalog} onChange={onChange} />
          );
        case 'SEND_EMAIL':
          return (
            <SendEmailForm key={step.uid} config={step.config} triggerType={triggerType} catalog={catalog} onChange={onChange} />
          );
        case 'NOTIFY_TEAM':
          return <RetiredInAppStepNotice key={step.uid} />;
        case 'STOP_IF':
          return (
            <StopIfForm key={step.uid} config={step.config} triggerType={triggerType} catalog={catalog} onChange={onChange} />
          );
      }
    }
    return null;
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-[440px]">
          <SheetHeader className="border-border flex-row items-start gap-3 space-y-0 border-b p-4 text-left">
            {tile}
            <div className="min-w-0 flex-1 pr-6">
              <p className="text-brand text-[10.5px] font-bold uppercase tracking-[0.08em]">{kicker}</p>
              <SheetTitle className="mt-0.5 truncate text-base font-bold tracking-tight">
                {title || 'Set this up'}
              </SheetTitle>
              <SheetDescription className="sr-only">
                Configure this {mode === 'trigger' ? 'trigger' : 'step'}.
              </SheetDescription>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-5">{renderBody()}</div>

          <div className="border-border flex items-center justify-between gap-2 border-t p-4">
            {mode === 'step' && step ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive h-11"
                onClick={async () => {
                  const label = STEP_TYPE_META[step.step_type].label;
                  if (!(await confirm(removeStepPrompt(label)))) return;
                  onRemoveStep(step.uid);
                  onOpenChange(false);
                }}
              >
                <Trash2 aria-hidden />
                Remove step
              </Button>
            ) : (
              <span />
            )}
            <Button type="button" className="h-11" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      {confirmDialog}
    </>
  );
}
