import { Rocket, CheckCircle2, PencilLine } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Switch } from '@/ui-kit/components/ui/switch';
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
 * A disabled button swallows pointer events, so the reason is carried by the
 * Button's `disabledReason` (mobile slice 40): a tap or Enter opens it as helper
 * text on touch, and the title on its shell still shows it on hover. It is the
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
    <Button type="button" onClick={onPublish} disabled={isPublishing} className="max-sm:h-11 max-sm:flex-1">
      <Rocket aria-hidden />
      {label}
    </Button>
  );

  const blockedButton = (label: string) => (
    <Button type="button" disabled disabledReason={blockedReason(issues)} className="max-sm:h-11 max-sm:flex-1">
      <Rocket aria-hidden />
      {label}
    </Button>
  );

  if (isDraft) {
    return hasIssues ? blockedButton('Publish') : publishButton('Publish');
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
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
