import type Stripe from 'stripe';

/** A flow throws this when the setup it needs is missing; the report lists it as skipped, with the reason. */
export class SkipFlow extends Error {}

/** Money a flow booked, so the nightly check at the end can be asked about exactly that money. */
export interface BookedMoney {
  flow: string;
  orgId: string;
  paymentId?: string;
  chargeId?: string | null;
  intentId?: string | null;
}

export interface SuiteContext {
  /** The backend under test. */
  apiUrl: string;
  /** The sandbox platform client (sk_test_ only; preflight enforces it). */
  stripe: Stripe;
  /** An onboarded sandbox connected account the connected-account flows charge on. */
  chargingAccount: string | null;
  booked: BookedMoney[];
}

export interface RunOpts {
  verbose: boolean;
}
