/*
 * Starts the customer's document request while the page's scripts are still downloading
 * (mobile slice 61, PERF-03). public.html loads this file async, so it runs as soon as its few
 * hundred bytes arrive; the document's own data request then no longer waits behind about 160 KB
 * of script, which on a phone line is most of a second of the largest paint.
 *
 * It only starts the request. src/lib/platform/earlyPublicFetch.ts hands the response to the page
 * when the page asks for the same URL, and the page falls back to a plain request of its own if it
 * is missing, failed or is for a different URL, so nothing here can break a page.
 *
 * This is a TEMPLATE: `public-early-script.ts` replaces the placeholder name in `var base` below with the
 * API address the build was given (the same VITE_API_URL the two pages read) and serves or emits
 * the result as /public-early.js. A separate same-origin file, because the content security policy
 * has no inline scripts; not bundled, so it stays a plain script; and not part of `public/`, so the
 * staff app's offline cache does not carry it. `earlyPublicFetch.test.ts` runs it as written.
 * The URL shape must stay identical to the one the two pages build (`PublicEstimatePage`,
 * `PublicInvoicePage`); the test pins both.
 */
(function () {
  try {
    var path = /^\/p\/(estimates|invoices)\/([^/]+)\/?$/.exec(window.location.pathname);
    var token = new URLSearchParams(window.location.search).get('token');
    if (!path || !token) return;
    var base = PUBLIC_API_BASE_PLACEHOLDER;
    var url = base + '/api/' + path[1] + '/' + decodeURIComponent(path[2]) + '/public?token=' + encodeURIComponent(token);
    var response = window.fetch(url);
    response.catch(function () {});
    window.__earlyPublicFetch = { url: url, response: response };
  } catch (e) {
    /* the page makes its own request */
  }
})();
