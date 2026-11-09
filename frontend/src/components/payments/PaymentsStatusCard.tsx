import { useState } from 'react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import type { StripeStatus } from '@/lib/api/shared/organization';

/**
 * Body of the "ServWave Payments" status card (Settings > ServWave Payments, card 1). The page owns the card
 * shell, its title and its "?"; this renders the state row: badge, message, fee line and the one button.
 *
 * Status only for anyone who may not manage the payout account: `onGoToPayout` is left out and no button shows.
 * It never renders a card, bank or identity field.
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

export const BANK_SNOOZE_KEY = 'servwave.payments.bank-nudge.snoozed-until';

// Tint classnames follow the PhoneSmsPage Badge pattern (tokens only, no raw hex/palette
// classes): default Badge variant is overridden entirely via className so twMerge drops
// the default bg/text and keeps only the tinted ones below. Each tint is the design system's
// own surface + text pair (tuned to 4.5:1); a `text-warning` on a 10% wash of itself was
// 4.38:1 (amber) and 4.19:1 (red), which failed AA on the "Under review" / "Paused" states
// (stripe-status-badge-contrast.test.ts holds the pairs).
export const SUCCESS_TINT = 'border-transparent bg-success-surface text-success-text hover:bg-success-surface';
export const WARNING_TINT = 'border-transparent bg-warning-surface text-warning-text hover:bg-warning-surface';
export const DANGER_TINT = 'border-transparent bg-danger-surface text-danger-text hover:bg-danger-surface';

export type TintTone = 'neutral' | 'success' | 'warning' | 'danger';

const TINT_CLASS: Record<TintTone, string | undefined> = {
  neutral: undefined,
  success: SUCCESS_TINT,
  warning: WARNING_TINT,
  danger: DANGER_TINT,
};

/** The one badge for a payments state or verification value: the tint is applied here and nowhere else. */
export function TintBadge({ tone, children }: { tone: TintTone; children: ReactNode }) {
  const className = TINT_CLASS[tone];
  return (
    <Badge variant={className ? undefined : 'secondary'} className={className}>
      {children}
    </Badge>
  );
}

/** What the org's accepted methods change in the copy. */
interface MessageContext {
  /** "card", "bank transfer" or "card or bank transfer" - the online methods that are on. */
  methods: string;
}

/**
 * The online methods the account takes, worded for a sentence. CARD and ACH in accepted_payment_methods
 * are the server-owned capability facts. Until the organization has loaded, say what the card always said.
 */
export function onlineMethodsPhrase(accepted: string[] | undefined): string {
  if (!accepted) return 'card';
  const card = accepted.includes('CARD');
  const bank = accepted.includes('ACH');
  if (card && bank) return 'card or bank transfer';
  if (bank) return 'bank transfer';
  return 'card';
}

interface StateContent {
  badgeLabel: string;
  badgeTone: TintTone;
  message: (ctx: MessageContext) => string;
  ctaLabel?: string;
  fee?: boolean;
}

const STATE_CONTENT: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, StateContent> = {
  1: {
    badgeLabel: 'Not connected',
    badgeTone: 'neutral',
    message: () => 'Accept card payments - set up ServWave Payments.',
    ctaLabel: 'Set up payments',
    fee: true,
  },
  2: {
    badgeLabel: 'In progress',
    badgeTone: 'neutral',
    message: () => 'Finish setting up - pick up where you left off.',
    ctaLabel: 'Resume setup',
    fee: true,
  },
  3: {
    badgeLabel: 'Under review',
    badgeTone: 'warning',
    // Also where a fail-closed status refresh lands (charges off, details as stored), so no
    // timing promise and no vendor name: the account may never turn on by itself.
    message: () =>
      'Card payments turn on once your details are verified. If they’re still off after a business day, contact ServWave support.',
  },
  4: {
    badgeLabel: 'Active',
    badgeTone: 'success',
    message: () => 'You’re set - send this invoice with a Pay button now.',
  },
  5: {
    badgeLabel: 'Active',
    badgeTone: 'success',
    message: ({ methods }) =>
      `ServWave Payments active - payouts enabled. Customers can now pay your invoices by ${methods}.`,
  },
  6: {
    badgeLabel: 'Action needed',
    badgeTone: 'warning',
    message: () => 'One more thing is needed to keep your payments running.',
    ctaLabel: 'Fix now',
  },
  7: {
    badgeLabel: 'Paused',
    badgeTone: 'danger',
    // Never interpolate the raw `stripe_disabled_reason` (machine codes like
    // `requirements.past_due`) into contractor-facing copy - the actual to-do lives
    // in the secure form behind "Fix now".
    message: () => 'Card payments are paused. A bit more information is needed before they can resume - click Fix now to finish.',
    ctaLabel: 'Fix now',
  },
  8: {
    badgeLabel: 'Unavailable',
    badgeTone: 'danger',
    message: () => 'ServWave Payments is unavailable for this account - contact support.',
  },
};

export function PaymentsStatusBody({
  status,
  acceptedMethods,
  onGoToPayout,
}: {
  status: StripeStatus;
  acceptedMethods: string[] | undefined;
  /** Left out for someone without the Manage payout account switch: the card then shows status only. */
  onGoToPayout?: () => void;
}) {
  // Read once on mount: the nudge is judged against when the card opened, and render stays pure.
  const [openedAt] = useState<number>(() => Date.now());
  const [snoozedUntil, setSnoozedUntil] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(BANK_SNOOZE_KEY) ?? 0);
    } catch {
      return 0;
    }
  });

  const state = deriveStripeState(status);
  const content = STATE_CONTENT[state];

  // State 4 (charges live, bank pending) -> deferred-bank nudge, dismissible 7-day snooze.
  const showBankNudge = state === 4 && Boolean(onGoToPayout) && openedAt > snoozedUntil;
  const snoozeNudge = () => {
    const until = Date.now() + 7 * 864e5;
    try {
      localStorage.setItem(BANK_SNOOZE_KEY, String(until));
    } catch {
      /* storage blocked: the strip still hides for this visit */
    }
    setSnoozedUntil(until);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 max-sm:flex-col max-sm:items-stretch">
        <div className="flex min-w-0 flex-1 basis-72 flex-col max-sm:basis-auto items-start gap-2">
          <TintBadge tone={content.badgeTone}>{content.badgeLabel}</TintBadge>
          <p className="text-sm text-text-primary">{content.message({ methods: onlineMethodsPhrase(acceptedMethods) })}</p>
          {content.fee && (
            <p className="text-[12.5px] text-text-secondary">
              Customers pay the invoice amount. Standard card and bank processing rates are billed to your account.
              ServWave charges no payment fee.
            </p>
          )}
        </div>
        {content.ctaLabel && onGoToPayout && (
          <Button onClick={onGoToPayout} className="max-sm:h-11 max-sm:w-full">
            {content.ctaLabel}
          </Button>
        )}
      </div>

      {showBankNudge && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-info-border bg-info-surface px-3.5 py-3">
          <p className="min-w-60 flex-1 text-sm text-text-primary">
            You’ve collected {formatCurrency(status.collected_awaiting_payout)}. Connect your bank to get paid out.
          </p>
          <Button size="sm" className="max-sm:h-11" onClick={onGoToPayout}>
            Connect bank
          </Button>
          <Button variant="outline" size="sm" className="max-sm:h-11" onClick={snoozeNudge}>
            Snooze for 7 days
          </Button>
        </div>
      )}
    </div>
  );
}
