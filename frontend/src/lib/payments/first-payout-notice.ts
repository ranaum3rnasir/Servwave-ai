import type { StripeStatus } from '@/lib/api/shared/organization';

export interface FirstPayoutNoticeCopy {
  tone: 'neutral' | 'success';
  title: string;
  body: string;
}

const AFTER_THAT = 'After that, payouts arrive every business day, about 2 business days after each payment.';
const DEPOSIT = 'Each payout reaches your bank as one deposit, after processing fees, from ServWave.';

/** "Fri, Nov 13" for a 'YYYY-MM-DD' day, read as a calendar day (no timezone shift). */
function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * What the payout pages say about payouts for an account that can take payments: until the first payout reaches the
 * bank, how long it usually takes (competitors warn new customers the same way); once it has, a short confirmation.
 * Null when the account cannot take payments yet (the status card says why) or the status carries no payout state.
 * Never names the processor.
 */
export function firstPayoutNotice(s: StripeStatus): FirstPayoutNoticeCopy | null {
  const first = s.first_payout;
  if (!first || !s.connected || !s.terms_accepted || !s.stripe_details_submitted || !s.stripe_charges_enabled) return null;
  if (first.state === 'arrived') {
    return {
      tone: 'success',
      title: 'Payouts are arriving regularly',
      body: first.arrival_date
        ? `Your first payout reached your bank on ${dayLabel(first.arrival_date)}. ${AFTER_THAT.replace('After that, payouts', 'Payouts')}`
        : AFTER_THAT.replace('After that, payouts', 'Payouts'),
    };
  }
  if (first.state === 'on_the_way') {
    return {
      tone: 'neutral',
      title: first.arrival_date ? `Your first payout is on its way, expected ${dayLabel(first.arrival_date)}` : 'Your first payout is on its way',
      body: `${DEPOSIT} ${AFTER_THAT}`,
    };
  }
  return {
    tone: 'neutral',
    title: 'Your first payout can take up to 7 business days',
    body:
      'A new payout account’s first payout can take up to 7 business days after its first card payment, while the account is checked. ' +
      `${AFTER_THAT} Bank (ACH) payments take about 4 more business days. ${DEPOSIT}`,
  };
}
