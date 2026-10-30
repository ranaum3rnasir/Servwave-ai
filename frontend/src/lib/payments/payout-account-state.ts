import { deriveStripeState } from '@/components/payments/PaymentsStatusCard';
import type { StripeStatus } from '@/lib/api/organization';

export type PayoutTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface PayoutAccountState {
  label: string;
  tone: PayoutTone;
  /** What the owner sees on the page for this state. Never the processor's reason code or an account id. */
  message: string;
}

/**
 * The payout account in plain words (slice 34): Active, Action needed or Restricted, plus the two states that
 * come before an account is usable. Built on the same state table as the Settings > Payments card, so the two
 * never disagree.
 */
export function payoutAccountState(s: StripeStatus): PayoutAccountState {
  switch (deriveStripeState(s)) {
    case 1:
      return { label: 'Not set up', tone: 'neutral', message: 'Set up your payout account to receive card and bank payments.' };
    case 2:
      return { label: 'Setup in progress', tone: 'neutral', message: 'Finish the steps below to start receiving payments.' };
    case 3:
      return { label: 'Under review', tone: 'warning', message: 'Your details are being verified. Payments turn on once that is done.' };
    case 4:
    case 5:
      return { label: 'Active', tone: 'success', message: 'Your payout account is active.' };
    case 6:
      return { label: 'Action needed', tone: 'warning', message: 'One more thing is needed to keep your payments running.' };
    case 7:
      return { label: 'Restricted', tone: 'danger', message: 'Payments are paused until a bit more information is provided.' };
    default:
      return { label: 'Restricted', tone: 'danger', message: 'This account cannot receive payments. Contact ServWave support.' };
  }
}
