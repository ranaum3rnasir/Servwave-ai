import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * `/public-early.js`: the script that starts the customer's document request before the page's
 * scripts have downloaded (mobile slice 61, PERF-03). The source is `public-early.template.js`;
 * this fills in the API address and serves it (dev and preview) or emits it (the customer page's
 * build). See the template for why it is a separate plain file.
 */

export const PUBLIC_EARLY_FILE = 'public-early.js';
const PLACEHOLDER = 'PUBLIC_API_BASE_PLACEHOLDER';

/** The template with the API address filled in as a string literal. Empty means "this origin". */
export function publicEarlyScript(template: string, apiBase: string | undefined): string {
  return template.replaceAll(PLACEHOLDER, JSON.stringify(apiBase ?? ''));
}

type Middlewares = {
  use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (body: string) => void }, next: () => void) => void) => void;
};

/**
 * @param root     the frontend folder, where the template lives.
 * @param apiBase  `VITE_API_URL` as the build was given it (the pages read the same variable).
 * @param emit     true in the customer page's build, which writes the file into `dist/`; false in
 *                 the staff build, whose output has no use for it. The dev and preview servers
 *                 serve it either way.
 */
export function publicEarlyScriptPlugin({ root, apiBase, emit }: { root: string; apiBase: string | undefined; emit: boolean }): Plugin {
  const source = () => publicEarlyScript(readFileSync(path.join(root, 'public-early.template.js'), 'utf8'), apiBase);
  const serve = (middlewares: Middlewares) => {
    middlewares.use((req, res, next) => {
      if (req.url?.split('?')[0] !== `/${PUBLIC_EARLY_FILE}`) return next();
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(source());
    });
  };
  return {
    name: 'public-early-script',
    configureServer(server) {
      serve(server.middlewares as unknown as Middlewares);
    },
    configurePreviewServer(server) {
      serve(server.middlewares as unknown as Middlewares);
    },
    generateBundle() {
      if (emit) this.emitFile({ type: 'asset', fileName: PUBLIC_EARLY_FILE, source: source() });
    },
  };
}
