/**
 * The customer's document request, started early (mobile slice 61, PERF-03).
 *
 * `public-early.template.js` (loaded async by `public.html`) starts the request for the estimate or
 * invoice in the link before the page's scripts have downloaded and leaves the pending response on
 * `window.__earlyPublicFetch`. The page asks for the same URL through `fetchPublicDocument`, which
 * hands that response over once and otherwise makes the request itself, so a missing, failed or
 * mismatched early request costs nothing but the time it would have saved.
 *
 * Only the first load uses it. A later request (the page re-reading the document after a payment
 * return) is a fresh `fetch`, because the early response is taken, not kept.
 */

interface EarlyPublicFetch {
  url: string;
  response: Promise<Response>;
}

declare global {
  interface Window {
    __earlyPublicFetch?: EarlyPublicFetch;
  }
}

/** The pending early response for `url`, once, or null when there is none for exactly that URL. */
export function takeEarlyPublicResponse(url: string): Promise<Response> | null {
  if (typeof window === 'undefined') return null;
  const early = window.__earlyPublicFetch;
  if (!early || early.url !== url) return null;
  delete window.__earlyPublicFetch;
  return early.response;
}

/** `fetch(url)`, using the early request when it was started for this very URL. */
export function fetchPublicDocument(url: string): Promise<Response> {
  const early = takeEarlyPublicResponse(url);
  if (!early) return fetch(url);
  return early.catch(() => fetch(url));
}
