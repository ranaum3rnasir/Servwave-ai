// Browser-safe stand-in for Node's built-in `module` API, aliased in place of
// the real `module` specifier in vite.config.ts (`resolve.alias`).
//
// Why this exists: email-reply-parser (frontend/src/lib/communication/
// emailQuoteSplit.ts) unconditionally does
// `import { createRequire } from "module"; const require =
// createRequire(import.meta.url);` at the top of its bundled regex.js, purely
// to optionally `require("re2")` for a hardened/ReDoS-safe regex engine -
// wrapped in its own try/catch (`detectRE2()`), falling back to plain
// RegExp when `re2` is not installed. `re2` is a native Node addon; it is not
// and never will be a dependency of this frontend, so that require() was
// always going to fail here exactly like it already does in any Node
// environment that hasn't installed the optional `re2` peer dep - the
// package's own fallback path is the one this app actually uses either way.
//
// The problem is only that `module` (and its `createRequire`) do not exist
// at all in a browser bundle, so without this shim `vite build` fails
// outright (`"createRequire" is not exported by "__vite-browser-external"`)
// and `vite dev` throws at runtime the first time this chunk loads. This
// shim reproduces the exact same "require() throws, library falls back to
// plain RegExp" behavior the package already has, without forking its
// internals or pinning a patched copy.
export function createRequire(): (id: string) => never {
  return () => {
    throw new Error('require() is not available in the browser');
  };
}
