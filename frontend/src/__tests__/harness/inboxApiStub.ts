/**
 * The mocks of the routed Email page (`src/pages/v2/communication/InboxPage.tsx`) for `vi.mock` factories (#3259). `vi.mock` is
 * hoisted per file, so a test file still writes the `vi.mock` call; the body comes from here. Kept apart from the page harness
 * (`inboxPage.tsx`) because a `vi.mock` factory cannot import a module that itself imports the mocked module: this one imports
 * nothing of the app.
 *
 *   vi.mock('@/lib/api/communication', async (importOriginal) =>
 *     (await import('@/__tests__/harness/inboxApiStub')).communicationStubs(await importOriginal(), { hooks: { useEmails: () => ({ data: EMAILS }) } }));
 *   vi.mock('@/lib/entitlements', async (importOriginal) =>
 *     (await import('@/__tests__/harness/inboxApiStub')).inboxEntitlements(await importOriginal()));
 */
import { vi } from 'vitest';

/** One array for every render: the page seeds its own state from these, and a fresh array each render would re-seed forever. */
const NOTHING: unknown[] = [];

/** The data hooks every hook-stubbing test of the page stubs, with the answer each gives unless the test says otherwise. */
const STANDARD = {
  useEmailGroups: () => ({ data: NOTHING }),
  useForwardRules: () => ({ data: NOTHING }),
  useTeamMembers: () => ({ data: NOTHING }),
  useSendingIdentity: () => ({ data: undefined }),
  useMarkEmailThreadRead: () => ({ mutate: vi.fn() }),
  useMarkEmailThreadUnread: () => ({ mutate: vi.fn() }),
  useSendEmail: () => ({ mutate: vi.fn(), isPending: false }),
  useMyMailbox: () => ({ data: { mailbox: null } }),
};

export interface CommunicationStubs {
  /** Standard hooks left REAL (they read the fake server of `serveInbox`), by name. */
  leave?: ReadonlyArray<keyof typeof STANDARD>;
  /** Hooks a test shapes itself, by name: a list for `useEmails`, a spy for a mutation, an identity. Added to / replacing the standard ones. */
  hooks?: Record<string, unknown>;
}

/** The module `@/lib/api/communication` with the standard data hooks stubbed; everything else is the real module. */
export function communicationStubs<M extends object>(actual: M, opts: CommunicationStubs = {}) {
  const standard = Object.fromEntries(Object.entries(STANDARD).filter(([name]) => !opts.leave?.includes(name as keyof typeof STANDARD)));
  return { ...actual, ...standard, ...opts.hooks };
}

/** The module `@/lib/entitlements` with every feature on (`feature` decides a feature by key when a test turns one off). */
export function inboxEntitlements<M extends object>(actual: M, opts: { ready?: boolean; feature?: (key: string) => boolean } = {}) {
  return {
    ...actual,
    useFeature: opts.feature ?? (() => true),
    ...(opts.ready === false ? {} : { useEntitlementsReady: () => true }),
  };
}
