/**
 * safeHref — scheme allowlist for any href/src bound to a user- or seed-supplied URL.
 *
 * React does NOT block `javascript:` / `data:` / `vbscript:` URIs in href (it only logs a
 * dev-time warning), so an unsanitized stored URL is a latent DOM-XSS sink (security finding
 * F-14). This returns the URL ONLY when it parses to an allowed scheme, else `undefined`
 * (when undefined, React omits the href and the anchor renders as inert, non-navigating text).
 *
 * Allowed: http, https, mailto, tel. Protocol-relative (`//host`) and scheme-relative paths
 * (`/foo`, `foo`, `#frag`, `?q`) are treated as same-origin-safe and passed through. Everything
 * else (javascript:, data:, blob:, vbscript:, file:, …) is rejected.
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (trimmed === '') return undefined;

  // Relative / same-origin references have no scheme — allow them through unchanged.
  // (A leading "//" is protocol-relative and resolves under the page's own https origin.)
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) {
    return trimmed;
  }

  // If there is no ":" before the first "/", "?", or "#", it is a relative path → safe.
  const schemeEnd = trimmed.indexOf(':');
  const firstSep = trimmed.search(/[/?#]/);
  if (schemeEnd === -1 || (firstSep !== -1 && firstSep < schemeEnd)) {
    return trimmed;
  }

  const scheme = trimmed.slice(0, schemeEnd + 1).toLowerCase();
  return ALLOWED_SCHEMES.has(scheme) ? trimmed : undefined;
}
