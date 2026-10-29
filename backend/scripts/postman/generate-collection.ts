/**
 * Builds a Postman collection (format v2.1) of the ServWave API from the code itself.
 *
 *   npx tsx scripts/postman/generate-collection.ts [output.json]
 *
 * Nothing here is hand-maintained: the script loads the real Express app, walks its router
 * stack for every method + path, and turns each route's `validate(schema)` Zod schema into an
 * example JSON body. Run it against `main` and the collection lists exactly what production
 * serves. The release workflow (.github/workflows/postman-collection.yml) does that on every
 * push to main and commits the result to the mobile app repository.
 *
 * It never connects to a database or sends a request: loading the app only builds the router,
 * so placeholder connection settings are enough (set below, before the app is required).
 */
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

// ─── Load the app with a validate() that remembers its schema ────────────────

// The app validates env at import time; these placeholders satisfy it. Nothing connects.
// Development mode: production also demands live mail and signing secrets at startup. The only
// routes that differ are the test-only /api/test ones, which EXCLUDED_PREFIXES drops below.
process.env.NODE_ENV = 'development';
process.env.DATABASE_URL ||= 'postgresql://postman:postman@127.0.0.1:5432/postman';
process.env.SUPABASE_URL ||= 'https://placeholder.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder';

const SRC = path.resolve(__dirname, '../../src');
const VALIDATE_FILE = path.join(SRC, 'middleware', 'validate.ts');
const SCHEMA_TAG = Symbol('zodSchema');

// validate(schema) returns a closure, so the schema is unreachable from the router stack.
// Swap the module for a copy whose middleware carries its schema, before any route loads it.
type LoadFn = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleInternals = Module as unknown as {
  _load: LoadFn;
  _resolveFilename: (request: string, parent: unknown) => string;
};
const originalLoad = moduleInternals._load;
let taggedValidate: Record<string, unknown> | undefined;
moduleInternals._load = function load(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  let resolved: string | undefined;
  try {
    resolved = moduleInternals._resolveFilename(request, parent);
  } catch {
    return loaded;
  }
  if (resolved !== VALIDATE_FILE) return loaded;
  if (!taggedValidate) {
    const real = loaded as { validate: (schema: unknown) => (...args: unknown[]) => unknown };
    taggedValidate = {
      ...(loaded as Record<string, unknown>),
      validate(schema: unknown) {
        const middleware = real.validate(schema) as ((...args: unknown[]) => unknown) & {
          [SCHEMA_TAG]?: unknown;
        };
        middleware[SCHEMA_TAG] = schema;
        return middleware;
      },
    };
  }
  return taggedValidate;
};

/* eslint-disable @typescript-eslint/no-require-imports */
const appModule = require(path.join(SRC, 'app')) as { default?: unknown; app?: unknown };
const { authenticate } = require(path.join(SRC, 'middleware', 'authenticate')) as {
  authenticate: unknown;
};
/* eslint-enable @typescript-eslint/no-require-imports */
const app = (appModule.default ?? appModule.app) as { _router: { stack: Layer[] } };

// ─── Walk the router stack ───────────────────────────────────────────────────

interface Layer {
  handle: ((...args: unknown[]) => unknown) & { stack?: Layer[]; [SCHEMA_TAG]?: unknown };
  regexp: RegExp & { fast_slash?: boolean };
  keys: { name: string }[];
  route?: { path: string | string[] | RegExp; methods: Record<string, boolean>; stack: Layer[] };
}

interface Endpoint {
  method: string;
  path: string;
  authenticated: boolean;
  schema?: unknown;
  upload: boolean;
}

/** The mount path Express compiled into a `use()` layer's regexp, e.g. `/api/customers`. */
function mountPath(layer: Layer): string {
  if (layer.regexp.fast_slash) return '';
  let keyIndex = 0;
  return layer.regexp.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys[keyIndex++]?.name ?? 'param'}`)
    .replace(/\\\//g, '/');
}

function walk(stack: Layer[], prefix: string, authed: boolean, out: Endpoint[]): void {
  // router.use([paths], authenticate, ...) guards every later route its paths match.
  const authGates: Layer[] = [];
  const isGated = (relativePath: string) =>
    authed || authGates.some((gate) => gate.regexp.fast_slash || gate.regexp.test(relativePath));
  for (const layer of stack) {
    if (layer.route) {
      if (typeof layer.route.path !== 'string') continue;
      const handlers = layer.route.stack.map((l) => l.handle);
      const routeAuthed = isGated(layer.route.path) || handlers.includes(authenticate as never);
      const schema = handlers.find((h) => h[SCHEMA_TAG])?.[SCHEMA_TAG];
      const upload = handlers.some((h) => h.name === 'multerMiddleware');
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        out.push({
          method: method.toUpperCase(),
          path: `${prefix}${layer.route.path}`.replace(/\/+$/, '') || '/',
          authenticated: routeAuthed,
          schema,
          upload,
        });
      }
    } else if (layer.handle.stack) {
      const mount = mountPath(layer);
      walk(layer.handle.stack, `${prefix}${mount}`, isGated(mount || '/'), out);
    } else if (layer.handle === authenticate) {
      authGates.push(layer);
    }
  }
}

// Server-to-server and internal surfaces the app never calls.
// Account-level payment and phone-provider setup stays in the web app.
const EXCLUDED_PREFIXES = [
  '/api/webhooks',
  '/api/copilot',
  '/api/test',
  '/api/organization/stripe',
  '/api/organization/connect-ctm',
  '/api/organization/disconnect-ctm',
];

const found: Endpoint[] = [];
walk(app._router.stack, '', false, found);
const seen = new Set<string>();
const endpoints = found.filter((e) => {
  const key = `${e.method} ${e.path}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return e.path.startsWith('/api/') && !EXCLUDED_PREFIXES.some((p) => e.path.startsWith(p));
});

// ─── Zod schema → example body + field list ──────────────────────────────────

interface ZodLike {
  _def: Record<string, unknown> & { typeName?: string };
}

const SAMPLE_UUID = '00000000-0000-0000-0000-000000000000';

function inner(def: ZodLike['_def']): ZodLike | undefined {
  return (def.innerType ?? def.schema ?? def.type ?? def.in) as ZodLike | undefined;
}

function example(schema: ZodLike | undefined, depth = 0): unknown {
  if (!schema?._def || depth > 8) return null;
  const def = schema._def;
  switch (def.typeName) {
    case 'ZodString': {
      const kinds = ((def.checks as { kind: string }[]) ?? []).map((c) => c.kind);
      if (kinds.includes('email')) return 'name@example.com';
      if (kinds.includes('uuid')) return SAMPLE_UUID;
      if (kinds.includes('datetime')) return '2026-01-01T09:00:00.000Z';
      if (kinds.includes('url')) return 'https://example.com';
      return 'string';
    }
    case 'ZodNumber':
    case 'ZodBigInt':
      return 0;
    case 'ZodBoolean':
      return false;
    case 'ZodDate':
      return '2026-01-01T09:00:00.000Z';
    case 'ZodLiteral':
      return def.value;
    case 'ZodEnum':
      return (def.values as unknown[])[0];
    case 'ZodNativeEnum':
      return Object.values(def.values as object)[0];
    case 'ZodArray':
      return [example(def.type as ZodLike, depth + 1)];
    case 'ZodTuple':
      return (def.items as ZodLike[]).map((i) => example(i, depth + 1));
    case 'ZodObject': {
      const shape = (def.shape as () => Record<string, ZodLike>)();
      return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, example(v, depth + 1)]));
    }
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return example([...(def.options as Iterable<ZodLike>)][0], depth + 1);
    case 'ZodIntersection': {
      const left = example(def.left as ZodLike, depth + 1);
      const right = example(def.right as ZodLike, depth + 1);
      return typeof left === 'object' && typeof right === 'object' ? { ...left, ...right } : left;
    }
    case 'ZodRecord':
    case 'ZodMap':
      return {};
    case 'ZodLazy':
      return example((def.getter as () => ZodLike)(), depth + 1);
    case 'ZodAny':
    case 'ZodUnknown':
    case 'ZodNull':
    case 'ZodUndefined':
      return null;
    default:
      return example(inner(def), depth + 1);
  }
}

function describeType(schema: ZodLike | undefined): { type: string; optional: boolean } {
  let optional = false;
  let current = schema;
  for (let i = 0; i < 10 && current?._def; i++) {
    const t = current._def.typeName;
    if (t === 'ZodOptional' || t === 'ZodDefault' || t === 'ZodCatch') optional = true;
    if (t === 'ZodOptional' || t === 'ZodNullable' || t === 'ZodDefault' || t === 'ZodCatch' ||
        t === 'ZodEffects' || t === 'ZodBranded' || t === 'ZodReadonly' || t === 'ZodPipeline') {
      current = inner(current._def);
      continue;
    }
    break;
  }
  const def = current?._def;
  const t = def?.typeName ?? 'ZodUnknown';
  if (t === 'ZodEnum') return { type: `one of ${(def!.values as string[]).join(' | ')}`, optional };
  if (t === 'ZodArray') return { type: `array of ${describeType(def!.type as ZodLike).type}`, optional };
  return { type: t.replace(/^Zod/, '').toLowerCase(), optional };
}

function fieldList(schema: ZodLike | undefined): string {
  let current = schema;
  for (let i = 0; i < 10 && current?._def && current._def.typeName !== 'ZodObject'; i++) {
    current = inner(current._def);
  }
  if (current?._def.typeName !== 'ZodObject') return '';
  const shape = (current._def.shape as () => Record<string, ZodLike>)();
  const rows = Object.entries(shape).map(([name, field]) => {
    const { type, optional } = describeType(field);
    return `| \`${name}\` | ${type} | ${optional ? 'optional' : 'required'} |`;
  });
  return ['| Field | Type | |', '|---|---|---|', ...rows].join('\n');
}

// ─── Collection ──────────────────────────────────────────────────────────────

const TOKEN_SCRIPT = [
  'const body = pm.response.json();',
  'if (body.session && body.session.access_token) {',
  "  pm.collectionVariables.set('accessToken', body.session.access_token);",
  "  pm.collectionVariables.set('refreshToken', body.session.refresh_token);",
  '}',
];

/** Requests whose body uses collection variables instead of the schema example. */
const BODY_OVERRIDES: Record<string, object> = {
  'POST /api/auth/login': { email: '{{email}}', password: '{{password}}' },
  'POST /api/auth/refresh': { refresh_token: '{{refreshToken}}' },
};
const SAVES_TOKEN = new Set(['POST /api/auth/login', 'POST /api/auth/refresh', 'POST /api/auth/mfa/verify']);

function folderPath(apiPath: string): string[] {
  const parts = apiPath.replace(/^\/api\//, '').split('/');
  const nested = parts[0] === 'communication' || parts[0] === 'inventory' || parts[0] === 'me';
  return nested && parts[1] && !parts[1].startsWith(':') ? [parts[0], parts[1]] : [parts[0]];
}

function title(segment: string): string {
  return segment.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Folder {
  name: string;
  item: unknown[];
}

const root: Folder[] = [];
function folderFor(names: string[]): Folder {
  let level = root;
  let folder: Folder | undefined;
  for (const name of names.map(title)) {
    folder = level.find((f) => f.name === name);
    if (!folder) {
      folder = { name, item: [] };
      level.push(folder);
    }
    level = folder.item as Folder[];
  }
  return folder!;
}

for (const e of endpoints) {
  const key = `${e.method} ${e.path}`;
  const segments = e.path.replace(/^\//, '').split('/');
  const params = segments.filter((s) => s.startsWith(':')).map((s) => ({ key: s.slice(1), value: '' }));
  const fields = fieldList(e.schema as ZodLike | undefined);

  const request: Record<string, unknown> = {
    method: e.method,
    header: [],
    url: {
      raw: `{{baseUrl}}${e.path}`,
      host: ['{{baseUrl}}'],
      path: segments,
      ...(params.length ? { variable: params } : {}),
    },
  };
  if (!e.authenticated) request.auth = { type: 'noauth' };
  if (e.upload) {
    request.body = { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: [] }] };
  } else if (BODY_OVERRIDES[key] || e.schema) {
    request.body = {
      mode: 'raw',
      raw: JSON.stringify(BODY_OVERRIDES[key] ?? example(e.schema as ZodLike), null, 2),
      options: { raw: { language: 'json' } },
    };
  }
  const notes = [
    e.authenticated ? '' : 'No login needed.',
    e.upload ? 'Multipart upload: attach the file in the `file` field.' : '',
    fields,
  ].filter(Boolean);
  if (notes.length) request.description = notes.join('\n\n');

  const item: Record<string, unknown> = { name: `${e.method} ${e.path.replace(/^\/api/, '')}`, request };
  if (SAVES_TOKEN.has(key)) {
    item.event = [{ listen: 'test', script: { type: 'text/javascript', exec: TOKEN_SCRIPT } }];
  }
  folderFor(folderPath(e.path)).item.push(item);
}

const collection = {
  info: {
    name: 'ServWave API',
    description: [
      'Every endpoint the ServWave API serves in production, generated from the code on each release.',
      '',
      '**Getting started**',
      '1. Set the `email` and `password` collection variables to your ServWave login.',
      '2. Send **Auth → POST /auth/login**. The access token is saved for you, and every other request uses it.',
      '3. When the token expires, send **Auth → POST /auth/refresh**.',
      '',
      'If the login answers `mfaRequired: true`, send **Auth → POST /auth/mfa/verify** with the `challengeId` and the emailed code.',
      '',
      'Example bodies show the shape of each request; replace the sample values with real ones.',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }] },
  variable: [
    { key: 'baseUrl', value: 'https://api.servwave.com' },
    { key: 'email', value: '' },
    { key: 'password', value: '' },
    { key: 'accessToken', value: '' },
    { key: 'refreshToken', value: '' },
  ],
  item: root,
};

const outFile = path.resolve(process.argv[2] ?? 'ServWave.postman_collection.json');
fs.writeFileSync(outFile, `${JSON.stringify(collection, null, 2)}\n`);
console.log(`Wrote ${endpoints.length} endpoints to ${outFile}`);
process.exit(0);
