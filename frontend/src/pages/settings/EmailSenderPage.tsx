import { useState } from 'react';
import { Mail } from 'lucide-react';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { useEmailSender, useUpdateEmailSender, useCheckEmailSender, emailSenderErrorMessage } from '@/lib/api/emailSender';
import NotAuthorizedPage from '@/components/NotAuthorizedPage';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Heading } from '@/components/ui/heading';
import { Skeleton } from '@/components/ui/skeleton';
import { MainMailboxReaders } from '@/pages/settings/MainMailboxReaders';
import { toast } from '@/components/ui/use-toast';

/**
 * Settings -> Sender Address.
 *
 * Sending is IN-HOUSE: every company sends from the one shared domain, whose DNS is configured centrally and once, so
 * no company ever publishes a record or verifies anything. What a company CAN choose is the company part: the string
 * before the `@` in its main address, and the last piece of everyone's own address (first.last.<company part>). The
 * domain renders as a fixed, non-editable suffix, and the backend refuses a value containing `@` for the same reason.
 *
 * Changing the part gives everyone a new address while every old one keeps receiving forever and is never given to
 * anyone else, so Save asks first. The server decides whether the part is free (never saying whose it is); its answer
 * is shown under the field.
 *
 * The default is DERIVED from the company name. Clearing the field returns to that rather than blanking the address.
 *
 * Gated like the Settings nav row: CASL `update Organization` (Company settings) plus the `email` entitlement, repeated
 * here so a direct URL hit never fetches and draws the same "no access" page as the other settings pages.
 *
 * Save asks the server first (a dry run of the change) and only a part it would accept reaches the warning, so a reserved
 * or taken part is refused under the field and the warning never promises an address that cannot exist.
 */

/** Mirrors the backend's own rule (organization.controller.ts): letters and digits only, capped, so the field can
 *  reject before a round trip. */
const LOCAL_PART_RE = /^[a-z0-9]*$/;
const MAX_LOCAL_PART = 40;

export default function EmailSenderPage() {
  const ability = useAppAbility();
  const canManage = ability.can('update', 'Organization');
  const canEmail = useFeature('email');
  // useFeature fails open by design, so the CASL half is what actually protects a person without Company settings here.
  const gated = canManage && canEmail;

  const { data: sender, isLoading, isError } = useEmailSender(gated);
  const update = useUpdateEmailSender();
  const check = useCheckEmailSender();

  // The server value is NOT mirrored into state. `draft` is null until the person types, and the field reads through to
  // the server value until then - so there is nothing to re-sync when the query resolves or refetches (the save
  // invalidates this very query), and nothing that can overwrite what is being typed.
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The server's refusal of the last save, shown under the field until the person edits it.
  const [refusal, setRefusal] = useState<string | null>(null);

  if (!gated) return <NotAuthorizedPage />;

  if (isLoading) {
    return (
      <Card className="space-y-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-8 w-full" />
      </Card>
    );
  }

  if (isError || !sender) {
    return (
      <Card>
        <p className="text-sm text-text-secondary">Could not load your sender address. Refresh to try again.</p>
      </Card>
    );
  }

  // Reads through to the server until the person has typed something.
  const value = draft ?? sender.local_part;
  const trimmed = value.trim().toLowerCase();
  const invalidChars = !LOCAL_PART_RE.test(trimmed);
  const tooLong = trimmed.length > MAX_LOCAL_PART;
  // Empty is legal - it means "go back to the company-name default" - so it is never an error, only a different save.
  const localError = invalidChars
    ? 'Use letters and numbers only, with no spaces, dots or @'
    : tooLong
      ? `Use at most ${MAX_LOCAL_PART} characters`
      : null;
  const shownError = localError ?? refusal;

  const unchanged = trimmed === sender.local_part;
  const canSave = !localError && !unchanged && !update.isPending && !check.isPending;
  const goingBackToName = trimmed === '';

  // The server judges the part before anything is said about changing everyone's address: a refusal is shown under the
  // field in the server's words and the warning never opens.
  function askToSave() {
    setRefusal(null);
    check.mutate(trimmed, {
      onSuccess: () => setConfirming(true),
      onError: (err) => setRefusal(emailSenderErrorMessage(err)),
    });
  }

  function save() {
    update.mutate(trimmed, {
      onSuccess: (res) => {
        // Drop back to reading through to the server, which the invalidated query is about to refetch with exactly
        // what was just saved.
        setDraft(null);
        setConfirming(false);
        toast({ description: `Addresses changed. Your main address is now ${res.local_part}@${res.sender_domain}.` });
      },
      onError: (err) => {
        setConfirming(false);
        setRefusal(emailSenderErrorMessage(err));
      },
    });
  }

  const preview = `${trimmed || sender.local_part}@${sender.sender_domain}`;

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div className="flex items-start gap-3">
          <Mail className="mt-0.5 h-4 w-4 flex-none text-text-secondary" aria-hidden="true" />
          <div className="min-w-0 space-y-1">
            <Heading level={3}>Sender address</Heading>
            <p className="text-sm text-text-secondary">
              Your main address is used for automated email. Email a person writes and sends by hand goes from their own
              address.
            </p>
            <p className="text-sm text-text-secondary">
              Everyone at your company has their own address on the same domain, made from their name and the company part
              below.
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <span id="email-sender-main-label" className="text-sm font-medium text-text-primary">Main address</span>
          <p aria-labelledby="email-sender-main-label" className="break-all text-sm text-text-primary">
            {sender.address}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email-sender-local-part">Company part</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="email-sender-local-part"
              className="min-w-0 flex-1"
              value={value}
              onChange={(e) => {
                setDraft(e.target.value);
                setRefusal(null);
              }}
              placeholder={sender.local_part}
              aria-describedby="email-sender-help"
              aria-invalid={Boolean(shownError)}
              maxLength={MAX_LOCAL_PART + 10}
            />
            {/* Fixed suffix, deliberately NOT an input: the domain is not the company's to choose, and rendering it as
                editable would re-offer the custom-domain model this page exists to retire.

                It sits BESIDE the field rather than welded to it. Squaring the two inner corners would mean passing
                `rounded-r-none` into <Input>, and appearance belongs to the primitive, not the call site
                (design-system/__tests__/layering-guard.test.ts). A gap says the same thing: the domain is plainly not part
                of what you type. */}
            <span className="max-w-full break-all text-sm text-text-secondary">@{sender.sender_domain}</span>
          </div>
          <p id="email-sender-help" className="text-[12px] text-text-secondary">
            {shownError ? (
              <span className="text-danger-text">{shownError}</span>
            ) : sender.local_part_is_custom ? (
              <>Your main address is <span className="break-all font-medium text-text-primary">{preview}</span>. Clear the field to go back to your company name.</>
            ) : (
              <>Currently follows your company name. Your main address is <span className="break-all font-medium text-text-primary">{preview}</span>.</>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={askToSave} disabled={!canSave}>
            Save
          </Button>
          {!unchanged && (
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setRefusal(null);
              }}
              disabled={update.isPending}
            >
              Cancel
            </Button>
          )}
        </div>

        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title="Change everyone's email address?"
          description={
            <>
              Everyone at your company gets a new address. Every old address keeps receiving email forever and is never given
              to anyone else.
            </>
          }
          confirmLabel="Change addresses"
          isLoading={update.isPending}
          onConfirm={save}
        >
          <p className="break-all text-sm text-text-secondary">
            {goingBackToName ? (
              'Your main address will follow your company name.'
            ) : (
              <>Your main address will be <span className="font-medium text-text-primary">{preview}</span>.</>
            )}
          </p>
        </ConfirmDialog>
      </Card>
      <MainMailboxReaders />
    </div>
  );
}
