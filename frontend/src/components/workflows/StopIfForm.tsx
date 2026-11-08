/**
 * StopIfForm — configure a STOP_IF checkpoint. The one control is a condition
 * <Select> scoped to the trigger's entity (invoice_* for invoice triggers, etc.)
 * via `catalog.stop_if.conditions[entity]`, labelled from `stop_if.labels`. Lead
 * triggers expose NO conditions, so the picker is replaced with a plain-English
 * dead-end note nudging the office to remove the step (the StepNode picker
 * already disables Stop-if there; this is the defensive twin).
 */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { stopIfConfigSchema, type StopIfFormValues } from '@/lib/workflows/stepSchemas';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';

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
        <div className="flex items-start gap-2.5 rounded bg-warning/10 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-text-primary">Stop conditions aren’t available for this trigger</p>
            <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
              This trigger has nothing to check against, so a Stop-if step will never do anything here. Remove it to keep
              the flow clean.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <Label tone="strong" htmlFor="stop-condition" className="mb-1.5 block text-sm font-semibold">
          Stop this automation if…
        </Label>
        {/* Always-controlled: '' (no pick yet) keeps Radix in controlled mode so the
            first selection doesn't trip React's uncontrolled→controlled warning. */}
        <Select
          value={condition}
          onValueChange={(v) => {
            setValue('condition', v, { shouldDirty: true, shouldValidate: true });
            onChange({ condition: v });
          }}
        >
          <SelectTrigger id="stop-condition" className="h-11" aria-label="Stop condition">
            <SelectValue placeholder="Pick a condition" />
          </SelectTrigger>
          <SelectContent>
            {conditions.map((c) => (
              <SelectItem key={c} value={c}>
                {labels[c] ?? c.replace(/_/g, ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs leading-relaxed text-text-secondary">
        The flow checks this right before each following step — if it’s true, the automation ends here.
      </p>
    </div>
  );
}
