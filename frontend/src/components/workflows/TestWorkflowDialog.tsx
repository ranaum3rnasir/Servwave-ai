/**
 * TestWorkflowDialog — the safe dry-run (plan §8). Opens on the header's Test
 * button; on open it immediately walks the DRAFT steps against the catalog's
 * sample context via `useTestWorkflow({ send_to_me: false })` — nothing is
 * ever sent to a real customer from here, there is no such option in the API.
 * "Send a test to me" re-runs the same walk with `send_to_me: true`, which
 * previews the rendered copy to the CALLER's own email + in-app notification.
 */

import { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { FlaskConical, Send, Clock, OctagonPause, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/use-toast';
import { useTestWorkflow, type DryRunStep } from '@/lib/api/workflows';
import { StepTypeTile } from './workflow-visuals';

export interface TestWorkflowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflowId: string | undefined;
  /** Closes the dialog and opens that step's config drawer. */
  onFixStep: (stepIndex: number) => void;
}

export default function TestWorkflowDialog({ open, onOpenChange, workflowId, onFixStep }: TestWorkflowDialogProps) {
  const test = useTestWorkflow();
  const firedRef = useRef(false);

  // Run the dry-run the moment the dialog opens; reset so the next open is fresh.
  useEffect(() => {
    if (!open) {
      firedRef.current = false;
      test.reset();
      return;
    }
    if (firedRef.current || !workflowId) return;
    firedRef.current = true;
    test.mutate({ id: workflowId, send_to_me: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workflowId]);

  function handleSendToMe() {
    if (!workflowId) return;
    test.mutate(
      { id: workflowId, send_to_me: true },
      {
        onSuccess: () => {
          toast({ title: 'Test sent', description: 'Test sent to your email + notifications' });
        },
      },
    );
  }

  function handleFix(stepIndex: number) {
    onOpenChange(false);
    onFixStep(stepIndex);
  }

  const steps = test.data?.steps ?? [];
  const loading = test.isPending && steps.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-primary" aria-hidden />
            Test this automation
          </DialogTitle>
          <DialogDescription>Nothing is sent to customers — this is a safe dry run.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          {loading ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : steps.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-secondary">Add a step to try this automation.</p>
          ) : (
            steps.map((step) => (
              <DryRunStepRow key={step.step_index} step={step} onFix={() => handleFix(step.step_index)} />
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button variant="solid" tone="business" onClick={handleSendToMe} disabled={test.isPending || steps.length === 0}>
            Send a test to me
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OutcomeChip({ icon: Icon, label, cls }: { icon: LucideIcon; label: string; cls: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}

function DryRunStepRow({ step, onFix }: { step: DryRunStep; onFix: () => void }) {
  const [previewOpen, setPreviewOpen] = useState(false);

  return (
    <div className="flex items-start gap-3 rounded-card border border-border bg-surface-light p-3">
      <StepTypeTile type={step.step_type} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-text-secondary">
          Step {step.step_index + 1}
        </p>

        {step.outcome === 'would_send' && (
          <div className="mt-0.5">
            <OutcomeChip icon={Send} label="Would send" cls="bg-success/10 text-success" />
            <p className="mt-1 text-sm text-text-primary">{step.detail}</p>
            {step.rendered && (
              <>
                {/* Deferred: idle text-primary with no hover feedback at all
                    today. The only text CTA cell, link slash brand, would add
                    a hover underline that doesn't exist here, and its
                    padding/font-size/min-height sizing doesn't match any
                    Button size rung - not a clean map, left raw. */}
                <button
                  type="button"
                  onClick={() => setPreviewOpen((v) => !v)}
                  aria-expanded={previewOpen}
                  className="-ml-1 mt-1 flex min-h-11 items-center gap-1 px-1 text-xs font-semibold text-primary"
                >
                  {previewOpen ? (
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {previewOpen ? 'Hide preview' : 'Preview message'}
                </button>
                {previewOpen && (
                  <div className="mt-2 rounded border border-border bg-background-light p-3 text-xs text-text-primary">
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
            <OutcomeChip icon={Clock} label="Waits" cls="bg-background-light text-text-secondary" />
            <p className="mt-1 text-sm text-text-primary">Waits {step.detail} here</p>
          </div>
        )}

        {step.outcome === 'would_check' && (
          <div className="mt-0.5">
            <OutcomeChip icon={OctagonPause} label="Guard check" cls="bg-warning/10 text-warning" />
            <p className="mt-1 text-sm text-text-primary">{step.detail}</p>
          </div>
        )}

        {step.outcome === 'needs_setup' && (
          <div className="mt-0.5">
            <OutcomeChip icon={AlertTriangle} label="Needs setup" cls="bg-warning/10 text-warning" />
            <p className="mt-1 text-sm text-text-primary">{step.detail}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={onFix}>
              Fix it
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
