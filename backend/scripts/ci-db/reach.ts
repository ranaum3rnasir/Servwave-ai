/*
 * What a source file reaches for on disk, found by reading its text. Used by one guard (scripts/__tests__/ci-db-suites.test.ts) to pin the
 * premise of the Database check's path-skip rule (#3238): no real-database suite, and no helper one imports, reads a path above the
 * backend folder, so a change to the frontend, the docs or the agent tooling cannot change what the suites see.
 *
 * It is a reading of text, not an execution: it works out `join`/`resolve` calls built from `__dirname`, the working folder, string
 * literals and constants of the same file; it also catches a relative name given to a file function, a working-folder path built by
 * concatenation, and a question to git for the repository root. A path it cannot work out that climbs out of its folder counts as found
 * ("cannot tell"): the guard asks for a constant it can read. Pure: source in, findings out.
 */
import path from 'node:path';

// A virtual layout: the repository root is /r and the backend folder /r/b. Anything that resolves outside /r/b is above the backend.
const ROOT = '/r';
const BACKEND = '/r/b';

const inside = (p: string): boolean => p === BACKEND || p.startsWith(`${BACKEND}/`);
const above = (p: string): boolean => !inside(p) && (p === ROOT || p === '/' || p.startsWith(`${ROOT}/`));

/** The source with its comments blanked out; strings and template literals are kept as they are. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          // The expression of a template: strings inside it end where they end, braces nest.
          let depth = 1;
          j += 2;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          continue;
        }
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The relative files a file brings in (imports, re-exports, requires, dynamic imports, mocks), and the `@/` alias. Packages are left out. */
export function importsOf(source: string): string[] {
  const code = stripComments(source);
  const found = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?(['"])([^'"]+)\1/g,
    /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*(['"])([^'"]+)\1/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) if (m[2]!.startsWith('.') || m[2]!.startsWith('@/')) found.add(m[2]!);
  return [...found];
}

// ---- the reads ------------------------------------------------------------------------------------------------------------------------

const FILE_FUNCTIONS = 'readFileSync|readFile|existsSync|readdirSync|readdir|statSync|lstatSync|accessSync|openSync|createReadStream|cpSync|copyFileSync|writeFileSync';

/** The text of the arguments of the call whose `(` is at `open`, split at the top-level commas. Null when the call never closes. */
function callArgs(code: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < code.length && code[i] !== c) { if (code[i] === '\\') i++; i++; }
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { args.push(code.slice(start, i)); return args; }
    } else if (c === ',' && depth === 1) { args.push(code.slice(start, i)); start = i + 1; }
  }
  return null;
}

const LITERAL = /^\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1\s*$/;

export interface Reads {
  /** What it reaches above the backend folder, as text for a failure message. */
  above: string[];
  /** Backend-relative paths it builds that stay inside the backend folder (a script it runs, a folder it reads). */
  inside: string[];
}

/** `dir` is the folder of the file, relative to the backend folder (posix, no leading slash). */
export function readsOf(source: string, dir: string): Reads {
  const code = stripComments(source);
  const reads: Reads = { above: [], inside: [] };
  const here = path.posix.join(BACKEND, dir);
  const vars = new Map<string, string | null>();

  const value = (arg: string): string | null => {
    const a = arg.trim();
    if (a === '__dirname') return here;
    if (/^(?:path\.)?dirname\(\s*__filename\s*\)$/.test(a)) return here;
    if (/^process\.cwd\(\s*\)$/.test(a)) return BACKEND;
    const lit = LITERAL.exec(a);
    if (lit) return lit[1] === '`' && lit[2]!.includes('${') ? null : lit[2]!;
    if (/^[A-Za-z_$][\w$]*$/.test(a)) return vars.get(a) ?? null;
    return null;
  };

  const pathCall = /(?<![\w$.])(?:path\.(?:posix\.)?)?(join|resolve)\s*\(/g;
  for (const m of code.matchAll(pathCall)) {
    const open = m.index! + m[0].length - 1;
    const args = callArgs(code, open);
    if (!args) continue;
    const name = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*$/.exec(code.slice(Math.max(0, m.index! - 120), m.index!))?.[1];
    const values = args.map(value);
    const literals = args.map((a) => LITERAL.exec(a)?.[2]);
    // The folders a literal climbs through, and whether what comes right after the last climb is the installed packages (which only a
    // manifest or lockfile change alters, and those are never on the list of irrelevant paths).
    const lastClimb = literals.reduce((at, l, i) => (l !== undefined && l.split('/').includes('..') ? i : at), -1);
    const climbs = lastClimb >= 0;
    const afterClimb = lastClimb >= 0 ? literals.slice(lastClimb).join('/').split('/').filter((x) => x !== '..' && x !== '') : [];
    const intoPackages = afterClimb[0] === 'node_modules';
    const known = values.findIndex((v) => v === null);
    const prefix = (known < 0 ? values : values.slice(0, known)) as string[];
    if (prefix.length === 0) {
      // The base is something it cannot work out (a parameter, an import of another file): harmless unless the call climbs.
      if (name) vars.set(name, null);
      if (climbs && !intoPackages) reads.above.push(`${m[1]}(${args.map((a) => a.trim()).join(', ')}) (cannot tell where it ends: use a constant this guard can read)`);
      continue;
    }
    const resolved = path.posix.resolve(ROOT, ...prefix.map((v, i) => (i === 0 && !v.startsWith('/') ? path.posix.join(BACKEND, v) : v)));
    // Names after the known part cannot take it back up. Only the known part is judged.
    if (name) vars.set(name, known < 0 ? resolved : null);
    const packages = resolved === `${ROOT}/node_modules` || resolved.startsWith(`${ROOT}/node_modules/`);
    if (above(resolved) && !packages && !(intoPackages && resolved === ROOT)) reads.above.push(`${m[1]}(${args.map((a) => a.trim()).join(', ')}) -> ${path.posix.relative(BACKEND, resolved) || '..'}`);
    else if (inside(resolved) && known < 0) reads.inside.push(path.posix.relative(BACKEND, resolved) || '.');
  }

  const direct = [
    // A relative name given to a file function is relative to the working folder, which is the backend folder.
    new RegExp(`\\b(?:${FILE_FUNCTIONS})\\s*\\(\\s*(['"\`])(\\.\\.(?:/[^'"\`]*)?)\\1`, 'g'),
  ];
  for (const re of direct) for (const m of code.matchAll(re)) reads.above.push(`a file function given '${m[2]}'`);
  for (const m of code.matchAll(/process\.cwd\(\s*\)\s*\+\s*(['"`])\/?\.\.(?:\/|\1)/g)) reads.above.push(`process.cwd() + '${m[0].slice(m[0].indexOf(m[1]!) + 1)}`);
  for (const m of code.matchAll(/\$\{\s*process\.cwd\(\s*\)\s*\}\/\.\.(?:\/|`)/g)) reads.above.push(m[0]);
  for (const m of code.matchAll(/--show-toplevel|--show-cdup|--show-superproject-working-tree/g)) reads.above.push(`git ${m[0]} (asks for the repository root)`);
  return reads;
}

/** What the source reaches above the backend folder; empty when it stays inside. */
export function pathsAboveBackend(source: string, dir: string): string[] {
  return readsOf(source, dir).above;
}
