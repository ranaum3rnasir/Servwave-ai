import { useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';

/**
 * EmailChipInput - the CC field, as a kit primitive.
 *
 * The keyboard contract - Enter/Tab/comma to commit, Backspace to take the last chip back, a max,
 * a dedupe, an inline error - was first written at components/ui/email-chip-input.tsx, in the v1
 * chrome that no v2 page could import from. That file has since been deleted with the rest of the
 * v1 schedule fork, so this is now the ONLY copy rather than the second one.
 *
 * The v1 original also carried a note that SendEstimateDialog and SendInvoiceDialog each grew
 * their own copy of this contract and were deliberately left alone - live money paths, no
 * user-visible payoff in swapping their internals. Those two copies still exist, still in the
 * v1 chrome. They are the follow-up, and they are why this lives in the kit rather than inside the
 * schedule module: the next surface that needs a CC field must have somewhere to find one.
 */
interface EmailChipInputProps {
  id: string;
  label: ReactNode;
  emails: string[];
  onChange: (next: string[]) => void;
  /** Cap, mirroring the server's `.max(5)` on notify_cc_emails. */
  max?: number;
  /**
   * Addresses already spoken for elsewhere in the form (the To field). Adding one here would
   * send the same person two copies, so it is refused with a reason rather than silently dropped.
   */
  reserved?: string[];
  placeholder?: string;
  disabled?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailChipInput({
  id,
  label,
  emails,
  onChange,
  max = 5,
  reserved = [],
  placeholder = 'Add email and press Enter',
  disabled = false,
}: EmailChipInputProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  function tryAdd(raw: string) {
    const candidate = raw.replace(/,$/, '').trim().toLowerCase();
    if (!candidate) return;
    if (!EMAIL_RE.test(candidate)) {
      setError('Enter a valid email address');
      return;
    }
    if (emails.includes(candidate) || reserved.some((r) => r.trim().toLowerCase() === candidate)) {
      setError('That address is already on this email');
      return;
    }
    if (emails.length >= max) {
      setError(`Up to ${max} CC addresses`);
      return;
    }
    onChange([...emails, candidate]);
    setDraft('');
    setError(null);
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>

      {emails.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {emails.map((email) => (
            <span
              key={email}
              className="bg-muted text-foreground inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs"
            >
              {email}
              <button
                type="button"
                onClick={() => onChange(emails.filter((e) => e !== email))}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${email}`}
                disabled={disabled}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <Input
        id={id}
        type="email"
        placeholder={placeholder}
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          const v = e.target.value;
          setError(null);
          // A trailing comma is a commit, matching how people paste address lists.
          if (v.endsWith(',')) tryAdd(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Tab') {
            if (draft.trim()) {
              e.preventDefault();
              tryAdd(draft);
            }
          } else if (e.key === 'Backspace' && !draft && emails.length > 0) {
            // Take the last chip back into the input rather than deleting it outright - a typo in
            // a long address should be fixable, not retyped.
            onChange(emails.slice(0, -1));
            setDraft(emails[emails.length - 1] ?? '');
          }
        }}
        // Committing on blur too: a user who types an address and clicks Send means to include
        // it, and losing it silently is the worst outcome here.
        onBlur={() => { if (draft.trim()) tryAdd(draft); }}
      />

      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}

export default EmailChipInput;
