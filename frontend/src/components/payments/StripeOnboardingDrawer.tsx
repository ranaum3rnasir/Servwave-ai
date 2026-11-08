import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { loadConnectAndInitialize } from '@stripe/connect-js';
import { ConnectComponentsProvider, ConnectAccountOnboarding } from '@stripe/react-connect-js';
import { useOrganization, useStripeStatus, useStripeAccountSession, useAcceptPaymentsTerms, useStripeAccountLink } from '@/lib/api/organization';
import { toast } from '@/components/ui/use-toast';
import { PAYMENTS_TERMS_URL, FEE_SCHEDULE_URL } from '@/lib/legal-urls';

type Phase = 'needsTerms' | 'initializing' | 'ready' | 'error';

// Module-level constant, not inline in the JSX below: Connect.js remounts the embedded
// element whenever collectionOptions changes identity. An inline object literal is a new
// reference on every render, so any unrelated re-render of this drawer (e.g. a background
// react-query refetch of org/status while the drawer is open) silently reset the embed
// back to its first step — the "Add information" button never advanced no matter how it
// was clicked, since every re-render clobbered whatever step the user had reached.
const ONBOARDING_COLLECTION_OPTIONS = { fields: 'currently_due', futureRequirements: 'omit' } as const;

/** Pull `code` off an axios error response body — same shape assumption as `extractApiError`. */
function errorCode(err: unknown): string | undefined {
  return (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
}

/**
 * ServWave Payments embedded onboarding drawer (spec §3.1/§3.2/§3.6/§6.2) — opened from
 * StripePaymentsStatusCard's CTA (Task 2.3, via `onOpenDrawer`).
 *
 * State machine: needsTerms → initializing → ready → error, with a hosted-Account-Link
 * escape hatch after a 2nd consecutive failure. This component never renders a
 * card/bank/SSN input itself — the `needsTerms` phase only ever shows a plain
 * clickwrap checkbox, and the `ready` phase only ever mounts Stripe's own embedded
 * iframe (`ConnectAccountOnboarding`); all sensitive collection happens on Stripe's
 * surface. The terms gate is enforced server-side, not just by UI ordering: the
 * embedded component is only ever reached (`initConnect`) after `useStripeAccountSession`
 * or `useAcceptPaymentsTerms` actually resolves against the backend — a disabled
 * Continue button is a UX nicety on top of that, not the enforcement mechanism itself.
 */
export function StripeOnboardingDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data: org } = useOrganization();
  // Fee % comes from the payments status (same source as StripePaymentsStatusCard), NOT from
  // useOrganization() — the /api/organization payload does not carry platform_fee_bps, so reading
  // it off `org` renders "NaN%" in the fee disclosure. /stripe/status always returns it.
  const { data: status } = useStripeStatus();
  const session = useStripeAccountSession();
  const acceptTerms = useAcceptPaymentsTerms();
  const accountLink = useStripeAccountLink();
  const [phase, setPhase] = useState<Phase>('initializing');
  const [attested, setAttested] = useState(false);
  const [failures, setFailures] = useState(0);
  const connectInstance = useRef<ReturnType<typeof loadConnectAndInitialize> | null>(null);

  // fetchClientSecret is called by Connect.js on mount AND on session expiry → always re-POST.
  const fetchClientSecret = useCallback(async () => {
    const { client_secret } = await session.mutateAsync();
    return client_secret;
  }, [session]);

  const initConnect = useCallback(() => {
    connectInstance.current = loadConnectAndInitialize({
      publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY,
      fetchClientSecret,
      appearance: {
        variables: {
          colorPrimary: 'rgb(var(--primary))', // Deep Ocean; tokens are channel-RGB → wrap in rgb()
          colorText: 'rgb(var(--text-primary))',
          colorDanger: 'rgb(var(--danger))',
          borderRadius: '6px',
          fontFamily: 'Manrope, system-ui, sans-serif',
        },
      },
      // There is no self-hosted /fonts/manrope.css in this repo — index.html loads Manrope
      // from this exact Google Fonts URL app-wide, and vercel.json's style-src/font-src
      // already allow fonts.googleapis.com/fonts.gstatic.com for it. Stripe's own
      // CssFontSource type docs give a Google Fonts CSS URL as the canonical example, so
      // reusing the app's existing font source (rather than a path that 404s) is correct.
      fonts: [{ cssSrc: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap' }],
    });
    setPhase('ready');
  }, [fetchClientSecret]);

  // On open: probe the account-session. 403 PAYMENTS_TERMS_ACCEPTANCE_REQUIRED → show the
  // checkbox. initConnect() below is only ever called after this probe (or acceptTerms,
  // in onAcceptTerms) actually succeeds against the backend — never from local state alone.
  useEffect(() => {
    if (!open) return;
    setPhase('initializing');
    session
      .mutateAsync()
      .then(() => initConnect())
      .catch((err: unknown) => {
        if (errorCode(err) === 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED') setPhase('needsTerms');
        else {
          setFailures((n) => n + 1);
          setPhase('error');
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onAcceptTerms = async () => {
    try {
      await acceptTerms.mutateAsync();
      initConnect();
    } catch {
      // useAcceptPaymentsTerms (Task 2.2) has no onError toast of its own — surface the
      // failure here so it's never silent, and so a rejected acceptance never falls
      // through to initConnect(): the embedded component still doesn't mount.
      toast({
        variant: 'destructive',
        title: "Couldn't save your acceptance",
        description: 'Try again.',
      });
    }
  };

  const retry = () => {
    setPhase('initializing');
    session
      .mutateAsync()
      .then(initConnect)
      .catch(() => {
        setFailures((n) => n + 1);
        setPhase('error');
      });
  };

  // useCallback (not an inline arrow in the JSX below): see ONBOARDING_COLLECTION_OPTIONS —
  // same remount hazard applies to onExit.
  const onEmbedExit = useCallback(() => {
    toast({ title: "You're set — send this invoice with a Pay button now." });
    onOpenChange(false);
  }, [onOpenChange]);

  const onContinueOnStripe = async () => {
    try {
      const { url } = await accountLink.mutateAsync();
      window.location.href = url;
    } catch {
      // useStripeAccountLink (Task 2.2) has no onError toast of its own — and this is the
      // last-resort escape hatch after 2+ failures, so a silent failure here would leave
      // the user with zero signal and no way forward. Surface it explicitly, same pattern
      // as onAcceptTerms above.
      toast({
        variant: 'destructive',
        title: "Couldn't create the Stripe setup link",
        description: 'Try again.',
      });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>ServWave Payments</SheetTitle>
          <SheetDescription>
            Secured by Stripe — ServWave never sees your card, bank, or SSN details.
          </SheetDescription>
        </SheetHeader>

        {phase === 'needsTerms' && (
          <div className="space-y-4 py-4">
            {/* Checkbox row (label wraps its control) - not a FormField-shape site, left raw. */}
            <label className="flex items-start gap-2">
              <Checkbox checked={attested} onCheckedChange={(v) => setAttested(!!v)} />
              <span className="text-sm">
                I agree to the{' '}
                <a href={PAYMENTS_TERMS_URL} target="_blank" rel="noreferrer" className="underline">
                  ServWave Payments Terms
                </a>
                , including a platform fee of up to 2% — currently{' '}
                {status ? status.platform_fee_bps / 100 : 0.5}% — deducted from my card-payment proceeds
                (
                <a href={FEE_SCHEDULE_URL} target="_blank" rel="noreferrer" className="underline">
                  Fee Schedule
                </a>
                ), and I’m authorized to bind {org?.name ?? 'my organization'} to these terms.
              </span>
            </label>
            <Button variant="solid" tone="business" disabled={!attested || acceptTerms.isPending} onClick={onAcceptTerms}>
              {acceptTerms.isPending ? 'Saving…' : 'Continue'}
            </Button>
          </div>
        )}

        {phase === 'initializing' && <Skeleton className="h-96 w-full" />}

        {phase === 'ready' && connectInstance.current && (
          <ConnectComponentsProvider connectInstance={connectInstance.current}>
            {/* collectionOptions currently_due = progressive/deferred-bank onboarding (§3.2/§13.1):
                collect only what's due now so the contractor can take cards BEFORE the bank is
                verified. Omitting this prop reverts to Stripe's default (eventually_due) =
                bank-first, defeating the model. */}
            <ConnectAccountOnboarding
              collectionOptions={ONBOARDING_COLLECTION_OPTIONS}
              onExit={onEmbedExit}
            />
          </ConnectComponentsProvider>
        )}

        {phase === 'error' && (
          <div className="space-y-3 py-4">
            <p className="text-sm text-text-secondary">
              Couldn&apos;t load secure setup. Retry, or continue on Stripe →
            </p>
            <Button onClick={retry}>Retry</Button>
            {failures >= 2 && (
              // §3.1/§6.2 fallback: after a SECOND failure, finish on Stripe's hosted Account Link.
              <Button variant="outline" disabled={accountLink.isPending} onClick={onContinueOnStripe}>
                Continue on Stripe →
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
