/*
 * Preloaded (node --require) into every process the Database command starts. Makes the developer's env files (".env", ".env.local",
 * ".env.<mode>") look absent, so nothing in the run can read one: the Prisma client, dotenv in the app's config, the Prisma command
 * line and the test tool all load such a file into the environment of the process that imports them, and what that file names (the
 * developer's own database, typically) would undo the command's scrub of the database settings. Examples ".env.example" and the
 * like stay readable. Plain CommonJS and no dependency, because it runs before anything else does.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');

const NOT_AN_ENV_FILE = /\.(example|sample|template|defaults)$/;

function hidden(p) {
  let s;
  try {
    if (typeof p === 'string') s = p;
    else if (Buffer.isBuffer(p)) s = p.toString();
    else if (p instanceof URL) s = fileURLToPath(p);
    else return false;
  } catch {
    return false;
  }
  const base = path.basename(s);
  return (base === '.env' || base.startsWith('.env.')) && !NOT_AN_ENV_FILE.test(base);
}

function missing(p, syscall) {
  const shown = typeof p === 'string' ? p : String(p);
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${shown}'`), { errno: -2, code: 'ENOENT', syscall, path: shown });
}

// Synchronous forms.
for (const [name, syscall] of [['readFileSync', 'open'], ['openSync', 'open'], ['statSync', 'stat'], ['lstatSync', 'lstat'], ['accessSync', 'access']]) {
  const real = fs[name];
  fs[name] = function patched(p, ...rest) {
    if (hidden(p)) {
      if ((name === 'statSync' || name === 'lstatSync') && rest[0] && rest[0].throwIfNoEntry === false) return undefined;
      throw missing(p, syscall);
    }
    return real.call(this, p, ...rest);
  };
}
const realExists = fs.existsSync;
fs.existsSync = function patched(p) { return hidden(p) ? false : realExists.call(this, p); };

// Callback forms.
for (const [name, syscall] of [['readFile', 'open'], ['open', 'open'], ['stat', 'stat'], ['lstat', 'lstat'], ['access', 'access']]) {
  const real = fs[name];
  fs[name] = function patched(p, ...rest) {
    if (hidden(p)) {
      const cb = rest[rest.length - 1];
      if (typeof cb === 'function') process.nextTick(cb, missing(p, syscall));
      return undefined;
    }
    return real.call(this, p, ...rest);
  };
}

// Promise forms.
for (const [name, syscall] of [['readFile', 'open'], ['open', 'open'], ['stat', 'stat'], ['lstat', 'lstat'], ['access', 'access']]) {
  const real = fs.promises[name];
  fs.promises[name] = function patched(p, ...rest) {
    return hidden(p) ? Promise.reject(missing(p, syscall)) : real.call(this, p, ...rest);
  };
}

syncBuiltinESMExports();
