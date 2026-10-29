/**
 * SendTextForm — configure a SEND_TEXT step. Recipient is fixed to the customer
 * (v1 catalog truth — shown, not chosen). One message field with the merge-chip
 * row, a live N/320 meter (amber past 300, red past 320), and the standing SMS
 * honesty note. Propagates the parsed config up on every edit; the builder's
 * autosave persists it.
 */

import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ZodType } from 'zod';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { sendTextConfigSchema, mergeFieldsIn, type SendTextFormValues } from '@/lib/workflows/stepSchemas';
import { useMergeInsert } from './useMergeInsert';
import MergeFieldChips from './MergeFieldChips';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';

export interface StepFormProps {
  config: Record<string, unknown>;
  triggerType: AutomationTriggerType;
  catalog?: WorkflowCatalog;
  onChange: (config: Record<string, unknown>) => void;
}

const SMS_LIMIT = 320;

export default function SendTextForm({ config, triggerType, catalog, onChange }: StepFormProps) {
  const form = useForm<SendTextFormValues>({
    // z.preprocess's input type is `unknown` by design, which hookform-resolvers
    // v5's tightened generics can no longer match against SendTextFormValues -
    // assert the schema's shape so zodResolver's overloads can find it; runtime
    // behavior is unchanged (still the same zodResolver + schema).
    resolver: zodResolver(sendTextConfigSchema as unknown as ZodType<SendTextFormValues>),
    mode: 'onChange',
    defaultValues: { recipient: 'customer', body: String(config.body ?? '') },
  });
  const { register, watch, setValue, getValues, formState } = form;

  const push = () => onChange({ recipient: 'customer', body: getValues('body') });
  const apply = (name: string, value: string) => {
    setValue(name as 'body', value, { shouldDirty: true, shouldValidate: true });
    push();
  };
  const { insert, bind } = useMergeInsert(apply, 'body');

  const body = watch('body');
  const used = useMemo(() => new Set(mergeFieldsIn(body)), [body]);
  const mergeFields = catalog?.triggers[triggerType]?.mergeFields ?? [];

  const len = body.length;
  const meterCls = len > SMS_LIMIT ? 'text-danger' : len > 300 ? 'text-warning' : 'text-text-secondary';
  const bodyReg = register('body');

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-text-secondary">Send to</span>
        <span className="rounded-pill bg-primary-subtle px-2.5 py-1 text-[13px] font-semibold text-primary">Customer</span>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label tone="strong" htmlFor="text-body" className="text-sm font-semibold">
            Message
          </Label>
          <span className={`text-xs font-medium tabular-nums ${meterCls}`}>{`${len} / ${SMS_LIMIT}`}</span>
        </div>
        <Textarea
          id="text-body"
          {...bodyReg}
          {...bind('body', bodyReg.ref)}
          onChange={(e) => {
            bodyReg.onChange(e);
            push();
          }}
          onBlur={(e) => {
            bodyReg.onBlur(e);
            push();
          }}
          className="min-h-28"
          placeholder="Hi {{customer.first_name}}, a reminder from {{org.name}}…"
        />
        {formState.errors.body && <p className="mt-1 text-xs font-medium text-danger">{formState.errors.body.message}</p>}
      </div>

      <MergeFieldChips fields={mergeFields} used={used} catalog={catalog} onInsert={insert} />

      <p className="rounded bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
        Texts are saved to the customer’s conversation now and will send automatically once the phone system is connected.
      </p>
    </div>
  );
}
