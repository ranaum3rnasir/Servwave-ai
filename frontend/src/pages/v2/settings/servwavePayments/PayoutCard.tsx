import { useEffect, useState } from 'react';
import {
  ConnectAccountManagement,
  ConnectAccountOnboarding,
  ConnectComponentsProvider,
  ConnectNotificationBanner,
} from '@stripe/react-connect-js';
import { Check, Clock, ExternalLink, Lock, TriangleAlert } from 'lucide-react';

import { toast } from '@/components/ui/use-toast';
import { NewTabLink } from '@/components/ui/new-tab-link';
import { TintBadge, deriveStripeState, type TintTone } from '@/components/payments/PaymentsStatusCard';
import {
  useAcceptPaymentsTerms,
  useConnectStripe,
  useRefreshStripeStatus,
  useStatementDescriptor,
  useStripeAccountLink,
  type StripeStatus,
  type VerificationValue,
} from '@/lib/api/shared/organization';
import { FEE_SCHEDULE_URL, PAYMENTS_TERMS_URL } from '@/lib/legal-urls';
import { payoutAccountState } from '@/lib/payments/payout-account-state';
import { discardPayoutConnect, getPayoutConnect, onSessionRequestSucceeded } from '@/lib/payments/payout-connect';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { cn } from '@/ui-kit/lib/utils';

import { FirstPayoutNotice } from '@/components/payments/FirstPayoutNotice';

import { InfoPopover } from '../../_shared/infoPopover';

// Module-level, not inline in the JSX: the embedded component remounts whenever this prop changes identity,
// and an inline literal is a new object on every render.
// currently_due = collect only what is due now, so card payments can start before the bank is verified.
const ONBOARDING_COLLECTION_OPTIONS = { fields: 'currently_due', futureRequirements: 'omit' } as const;
// Everything, what is only due later included: the "Add details now" form, the banner and account management. Without
// it a co-owner's details stay unasked and unshown until a volume threshold makes them due and payouts pause.
const ALL_COLLECTION_OPTIONS = { fields: 'eventually_due', futureRequirements: 'include' } as const;

const VERIFICATION_ROWS: ReadonlyArray<readonly [keyof NonNullable<StripeStatus['verification']>, string]> = [
  ['business_details', 'Business details'],
  ['owner_identity', 'Owner identity'],
  ['bank_account', 'Bank account'],
  ['tax_id', 'Tax ID'],
];

const VERIFICATION_PILL: Record<VerificationValue, { label: string; tone: TintTone }> = {
  verified: { label: 'Verified', tone: 'success' },
  pending: { label: 'Pending', tone: 'neutral' },
  not_started: { label: 'Not started', tone: 'neutral' },
  due_later: { label: 'Due later', tone: 'neutral' },
  action_needed: { label: 'Action needed', tone: 'warning' },
  restricted: { label: 'Restricted', tone: 'danger' },
};

function VerificationGroup({ verification }: { verification: NonNullable<StripeStatus['verification']> }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] font-semibold">Verification</p>
      <ul className="flex flex-col">
        {VERIFICATION_ROWS.map(([key, label]) => {
          const value = verification[key];
          const pill = VERIFICATION_PILL[value] ?? VERIFICATION_PILL.pending;
          const Icon = value === 'verified' ? Check : value === 'not_started' || value === 'due_later' ? Clock : TriangleAlert;
          return (
            <li key={key} className="flex min-h-11 items-center gap-3 border-b border-border-soft last:border-b-0">
              <Icon aria-hidden className="size-4 shrink-0 text-text-secondary" />
              <span className="flex-1 text-sm">{label}</span>
              <TintBadge tone={pill.tone}>{pill.label}</TintBadge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What a customer reads on their card statement: shown, never edited (ServWave sets it). */
function StatementDescriptorGroup() {
  const { data } = useStatementDescriptor();
  const value = data?.statement_descriptor ?? '';
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Label htmlFor="statement-descriptor" className="text-[13px] font-semibold">
          Statement descriptor
        </Label>
        <InfoPopover label="statement descriptor">
          How a charge from you reads on your customers’ card statements. ServWave sets it; to change it, contact ServWave support.
        </InfoPopover>
      </div>
      <div className="relative max-w-90">
        <Input
          id="statement-descriptor"
          readOnly
          aria-readonly="true"
          value={value}
          data-testid="statement-descriptor"
          className="bg-muted pr-9 font-semibold tracking-wide max-sm:h-11"
        />
        <Lock aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-text-secondary" />
      </div>
      {value && (
        <div
          aria-label="Example statement line"
          className="flex max-w-90 items-center justify-between gap-3 rounded-lg border border-border bg-surface-light px-3.5 py-2.5 font-mono text-[12.5px]"
        >
          <span className="font-bold">{value}</span>
          <span>{today}</span>
          <span>$642.50</span>
        </div>
      )}
    </div>
  );
}

function TermsBox({ alreadyConnected }: { alreadyConnected: boolean }) {
  const acceptTerms = useAcceptPaymentsTerms();
  const connect = useConnectStripe();
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);

  const accept = async () => {
    setSaving(true);
    try {
      try {
        await acceptTerms.mutateAsync();
      } catch {
        toast({ variant: 'destructive', title: 'Couldn’t save your acceptance', description: 'Try again.' });
        return;
      }
      // The account is opened only now, after the terms. Failure toasts come from the hook itself.
      if (!alreadyConnected) await connect.mutateAsync();
    } catch {
      /* the hook already told the owner */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3.5">
      <label className="flex cursor-pointer items-start gap-3">
        <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} aria-label="I agree to the terms and fee schedule" />
        <span className="text-sm">
          I agree to the{' '}
          <NewTabLink href={PAYMENTS_TERMS_URL} className="inline">ServWave Payments terms</NewTabLink> and{' '}
          <NewTabLink href={FEE_SCHEDULE_URL} className="inline">fee schedule</NewTabLink>. Customers pay the invoice amount. Standard card
          and bank processing rates are billed to my account. ServWave charges no payment fee.
        </span>
      </label>
      <div>
        <Button disabled={!agreed || saving} onClick={accept} className="max-sm:h-11 max-sm:w-full">
          {saving ? 'Saving…' : 'Accept terms and set up payout account'}
        </Button>
      </div>
    </div>
  );
}

function SecureArea({ status, state }: { status: StripeStatus; state: number }) {
  const refreshStatus = useRefreshStripeStatus();
  const accountLink = useStripeAccountLink();
  const [loadFailures, setLoadFailures] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [openForm, setOpenForm] = useState<'onboarding' | 'onboarding_all' | 'management' | null>(null);

  // The failure box shows only while the section is failed: a session that now answers clears it.
  useEffect(
    () => onSessionRequestSucceeded((surface) => { if (surface === 'owner') setLoadFailures(0); }),
    [],
  );

  const due = (status.stripe_requirements_due?.length ?? 0) > 0;
  const nothingDue = state === 5 && !due;
  // Nothing is asked now, but the processor will ask for more later: say so and offer to hand it over now.
  const dueLater = !due && Object.values(status.verification ?? {}).includes('due_later');
  // The onboarding form mounts by itself only when something is due now.
  const form: 'onboarding' | 'onboarding_all' | 'management' | null = openForm ?? (due ? 'onboarding' : null);

  const onEmbedExit = () => {
    setOpenForm(null);
    // Leaving the embedded flow is not proof the account can take payments: re-read the status first.
    refreshStatus
      .mutateAsync()
      .then((s) => s.stripe_charges_enabled)
      .catch(() => false)
      .then((canTakeCards) =>
        toast({
          title: canTakeCards
            ? 'You’re set - send an invoice with a Pay button now.'
            : 'Setup saved. Payments turn on once your details are verified.',
        }),
      );
  };
  const onLoadError = () => setLoadFailures((n) => n + 1);
  const retry = () => {
    discardPayoutConnect();
    setLoadFailures(0);
    setAttempt((n) => n + 1);
  };
  const continueInSecureSetup = async () => {
    // Opened in a tab we already hold, because a tab opened after the request would be blocked as a pop-up.
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    try {
      const { url } = await accountLink.mutateAsync({ collect: form === 'onboarding_all' ? 'all' : 'now' });
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch {
      tab?.close();
      toast({ variant: 'destructive', title: 'Couldn’t open secure setup', description: 'Try again.' });
    }
  };

  const copy = nothingDue
    ? 'Bank and identity details are managed in a secure form. They never pass through ServWave.'
    : 'The secure form for the details still due appears here.';

  return (
    <ConnectComponentsProvider key={attempt} connectInstance={getPayoutConnect()}>
      <div className="flex flex-col gap-4">
        <ConnectNotificationBanner collectionOptions={ALL_COLLECTION_OPTIONS} onLoadError={onLoadError} />
        {loadFailures > 0 ? (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-danger-border bg-danger-surface p-3.5">
            <b className="text-sm">Couldn’t load secure setup.</b>
            <span className="text-sm">Retry, or continue in secure setup.</span>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="max-sm:h-11" onClick={retry}>
                Retry
              </Button>
              <Button variant="outline" size="sm" className="max-sm:h-11" disabled={accountLink.isPending} onClick={continueInSecureSetup}>
                Continue in secure setup
                <ExternalLink aria-hidden className="size-3 opacity-80" />
                <span className="sr-only"> (opens in a new tab)</span>
              </Button>
            </div>
          </div>
        ) : form === 'onboarding' || form === 'onboarding_all' ? (
          <ConnectAccountOnboarding
            collectionOptions={form === 'onboarding_all' ? ALL_COLLECTION_OPTIONS : ONBOARDING_COLLECTION_OPTIONS}
            onExit={onEmbedExit}
            onLoadError={onLoadError}
          />
        ) : form === 'management' ? (
          <ConnectAccountManagement collectionOptions={ALL_COLLECTION_OPTIONS} onLoadError={onLoadError} />
        ) : (
          <>
            {dueLater && (
              <div className="flex flex-col gap-2 rounded-lg border border-border p-3.5" data-testid="due-later">
                <b className="text-sm">More details will be needed later</b>
                <span className="text-sm">
                  Nothing is needed today. Some details, such as information about each owner, will be required once your
                  payment volume grows. If they are missing then, payouts pause until they are added. Add them now to avoid that.
                </span>
                <div>
                  <Button className="max-sm:h-11 max-sm:w-full" onClick={() => setOpenForm('onboarding_all')}>
                    Add details now
                  </Button>
                </div>
              </div>
            )}
            <div className="flex items-center gap-3 rounded-lg border border-dashed border-input bg-muted p-3.5 text-text-secondary">
              <Lock aria-hidden className="size-4.5 shrink-0" />
              <span className="text-sm">{copy}</span>
            </div>
            <div>
              <Button
                variant="outline"
                className="max-sm:h-11 max-sm:w-full"
                onClick={() => setOpenForm(nothingDue ? 'management' : 'onboarding')}
              >
                {nothingDue ? 'Manage bank and identity' : 'Finish setup'}
              </Button>
            </div>
          </>
        )}
      </div>
    </ConnectComponentsProvider>
  );
}

/**
 * Card 2: Payout account & verification. Status for anyone who may see the card; the terms box, the secure forms
 * and the descriptor are for whoever holds Manage payout account. No card, bank or identity field is ever drawn
 * here: that all happens inside the embedded components.
 */
export function PayoutCardBody({ status, canManage }: { status: StripeStatus; canManage: boolean }) {
  const state = deriveStripeState(status);
  const account = payoutAccountState(status);
  const needsTerms = !status.terms_accepted || !status.connected;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <TintBadge tone={account.tone}>{account.label}</TintBadge>
          <span className="min-w-60 flex-1 text-sm">{account.message}</span>
        </div>
        <p className="text-[12.5px] text-text-secondary">
          To protect your account, you may be asked for a verification code sent by text.
        </p>
      </div>

      <FirstPayoutNotice status={status} />

      {state === 1 || needsTerms ? (
        canManage && <TermsBox alreadyConnected={status.connected} />
      ) : (
        state !== 8 && (
          <>
            {status.verification && <VerificationGroup verification={status.verification} />}
            {canManage && <SecureArea status={status} state={state} />}
          </>
        )
      )}

      {canManage && (
        <div className={cn('border-t border-border-soft pt-4')}>
          <StatementDescriptorGroup />
        </div>
      )}
    </div>
  );
}
