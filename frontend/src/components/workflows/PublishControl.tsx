/**
 * PublishControl — the header's 4-state live/draft control (plan §F).
 *
 * Purely prop-driven (the page owns the mutations + toasts) so all four states
 * are trivially renderable in isolation. Publishing while `issues` exist is
 * impossible from here — the button is disabled and explains why; the server
 * 400s as a backstop. Status is always icon + label, never colour alone.
 */

import { Rocket, CheckCircle2, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ValidationIssue, WorkflowStatus } from '@/lib/api/workflows';

export interface PublishControlProps {
  status: WorkflowStatus;
  hasUnpublishedChanges: boolean;
  dirty: boolean;
  issues: ValidationIssue[];
  isEnabled: boolean;
  onPublish: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  isPublishing?: boolean;
  isToggling?: boolean;
}

/** Plain-English reason Publish is blocked — counts distinct steps needing setup. */
export function blockedReason(issues: ValidationIssue[]): string {
  const stepIdxs = new Set(issues.filter((i) => i.step_index >= 0).map((i) => i.step_index));
  if (stepIdxs.size > 0) {
    return `Fix ${stepIdxs.size} ${stepIdxs.size === 1 ? 'step that needs' : 'steps that need'} setup`;
  }
  return issues[0]?.message ?? "This automation isn't ready to publish";
}

function LivePill({ pending }: { pending: boolean }) {
  return pending ? (
    <span className="inline-flex items-center gap-1.5 rounded-pill bg-primary-subtle px-2.5 py-1 text-xs font-semibold text-primary">
      <PencilLine className="h-3.5 w-3.5" aria-hidden />
      Live · editing draft
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-pill bg-success/10 px-2.5 py-1 text-xs font-semibold text-success">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
      Live · up to date
    </span>
  );
}

export default function PublishControl({
  status,
  hasUnpublishedChanges,
  dirty,
  issues,
  isEnabled,
  onPublish,
  onToggleEnabled,
  isPublishing = false,
  isToggling = false,
}: PublishControlProps) {
  const isDraft = status !== 'PUBLISHED';
  const hasIssues = issues.length > 0;
  const pending = hasUnpublishedChanges || dirty;

  const publishButton = (label: string) => (
    <Button variant="solid" tone="business" onClick={onPublish} disabled={isPublishing}>
      <Rocket className="mr-1.5 h-4 w-4" aria-hidden />
      {label}
    </Button>
  );

  // ── DRAFT ──────────────────────────────────────────────────────────────────
  if (isDraft) {
    if (hasIssues) {
      const reason = blockedReason(issues);
      return (
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A disabled button swallows pointer events, so the tooltip listens
                  on a focusable wrapper (same idiom as the draft Switch on Home). */}
              <span tabIndex={0} className="inline-flex" aria-label={reason}>
                <Button variant="solid" tone="business" disabled aria-disabled>
                  <Rocket className="mr-1.5 h-4 w-4" aria-hidden />
                  Publish
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{reason}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }
    return publishButton('Publish');
  }

  // ── PUBLISHED ────────────────────────────────────────────────────────────────
  return (
    <div className="flex items-center gap-3">
      <LivePill pending={pending} />
      <Switch
        checked={isEnabled}
        disabled={isToggling}
        onCheckedChange={onToggleEnabled}
        aria-label={isEnabled ? 'Pause this automation' : 'Turn this automation on'}
      />
      {pending && (hasIssues ? null : publishButton('Publish changes'))}
      {pending && hasIssues && (
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="inline-flex" aria-label={blockedReason(issues)}>
                <Button variant="solid" tone="business" disabled aria-disabled>
                  <Rocket className="mr-1.5 h-4 w-4" aria-hidden />
                  Publish changes
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{blockedReason(issues)}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}
