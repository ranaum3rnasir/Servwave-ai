import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle } from 'lucide-react';

import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { stopIfConfigSchema, type StopIfFormValues } from '@/lib/workflows/stepSchemas';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';

import { ELLIPSIS, EM_DASH, RSQUO } from './glyphs';

/**
 * A STOP_IF checkpoint. The one control is a condition select scoped to the
 * trigger's entity via `catalog.stop_if.conditions[entity]`.
 *
 * Lead triggers expose NO conditions, so the picker is replaced with a
 * plain-English dead-end note nudging the office to remove the step. The step
 * picker already locks Stop-if there; this is the defensive twin.
 *
 * The Select is ALWAYS controlled: the empty string keeps Radix in controlled
 * mode so the first selection does not trip React's uncontrolled-to-controlled
 * warning. Keep the sentinel.
 *
 * There is deliberately no inline error for an empty condition. The "Needs
 * setup" badge on the node is the feedback.
 */
export interface StopIfFormProps {
  config: Record<string, unknown>;
  triggerType: AutomationTriggerType;
  catalog?: WorkflowCatalog;
  onChange: (config: Record<string, unknown>) => void;
}

export default function StopIfForm({ config, triggerType, catalog, onChange }: StopIfFormProps) {
  const form = useForm<StopIfFormValues>({
    resolver: zodResolver(stopIfConfigSchema),
    mode: 'onChange',
    defaultValues: { condition: String(config.condition ?? '') },
  });
  const { watch, setValue } = form;
  const condition = watch('condition');

  const entity = catalog?.triggers[triggerType]?.entity;
  const conditions = (entity && catalog?.stop_if.conditions[entity]) ?? [];
  const labels = catalog?.stop_if.labels ?? {};

  if (conditions.length === 0) {
    return (
      <div className="space-y-3">
        <div className="bg-status-amber-subtle flex items-start gap-2.5 rounded-md px-3 py-2.5">
          <AlertTriangle className="text-status-amber-emphasis mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="text-sm font-semibold">
              {`Stop conditions aren${RSQUO}t available for this trigger`}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
              This trigger has nothing to check against, so a Stop-if step will never do anything here. Remove it to
              keep the flow clean.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="stop-condition" className="mb-1.5 block text-sm font-semibold">
          {`Stop this automation if${ELLIPSIS}`}
        </Label>
        <SelectField
          id="stop-condition"
          value={condition}
          onValueChange={(v) => {
            setValue('condition', v, { shouldDirty: true, shouldValidate: true });
            onChange({ condition: v });
          }}
          className="h-11"
          aria-label="Stop condition"
          placeholder="Pick a condition"
          options={conditions.map((c) => ({ value: c, label: labels[c] ?? c.replace(/_/g, ' ') }))}
        />
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {`The flow checks this right before each following step ${EM_DASH} if it${RSQUO}s true, the automation ends here.`}
      </p>
    </div>
  );
}
