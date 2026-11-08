#!/usr/bin/env node
/**
 * QA session minter - log an agent into the DEMO ORG without a password.
 *
 * Why this exists: verifying a fix in a real browser used to need a human to type
 * the demo org's password. This mints a session through Supabase's admin API
 * instead, so an agent can drive staging (and prod's demo org) end to end.
 *
 * How it works: `generateLink({ type: 'magiclink' })` produces a one-time action
 * link for the target user. Navigating a browser to that link logs in and
 * redirects to the app, where the frontend's `detectSessionInUrl: true` picks the
 * session out of the URL fragment and persists it. No password is ever handled.
 *
 * One-time token rule: GoTrue keeps a SINGLE live magiclink token per user, so each
 * mint invalidates the previous one. Every consumer therefore needs its own link,
 * and the link nobody consumes - the one printed for the browser - must be minted
 * LAST. Reordering these calls silently prints a dead link that lands on /login.
 *
 * Scope guard: refuses any user whose organization is not flagged `is_demo`.
 *
 * Credentials are read from gitignored env files, never from the command line:
 *   staging -> backend/.env (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
 *              frontend/.env (VITE_SUPABASE_ANON_KEY)
 *   prod    -> .env.qa (PROD_SUPABASE_URL, PROD_SUPABASE_SERVICE_ROLE_KEY,
 *                       PROD_SUPABASE_ANON_KEY)
 *
 * Usage:
 *   node scripts/qa-session.mjs staging
 *   node scripts/qa-session.mjs prod admin@alphacrm.com
 *   node scripts/qa-session.mjs staging --session   # also write a session file
 *   node scripts/qa-session.mjs staging --session --inject   # + a paste-in snippet
 *
 * --session writes .qa/session-<target>.json (a real, already-verified session) and
 * still prints a live magic link. --inject additionally prints a one-line
 * localStorage snippet to paste in the app's console - preferred on staging, whose
 * Supabase Site URL points at the prod frontend, so the magic link redirects there.
 *
 * SENSITIVITY: the --session file is a CREDENTIAL, not a log. It carries a live
 * access token AND a refresh token for a real user, so it grants that user's access
 * until the refresh token is revoked - outliving the access token's own expiry. It
 * is written to the gitignored .qa/ directory and chmod 0600 for that reason. Never
 * commit it, attach it to an issue or PR, or paste its contents into a chat: opaque
 * JWTs in a JSON file do not look like a key to gitleaks, so nothing downstream will
 * catch the mistake. Delete it when the QA run is done.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_EMAIL = 'admin@alphacrm.com';
const APP_URL = {
  staging: 'https://servwave-demo.vercel.app',
  prod: 'https://app.servwave.com',
};
const API_URL = {
  staging: 'https://alpha-crm-test-env.onrender.com',
  prod: 'https://api.servwave.com',
};

function readEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  // Split on either ending - these files carry mixed CRLF/LF, and a stray \r is a
  // line terminator in JS regex, so `.` will not cross it.
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}

const target = process.argv[2] ?? 'staging';
const email = process.argv.find((a) => a.includes('@')) ?? DEFAULT_EMAIL;
const wantSession = process.argv.includes('--session');

if (!APP_URL[target]) die(`unknown target "${target}" - use "staging" or "prod"`);

const be = readEnv(`${REPO}/backend/.env`);
const fe = readEnv(`${REPO}/frontend/.env`);
const qa = readEnv(`${REPO}/.env.qa`);

const config =
  target === 'staging'
    ? { url: be.SUPABASE_URL, serviceKey: be.SUPABASE_SERVICE_ROLE_KEY, anonKey: fe.VITE_SUPABASE_ANON_KEY }
    : { url: qa.PROD_SUPABASE_URL, serviceKey: qa.PROD_SUPABASE_SERVICE_ROLE_KEY, anonKey: qa.PROD_SUPABASE_ANON_KEY };

if (!config.url || !config.serviceKey || !config.anonKey) {
  const missing = Object.entries(config)
    .filter(([, v]) => !v)
    .map(([k]) => k)
    .join(', ');
  die(
    target === 'prod'
      ? `prod is not configured (missing: ${missing}).\n` +
          `  Create ${REPO}/.env.qa (gitignored by the .env.* rule) with:\n` +
          `    PROD_SUPABASE_URL=https://redacted-prod-ref.supabase.co\n` +
          `    PROD_SUPABASE_ANON_KEY=<prod anon key>\n` +
          `    PROD_SUPABASE_SERVICE_ROLE_KEY=<prod service role key>`
      : `staging is not configured (missing: ${missing})`,
  );
}

const admin = createClient(config.url, config.serviceKey, { auth: { persistSession: false } });
const pub = createClient(config.url, config.anonKey, { auth: { persistSession: false } });

async function mint() {
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: APP_URL[target] },
  });
  if (error) die(`generate_link failed: ${error.message}`);
  return data.properties;
}

// Scope guard. PostgREST is not usable on these projects (the app talks to Postgres
// through Prisma, so the schema is never exposed to it), so instead of reading the
// org row directly we mint a throwaway session and ask the backend who it is. That
// is a stronger check anyway: it proves the token the browser will carry really does
// resolve to a demo org, and doubles as a smoke test that the API accepts it.
const probe = await mint();
const { data: probed, error: probeErr } = await pub.auth.verifyOtp({
  token_hash: probe.hashed_token,
  type: 'magiclink',
});
if (probeErr) die(`verifyOtp failed: ${probeErr.message}`);

const meRes = await fetch(`${API_URL[target]}/api/auth/me`, {
  headers: { Authorization: `Bearer ${probed.session.access_token}` },
});
if (!meRes.ok) die(`GET /api/auth/me on ${target} returned ${meRes.status}`);
const me = await meRes.json();
const who = me.user ?? me;

if (who.org_is_demo !== true) {
  die(
    `refusing: ${email} on ${target} resolves to organization ${who.organization_id} ` +
      `with org_is_demo=${who.org_is_demo}. This tool only ever logs into a demo org.`,
  );
}

console.log('\n  QA session ready');
console.log('  target :', target, `(${APP_URL[target]})`);
console.log('  user   :', who.email, `- ${who.role}`);
console.log('  org    :', who.organization_id, '(org_is_demo: true)');
console.log('  api    :', `${API_URL[target]} - /api/auth/me 200`);
console.log('');

// Order matters here - see the one-time token rule at the top of this file. The
// session file consumes a link of its own, and it has to do so BEFORE the browser's
// link is minted, because minting is what invalidates the previous token.
if (wantSession) {
  const sessionLink = await mint();
  const pub = createClient(config.url, config.anonKey, { auth: { persistSession: false } });
  const { data: verified, error: verifyErr } = await pub.auth.verifyOtp({
    token_hash: sessionLink.hashed_token,
    type: 'magiclink',
  });
  if (verifyErr) die(`verifyOtp failed: ${verifyErr.message}`);

  const ref = new URL(config.url).hostname.split('.')[0];
  // Written inside .qa/ rather than the repo root: the directory is gitignored as a
  // whole, so the file cannot be swept up by `git add -A` even if this filename ever
  // changes. 0o700 on the dir and 0o600 on the file keep it off other local accounts.
  const dir = `${REPO}/.qa`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = `${dir}/session-${target}.json`;
  writeFileSync(out, JSON.stringify({ storageKey: `sb-${ref}-auth-token`, session: verified.session }), {
    mode: 0o600,
  });
  console.log('  session file :', out);
  console.log('  WARNING      : contains a live access AND refresh token for', email);
  console.log('                 do not commit it, paste it into an issue, or share it.');
  console.log('  storage key  :', `sb-${ref}-auth-token`);
  console.log('  expires      :', new Date(verified.session.expires_at * 1000).toISOString());
  console.log('');

  if (process.argv.includes('--inject')) {
    // A single statement to evaluate in the app's own origin. Preferred over the
    // magic link on staging, because that project's Site URL points at the prod
    // frontend and Supabase overrides any redirectTo that is not allowlisted.
    console.log('  --- paste into the browser console on', APP_URL[target], '---');
    console.log(
      `localStorage.setItem(${JSON.stringify(`sb-${ref}-auth-token`)}, ${JSON.stringify(
        JSON.stringify(verified.session),
      )}); location.replace('/');`,
    );
    console.log('');
  }
}

// Minted last and deliberately left unconsumed, so this token is the live one.
const link = await mint();
console.log('  Navigate the browser to this one-time link to be logged in:\n');
console.log(link.action_link);
console.log('');

// Supabase overrides any redirectTo that its project Site URL does not allowlist, so
// the link can silently land on a DIFFERENT frontend than the target reported above
// (staging's project points at the prod app). Report where it will actually go.
const lands = new URL(link.action_link).searchParams.get('redirect_to') ?? '';
if (!lands.startsWith(APP_URL[target])) {
  console.log(`  NOTE: that link redirects to ${lands || '(unset)'} - NOT ${APP_URL[target]}.`);
  console.log('  Supabase overrode redirectTo via this project\'s Site URL allowlist.');
  console.log(
    wantSession
      ? '  To land on the target frontend, use the session file / --inject snippet above.'
      : '  To land on the target frontend, re-run with --session --inject and paste that snippet.',
  );
  console.log('');
}
