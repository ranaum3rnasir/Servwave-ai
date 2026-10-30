import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Heading } from '@/components/ui/heading';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/utils';
import { useOrganization, useStripeStatus, type StripeStatus } from '@/lib/api/organization';
import { useFeature } from '@/lib/entitlements';

/**
 * ServWave Payments status card (spec §6.1/§6.4) — Settings → Payments.
 *
 * Status only. Setting up, fixing and managing the account is the owner's page (Settings -> Payout account &
 * verification); this card just hands over to it through `onOpenSetup`, and shows no button at all to anyone
 * who may not manage the payout account. It never renders a card/bank/SSN input field itself.
 */

export function deriveStripeState(s: StripeStatus): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 {
  const reason = s.stripe_disabled_reason ?? '';
  if (!s.connected) return 1;
  if (/^rejected\./.test(reason) || reason === 'deauthorized') return 8;
  // A brand-new account has not been paused, it has not been filled in: the processor marks every
  // requirement past due the moment an account exists (disabled_reason = requirements.past_due). So an
  // account whose details were never submitted is "setup in progress" whatever its disabled reason says.
  if (!s.stripe_details_submitted) return 2;
  if (reason && !s.stripe_charges_enabled) return 7;
  if ((s.stripe_requirements_due?.length ?? 0) > 0) return 6;
  if (!s.stripe_charges_enabled) return 3;
  if (s.stripe_charges_enabled && !s.stripe_payouts_enabled) return 4;
  return 5;
}

const BANK_SNOOZE_KEY = 'servwave.payments.bank-nudge.snoozed-until';

// Tint classnames follow the PhoneSmsPage Badge pattern (tokens only, no raw hex/palette
// classes): default Badge variant is overridden entirely via className so twMerge drops
// the default bg/text and keeps only the tinted ones below. Each tint is the design system's
// own surface + text pair (tuned to 4.5:1); a `text-warning` on a 10% wash of itself was
// 4.38:1 (amber) and 4.19:1 (red), which failed AA on the "Under review" / "Paused" states
// (stripe-status-badge-contrast.test.ts holds the pairs).
const SUCCESS_TINT = 'border-transparent bg-success-surface text-success-text hover:bg-success-surface';
const WARNING_TINT = 'border-transparent bg-warning-surface text-warning-text hover:bg-warning-surface';
const DANGER_TINT = 'border-transparent bg-danger-surface text-danger-text hover:bg-danger-surface';

/** What the org's plan and accepted methods change in the copy. */
interface MessageContext {
  inPlan: boolean;
  /** "card", "bank transfer" or "card or bank transfer" - the online methods that are on. */
  methods: string;
}

/**
 * The online methods the account takes, worded for a sentence. CARD and ACH in accepted_payment_methods
 * are the server-owned capability facts. Until the organization has loaded, say what the card always said.
 */
function onlineMethodsPhrase(accepted: string[] | undefined): string {
  if (!accepted) return 'card';
  const card = accepted.includes('CARD');
  const bank = accepted.includes('ACH');
  if (card && bank) return 'card or bank transfer';
  if (bank) return 'bank transfer';
  return 'card';
}

interface StateContent {
  badgeLabel: string;
  /** Omit to use Badge's built-in `secondary` variant (neutral, informational states). */
  badgeClassName?: string;
  badgeVariant?: 'secondary';
  // Copy strings verbatim from spec §6.8.
  message: (s: StripeStatus, ctx: MessageContext) => string;
  ctaLabel?: string;
  // §6.4 row 1 explicitly names the `business` tone for the first CTA; the rest
  // stay on the default (ocean) button — sage is reserved for forward-motion
  // business actions and isn't called out for the other rows.
  ctaTone?: 'business';
}

const STATE_CONTENT: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, StateContent> = {
  1: {
    badgeLabel: 'Not connected',
    badgeVariant: 'secondary',
    message: () => 'Accept card payments - set up ServWave Payments.',
    ctaLabel: 'Set up payments',
    ctaTone: 'business',
  },
  2: {
    badgeLabel: 'In progress',
    badgeVariant: 'secondary',
    message: () => 'Finish setting up - pick up where you left off.',
    ctaLabel: 'Resume setup',
  },
  3: {
    badgeLabel: 'Under review',
    badgeClassName: WARNING_TINT,
    // Also where a fail-closed status refresh lands (charges off, details as stored), so no
    // timing promise and no vendor name: the account may never turn on by itself.
    message: () =>
      "Card payments turn on once your details are verified. If they're still off after a business day, contact ServWave support.",
  },
  4: {
    badgeLabel: 'Active',
    badgeClassName: SUCCESS_TINT,
    message: (_s, { inPlan }) =>
      inPlan ? "You're set - send this invoice with a Pay button now." : 'Your payout account is set up.',
  },
  5: {
    badgeLabel: 'Active',
    badgeClassName: SUCCESS_TINT,
    message: (_s, { inPlan, methods }) =>
      inPlan
        ? `ServWave Payments active - payouts enabled. Customers can now pay your invoices by ${methods}.`
        : 'ServWave Payments active - payouts enabled.',
  },
  6: {
    badgeLabel: 'Action needed',
    badgeClassName: WARNING_TINT,
    message: () => 'One more thing is needed to keep your payments running.',
    ctaLabel: 'Fix now',
  },
  7: {
    badgeLabel: 'Paused',
    badgeClassName: DANGER_TINT,
    // Never interpolate the raw `stripe_disabled_reason` (machine codes like
    // `requirements.past_due`) into contractor-facing copy - the actual to-do lives
    // in the embedded setup behind "Fix now".
    message: () => 'Card payments are paused. A bit more information is needed before they can resume - click Fix now to finish.',
    ctaLabel: 'Fix now',
  },
  8: {
    badgeLabel: 'Unavailable',
    badgeClassName: DANGER_TINT,
    message: () => 'ServWave Payments is unavailable for this account - contact support.',
    // §6.4 row 8: "No CTA into setup."
  },
};

/**
 * `onOpenSetup` takes the owner to the payout account page (terms, onboarding, account management). Left out
 * for someone who may not manage the payout account, the card then shows status only, with no button.
 */
export function PaymentsStatusCard({ onOpenSetup }: { onOpenSetup?: () => void }) {
  const { data: s, isLoading } = useStripeStatus();
  const { data: org } = useOrganization();
  const inPlan = useFeature('online_payments');
  // Read once on mount: the nudge is judged against when the card opened, and render stays pure.
  const [openedAt] = useState<number>(() => Date.now());
  const [snoozedUntil, setSnoozedUntil] = useState<number>(() =>
    Number(localStorage.getItem(BANK_SNOOZE_KEY) ?? 0)
  );

  if (isLoading || !s) {
    return (
      <Card>
        <Skeleton className="h-16 w-full" />
      </Card>
    );
  }

  const state = deriveStripeState(s);
  const content = STATE_CONTENT[state];


  // State 4 (charges live, bank pending) → deferred-bank nudge (§6.6/§6.8), dismissible 7-day snooze.
  const showBankNudge = state === 4 && openedAt > snoozedUntil;
  const snoozeNudge = () => {
    const until = Date.now() + 7 * 864e5;
    localStorage.setItem(BANK_SNOOZE_KEY, String(until));
    setSnoozedUntil(until);
  };

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Heading level={3}>ServWave Payments</Heading>
        <Badge variant={content.badgeVariant} className={content.badgeClassName}>
          {content.badgeLabel}
        </Badge>
      </div>

      <p className="text-sm text-text-primary">{content.message(s, { inPlan, methods: onlineMethodsPhrase(org?.accepted_payment_methods) })}</p>

      {content.ctaLabel && onOpenSetup && (
        <Button tone={content.ctaTone} size="sm" onClick={onOpenSetup}>
          {content.ctaLabel}
        </Button>
      )}

      {showBankNudge && onOpenSetup && (
        <div className="space-y-2 rounded-card border border-border p-3">
          <p className="text-sm text-text-primary">
            You&apos;ve collected {formatCurrency(s.collected_awaiting_payout)}. Connect your bank to
            get paid out.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={onOpenSetup}>
              Connect bank
            </Button>
            <Button variant="ghost" size="sm" onClick={snoozeNudge}>
              Snooze
            </Button>
          </div>
        </div>
      )}

      {/* Fee disclosure is decision-time only: shown in the not-yet-connected states (1-2)
          where it informs the owner's setup decision, and hidden once payments are live. The
          binding disclosure lives at onboarding consent (§6.2), so a permanent restatement here
          is redundant noise. Payments go-live D9/D12: ServWave takes no payment fee, and the
          processor's standard rates are billed to the contractor's own account. */}
      {(state === 1 || state === 2) && (
        <p className="border-t border-border pt-3 text-xs text-text-secondary">
          Customers pay the invoice amount. Standard card and bank processing rates are billed to
          your account. ServWave charges no payment fee.
        </p>
      )}
    </Card>
  );
}
