import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Heading } from '@/components/ui/heading';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/utils';
import { useStripeStatus, useConnectStripe, type StripeStatus } from '@/lib/api/organization';

/**
 * ServWave Payments status card (spec §6.1/§6.4) — Settings → Payments.
 *
 * The onboarding DRAWER is owned by the parent page (Task 2.4, not built yet). This
 * card never imports it — it only calls `onOpenDrawer`, a callback the parent wires
 * up once the drawer exists. That keeps this task decoupled from a forward
 * dependency on unbuilt work. This card is a status/CTA surface only: it never
 * renders a card/bank/SSN input field itself (all sensitive entry happens on
 * Stripe's hosted surface via the drawer).
 */

export function deriveStripeState(s: StripeStatus): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 {
  const reason = s.stripe_disabled_reason ?? '';
  if (!s.stripe_account_id) return 1;
  if (/^rejected\./.test(reason) || reason === 'deauthorized') return 8;
  if (reason && !s.stripe_charges_enabled) return 7;
  if (!s.stripe_details_submitted) return 2;
  if ((s.stripe_requirements_due?.length ?? 0) > 0) return 6;
  if (!s.stripe_charges_enabled) return 3;
  if (s.stripe_charges_enabled && !s.stripe_payouts_enabled) return 4;
  return 5;
}

const BANK_SNOOZE_KEY = 'servwave.payments.bank-nudge.snoozed-until';

// Tint classnames follow the PhoneSmsPage Badge pattern (tokens only, no raw hex/palette
// classes): default Badge variant is overridden entirely via className so twMerge drops
// the default bg/text and keeps only the tinted ones below.
const SUCCESS_TINT = 'border-transparent bg-success/10 text-success hover:bg-success/10';
const WARNING_TINT = 'border-transparent bg-warning/10 text-warning hover:bg-warning/10';
const DANGER_TINT = 'border-transparent bg-danger/10 text-danger hover:bg-danger/10';

interface StateContent {
  badgeLabel: string;
  /** Omit to use Badge's built-in `secondary` variant (neutral, informational states). */
  badgeClassName?: string;
  badgeVariant?: 'secondary';
  // Copy strings verbatim from spec §6.8.
  message: (s: StripeStatus) => string;
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
    message: () => 'Accept card payments — set up ServWave Payments.',
    ctaLabel: 'Set up payments',
    ctaTone: 'business',
  },
  2: {
    badgeLabel: 'In progress',
    badgeVariant: 'secondary',
    message: () => 'Finish setting up — pick up where you left off.',
    ctaLabel: 'Resume setup',
  },
  3: {
    badgeLabel: 'Under review',
    badgeClassName: WARNING_TINT,
    message: () => 'Stripe is reviewing your details — usually takes minutes.',
  },
  4: {
    badgeLabel: 'Active',
    badgeClassName: SUCCESS_TINT,
    message: () => "You're set — send this invoice with a Pay button now.",
  },
  5: {
    badgeLabel: 'Active',
    badgeClassName: SUCCESS_TINT,
    message: () => 'ServWave Payments active - payouts enabled. Customers can now pay your invoices by card.',
  },
  6: {
    badgeLabel: 'Action needed',
    badgeClassName: WARNING_TINT,
    message: () => 'Stripe needs one more thing to keep your payments running.',
    ctaLabel: 'Fix now',
  },
  7: {
    badgeLabel: 'Paused',
    badgeClassName: DANGER_TINT,
    // Never interpolate Stripe's raw `stripe_disabled_reason` (machine codes like
    // `requirements.past_due`) into contractor-facing copy - the actual to-do lives
    // on Stripe's own screens behind "Fix now".
    message: () => 'Card payments are paused. Stripe needs a bit more information before they can resume - click Fix now to finish.',
    ctaLabel: 'Fix now',
  },
  8: {
    badgeLabel: 'Unavailable',
    badgeClassName: DANGER_TINT,
    message: () => 'ServWave Payments is unavailable for this account — contact support.',
    // §6.4 row 8: "No CTA into the drawer."
  },
};

export function StripePaymentsStatusCard({ onOpenDrawer }: { onOpenDrawer: () => void }) {
  const { data: s, isLoading } = useStripeStatus();
  const connect = useConnectStripe();
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

  // CTA (Set up / Resume / Fix now): connect() first if no account id yet, then open the drawer.
  const openSetup = async () => {
    if (!s.stripe_account_id) await connect.mutateAsync();
    onOpenDrawer();
  };

  // State 4 (charges live, bank pending) → deferred-bank nudge (§6.6/§6.8), dismissible 7-day snooze.
  const showBankNudge = state === 4 && Date.now() > snoozedUntil;
  const snoozeNudge = () => {
    const until = Date.now() + 7 * 864e5;
    localStorage.setItem(BANK_SNOOZE_KEY, String(until));
    setSnoozedUntil(until);
  };

  const feePct = s.platform_fee_bps / 100;

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Heading level={3}>ServWave Payments</Heading>
        <Badge variant={content.badgeVariant} className={content.badgeClassName}>
          {content.badgeLabel}
        </Badge>
      </div>

      <p className="text-sm text-text-primary">{content.message(s)}</p>

      {content.ctaLabel && (
        <Button
          tone={content.ctaTone}
          size="sm"
          onClick={openSetup}
          disabled={connect.isPending}
        >
          {connect.isPending ? 'Connecting…' : content.ctaLabel}
        </Button>
      )}

      {showBankNudge && (
        <div className="space-y-2 rounded-card border border-border p-3">
          <p className="text-sm text-text-primary">
            You&apos;ve collected {formatCurrency(s.collected_awaiting_payout)}. Connect your bank to
            get paid out.
          </p>
          <div className="flex gap-2">
            <Button size="sm" onClick={openSetup} disabled={connect.isPending}>
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
          binding disclosure lives at onboarding consent (§6.2) and per-payment (§7.3), so a
          permanent restatement here is redundant noise. */}
      {(state === 1 || state === 2) && (
        <p className="border-t border-border pt-3 text-xs text-text-secondary">
          ServWave platform fee: {feePct}% per card payment, deducted from your proceeds — your
          customer always pays the invoice amount.
        </p>
      )}
    </Card>
  );
}
