import type { DepositPolicy, PaymentMethod } from '@prisma/client';
import { onlinePaymentsInPlan } from './online-payments-plan';

/**
 * Payments go-live slice 19 - the payment options resolver (PRD Module 6, D5).
 *
 * One pure function returns a document's effective payment options from the org's defaults, the
 * document's overrides and what the org's payout account can take today. The public pay pages,
 * the send dialogs and the checkout builder ask it; nothing else reads the raw settings.
 */

export type OnlineMethod = 'CARD' | 'ACH';

export interface OrgPaymentDefaults {
  /** The org's default offered methods (accepted methods, after the legacy per-org override). */
  methods: PaymentMethod[];
  tips_enabled: boolean;
  /** Whole percentages of the pre-tax amount being paid. */
  tip_presets: number[];
  deposit_policy: DepositPolicy;
  bank_transfer_instructions: string | null;
}

/** What the org's payout account can take right now. */
export interface PaymentCapabilities {
  card: boolean;
  ach: boolean;
}

export interface PaymentOptions {
  /** Every method offered on this document, online ones only when the account can take them. */
  methods: PaymentMethod[];
  online_methods: OnlineMethod[];
  tips: { enabled: boolean; presets: number[] };
  allow_partial: boolean;
  deposit_policy: DepositPolicy;
  /** The org's manual-transfer instructions, only while BANK_TRANSFER is offered here. */
  bank_transfer_instructions: string | null;
}

/**
 * One document's overrides. Every field is nullable and null means "follow the org":
 * - methods: the invoice's methods override, or the methods an estimate was sent with;
 * - allow_partial: invoice only, null = off;
 * - deposit_policy: estimate only.
 * Tips have no document override (PRD call 6).
 */
export interface DocumentPaymentOverrides {
  methods?: PaymentMethod[] | null;
  allow_partial?: boolean | null;
  deposit_policy?: DepositPolicy | null;
}

export interface ResolvePaymentOptionsInput {
  org: OrgPaymentDefaults;
  document?: DocumentPaymentOverrides | null;
  capabilities: PaymentCapabilities;
}

/** ACH is in the org's accepted methods: the stored mirror of the account's bank-debit capability. */
export function achCapabilityListed(org: { accepted_payment_methods?: unknown }): boolean {
  return Array.isArray(org.accepted_payment_methods) && (org.accepted_payment_methods as unknown[]).includes('ACH');
}

/**
 * The account can take bank payments: ACH is in its accepted methods (the server-owned mirror of
 * the bank-debit capability) AND it can take money at all. A deauthorized or failed-closed account
 * has charges off, so ACH goes with it.
 */
export function achCapabilityActive(org: { accepted_payment_methods?: unknown; stripe_charges_enabled?: boolean | null }): boolean {
  return achCapabilityListed(org) && org.stripe_charges_enabled === true;
}

const ONLINE_METHODS: readonly OnlineMethod[] = ['CARD', 'ACH'];

function isOnline(method: PaymentMethod): method is OnlineMethod {
  return (ONLINE_METHODS as readonly string[]).includes(method);
}

function canTake(method: OnlineMethod, capabilities: PaymentCapabilities): boolean {
  return method === 'CARD' ? capabilities.card : capabilities.ach;
}

export function resolvePaymentOptions({ org, document, capabilities }: ResolvePaymentOptionsInput): PaymentOptions {
  // A document's method list replaces the org default (a large job can be bank-only).
  const listed = document?.methods ?? org.methods;
  // An online method is offered only while the account can take it (CARD -> card capability,
  // ACH -> ACH capability), whatever a list says: the capability is server-owned. Manual methods
  // pass through untouched.
  const methods = listed.filter((m) => !isOnline(m) || canTake(m, capabilities));
  return {
    methods,
    online_methods: methods.filter(isOnline),
    tips: org.tips_enabled ? { enabled: true, presets: [...org.tip_presets] } : { enabled: false, presets: [] },
    allow_partial: document?.allow_partial === true,
    deposit_policy: document?.deposit_policy ?? org.deposit_policy,
    bank_transfer_instructions: methods.includes('BANK_TRANSFER') ? org.bank_transfer_instructions : null,
  };
}

/**
 * The tip each preset stands for, in cents (story 27). A preset is a percentage of the PRE-TAX
 * portion of the amount being paid, so a customer is never nudged into tipping on tax: paying
 * part of an invoice tips on that part's share of the pre-tax total. One rounding, at the end.
 */
export function tipPresetAmountsCents(input: {
  presets: number[];
  payingCents: number;
  totalCents: number;
  taxCents: number;
}): number[] {
  const { presets, payingCents, totalCents, taxCents } = input;
  if (totalCents <= 0) return presets.map(() => 0);
  const preTaxCents = Math.max(0, totalCents - taxCents);
  return presets.map((pct) => Math.round((payingCents * preTaxCents * pct) / (totalCents * 100)));
}

// ─── Reading an org row into the resolver's inputs ──────────────────────────
// The callers (public pages, checkout, send dialogs) load rows; these turn a row into the pure
// inputs above, so no caller interprets the raw settings itself. Fields a row lacks (a narrow
// select) read as the column defaults the migration gives every existing org.

export interface OrgPaymentRow {
  accepted_payment_methods: unknown;
  stripe_charges_enabled: boolean;
  /** Story 24: false = Card is offered only on a document that lists it. Missing reads as true. */
  card_offered_by_default?: boolean | null;
  /** Story 24: false = bank payment (ACH) is offered only on a document that lists it. Missing reads as true. */
  bank_offered_by_default?: boolean | null;
  tips_enabled?: boolean | null;
  tip_presets?: number[] | null;
  deposit_policy?: DepositPolicy | null;
  bank_transfer_instructions?: string | null;
  /**
   * Slice 16: the plan fields (ORG_PLAN_SELECT). Required, so every lookup that feeds the
   * resolver reads them: an org whose plan lacks online payments is offered no online method.
   */
  plan: string;
  trial_ends_at: Date | null;
  feature_overrides: unknown;
}

/** Column defaults (migration 20261006210000_payment_options). */
export const DEFAULT_TIP_PRESETS = [10, 15, 20];
export const DEFAULT_DEPOSIT_POLICY: DepositPolicy = 'REQUIRED_BEFORE_APPROVAL';

/**
 * The org's default method list, before capabilities: organizations.accepted_payment_methods is
 * the only source (conductor decision 2026-10-06). The legacy per-org `available_payment_methods`
 * settings row is NOT read: every onboarded tenant carries it frozen at its provisioning value, so
 * reading it would shadow whatever the owner saves. Only a missing org row falls back to a fixed
 * default.
 */
export function orgDefaultMethods(org: OrgPaymentRow | null | undefined): PaymentMethod[] {
  return (Array.isArray(org?.accepted_payment_methods)
    ? (org!.accepted_payment_methods as string[])
    : ['CARD', 'EXTERNAL_CARD', 'BANK_TRANSFER', 'CHECK', 'CASH']) as PaymentMethod[];
}

export function orgPaymentDefaults(org: OrgPaymentRow | null | undefined): OrgPaymentDefaults {
  // Story 24: the owner can leave Card or Bank out of the DEFAULT offer. Each stays a capability (a
  // document that lists it still offers it), so it is dropped here and not in orgPaymentCapabilities.
  // The default list is the manual methods, plus CARD / ACH while the account can take them (the
  // resolver checks that) and the owner offers them by default.
  const methods = orgDefaultMethods(org).filter((m) =>
    (m !== 'CARD' || org?.card_offered_by_default !== false) && (m !== 'ACH' || org?.bank_offered_by_default !== false));
  return {
    methods,
    tips_enabled: org?.tips_enabled === true,
    tip_presets: Array.isArray(org?.tip_presets) ? org!.tip_presets! : DEFAULT_TIP_PRESETS,
    deposit_policy: org?.deposit_policy ?? DEFAULT_DEPOSIT_POLICY,
    bank_transfer_instructions: org?.bank_transfer_instructions ?? null,
  };
}

/**
 * What the org can take online. CARD: charges are enabled and CARD is in the accepted methods.
 * ACH: achCapabilityActive. Neither while the org's plan lacks online payments (slice 16): the
 * checkout door refuses both then, so no page or dialog that asks the resolver may offer them.
 */
export function orgPaymentCapabilities(org: OrgPaymentRow | null | undefined): PaymentCapabilities {
  const inPlan = !!org && onlinePaymentsInPlan(org);
  return {
    card: inPlan && org.stripe_charges_enabled === true && orgDefaultMethods(org).includes('CARD'),
    ach: inPlan && achCapabilityActive(org),
  };
}

/** Parses a stored methods override (JSON column); anything but an array of strings is "no override". */
export function storedMethodsOverride(value: unknown): PaymentMethod[] | null {
  return Array.isArray(value) && value.every((m) => typeof m === 'string') ? (value as PaymentMethod[]) : null;
}

/** The whole read: org row + one document's overrides -> effective options. */
export function paymentOptionsFor(
  org: OrgPaymentRow | null | undefined,
  document?: DocumentPaymentOverrides | null,
): PaymentOptions {
  return resolvePaymentOptions({
    org: orgPaymentDefaults(org),
    document,
    capabilities: orgPaymentCapabilities(org),
  });
}
