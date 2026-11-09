/* eslint-disable react-refresh/only-export-components -- a test harness, never hot-reloaded */
import { useEffect } from 'react';
import { vi } from 'vitest';

/**
 * The mocks of the routed public estimate page (`src/pages/v2/auth-public/PublicEstimatePage.tsx`) and its sibling the public
 * invoice page, for `vi.mock` factories (#3259). Kept apart from the page harness (`publicEstimatePage.tsx`) because a
 * `vi.mock` factory cannot import a module that itself imports the mocked module: this one imports only the test tool.
 *
 *   vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/publicEstimateMocks')).publicRouter());
 *   vi.mock('react-signature-canvas', async () => (await import('@/__tests__/harness/publicEstimateMocks')).signedPad());
 *
 * The address the customer arrived on is state of this module, set by `renderPublicEstimate` (or `setPublicRoute` for the
 * invoice page) every time a page is drawn, so a file that holds many cases never carries one case's address into the next.
 */
export const publicRoute = { id: 'est-1', query: 'token=tok-1' };

/** What `useParams` and `useSearchParams` answer from now on: the document id and the token (or a whole query string). */
export function setPublicRoute(route: { id: string; token?: string; query?: string }): void {
  publicRoute.id = route.id;
  publicRoute.query = route.query ?? `token=${route.token ?? 'tok-1'}`;
}

/** The real router, but for the two hooks that read the address the link was opened on. */
export async function publicRouter() {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: publicRoute.id }),
    useSearchParams: () => [new URLSearchParams(publicRoute.query), vi.fn()],
  };
}

/** Whether the pad reports a drawn signature when it mounts: set by `renderPublicEstimate` (`signed`, default true). */
export const padState = { signedOnMount: true };

/**
 * A signature pad that reports "signature drawn" on mount (fires the real `onEnd` prop), so the deposit payment step renders
 * at once, as for a customer who has already signed. jsdom has no canvas.
 */
export function signedPad() {
  function SignedPad(props: { onEnd?: () => void }) {
    useEffect(() => {
      if (padState.signedOnMount) props.onEnd?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }
  return { default: SignedPad };
}

/** A pad that never draws anything: for a case that is not about signing. */
export function blankPad() {
  return { default: () => null };
}
