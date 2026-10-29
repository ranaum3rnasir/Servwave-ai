/**
 * Resend email-assertion helper — catalog SEL-32 / DLV-22 / COL-23.
 *
 * Queries the Resend REST API directly over HTTPS with the Node-global `fetch`
 * (Node 20+, already used bare in helpers/api-helpers.ts) — no new dependencies.
 *
 * ── ENV LOADING (verified 2026-06-10) ────────────────────────────────────────
 * The API tier (`playwright.api.config.ts` + `global-setup-api.ts`) loads NO env
 * files into the Playwright test process — neither imports dotenv, and the config
 * has no `webServer.env` / config-level env injection. The backend's key lives in
 * `backend/.env` and is read by the BACKEND process only (via `dotenv.config()` in
 * `backend/src/config/env.ts`). Therefore the TEST process does NOT see
 * backend/.env: to run with email assertions enabled you must export the var in
 * the shell that launches Playwright, e.g.
 *
 *   E2E_ASSERT_EMAILS=1 \
 *   RESEND_API_KEY=$(grep '^RESEND_API_KEY=' backend/.env | cut -d= -f2-) \
 *   npx playwright test --config e2e/playwright.api.config.ts e2e/specs/workflow/redesign-28-emails.spec.ts
 *
 * (The `webServer` child inherits the same shell env, so exporting TZ etc. affects
 * both processes identically.)
 *
 * TWO keys must be live for these assertions to mean anything:
 *   1. The BACKEND must have RESEND_API_KEY set (backend/.env — present as of
 *      2026-06-10). `backend/src/lib/email.ts:15` builds the client as
 *      `env.RESEND_API_KEY ? new Resend(...) : null` and EVERY send silently
 *      no-ops when null — the API would 200 and no email would ever exist.
 *   2. The TEST process needs RESEND_API_KEY exported (same key) to query the API.
 *
 * ── API SHAPES (grounded in the vendored resend SDK v6.9.2 ────────────────────
 *    node_modules/resend/dist/index.d.mts + dist/index.mjs, hoisted to the repo
 *    root by npm workspaces; backend imports it in lib/email.ts) ───────────────
 *
 *   Auth:    `Authorization: Bearer <RESEND_API_KEY>` against https://api.resend.com
 *            (dist/index.mjs `defaultBaseUrl` + constructor Headers).
 *   List:    GET /emails?limit=N   (PaginationOptions: limit 1–100 default 20,
 *            plus `after`/`before` cursors — dist/index.mjs buildPaginationQuery)
 *            → { object: 'list', has_more: boolean, data: ListEmail[] }
 *            where ListEmail = GetEmailResponseSuccess minus html/text/tags/object
 *            (ListEmailsResponseSuccess, index.d.mts ~:1179).
 *   Get:     GET /emails/:id
 *            → { object: 'email', id, from, to: string[], cc, bcc, reply_to,
 *                subject, html: string|null, text: string|null, created_at,
 *                last_event: 'bounced'|'delivered'|'sent'|…, scheduled_at, … }
 *            (GetEmailResponseSuccess, index.d.mts ~:988).
 *   The SDK's fetchRequest returns `data: await response.json()` verbatim, so the
 *   shapes above ARE the raw wire format, not an SDK envelope.
 *
 * ── CAVEATS ──────────────────────────────────────────────────────────────────
 * - Seeded customers/users all use `@e2e-qa.invalid` addresses. These BOUNCE —
 *   the sends still appear in the Resend list as attempts (last_event will be
 *   'bounced'/'failed' rather than 'delivered'). NEVER filter on last_event.
 *   Customer-facing mails go to the seeded customer's address; user-facing mails
 *   (e.g. job-assignment) go to the seeded user's address — both @e2e-qa.invalid.
 * - The Resend account may be SHARED across environments (local/staging use the
 *   same key), so the list can contain unrelated traffic. Always scope matches
 *   with a unique-per-seed subject fragment (estimate/job/invoice numbers) and/or
 *   the unique recipient address, plus `sinceMs`.
 * - All backend sends are FIRE-AND-FORGET (errors swallowed by logger.error), and
 *   estimate sends render a PDF first — a PDF failure silently skips the email.
 *   A findRecentEmail timeout therefore cannot distinguish "never sent" from
 *   "send crashed server-side"; check backend logs when a positive row times out.
 * - Clock skew: `created_at` is Resend's clock; `sinceMs` is the local clock.
 *   Matching pads the window by `skewMs` (default 15s) so an email stamped just
 *   "before" a locally-captured t0 is not missed. Safe because subjects carry
 *   unique per-seed numbers; pass `skewMs: 0` (+ `excludeIds`) for
 *   presence-of-absence checks where the pad could reach back into a prior,
 *   legitimately-sent email.
 * - Polling is one list call per ~2s (Resend's public rate limit is ~2 req/s).
 * - Single-page lookup (limit=100, no cursor-walk): if >100 account-wide emails
 *   land between the action and the poll, a match could be missed. Acceptable for
 *   a QA org; revisit with `after` cursors if it ever flakes.
 */

const RESEND_API_BASE = 'https://api.resend.com';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_CLOCK_SKEW_MS = 15_000;

/** Gate: email assertions are opt-in. Default-skipped until both are set. */
export function emailsEnabled(): boolean {
  return process.env.E2E_ASSERT_EMAILS === '1' && !!process.env.RESEND_API_KEY;
}

/** One row of GET /emails (ListEmail — GetEmailResponseSuccess minus html/text/tags/object). */
export interface ResendListEmail {
  id: string;
  from: string;
  to: string[];
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  subject: string;
  created_at: string;
  last_event: string;
  scheduled_at: string | null;
}

/** GET /emails/:id (GetEmailResponseSuccess). */
export interface ResendEmail extends ResendListEmail {
  object: 'email';
  html: string | null;
  text: string | null;
  tags?: { name: string; value: string }[];
}

interface ResendListEmailsResponse {
  object: 'list';
  has_more: boolean;
  data: ResendListEmail[];
}

async function resendGet<T>(path: string): Promise<T> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error(
      'RESEND_API_KEY is not set in the test process — export it (see helpers/resend-assert.ts header) or keep the spec skipped.',
    );
  }
  const res = await fetch(`${RESEND_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<unreadable body>');
    throw new Error(`Resend GET ${path} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Defensive: the SDK types say `to: string[]`, but normalize a bare string too. */
function recipientsOf(e: ResendListEmail): string[] {
  return Array.isArray(e.to) ? e.to : [String(e.to)];
}

export interface FindRecentEmailOptions {
  /** Substring the subject must contain — include a unique seed number (E#/J#/I#) whenever possible. */
  subjectIncludes: string;
  /** Exact recipient match (case-insensitive) against the `to` array, if given. */
  to?: string;
  /** Local Date.now() captured BEFORE the email-triggering action. */
  sinceMs: number;
  /** Total poll budget (default 20s). Use a short budget for presence-of-absence checks. */
  timeoutMs?: number;
  /** Poll interval (default 2s — respects Resend's ~2 req/s rate limit). */
  pollMs?: number;
  /** Local↔Resend clock-skew pad subtracted from sinceMs (default 15s). Pass 0 for absence checks. */
  skewMs?: number;
  /** Email ids to ignore (e.g. a prior legitimate send with the same subject). */
  excludeIds?: string[];
}

/**
 * Poll Resend's list-emails endpoint (~2s interval, ~20s budget) for a message
 * created at/after `sinceMs` whose subject contains `subjectIncludes` and (if
 * given) whose `to` includes the recipient. Returns the list row or null on
 * timeout. A null is the assertion primitive for BOTH directions:
 *   presence → expect(await findRecentEmail(...)).not.toBeNull()
 *   absence  → expect(await findRecentEmail({ ...short, skewMs: 0 })).toBeNull()
 */
export async function findRecentEmail(opts: FindRecentEmailOptions): Promise<ResendListEmail | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const skewMs = opts.skewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const floorMs = opts.sinceMs - skewMs;
  const wantedTo = opts.to?.toLowerCase();
  const excluded = new Set(opts.excludeIds ?? []);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const page = await resendGet<ResendListEmailsResponse>('/emails?limit=100');
    const match = (page.data ?? []).find((e) => {
      if (excluded.has(e.id)) return false;
      const createdMs = Date.parse(e.created_at);
      if (!Number.isFinite(createdMs) || createdMs < floorMs) return false;
      if (typeof e.subject !== 'string' || !e.subject.includes(opts.subjectIncludes)) return false;
      if (wantedTo && !recipientsOf(e).some((t) => t.toLowerCase() === wantedTo)) return false;
      return true;
    });
    if (match) return match;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/** GET /emails/:id and return its `html` field (null when Resend stored none). */
export async function getEmailHtml(id: string): Promise<string | null> {
  const email = await resendGet<ResendEmail>(`/emails/${encodeURIComponent(id)}`);
  return email.html ?? null;
}
