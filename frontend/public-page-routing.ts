import type { Plugin } from 'vite';

/**
 * Serves `public.html` for a customer's link in `vite dev` and `vite preview`, the way
 * `vercel.json`'s `/p/(.*)` rewrite does on the host (mobile slice 47).
 *
 * Without it both dev servers fall back to `index.html` for any unknown path, so a local run and
 * the mobile gate would exercise the staff entry instead of the light one that customers get.
 *
 * Its own module (not inline in vite.config.ts) so a unit test can pin the mapping.
 */

/** The URL to serve instead, or null to leave the request alone. Query string is preserved. */
export function publicPageRewrite(url: string | undefined): string | null {
  if (!url) return null;
  const qs = url.indexOf('?');
  const path = qs === -1 ? url : url.slice(0, qs);
  if (!path.startsWith('/p/')) return null;
  return `/public.html${qs === -1 ? '' : url.slice(qs)}`;
}

type Middlewares = { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void };

function rewrite(middlewares: Middlewares) {
  middlewares.use((req, _res, next) => {
    const target = publicPageRewrite(req.url);
    if (target) req.url = target;
    next();
  });
}

export function servePublicPage(): Plugin {
  return {
    name: 'serve-public-page',
    configureServer(server) {
      // Added directly (not returned from a callback) so it runs BEFORE Vite's own html fallback.
      rewrite(server.middlewares as unknown as Middlewares);
    },
    configurePreviewServer(server) {
      rewrite(server.middlewares as unknown as Middlewares);
    },
  };
}
