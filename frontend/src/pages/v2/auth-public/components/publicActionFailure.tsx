import type { ReactNode } from 'react';

import { PublicCallLink } from './publicShell';

/**
 * What the customer is told when a sign, pay or decline try is refused for a reason they can act on
 * (#2981). One module for the public estimate page AND the public invoice page, so the two can never
 * say different things.
 *
 * - 429 (they ran out of tries): wait, or call.
 * - 404 on an action (the link they hold is no longer the current one): open the latest link, or call.
 * - Anything else: `null`, and the page keeps its own generic message.
 *
 * The phone is the company's, as the page's own payload already carries it, drawn as a call link.
 * With no phone on file the sentence ends where the phone would have started.
 */

export interface PublicActionContact {
  phone?: string | null;
  phone_ext?: string | null;
}

export function publicActionFailure(
  status: number,
  org: PublicActionContact | null | undefined,
  body?: { code?: unknown } | null,
): ReactNode | null {
  const hasPhone = !!org?.phone && /[\d+]/.test(org.phone);
  if (status === 429) {
    return hasPhone ? (
      <>
        We are experiencing issues. Please try again in a few minutes or call us at <PublicCallLink phone={org!.phone!} phoneExt={org!.phone_ext} />.
      </>
    ) : (
      'We are experiencing issues. Please try again in a few minutes.'
    );
  }
  // A 404 that carries a code is a refusal with its own words (the page maps those itself).
  if (status === 404 && typeof body?.code !== 'string') {
    return hasPhone ? (
      <>
        This link is out of date. Please open the latest link we sent you, or call us at <PublicCallLink phone={org!.phone!} phoneExt={org!.phone_ext} />.
      </>
    ) : (
      'This link is out of date. Please open the latest link we sent you.'
    );
  }
  return null;
}
