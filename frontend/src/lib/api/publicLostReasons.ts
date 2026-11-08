import { useEffect, useState } from 'react';

import { LOST_REASON_OPTIONS } from '@/constants/lostReasons';

/**
 * The decline reasons the CUSTOMER may choose between - slice C's public half (decision D6).
 *
 * WHY THIS IS NOT `useLostReasonOptions()`. That one goes through `lib/axios`, which attaches the
 * signed-in user's Bearer token; the public estimate page has no session at all. The `?token=` in
 * the URL is the only credential the customer holds, so this speaks to a separate token-scoped
 * route and uses bare `fetch` with `VITE_API_URL` - the same way every other call on that page
 * does, and for the same reason.
 *
 * WHY IT FETCHES ON OPEN RATHER THAN ON PAGE LOAD. Slice 1's acceptance says the decline dialog
 * "must not start returning anything the page did not already have". Hanging the org's list off
 * the estimate payload would ship it to everyone holding a link whether or not they ever decline;
 * `enabled` is the dialog's own open state, so the request happens when the question is asked.
 *
 * WHY IT FAILS OPEN, TO THE FIVE BUILT-INS. A customer who finds an empty picker - or worse, a
 * spinner - may abandon the decline altogether, and the business would lose the STATUS and not
 * merely the reason. So the built-ins are the starting value and only a good answer replaces
 * them. If the list was curated and this request failed, the customer may pick a word the org
 * retired; the server drops an unoffered code and keeps the decline (D8), which is the same
 * trade made everywhere else on this page: a bad answer costs the answer, never the decline.
 */
export function usePublicLostReasons(
  estimateId: string | undefined,
  token: string | null,
  enabled: boolean,
): { value: string; label: string }[] {
  const [options, setOptions] = useState(LOST_REASON_OPTIONS);

  useEffect(() => {
    if (!enabled || !estimateId || !token) return;
    // Guards the late answer: the customer can close the dialog before this lands, and React
    // would warn about the set on an unmounted page.
    let cancelled = false;

    void fetch(
      `${import.meta.env.VITE_API_URL || ''}/api/estimates/${estimateId}/decline-reasons?token=${encodeURIComponent(token)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { decline_reasons?: { code: string; label: string }[] } | null) => {
        if (cancelled) return;
        const list = body?.decline_reasons;
        // An empty array is not an answer worth rendering - it would leave the customer with
        // nothing to pick - so the built-ins stand in that case too.
        if (Array.isArray(list) && list.length > 0) {
          setOptions(list.map((r) => ({ value: r.code, label: r.label })));
        }
      })
      .catch(() => {
        // Deliberately silent. See the header: the decline matters more than the reason, and a
        // customer has no use for a diagnostic about the vendor's settings list.
      });

    return () => {
      cancelled = true;
    };
  }, [estimateId, token, enabled]);

  return options;
}
