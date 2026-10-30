import { useState } from 'react';
import { Check, Copy, Mail } from 'lucide-react';

import { useFeature } from '@/lib/entitlements';
import { useMyMailbox } from '@/lib/api/communication';

import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';

/** What a person in "address needed" is told, on the Email page: the PRD's sentence, word for word. */
export const ADDRESS_NEEDED_MESSAGE =
  "You don't have an email address yet. An admin needs to set one before you can send email.";

/**
 * The signed-in person's own email address (PRD 10), shown in two places: a strip at the top of the Email page
 * (`banner`) and a field on their profile (`field`). An active mailbox shows its address with a copy button; one in
 * "address needed" shows the sentence above and no address. It shows nothing for a person with no mailbox, while the
 * address is loading, and while the company lacks the Email plan feature (the server answers 402 then, and the
 * question is not even asked). `compact` (a phone's banner) keeps it to a row: the address (it breaks, never clips) and Copy, with the label
 * left for a screen reader, so the list below gets the screen.
 */
export function MyMailboxAddress({ variant, compact = false }: { variant: 'banner' | 'field'; compact?: boolean }) {
  const hasEmail = useFeature('email');
  const { data } = useMyMailbox();
  const mailbox = data?.mailbox;
  if (!hasEmail || !mailbox) return null;

  const label = variant === 'banner' ? 'Your email address' : 'Company email address';

  if (!mailbox.address) {
    return (
      <p
        role="status"
        className={cn(
          'text-sm',
          variant === 'banner' && 'bg-kit-card mb-3 flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2',
          variant === 'field' && 'text-muted-foreground',
        )}
      >
        {variant === 'banner' && <Mail className="text-muted-foreground size-4 shrink-0" aria-hidden />}
        {ADDRESS_NEEDED_MESSAGE}
      </p>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center gap-x-2 gap-y-1 text-sm',
        !compact && 'flex-wrap',
        variant === 'banner' && 'bg-kit-card mb-3 shrink-0 rounded-lg border px-3',
        variant === 'banner' && (compact ? 'py-1 pr-1' : 'py-2'),
      )}
    >
      {variant === 'banner' && <Mail className="text-muted-foreground size-4 shrink-0" aria-hidden />}
      <span className={compact ? 'sr-only' : 'text-muted-foreground'}>{label}</span>
      <span className={cn('min-w-0 font-medium break-all', compact && 'flex-1')}>{mailbox.address}</span>
      <CopyAddressButton address={mailbox.address} />
      {variant === 'field' && (
        <p className="text-muted-foreground w-full text-xs">
          Customers can write to you here. It is not the email you sign in with.
        </p>
      )}
    </div>
  );
}

/** A Copy button for an address: the person's own on the Email page and profile, anyone's on the Users page. */
export function CopyAddressButton({ address, label = 'Copy your email address' }: { address: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
