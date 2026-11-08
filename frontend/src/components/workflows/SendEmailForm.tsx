/**
 * SendEmailForm — configure a SEND_EMAIL step. `RecipientMultiSelect` renders the
 * legal v2.1 audiences for this trigger (catalog.audiences[trigger].SEND_EMAIL),
 * with its own reveals for a specific person (one or more) and custom addresses
 * (one or more). Subject + body both accept merge chips (the chip row inserts
 * into whichever of the two was focused last). Propagates the parsed config up
 * on every edit as the array shape: `{ recipients, subject, body, user_ids?,
 * custom_emails? }`; a legacy singular `recipient` (± the pre-v2.1
 * `assigned_techs` alias) is normalized to `recipients: [...]` on load so an
 * existing single-recipient workflow shows the right box ticked.
 */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { mergeFieldsIn } from '@/lib/workflows/stepSchemas';
import { useMergeInsert } from './useMergeInsert';
import MergeFieldChips from './MergeFieldChips';
import RecipientMultiSelect, { normalizeRecipientFields, toLegacySingularRecipient } from './RecipientMultiSelect';
import type { StepFormProps } from './SendTextForm';
import type { AudienceKey } from '@/lib/api/workflows';

/**
 * Subject/body constraints only — mirrors stepSchemas.ts's sendEmailConfigSchema
 * subject/body bounds exactly. Kept local: recipients[]/user_ids[]/custom_emails[]
 * are now owned by RecipientMultiSelect's own controlled state (not RHF/Zod), and
 * stepSchemas.ts's `recipient` enum is the legacy 6-member shape — out of scope here.
 */
const emailContentSchema = z.object({
  subject: z.string().min(1, 'Add a subject line').max(200, 'Subject is too long (200 characters max)'),
  body: z.string().min(1, 'Write the email').max(5000, 'Email is too long (5,000 characters max)'),
});
type EmailContentValues = z.infer<typeof emailContentSchema>;

export default function SendEmailForm({ config, triggerType, catalog, onChange }: StepFormProps) {
  const initial = useMemo(() => normalizeRecipientFields(config), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [recipients, setRecipients] = useState<AudienceKey[]>(initial.recipients);
  const [userIds, setUserIds] = useState<string[]>(initial.userIds);
  const [customEmails, setCustomEmails] = useState<string[]>(initial.customEmails);

  const form = useForm<EmailContentValues>({
    resolver: zodResolver(emailContentSchema),
    mode: 'onChange',
    defaultValues: {
      subject: String(config.subject ?? ''),
      body: String(config.body ?? ''),
    },
  });
  const { register, watch, setValue, getValues, formState } = form;

  // Pushes the current (or just-overridden) state up as one config object. Overrides
  // let the RecipientMultiSelect callbacks push the fresh value immediately — reading
  // component state here would still see the pre-setState snapshot in the same tick.
  const push = (overrides?: { recipients?: AudienceKey[]; userIds?: string[]; customEmails?: string[] }) => {
    const v = getValues();
    const rec = overrides?.recipients ?? recipients;
    const uIds = overrides?.userIds ?? userIds;
    const cEmails = overrides?.customEmails ?? customEmails;
    const cfg: Record<string, unknown> = { recipients: rec, subject: v.subject, body: v.body };
    const legacyRecipient = toLegacySingularRecipient(rec);
    if (legacyRecipient) cfg.recipient = legacyRecipient;
    if (uIds.length > 0) cfg.user_ids = uIds;
    if (cEmails.length > 0) cfg.custom_emails = cEmails;
    onChange(cfg);
  };
  const apply = (name: string, value: string) => {
    setValue(name as 'subject' | 'body', value, { shouldDirty: true, shouldValidate: true });
    push();
  };
  const { insert, bind } = useMergeInsert(apply, 'body');

  const subject = watch('subject');
  const body = watch('body');
  const used = useMemo(() => new Set([...mergeFieldsIn(subject), ...mergeFieldsIn(body)]), [subject, body]);
  const mergeFields = catalog?.triggers[triggerType]?.mergeFields ?? [];
  const options = catalog?.audiences?.[triggerType]?.SEND_EMAIL ?? [];

  const subjectReg = register('subject');
  const bodyReg = register('body');

  return (
    <div className="space-y-4">
      <div>
        <Label tone="strong" className="mb-1.5 block text-sm font-semibold">Send to</Label>
        <RecipientMultiSelect
          options={options}
          recipients={recipients}
          userIds={userIds}
          customEmails={customEmails}
          onRecipientsChange={(next) => {
            setRecipients(next);
            push({ recipients: next });
          }}
          onUserIdsChange={(next) => {
            setUserIds(next);
            push({ userIds: next });
          }}
          onCustomEmailsChange={(next) => {
            setCustomEmails(next);
            push({ customEmails: next });
          }}
        />
      </div>

      <div>
        <Label tone="strong" htmlFor="email-subject" className="mb-1.5 block text-sm font-semibold">
          Subject
        </Label>
        <Input
          id="email-subject"
          {...subjectReg}
          {...bind('subject', subjectReg.ref)}
          onChange={(e) => {
            subjectReg.onChange(e);
            push();
          }}
          onBlur={(e) => {
            subjectReg.onBlur(e);
            push();
          }}
          className="h-11"
          placeholder="Your appointment with {{org.name}}"
        />
        {formState.errors.subject && (
          <p className="mt-1 text-xs font-medium text-danger">{formState.errors.subject.message}</p>
        )}
      </div>

      <div>
        <Label tone="strong" htmlFor="email-body" className="mb-1.5 block text-sm font-semibold">
          Body
        </Label>
        <Textarea
          id="email-body"
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
          className="min-h-32"
          placeholder="Hi {{customer.first_name}}, …"
        />
        {formState.errors.body && <p className="mt-1 text-xs font-medium text-danger">{formState.errors.body.message}</p>}
      </div>

      <MergeFieldChips fields={mergeFields} used={used} catalog={catalog} onInsert={insert} />
    </div>
  );
}
