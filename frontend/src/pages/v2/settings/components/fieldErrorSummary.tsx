import { Button } from '@/ui-kit/components/ui/button';

import { jumpToField } from './jumpToField';

export interface FieldProblem {
  /** The id of the input to jump to. */
  id: string;
  /** The field's visible label, named in the link. */
  label: string;
}

/**
 * The short banner at the top of a card whose save failed: how many fields to fix, and a link that
 * jumps to the first. A toast is never the only signal.
 */
export function FieldErrorSummary({ problems }: { problems: FieldProblem[] }) {
  const first = problems[0];
  if (!first) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger bg-danger/10 px-3 py-2 text-sm">
      <span className="font-medium text-danger">
        {problems.length === 1 ? 'Fix 1 field to save' : `Fix ${problems.length} fields to save`}
      </span>
      <Button type="button" variant="link" size="sm" onClick={() => jumpToField(first.id)}>
        Go to {first.label}
      </Button>
    </div>
  );
}
