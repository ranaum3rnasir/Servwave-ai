/**
 * The public estimate/invoice PDF link (mobile slice 04, story 112, rubric PUB-02).
 *
 * It points at the API HOST, never a relative `/api/...` path: on the deployed frontend a relative
 * API path is answered by the static host's catch-all rewrite with the app shell (200 + HTML), not
 * the document - the same trap the authed PDF preview hit (vault: Learnings/
 * Vercel-SPA-Fallback-Masks-API-Misroutes.md). Callers open it in the SAME tab, because in-app
 * browsers often drop new windows; the backend serves it `inline` for the same reason.
 */
export function publicPdfHref(kind: 'estimates' | 'invoices', id: string, token: string): string {
  return `${import.meta.env.VITE_API_URL || ''}/api/${kind}/${id}/public/pdf?token=${encodeURIComponent(token)}`;
}
