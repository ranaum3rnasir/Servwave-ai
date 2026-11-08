import { Rocket, CheckCircle2, PencilLine } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Switch } from '@/ui-kit/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui-kit/components/ui/tooltip';
import { blockedReason } from '@/components/workflows/PublishControl';
import type { ValidationIssue, WorkflowStatus } from '@/lib/api/workflows';

import { MIDDOT } from './glyphs';

/**
 * The header's 4-state live/draft control.
 *
 * Purely prop-driven: the page owns the mutations and the toasts, so all four
 * states are trivially renderable in isolation. Publishing while `issues` exist
 * is impossible from here; the button is disabled and explains why, and the
 * server 400s as a backstop.
 *
 * `blockedReason` is imported from the legacy control rather than copied. It is
 * pure, exported and unit-tested there, and it is the single answer to "why
 * can I not publish".
 *
 * A disabled button swallows pointer events, which would kill the explanatory
 * tooltip, so the disabled variants sit inside a focusable `span` wrapper. That
 * idiom appears four times across this module and is not decoration: it is the
 * only place the user learns WHY Publish or Test is blocked.
 */
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

function LivePill({ pending }: { pending: boolean }) {
  return pending ? (
    <Badge variant="softBlue" size="pill">
      <PencilLine aria-hidden />
      {`Live ${MIDDOT} editing draft`}
    </Badge>
  ) : (
    <Badge variant="softGreen" size="pill">
      <CheckCircle2 aria-hidden />
      {`Live ${MIDDOT} up to date`}
    </Badge>
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
    <Button type="button" onClick={onPublish} disabled={isPublishing}>
      <Rocket aria-hidden />
      {label}
    </Button>
  );

  const blockedButton = (label: string) => {
    const reason = blockedReason(issues);
    return (
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex" aria-label={reason}>
              <Button type="button" disabled aria-disabled>
                <Rocket aria-hidden />
                {label}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  if (isDraft) {
    return hasIssues ? blockedButton('Publish') : publishButton('Publish');
  }

  return (
    <div className="flex items-center gap-3">
      <LivePill pending={pending} />
      <Switch
        checked={isEnabled}
        disabled={isToggling}
        onCheckedChange={onToggleEnabled}
        aria-label={isEnabled ? 'Pause this automation' : 'Turn this automation on'}
      />
      {pending && !hasIssues && publishButton('Publish changes')}
      {pending && hasIssues && blockedButton('Publish changes')}
    </div>
  );
}
