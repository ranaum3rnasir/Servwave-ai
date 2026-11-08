import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Textarea } from '@/ui-kit/components/ui/textarea';
import { mergeFieldsIn } from '@/lib/workflows/stepSchemas';
import { displayedFallbacks, storedFallbacks } from '@/lib/workflows/fallbacks';
import { useMergeInsert } from '@/components/workflows/useMergeInsert';
import type { AudienceKey } from '@/lib/api/workflows';

import { ELLIPSIS } from './glyphs';
import MergeFieldChips from './mergeFieldChips';
import RecipientMultiSelect, { normalizeRecipientFields, toLegacySingularRecipient } from './recipientMultiSelect';
import type { StepFormProps } from './sendTextForm';

/**
 * A SEND_EMAIL step. Ownership is deliberately split: react-hook-form covers
 * the COPY only, while recipients / user ids / custom emails live in plain
 * `useState` owned by RecipientMultiSelect's controlled contract.
 *
 * That is not tidiness lost. `stepSchemas.ts`'s recipient enums are the legacy
 * 6-member vocabulary while the picker speaks the 9-member catalog `AudienceKey`
 * set, so a local content-only schema is the only honest fit and recipient
 * legality stays server-owned. Do not unify them.
 *
 * `push(overrides?)` exists because reading state right after `setState` in the
 * same tick would push the stale snapshot.
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
  // "If empty, fill with". Undefined until the author touches one, so an untouched step keeps
  // the shape it had and the server's seeded default (lib/workflows/fallbacks.ts).
  const [fallbacks, setFallbacks] = useState<Record<string, string> | undefined>(() => storedFallbacks(config));

  const form = useForm<EmailContentValues>({
    resolver: zodResolver(emailContentSchema),
    mode: 'onChange',
    defaultValues: {
      subject: String(config.subject ?? ''),
      body: String(config.body ?? ''),
    },
  });
  const { register, watch, setValue, getValues, formState } = form;

  const push = (overrides?: {
    recipients?: AudienceKey[];
    userIds?: string[];
    customEmails?: string[];
    fallbacks?: Record<string, string>;
  }) => {
    const v = getValues();
    const rec = overrides?.recipients ?? recipients;
    const uIds = overrides?.userIds ?? userIds;
    const cEmails = overrides?.customEmails ?? customEmails;
    const fb = overrides?.fallbacks ?? fallbacks;
    const cfg: Record<string, unknown> = { recipients: rec, subject: v.subject, body: v.body };
    const legacyRecipient = toLegacySingularRecipient(rec);
    if (legacyRecipient) cfg.recipient = legacyRecipient;
    if (uIds.length > 0) cfg.user_ids = uIds;
    if (cEmails.length > 0) cfg.custom_emails = cEmails;
    if (fb) cfg.fallbacks = fb;
    onChange(cfg);
  };
  const onFallbackChange = (field: string, value: string) => {
    const next = { ...displayedFallbacks(fallbacks, catalog), [field]: value };
    setFallbacks(next);
    push({ fallbacks: next });
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
        <Label className="mb-1.5 block text-sm font-semibold">Send to</Label>
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
        <Label htmlFor="email-subject" className="mb-1.5 block text-sm font-semibold">
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
          <p className="text-destructive mt-1 text-xs font-medium">{formState.errors.subject.message}</p>
        )}
      </div>

      <div>
        <Label htmlFor="email-body" className="mb-1.5 block text-sm font-semibold">
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
          placeholder={`Hi {{customer.first_name}}, ${ELLIPSIS}`}
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
    </div>
  );
}
