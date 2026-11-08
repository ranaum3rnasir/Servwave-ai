import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Send, Clock, OctagonPause, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';

import { Badge, type BadgeProps } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { toast } from '@/ui-kit/components/ui/sonner';
import { useTestWorkflow, type DryRunStep } from '@/lib/api/workflows';

import { EM_DASH } from './glyphs';
import { StepTypeTile } from './workflowVisuals';

/**
 * The safe dry run. On open it walks the SAVED steps against the catalog's
 * sample context; nothing is ever sent to a real customer from here, and there
 * is no such option in the API. "Send a test to me" re-runs the same walk with
 * `send_to_me: true`, which previews the rendered copy to the CALLER's own
 * email and in-app notification.
 *
 * The `firedRef` latch makes every open a fresh run: on close it resets the
 * latch and the mutation.
 *
 * "Sample data" / "Empty fields" re-runs the same walk with `empty_fields`,
 * which the server renders through the renderer and the per-step fallback map
 * a real send uses, so the empty-state preview IS what a customer with nothing
 * on file would receive. Sample data is the default on every open.
 *
 * "Fix it" closes the dialog and hands `step.step_index` back to the page,
 * which maps it onto `state.steps[index].uid`. The index alignment between
 * dry-run steps and draft steps is a contract; do not reorder either list
 * independently.
 */
export interface TestWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string | undefined;
  /** Closes the dialog then opens that step's config drawer. */
  onFixStep: (stepIndex: number) => void;
}

function TestWorkflowDialog({ open, onOpenChange, workflowId, onFixStep }: TestWorkflowDialogProps) {
  const test = useTestWorkflow();
  const firedRef = useRef(false);
  const [emptyFields, setEmptyFields] = useState(false);

  useEffect(() => {
    if (!open) {
      firedRef.current = false;
      test.reset();
      return;
    }
    if (firedRef.current || !workflowId) return;
    firedRef.current = true;
    test.mutate({ id: workflowId, send_to_me: false, empty_fields: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workflowId]);

  // Every close path in this component goes through here, so the toggle is back on sample
  // data for the next open without a setState inside the open/close effect above.
  function handleOpenChange(next: boolean) {
    if (!next) setEmptyFields(false);
    onOpenChange(next);
  }

  function handleFieldsMode(next: boolean) {
    if (next === emptyFields || !workflowId) return;
    setEmptyFields(next);
    test.mutate({ id: workflowId, send_to_me: false, empty_fields: next });
  }

  function handleSendToMe() {
    if (!workflowId) return;
    test.mutate(
      { id: workflowId, send_to_me: true, empty_fields: emptyFields },
      {
        onSuccess: () => {
          toast.success('Test sent', { description: 'Test sent to your email + notifications' });
        },
      },
    );
  }

  function handleFix(stepIndex: number) {
    handleOpenChange(false);
    onFixStep(stepIndex);
  }

  const steps = test.data?.steps ?? [];
  const loading = test.isPending && steps.length === 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Height and scrolling are the primitive's now - it caps every dialog at
          the viewport and scrolls the body, so a per-call-site vh guess is one
          more number to disagree with the dialog next door. */}
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="text-brand size-4" aria-hidden />
            Test this automation
          </DialogTitle>
          <DialogDescription>
            {`Nothing is sent to customers ${EM_DASH} this is a safe dry run.`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-2.5">
          <div className="flex items-center gap-1" role="group" aria-label="Preview with">
            <span className="text-muted-foreground mr-1 text-xs font-medium">Preview with</span>
            {(
              [
                { label: 'Sample data', value: false },
                { label: 'Empty fields', value: true },
              ] as const
            ).map((opt) => (
              <Button
                key={opt.label}
                type="button"
                variant={emptyFields === opt.value ? 'secondary' : 'ghost'}
                size="sm"
                aria-pressed={emptyFields === opt.value}
                onClick={() => handleFieldsMode(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          {loading ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : steps.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">Add a step to try this automation.</p>
          ) : (
            steps.map((step) => (
              <DryRunStepRow key={step.step_index} step={step} onFix={() => handleFix(step.step_index)} />
            ))
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
          <Button type="button" onClick={handleSendToMe} disabled={test.isPending || steps.length === 0}>
            Send a test to me
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const OUTCOME_CHIP: Record<
  DryRunStep['outcome'],
  { label: string; variant: NonNullable<BadgeProps['variant']>; icon: typeof Send }
> = {
  would_send: { label: 'Would send', variant: 'softGreen', icon: Send },
  would_wait: { label: 'Waits', variant: 'softNeutral', icon: Clock },
  would_check: { label: 'Guard check', variant: 'softAmber', icon: OctagonPause },
  needs_setup: { label: 'Needs setup', variant: 'softAmber', icon: AlertTriangle },
};

function OutcomeChip({ outcome }: { outcome: DryRunStep['outcome'] }) {
  const meta = OUTCOME_CHIP[outcome];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} size="pill">
      <Icon aria-hidden />
      {meta.label}
    </Badge>
  );
}

function DryRunStepRow({ step, onFix }: { step: DryRunStep; onFix: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <div className="border-border bg-kit-card flex items-start gap-3 rounded-lg border p-3">
      <StepTypeTile type={step.step_type} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-[10.5px] font-bold uppercase tracking-[0.08em]">
          Step {step.step_index + 1}
        </p>

        {step.outcome === 'would_send' && (
          <div className="mt-0.5">
            <OutcomeChip outcome="would_send" />
            <p className="mt-1 text-sm">{step.detail}</p>
            {step.rendered && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPreviewOpen((v) => !v)}
                  aria-expanded={previewOpen}
                  className="text-brand hover:text-brand -ml-1 mt-1 min-h-11 gap-1 px-1 text-xs font-semibold"
                >
                  {previewOpen ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
                  {previewOpen ? 'Hide preview' : 'Preview message'}
                </Button>
                {previewOpen && (
                  <div className="border-border bg-muted mt-2 rounded-md border p-3 text-xs">
                    {step.rendered.subject && <p className="mb-1.5 font-semibold">{step.rendered.subject}</p>}
                    <p className="whitespace-pre-wrap">{step.rendered.body}</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {step.outcome === 'would_wait' && (
          <div className="mt-0.5">
            <OutcomeChip outcome="would_wait" />
            <p className="mt-1 text-sm">Waits {step.detail} here</p>
          </div>
        )}

        {step.outcome === 'would_check' && (
          <div className="mt-0.5">
            <OutcomeChip outcome="would_check" />
            <p className="mt-1 text-sm">{step.detail}</p>
          </div>
        )}

        {step.outcome === 'needs_setup' && (
          <div className="mt-0.5">
            <OutcomeChip outcome="needs_setup" />
            <p className="mt-1 text-sm">{step.detail}</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={onFix}>
              Fix it
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Declared then exported, rather than `export default function`, for the same
 * reason as addStepButton: the duplicate-primitive guard resolves a primitive
 * import by the literal string `@/components/ui/<name>` and cannot see
 * `@/ui-kit/components/ui/dialog`, so a concept-named default export composing
 * the KIT Dialog reads to it as a hand-rolled copy. This component does
 * compose the kit Dialog. See the branch ledger.
 */
export { TestWorkflowDialog };
export default TestWorkflowDialog;
