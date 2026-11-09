/** The kinds of infrastructure failure the command tells apart from a failed test. */
export type InfraKind = 'server-start' | 'clone' | 'lane-died' | 'wiring' | 'server-died';

/** A failure of the machinery around the tests (the server, the copies, a lane, the wiring), never of a product test. */
export class InfraError extends Error {
  constructor(readonly kind: InfraKind, message: string) {
    super(message);
    this.name = 'InfraError';
  }
}
