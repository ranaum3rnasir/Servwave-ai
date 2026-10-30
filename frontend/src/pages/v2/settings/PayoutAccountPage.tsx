import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import {
  ConnectAccountManagement,
  ConnectAccountOnboarding,
  ConnectComponentsProvider,
  ConnectNotificationBanner,
} from '@stripe/react-connect-js';

import { useAppAbility } from '@/contexts/AbilityContext';
import {
  useAcceptPaymentsTerms,
  useConnectStripe,
  useRefreshStripeStatus,
  useStatementDescriptor,
  useStripeAccountLink,
  useStripeStatus,
} from '@/lib/api/organization';
import { discardPayoutConnect, getPayoutConnect, onSessionRequestSucceeded } from '@/lib/payments/payout-connect';
import { payoutAccountState, type PayoutTone } from '@/lib/payments/payout-account-state';
import { PAYMENTS_TERMS_URL, FEE_SCHEDULE_URL } from '@/lib/legal-urls';
import { toast } from '@/components/ui/use-toast';

import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { Section } from './components/section';

// Module-level, not inline in the JSX: the embedded component remounts whenever this prop changes identity,
// and an inline literal is a new object on every render (see the drawer this page replaced).
// currently_due = collect only what is due now, so card payments can start before the bank is verified.
const ONBOARDING_COLLECTION_OPTIONS = { fields: 'currently_due', futureRequirements: 'omit' } as const;

const TONE_BADGE: Record<PayoutTone, 'softNeutral' | 'softGreen' | 'softAmber' | 'softRed'> = {
  neutral: 'softNeutral',
  success: 'softGreen',
  warning: 'softAmber',
  danger: 'softRed',
};

/**
 * What a customer reads on their card statement. Shown, never edited: the platform cannot write the descriptor
 * on this kind of account, so there is no field and no Save here.
 */
function StatementDescriptorSection() {
  const { data } = useStatementDescriptor();
  const value = data?.statement_descriptor ?? '';
  return (
    <Section title="Statement descriptor" description="This is how charges appear on your customers' card statements.">
      {value && <p className="text-sm font-medium" data-testid="statement-descriptor">{value}</p>}
    </Section>
  );
}

/**
 * Settings > Payout account & verification. Owner only: whoever holds the "Manage payout account" switch.
 *
 * Everything about getting paid out lives here, inside ServWave: the terms, the embedded onboarding, the bank
 * and identity details, and the account notifications. This page never renders a card, bank or identity field
 * itself; that all happens inside the embedded components. Nothing is requested from the server until the terms
 * are accepted, and the processor's account id is never on the page or in the status it reads.
 */
export default function PayoutAccountPage() {
  const ability = useAppAbility();
  const { data: status, isLoading } = useStripeStatus();
  const acceptTerms = useAcceptPaymentsTerms();
  const connect = useConnectStripe();
  const refreshStatus = useRefreshStripeStatus();
  const accountLink = useStripeAccountLink();

  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailures, setLoadFailures] = useState(0);
  const [attempt, setAttempt] = useState(0);

  // The card shows only while the section is failed: a session that now answers clears it.
  useEffect(
    () => onSessionRequestSucceeded((surface) => { if (surface === 'owner') setLoadFailures(0); }),
    [],
  );

  if (!ability.can('manage_payout_account', 'Organization')) return <Navigate to="/settings" replace />;

  const onContinue = async () => {
    if (!status) return;
    setSaving(true);
    try {
      if (!status.terms_accepted) {
        try {
          await acceptTerms.mutateAsync();
        } catch {
          toast({ variant: 'destructive', title: "Couldn't save your acceptance", description: 'Try again.' });
          return;
        }
      }
      // The account is opened only now, after the terms. Failure toasts from the hook itself.
      if (!status.connected) await connect.mutateAsync();
    } catch {
      /* the hook already told the owner */
    } finally {
      setSaving(false);
    }
  };

  const onEmbedExit = () => {
    // Leaving the embedded flow is not proof the account can take payments: re-read the status first.
    refreshStatus
      .mutateAsync()
      .then((s) => s.stripe_charges_enabled)
      .catch(() => false)
      .then((canTakeCards) =>
        toast({
          title: canTakeCards
            ? "You're set - send an invoice with a Pay button now."
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

  const continueInHostedSetup = async () => {
    try {
      const { url } = await accountLink.mutateAsync();
      window.location.href = url;
    } catch {
      toast({ variant: 'destructive', title: "Couldn't open secure setup", description: 'Try again.' });
    }
  };

  const state = status ? payoutAccountState(status) : null;
  const needsTerms = Boolean(status) && (!status!.terms_accepted || !status!.connected);

  return (
    <div className="space-y-6">
      <Section
        title="Payout account & verification"
        description="Where your customer payments are paid out to. Your bank and identity details are entered securely and never pass through ServWave."
        action={state && <Badge variant={TONE_BADGE[state.tone]}>{state.label}</Badge>}
      >
        {state && !needsTerms && <p className="text-sm">{state.message}</p>}
        <p className="text-xs text-muted-foreground">
          To protect your account, you may be asked for a verification code sent by text.
        </p>
      </Section>

      {isLoading || !status ? (
        <Skeleton className="h-64 w-full" />
      ) : needsTerms ? (
        <Section>
          <label className="flex items-start gap-2">
            <Checkbox checked={agreed} onCheckedChange={(v) => setAgreed(v === true)} />
            <span className="text-sm">
              I agree to the{' '}
              <a href={PAYMENTS_TERMS_URL} target="_blank" rel="noreferrer" className="underline">
                ServWave Payments terms
              </a>{' '}
              and{' '}
              <a href={FEE_SCHEDULE_URL} target="_blank" rel="noreferrer" className="underline">
                fee schedule
              </a>
              . Customers pay the invoice amount. Standard card and bank processing rates are billed to my account.
              ServWave charges no payment fee.
            </span>
          </label>
          <div>
            <Button disabled={!agreed || saving} onClick={onContinue}>
              {saving ? 'Saving…' : 'Continue'}
            </Button>
          </div>
        </Section>
      ) : (
        <ConnectComponentsProvider key={attempt} connectInstance={getPayoutConnect()}>
          <div className="space-y-6">
            <ConnectNotificationBanner onLoadError={onLoadError} />
            {status.stripe_details_submitted ? (
              <Section title="Bank and identity details">
                <ConnectAccountManagement onLoadError={onLoadError} />
              </Section>
            ) : (
              <Section title="Finish setup">
                <ConnectAccountOnboarding
                  collectionOptions={ONBOARDING_COLLECTION_OPTIONS}
                  onExit={onEmbedExit}
                  onLoadError={onLoadError}
                />
              </Section>
            )}
            <StatementDescriptorSection />
            {loadFailures > 0 && (
              <Section>
                <p className="text-sm text-muted-foreground">Couldn&apos;t load secure setup. Retry, or continue in secure setup.</p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={retry}>Retry</Button>
                  {loadFailures >= 2 && (
                    <Button variant="outline" disabled={accountLink.isPending} onClick={continueInHostedSetup}>
                      Continue in secure setup →
                    </Button>
                  )}
                </div>
              </Section>
            )}
          </div>
        </ConnectComponentsProvider>
      )}
    </div>
  );
}
