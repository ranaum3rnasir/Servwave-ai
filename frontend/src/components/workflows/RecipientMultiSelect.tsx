/**
 * RecipientMultiSelect — the v2.1 multi-select audience picker shared by
 * SendEmailForm and NotifyTeamForm. Renders a checkbox per legal `AudienceOption`
 * (as served by the catalog's `audiences[trigger][action]`, already channel- and
 * entity-narrowed server-side — this component does no filtering of its own).
 * Ticking `specific_user` reveals a multi-pick team-member checkbox list (reusing
 * the assignable-users data source the old single-Select specific-user reveal
 * used); ticking `custom` (SEND_EMAIL only — simply absent from `options`
 * otherwise) reveals a chip-style multi-email field (same "type + Enter" pattern
 * as the estimate/invoice send dialogs' CC field). Every not-guaranteed audience's
 * `hint` (e.g. salesperson) renders as light helper text under its row.
 *
 * Fully controlled: the parent form owns `recipients`/`userIds`/`customEmails`
 * and re-renders this with the next value on every change — this component holds
 * no selection state of its own (only the transient text of the custom-email
 * input, which isn't part of the emitted config until committed).
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useAssignableUsers } from '@/lib/api/users';
import type { AudienceKey, AudienceOption } from '@/lib/api/workflows';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface RecipientMultiSelectProps {
  /** The legal audiences for the current trigger + channel, as served by the catalog. */
  options: AudienceOption[];
  recipients: AudienceKey[];
  userIds: string[];
  customEmails: string[];
  onRecipientsChange: (recipients: AudienceKey[]) => void;
  onUserIdsChange: (userIds: string[]) => void;
  onCustomEmailsChange: (customEmails: string[]) => void;
}

export default function RecipientMultiSelect({
  options,
  recipients,
  userIds,
  customEmails,
  onRecipientsChange,
  onUserIdsChange,
  onCustomEmailsChange,
}: RecipientMultiSelectProps) {
  function toggle(key: AudienceKey) {
    const next = recipients.includes(key) ? recipients.filter((k) => k !== key) : [...recipients, key];
    onRecipientsChange(next);
    // Revealed sub-pickers hide when their audience is unticked — drop their now-stale
    // selection rather than leave an invisible orphaned value in the saved config.
    if (key === 'specific_user' && !next.includes('specific_user') && userIds.length > 0) onUserIdsChange([]);
    if (key === 'custom' && !next.includes('custom') && customEmails.length > 0) onCustomEmailsChange([]);
  }

  return (
    <div className="space-y-2.5">
      {options.map((opt) => {
        const checked = recipients.includes(opt.key);
        return (
          <div key={opt.key}>
            {/* Checkbox row (label wraps its control) - not a FormField-shape site, left raw. */}
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
              <Checkbox checked={checked} onCheckedChange={() => toggle(opt.key)} aria-label={opt.label} />
              <span>{opt.label}</span>
            </label>
            {opt.hint && <p className="mt-0.5 pl-6 text-xs leading-relaxed text-text-secondary">{opt.hint}</p>}
            {opt.key === 'specific_user' && checked && (
              <div className="ml-6 mt-1.5">
                <SpecificUserField userIds={userIds} onChange={onUserIdsChange} />
              </div>
            )}
            {opt.key === 'custom' && checked && (
              <div className="ml-6 mt-1.5">
                <CustomEmailsField customEmails={customEmails} onChange={onCustomEmailsChange} />
              </div>
            )}
          </div>
        );
      })}
      {recipients.length === 0 && <p className="text-xs font-medium text-danger">Pick at least one recipient</p>}
    </div>
  );
}

/** Multi-pick reveal for `specific_user` — checkbox list over the assignable-users roster. */
function SpecificUserField({ userIds, onChange }: { userIds: string[]; onChange: (next: string[]) => void }) {
  // `directory`, not `task`: nothing here is assigned to anybody. This list feeds a workflow
  // step's "To" field, whose save never touches `isAssigneeSetPermitted` (or any assign grant),
  // so the pool is not the rule that governs it. `read User` is - which is what gated this list
  // when it read the staff directory.
  const { data: users } = useAssignableUsers({ purpose: 'directory' });

  function toggle(id: string) {
    onChange(userIds.includes(id) ? userIds.filter((x) => x !== id) : [...userIds, id]);
  }

  return (
    <div className="space-y-1.5 rounded border border-border p-2.5">
      {(users ?? []).map((u) => {
        const fullName = `${u.first_name} ${u.last_name}`;
        return (
          // Checkbox row (label wraps its control) - not a FormField-shape site, left raw.
          <label key={u.id} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
            <Checkbox checked={userIds.includes(u.id)} onCheckedChange={() => toggle(u.id)} aria-label={fullName} />
            <span>{fullName}</span>
          </label>
        );
      })}
      {userIds.length === 0 && <p className="text-xs font-medium text-danger">Pick at least one team member</p>}
    </div>
  );
}

/** Multi-pick reveal for `custom` — type an address + Enter to add a chip (mirrors the
 * estimate/invoice send dialogs' CC field). */
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
            <span
              key={email}
              className="inline-flex items-center gap-1 rounded-full bg-neutral-surface px-2.5 py-1 text-xs text-text-primary"
            >
              {email}
              {/* Deferred: a small close-X affordance inside a chip - exactly
                  the shape the program's never-convert list names. */}
              <button
                type="button"
                onClick={() => remove(email)}
                className="text-text-secondary hover:text-text-primary"
                aria-label={`Remove ${email}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
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
      {error && <p className="text-xs font-medium text-danger">{error}</p>}
      {customEmails.length === 0 && !error && (
        <p className="text-xs font-medium text-danger">Enter at least one email address</p>
      )}
    </div>
  );
}

/**
 * Normalizes a step config's recipient fields to the v2.1 array shape for the
 * multi-select's initial state, folding the legacy singular fields (mirrors the
 * backend's normalizeMessagingConfig / the FE stepSchemas.ts withRecipientsArray
 * preprocess) PLUS the pre-v2.1 `assigned_techs` alias — the old NotifyTeamForm's
 * single-Select wrote that literal key, and the new catalog only advertises the
 * canonical `assigned_team` — so an existing single-recipient workflow still shows
 * the right box ticked on load.
 */
export function normalizeRecipientFields(config: Record<string, unknown>): {
  recipients: AudienceKey[];
  userIds: string[];
  customEmails: string[];
} {
  const recipients = Array.isArray(config.recipients)
    ? config.recipients.filter((r): r is string => typeof r === 'string').map(foldLegacyAudienceKey)
    : typeof config.recipient === 'string'
      ? [foldLegacyAudienceKey(config.recipient)]
      : [];

  const userIds = Array.isArray(config.user_ids)
    ? config.user_ids.filter((u): u is string => typeof u === 'string')
    : typeof config.user_id === 'string' && config.user_id.trim()
      ? [config.user_id]
      : [];

  const customEmails = Array.isArray(config.custom_emails)
    ? config.custom_emails.filter((e): e is string => typeof e === 'string')
    : typeof config.custom_email === 'string' && config.custom_email.trim()
      ? [config.custom_email]
      : [];

  return { recipients, userIds, customEmails };
}

function foldLegacyAudienceKey(key: string): AudienceKey {
  return key === 'assigned_techs' ? 'assigned_team' : (key as AudienceKey);
}

/**
 * Best-effort mirror of the v2.1 array back onto the pre-v2.1 singular
 * `recipient` field, for the single-recipient case only (undefined for zero or
 * 2+ recipients — nothing sensible to mirror). Purely a compatibility shim: the
 * FE-only bubble/recipe sentence helpers (stepSentence.ts, describeWorkflow.ts)
 * still read `config.recipient` and are out of this task's scope, so without
 * this a freshly multi-select-configured step would show a generic "the
 * recipient" fallback even in the common single-pick case. The backend drops
 * `recipient` unconditionally once folded (normalizeMessagingConfig), so
 * sending both fields alongside `recipients[]` is safe — `recipients` wins.
 */
export function toLegacySingularRecipient(recipients: AudienceKey[]): string | undefined {
  if (recipients.length !== 1) return undefined;
  const key = recipients[0];
  return key === 'assigned_team' ? 'assigned_techs' : key;
}
