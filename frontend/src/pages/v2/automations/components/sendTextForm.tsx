import { useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { cn } from '@/ui-kit/lib/utils';
import { mergeFieldsIn } from '@/lib/workflows/stepSchemas';
import { displayedFallbacks, storedFallbacks } from '@/lib/workflows/fallbacks';
import { useMergeInsert } from '@/components/workflows/useMergeInsert';
import type { AudienceKey, AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';

import { ELLIPSIS } from './glyphs';
import MergeFieldChips from './mergeFieldChips';
import RecipientMultiSelect, { normalizeRecipientFields, toLegacySingularRecipient } from './recipientMultiSelect';

/**
 * A SEND_TEXT step.
 *
 * Spec C slice 8: the recipient used to be FIXED to the customer - a static badge under the
 * Send-to label, `recipient: 'customer'` in the defaults and in every config emitted. There
 * was no filter to relax; the work was adding the picker the email step already had. A text
 * now reaches every audience an email reaches except `custom`, which is an audience of literal
 * email ADDRESSES with nothing on a handset to resolve to - the catalog simply never offers it
 * on SEND_SMS, so no filtering happens here.
 *
 * Ownership is split exactly as sendEmailForm.tsx splits it, for the same reason: react-hook-
 * form covers the COPY only, while recipients / user ids live in plain `useState` owned by
 * RecipientMultiSelect's controlled contract. Recipient LEGALITY stays server-owned - the
 * options come from the catalog, and validateStep re-checks them at publish.
 *
 * The selection is mirrored in a REF as well as in state, and `push` reads the ref. Two
 * separate callbacks can fire in one tick - unticking `specific_user` calls
 * `onRecipientsChange` and then `onUserIdsChange` - and a `push` that read `useState` would
 * see the pre-first-call snapshot on the second, making the LAST emitted config re-add the
 * audience the admin just switched off. The checkbox would then read unticked while the saved
 * draft still carried `specific_user` with no chosen people, which the server rejects with
 * "Pick the team member to notify" against a control that looks correct.
 *
 * `useMergeInsert` is imported unchanged. It reads the LIVE DOM node rather than a possibly-
 * stale form value, so the kit Textarea has to keep forwarding its ref; if it did not, chip
 * insertion would silently no-op.
 *
 * The textarea's element id is `sms-body` where the legacy one used a colour-utility-shaped
 * name. The unresolved-class guard tokenises raw source text, so an id shaped like a Tailwind
 * colour utility registers as a dead class in every file that mentions it. Nothing selects
 * this field by id: the label association is what it is for, and the specs reach it by its
 * accessible name. Recorded in the branch ledger.
 */
export interface StepFormProps {
  config: Record<string, unknown>;
  triggerType: AutomationTriggerType;
  catalog?: WorkflowCatalog;
  onChange: (config: Record<string, unknown>) => void;
}

const SMS_LIMIT = 320;

/**
 * Copy only, so the bounds are duplicated from stepSchemas.ts's sendTextConfigSchema rather
 * than sliced off it - character for character, since the inline error and the server's
 * "needs setup" issue are one message arriving by two routes.
 */
const textContentSchema = z.object({
  body: z.string().min(1, 'Write the text message').max(SMS_LIMIT, 'Texts are capped at 320 characters'),
});
type TextContentValues = z.infer<typeof textContentSchema>;

export default function SendTextForm({ config, triggerType, catalog, onChange }: StepFormProps) {
  const initial = useMemo(() => normalizeRecipientFields(config), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [recipients, setRecipients] = useState<AudienceKey[]>(initial.recipients);
  const [userIds, setUserIds] = useState<string[]>(initial.userIds);
  const selection = useRef({ recipients: initial.recipients, userIds: initial.userIds });
  // "If empty, fill with". Undefined until the author touches one, so an untouched step keeps
  // the shape it had and the server's seeded default (lib/workflows/fallbacks.ts).
  const [fallbacks, setFallbacks] = useState<Record<string, string> | undefined>(() => storedFallbacks(config));

  const form = useForm<TextContentValues>({
    resolver: zodResolver(textContentSchema),
    mode: 'onChange',
    defaultValues: { body: String(config.body ?? '') },
  });
  const { register, watch, setValue, getValues, formState } = form;

  const push = (overrides?: { recipients?: AudienceKey[]; userIds?: string[]; fallbacks?: Record<string, string> }) => {
    const { recipients: rec, userIds: uIds } = Object.assign(selection.current, overrides);
    const cfg: Record<string, unknown> = { recipients: rec, body: getValues('body') };
    const legacyRecipient = toLegacySingularRecipient(rec);
    if (legacyRecipient) cfg.recipient = legacyRecipient;
    if (uIds.length > 0) cfg.user_ids = uIds;
    const fb = overrides?.fallbacks ?? fallbacks;
    if (fb) cfg.fallbacks = fb;
    onChange(cfg);
  };
  const onFallbackChange = (field: string, value: string) => {
    const next = { ...displayedFallbacks(fallbacks, catalog), [field]: value };
    setFallbacks(next);
    push({ fallbacks: next });
  };
  const apply = (name: string, value: string) => {
    setValue(name as 'body', value, { shouldDirty: true, shouldValidate: true });
    push();
  };
  const { insert, bind } = useMergeInsert(apply, 'body');

  const body = watch('body');
  const used = useMemo(() => new Set(mergeFieldsIn(body)), [body]);
  const mergeFields = catalog?.triggers[triggerType]?.mergeFields ?? [];
  const options = catalog?.audiences?.[triggerType]?.SEND_SMS ?? [];

  const len = body.length;
  const meterCls = len > SMS_LIMIT ? 'text-destructive' : len > 300 ? 'text-status-amber-emphasis' : 'text-muted-foreground';
  const bodyReg = register('body');

  return (
    <div className="space-y-4">
      <div>
        <Label className="mb-1.5 block text-sm font-semibold">Send to</Label>
        <RecipientMultiSelect
          options={options}
          recipients={recipients}
          userIds={userIds}
          onRecipientsChange={(next) => {
            setRecipients(next);
            push({ recipients: next });
          }}
          onUserIdsChange={(next) => {
            setUserIds(next);
            push({ userIds: next });
          }}
        />
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <Label htmlFor="sms-body" className="text-sm font-semibold">
            Message
          </Label>
          <span className={cn('text-xs font-medium tabular-nums', meterCls)}>{`${len} / ${SMS_LIMIT}`}</span>
        </div>
        <Textarea
          id="sms-body"
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
          placeholder={`Hi {{customer.first_name}}, a reminder from {{org.name}}${ELLIPSIS}`}
        />
        {formState.errors.body && (
          <p className="text-destructive mt-1 text-xs font-medium">{formState.errors.body.message}</p>
        )}
      </div>

      <MergeFieldChips
        fields={mergeFields}
        used={used}
        catalog={catalog}
        onInsert={insert}
        fallbacks={displayedFallbacks(fallbacks, catalog)}
        onFallbackChange={onFallbackChange}
      />

      <p className="bg-status-amber-subtle text-status-amber-emphasis rounded-md px-3 py-2 text-xs leading-relaxed">
        Every text is saved to the conversation of whoever it goes to, customer or team member.
        Anyone with no phone number on file is skipped, and the run history says who.
      </p>
    </div>
  );
}
