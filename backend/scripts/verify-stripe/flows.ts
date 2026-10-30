import path from 'path';

/**
 * Payments go-live slice 39 - the one list of flows the suite runs, in run order, and the
 * scenarios each one proves. A scenario nothing claims is a hole in the go-live evidence, and the
 * unit test over this file fails on it.
 */
export const SCENARIOS = [
  'card-invoice',
  'card-deposit',
  'card-partial-tip',
  'ach-success',
  'ach-failure',
  'ach-partial-refund',
  'refund-by-id-one-row',
  'in-app-refund',
  'dispute',
  'link-display',
  'klarna-absent',
  'link-hidden-fallback',
  'idempotency-double-fire',
  'signature-mismatch',
  'missing-metadata',
  'unknown-account-event',
  'connected-account-event',
  'hosted-bank-connected',
  'hosted-bank-deposit',
  'nightly-reconcile',
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type Need = 'charging-account' | 'staff-session';

export interface FlowDef {
  id: string;
  covers: readonly Scenario[];
  /** Setup the flow cannot run without; it reports itself skipped when one is missing. */
  needs?: readonly Need[];
}

export const FLOWS: readonly FlowDef[] = [
  { id: 'account-model', covers: [] },
  { id: 'connect-infra', covers: [] },
  { id: 'checkout-per-method', covers: [] },
  { id: 'link-klarna-gate', covers: ['link-display', 'klarna-absent'] },
  { id: 'link-hidden-fallback', covers: ['link-hidden-fallback'], needs: ['charging-account'] },
  { id: 'flow-A-deposit-checkout', covers: ['card-deposit'] },
  { id: 'flow-B-invoice-checkout', covers: ['card-invoice'] },
  { id: 'flow-C-deposit-refund-realapi', covers: ['refund-by-id-one-row'] },
  { id: 'flow-D-invoice-refund-realapi', covers: ['refund-by-id-one-row'] },
  { id: 'flow-F-dispute-realapi', covers: ['dispute'] },
  { id: 'flow-G-ach-lifecycle', covers: ['ach-success', 'ach-failure'] },
  { id: 'flow-H-partial-ach-refund', covers: ['ach-partial-refund'] },
  { id: 'flow-I-estimate-deposit-flows', covers: [] },
  { id: 'idempotency-double-fire', covers: ['idempotency-double-fire'] },
  { id: 'signature-mismatch', covers: ['signature-mismatch'] },
  { id: 'missing-metadata', covers: ['missing-metadata'] },
  { id: 'flow-J-partial-card-tip', covers: ['card-partial-tip'], needs: ['charging-account'] },
  { id: 'flow-K-in-app-refund', covers: ['in-app-refund', 'refund-by-id-one-row'], needs: ['charging-account', 'staff-session'] },
  { id: 'flow-L-connected-account-event', covers: ['connected-account-event'], needs: ['charging-account'] },
  { id: 'flow-M-unknown-account-event', covers: ['unknown-account-event'], needs: ['charging-account'] },
  { id: 'flow-N-hosted-bank-connected', covers: ['hosted-bank-connected', 'hosted-bank-deposit'], needs: ['charging-account'] },
  // Last: it checks the money every flow above booked.
  { id: 'nightly-reconcile', covers: ['nightly-reconcile'], needs: ['charging-account'] },
];

export function uncoveredScenarios(): Scenario[] {
  const claimed = new Set(FLOWS.flatMap((f) => f.covers));
  return SCENARIOS.filter((s) => !claimed.has(s));
}

export function flowFilePath(id: string): string {
  return path.join(__dirname, 'tests', `${id}.ts`);
}
