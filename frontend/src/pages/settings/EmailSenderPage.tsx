import { useState } from 'react';
import { Mail } from 'lucide-react';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { useSendingIdentity } from '@/lib/api/communication';
import { useUpdateEmailSender, emailSenderErrorMessage } from '@/lib/api/emailSender';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { Heading } from '@/components/ui/heading';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/use-toast';

/**
 * Settings -> Sender Address.
 *
 * Replaces the guided custom-domain page. Sending is IN-HOUSE: every org sends
 * from the one shared platform domain, whose DNS is configured centrally and
 * once, so no org ever publishes a record or verifies anything. The page that
 * used to live here offered the opposite model - "add your own domain" - which
 * still worked and therefore contradicted the decision rather than merely
 * describing it wrongly.
 *
 * What an org CAN choose is the local part: the string before the `@`. The
 * domain renders as a fixed, non-editable suffix, and the backend refuses a
 * value containing `@` for the same reason.
 *
 * Default is DERIVED from the company name and stored as NULL, so an org that
 * never touches this keeps behaving exactly as it did before the setting
 * existed, including following a company rename. Clearing the field returns it
 * to that state rather than blanking the address.
 *
 * Admin-only, gated the same AND way the old page was: CASL `update
 * Organization` plus the `email` entitlement, repeated here so a direct URL hit
 * renders nothing and never fetches.
 */

/** Mirrors the backend's own rule (organization.controller.ts): letters and
 *  digits only, capped, so the field can reject before a round trip. */
const LOCAL_PART_RE = /^[a-z0-9]*$/;
const MAX_LOCAL_PART = 40;

export default function EmailSenderPage() {
  const ability = useAppAbility();
  const canManage = ability.can('update', 'Organization');
  const canEmail = useFeature('email');
  // useFeature fails open by design, so the CASL half is what actually protects
  // a non-admin here.
  const gated = canManage && canEmail;

  const { data: identity, isLoading, isError } = useSendingIdentity();
  const update = useUpdateEmailSender();

  // The server value is NOT mirrored into state. `draft` is null until the
  // admin types, and the field simply reads through to the server value until
  // then - so there is nothing to re-sync when the query resolves or refetches
  // (the mutation invalidates this very query), and nothing that can overwrite
  // what is being typed. An effect that seeded state from `identity` would do
  // the same job with a cascading render and a stale window on first paint.
  const [draft, setDraft] = useState<string | null>(null);

  if (!gated) return null;

  if (isLoading) {
    return (
      <Card className="space-y-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-8 w-full" />
      </Card>
    );
  }

  if (isError || !identity) {
    return (
      <Card>
        <p className="text-sm text-text-secondary">
          Could not load your sending address. Refresh to try again.
        </p>
      </Card>
    );
  }

  // Reads through to the server until the admin has typed something.
  const value = draft ?? identity.localPart;
  const trimmed = value.trim().toLowerCase();
  const invalidChars = !LOCAL_PART_RE.test(trimmed);
  const tooLong = trimmed.length > MAX_LOCAL_PART;
  // Empty is legal - it means "go back to the company-name default" - so it is
  // never an error, only a different kind of save.
  const localError = invalidChars
    ? 'Use letters and numbers only, with no spaces, dots or @'
    : tooLong
      ? `Use at most ${MAX_LOCAL_PART} characters`
      : null;

  const unchanged = trimmed === identity.localPart;
  const canSave = !localError && !unchanged && !update.isPending;

  function save() {
    update.mutate(trimmed, {
      onSuccess: (res) => {
        // Drop back to reading through to the server, which the invalidated
        // query is about to refetch with exactly what was just saved.
        setDraft(null);
        toast({
          description: res.local_part_is_custom
            ? `Now sending from ${res.local_part}@${res.sender_domain}`
            : `Back to the default, ${res.local_part}@${res.sender_domain}`,
        });
      },
      onError: (err) => {
        toast({ description: emailSenderErrorMessage(err), variant: 'destructive' });
      },
    });
  }

  const preview = `${trimmed || identity.localPart}@${identity.senderDomain}`;

  return (
    <Card className="space-y-4">
      <div className="flex items-start gap-3">
        <Mail className="mt-0.5 h-4 w-4 flex-none text-text-secondary" aria-hidden="true" />
        <div className="space-y-1">
          <Heading level={3}>Sender address</Heading>
          <p className="text-sm text-text-secondary">
            The address your customers see on estimates, invoices and receipts. The domain is
            managed by ServWave and is the same for every account - you choose the part before
            the @.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email-sender-local-part">Address</Label>
        <div className="flex items-center gap-2">
          <Input
            id="email-sender-local-part"
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={identity.localPart}
            aria-describedby="email-sender-help"
            aria-invalid={Boolean(localError)}
            maxLength={MAX_LOCAL_PART + 10}
          />
          {/* Fixed suffix, deliberately NOT an input: the domain is not the
              org's to choose, and rendering it as editable would re-offer the
              custom-domain model this page exists to retire.

              It sits BESIDE the field rather than welded to it. Squaring the
              two inner corners would mean passing `rounded-r-none` into
              <Input>, and appearance belongs to the primitive, not the call
              site (design-system/__tests__/layering-guard.test.ts). A gap says
              the same thing: the domain is plainly not part of what you type. */}
          <span className="flex-none whitespace-nowrap text-sm text-text-secondary">
            @{identity.senderDomain}
          </span>
        </div>
        <p id="email-sender-help" className="text-[12px] text-text-secondary">
          {localError ? (
            <span className="text-danger-text">{localError}</span>
          ) : identity.localPartIsCustom ? (
            <>Sending as <span className="font-medium text-text-primary">{preview}</span>. Clear the field to go back to your company name.</>
          ) : (
            <>Currently follows your company name. Sending as <span className="font-medium text-text-primary">{preview}</span>.</>
          )}
        </p>
      </div>

      {/* Not a cosmetic setting: reply THREADING is safe either way (replies
          route on a per-thread token, never on this address), but anyone who
          saved the old address or filters mail on it is silently affected. */}
      <Alert tone="warning" role="status">
        Changing this changes the address on every future email. Customers who saved the old one,
        or filter mail by it, will not match the new address.
      </Alert>

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={!canSave}>
          {update.isPending ? 'Saving...' : 'Save'}
        </Button>
        {!unchanged && (
          <Button
            variant="ghost"
            onClick={() => setDraft(null)}
            disabled={update.isPending}
          >
            Cancel
          </Button>
        )}
      </div>
    </Card>
  );
}
