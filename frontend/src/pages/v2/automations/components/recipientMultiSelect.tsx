import { useState } from 'react';
import { X } from 'lucide-react';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { useAssignableUsers } from '@/lib/api/users';
import type { AudienceKey, AudienceOption } from '@/lib/api/workflows';

/**
 * The multi-select audience picker shared by the email and notify forms.
 *
 * One checkbox per legal `AudienceOption` as served by the catalog, already
 * channel- and entity-narrowed server-side. This component does NO filtering of
 * its own; recipient legality stays server-owned.
 *
 * Fully controlled: the parent owns `recipients` / `userIds` / `customEmails`.
 * The only state here is the transient text of the custom-email input, which is
 * not part of the emitted config until committed.
 *
 * The custom-address pair is OPTIONAL because the text channel has no such
 * audience: the catalog never serves `custom` on SEND_SMS, and a text step's
 * config schema is `.strict()` without a `custom_emails` field, so sendTextForm
 * has nothing to own and no no-op handler to fake. Omitting them is the honest
 * way to say "this channel cannot address a literal address".
 *
 * `normalizeRecipientFields` and `toLegacySingularRecipient` are re-exported
 * from the legacy module rather than copied. They fold the pre-v2.1 singular
 * fields and the `assigned_techs` alias, they are covered by that module's own
 * spec, and a second copy would drift.
 */
export {
  normalizeRecipientFields,
  toLegacySingularRecipient,
} from '@/components/workflows/RecipientMultiSelect';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RecipientMultiSelectProps {
  /** The legal audiences for the current trigger and channel, as served by the catalog. */
  options: AudienceOption[];
  recipients: AudienceKey[];
  userIds: string[];
  /** Omitted by channels with no custom-address audience - see the note above. */
  customEmails?: string[];
  onRecipientsChange: (recipients: AudienceKey[]) => void;
  onUserIdsChange: (userIds: string[]) => void;
  onCustomEmailsChange?: (customEmails: string[]) => void;
}

export default function RecipientMultiSelect({
  options,
  recipients,
  userIds,
  customEmails = [],
  onRecipientsChange,
  onUserIdsChange,
  onCustomEmailsChange,
}: RecipientMultiSelectProps) {
  function toggle(key: AudienceKey) {
    const next = recipients.includes(key) ? recipients.filter((k) => k !== key) : [...recipients, key];
    onRecipientsChange(next);
    // A revealed sub-picker hides when its audience is unticked. Drop its now
    // stale selection rather than leave an invisible orphaned value in the
    // saved config.
    if (key === 'specific_user' && !next.includes('specific_user') && userIds.length > 0) onUserIdsChange([]);
    if (key === 'custom' && !next.includes('custom') && customEmails.length > 0) onCustomEmailsChange?.([]);
  }

  return (
    <div className="space-y-2.5">
      {options.map((opt) => {
        const checked = recipients.includes(opt.key);
        return (
          <div key={opt.key}>
            <Label className="flex cursor-pointer items-center gap-2 text-sm font-normal">
              <Checkbox checked={checked} onCheckedChange={() => toggle(opt.key)} aria-label={opt.label} />
              <span>{opt.label}</span>
            </Label>
            {opt.hint && <p className="text-muted-foreground mt-0.5 pl-6 text-xs leading-relaxed">{opt.hint}</p>}
            {opt.key === 'specific_user' && checked && (
              <div className="ml-6 mt-1.5">
                <SpecificUserField userIds={userIds} onChange={onUserIdsChange} />
              </div>
            )}
            {opt.key === 'custom' && checked && onCustomEmailsChange && (
              <div className="ml-6 mt-1.5">
                <CustomEmailsField customEmails={customEmails} onChange={onCustomEmailsChange} />
              </div>
            )}
          </div>
        );
      })}
      {recipients.length === 0 && (
        <p className="text-destructive text-xs font-medium">Pick at least one recipient</p>
      )}
    </div>
  );
}

/** Multi-pick reveal for `specific_user`, over the assignable-users roster. */
function SpecificUserField({ userIds, onChange }: { userIds: string[]; onChange: (next: string[]) => void }) {
  // `directory`, not `task` - see the v1 twin. A workflow recipient is not an assignee, so no
  // assign grant governs this list and `read User` is the gate it has always had.
  const { data: users } = useAssignableUsers({ purpose: 'directory' });

  function toggle(id: string) {
    onChange(userIds.includes(id) ? userIds.filter((x) => x !== id) : [...userIds, id]);
  }

  return (
    <div className="border-border space-y-1.5 rounded-md border p-2.5">
      {(users ?? []).map((u) => {
        const fullName = `${u.first_name} ${u.last_name}`;
        return (
          <Label key={u.id} className="flex cursor-pointer items-center gap-2 text-sm font-normal">
            <Checkbox checked={userIds.includes(u.id)} onCheckedChange={() => toggle(u.id)} aria-label={fullName} />
            <span>{fullName}</span>
          </Label>
        );
      })}
      {userIds.length === 0 && <p className="text-destructive text-xs font-medium">Pick at least one team member</p>}
    </div>
  );
}

/** Multi-pick reveal for `custom`: type an address then Enter to add a chip. */
function CustomEmailsField({ customEmails, onChange }: { customEmails: string[]; onChange: (next: string[]) => void }) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  function tryAdd(raw: string) {
    const candidate = raw.trim().replace(/,$/, '').trim();
    if (!candidate) return;
    if (!EMAIL_RE.test(candidate)) {
      setError('Enter a valid email address');
      return;
    }
    if (customEmails.includes(candidate)) {
      setError('That address is already added');
      return;
    }
    onChange([...customEmails, candidate]);
    setInput('');
    setError(null);
  }

  function remove(email: string) {
    onChange(customEmails.filter((e) => e !== email));
    setError(null);
  }

  return (
    <div className="space-y-1.5">
      {customEmails.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {customEmails.map((email) => (
            <Badge key={email} variant="softNeutral" size="pill">
              {email}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => remove(email)}
                aria-label={`Remove ${email}`}
                className="size-4 rounded-full"
              >
                <X className="size-3" aria-hidden />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        type="email"
        placeholder="Add email and press Enter"
        aria-label="Custom email address"
        className="h-11"
        value={input}
        onChange={(e) => {
          const v = e.target.value;
          setError(null);
          if (v.endsWith(',')) {
            tryAdd(v);
          } else {
            setInput(v);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Tab') {
            if (input.trim()) {
              e.preventDefault();
              tryAdd(input);
            }
          } else if (e.key === 'Backspace' && !input && customEmails.length > 0) {
            const last = customEmails[customEmails.length - 1];
            if (last) remove(last);
          }
        }}
        onBlur={() => {
          if (input.trim()) tryAdd(input);
        }}
      />
      {error && <p className="text-destructive text-xs font-medium">{error}</p>}
      {customEmails.length === 0 && !error && (
        <p className="text-destructive text-xs font-medium">Enter at least one email address</p>
      )}
    </div>
  );
}
