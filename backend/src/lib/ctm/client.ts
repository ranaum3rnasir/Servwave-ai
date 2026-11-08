import { env } from '../../config/env';
import { logger } from '../logger';
import { normalizeNAPhone } from '../comms-identity';

/**
 * CTM (CallTrackingMetrics) API client.
 *
 * Mirrors lib/stripe.ts: config comes from env, `isCtmConfigured()` gates every
 * caller, `getCtmForOrg(org)` resolves the per-org CTM sub-account. One agency
 * Access/Secret key pair reaches every sub-account (scoped via account_id in
 * the path), so the keys are treated like the Stripe platform secret: never
 * logged, never echoed into error messages, dashboard-configured only.
 *
 * API realities this client encodes (verified against CTM's official docs/SDKs;
 * see md_files/plans/communication/ctm-plan-v3.1-review-addendum.md §A):
 *  - lists are PAGE-based ({page, next_page, total_pages, <items>}), not cursor
 *  - errors follow {"status":"error","reason":"…"}; 406 = validation failure
 *  - ~10 req/s per key and "excessive errors may be throttled" agency-wide, so
 *    requests are paced and retries happen ONLY on 429/5xx/network, never 4xx
 */

const DEFAULT_BASE = 'https://api.calltrackingmetrics.com/api/v1';

// Minimum spacing between requests. 120ms ≈ 8 req/s — safely under CTM's
// documented 10 req/s so a burst (number import, backfill) can't trip the
// agency-wide throttle.
const MIN_REQUEST_INTERVAL_MS = 120;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

// Recording fetches may only START on CTM's own hosts — the URL is always
// derived from the stored call sid, never taken from webhook payload data
// (SSRF guard). Redirects (storage CDNs) are followed manually with the
// Authorization header dropped off-host, https-only, bounded depth.
const RECORDING_INITIAL_HOSTS = new Set([
  'api.calltrackingmetrics.com',
  'app.calltrackingmetrics.com',
]);
const RECORDING_MAX_REDIRECTS = 3;

export class CtmApiError extends Error {
  readonly httpStatus: number;
  readonly reason: string;

  constructor(httpStatus: number, reason: string) {
    // `reason` comes from CTM's response body / statusText — never from our
    // request (which would risk echoing auth material).
    super(`Phone system API error ${httpStatus}: ${reason}`);
    this.name = 'CtmApiError';
    this.httpStatus = httpStatus;
    this.reason = reason;
  }
}

export function isCtmConfigured(): boolean {
  return !!(env.CTM_ACCESS_KEY && env.CTM_SECRET_KEY);
}

/**
 * Phase-0 outbound SAFETY GUARD. When CTM_OUTBOUND_ALLOWLIST is set (a
 * comma-separated list of E.164 test numbers), an outbound SMS or click-to-call
 * may ONLY reach a number on that list — every other destination is refused
 * BEFORE any CTM API call. Unset/empty = unrestricted (normal prod behavior).
 *
 * Read fresh from env at call time. Both the allowlist entries and the argument
 * are normalized (normalizeNAPhone) so 2015550123 / (201) 555-0123 /
 * +12015550123 all compare equal.
 */
export function isOutboundAllowed(toE164: string): boolean {
  const raw = env.CTM_OUTBOUND_ALLOWLIST;
  if (!raw || !raw.trim()) return true; // unset/empty → unrestricted
  const allowed = new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => normalizeNAPhone(entry) ?? entry),
  );
  if (allowed.size === 0) return true; // nothing parseable → unrestricted
  const normalizedTo = normalizeNAPhone(toE164) ?? toE164;
  return allowed.has(normalizedTo);
}

export function getCtmForOrg(org: { ctm_account_id: string | null }): { accountId: string } {
  if (!isCtmConfigured()) {
    throw new Error(
      'The phone system is not configured. Set CTM_ACCESS_KEY / CTM_SECRET_KEY in environment.',
    );
  }
  if (!org.ctm_account_id) {
    throw new Error('Organization is not connected to a phone system.');
  }
  return { accountId: org.ctm_account_id };
}

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${env.CTM_ACCESS_KEY}:${env.CTM_SECRET_KEY}`).toString('base64');
}

function baseUrl(): string {
  return (env.CTM_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
async function pace(): Promise<void> {
  const now = Date.now();
  const runAt = Math.max(now, lastRequestAt + MIN_REQUEST_INTERVAL_MS);
  lastRequestAt = runAt;
  if (runAt > now) await sleep(runAt - now);
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
  // CTM accepts JSON on most write endpoints; the SMS endpoint is exercised
  // form-encoded in CTM's own examples, so it opts in via `form`.
  form?: boolean;
}

async function request<T = Record<string, unknown>>(path: string, opts: RequestOpts = {}): Promise<T> {
  if (!isCtmConfigured()) {
    throw new Error(
      'The phone system is not configured. Set CTM_ACCESS_KEY / CTM_SECRET_KEY in environment.',
    );
  }
  const url = `${baseUrl()}${path}`;

  for (let attempt = 1; ; attempt++) {
    await pace();
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: {
          Authorization: authHeader(),
          Accept: 'application/json',
          ...(opts.body
            ? { 'Content-Type': opts.form ? 'application/x-www-form-urlencoded' : 'application/json' }
            : {}),
        },
        body: opts.body
          ? opts.form
            ? new URLSearchParams(
                Object.fromEntries(
                  Object.entries(opts.body)
                    .filter(([, v]) => v !== undefined && v !== null)
                    .map(([k, v]) => [k, String(v)]),
                ),
              ).toString()
            : JSON.stringify(opts.body)
          : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Network / timeout. Retry with backoff; the final failure is generic on
      // purpose (fetch errors can embed the URL — never the creds, but keep it
      // clean anyway).
      if (attempt < MAX_ATTEMPTS) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      throw new CtmApiError(0, 'network error or timeout');
    }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }

    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null; // non-JSON body — handled below
    }

    if (!res.ok || (json && json.status === 'error')) {
      const reason =
        (json && ((json.reason as string) || (json.error as string) || (json.message as string))) ||
        res.statusText ||
        'request failed';
      throw new CtmApiError(res.status, String(reason).slice(0, 500));
    }

    return (json ?? ({} as Record<string, unknown>)) as T;
  }
}

// ─── Pagination (page-based: {page, next_page, total_pages, <itemsKey>}) ─────

interface PagedEnvelope {
  page?: number | string;
  next_page?: number | string | null;
  total_pages?: number | string;
  [key: string]: unknown;
}

function extractItems<T>(envl: PagedEnvelope, itemsKey: string): T[] {
  const direct = envl[itemsKey];
  if (Array.isArray(direct)) return direct as T[];
  // Defensive: pick the first array-valued key (exact items key is probe-refined).
  for (const v of Object.values(envl)) {
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

async function* paginate<T>(
  path: string,
  itemsKey: string,
  params: Record<string, string | number | undefined> = {},
): AsyncGenerator<T[], void, void> {
  let page = 1;
  for (;;) {
    const qp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qp.set(k, String(v));
    }
    qp.set('page', String(page));
    const envl = await request<PagedEnvelope>(`${path}${path.includes('?') ? '&' : '?'}${qp.toString()}`);
    const items = extractItems<T>(envl, itemsKey);
    yield items;

    // CTM's `next_page` is a URL, not a page number:
    //   "https://api.calltrackingmetrics.com/api/v1/accounts/500001/calls?page=2"
    // so it is a "there is more" flag and nothing else. This walk used to do
    // Number(next_page), got NaN, and stopped after page one - silently, since
    // a truncated list looks exactly like a short one. Page size is 10, so
    // every caller saw the first 10 of everything: 10 of Northwind Services' 20
    // numbers, 10 of its 123 calls. Advance by counting, and prefer
    // total_pages (a real number) as the bound.
    if (items.length === 0) break;
    const totalPages = Number(envl.total_pages);
    if (Number.isFinite(totalPages) && totalPages > 0) {
      if (page >= totalPages) break;
    } else if (envl.next_page === undefined || envl.next_page === null || envl.next_page === '') {
      break;
    }
    page += 1;
  }
}

// ─── Accounts (agency scope) ─────────────────────────────────────────────────

export async function listAccounts(): Promise<Array<Record<string, unknown>>> {
  const res = await request<PagedEnvelope>('/accounts.json?names=1&all=1');
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>;
  return extractItems(res, 'accounts');
}

export async function createAccount(name: string, timezoneHint?: string): Promise<Record<string, unknown>> {
  return request('/accounts', {
    method: 'POST',
    body: { account: { name, ...(timezoneHint ? { timezone_hint: timezoneHint } : {}) }, billing_type: 'existing' },
  });
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

/** Every number on the account. Paginated: an org with more than one page of
 *  numbers must not have Sync report half its inventory as the whole truth. */
export async function listNumbers(accountId: string): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  for await (const page of paginate<Record<string, unknown>>(
    `/accounts/${accountId}/numbers`,
    'numbers',
  )) {
    all.push(...page);
  }
  return all;
}

/** CTM number-inventory search.
 *
 *  These are CTM's own wire parameters and nothing else. In particular there
 *  is NO `type` parameter: CTM silently ignores unknown keys, so a `type` of
 *  'tollfree' left the search on its searchby=area default and returned local
 *  numbers. Toll-free is requested via `searchby: 'tollfree'` (or by passing a
 *  toll-free `areacode`). Callers translate their own vocabulary before they
 *  get here - see comm-numbers.controller. */
export async function searchNumbers(
  accountId: string,
  params: { country?: string; searchby?: string; areacode?: string },
): Promise<Array<Record<string, unknown>>> {
  const qp = new URLSearchParams();
  qp.set('country', params.country ?? 'US');
  if (params.searchby) qp.set('searchby', params.searchby);
  if (params.areacode) qp.set('areacode', params.areacode);
  const res = await request<PagedEnvelope>(`/accounts/${accountId}/numbers/search.json?${qp.toString()}`);
  return extractItems(res, 'numbers');
}

/**
 * CTM's POST /numbers wraps the created number under `number`, while
 * GET /numbers/{id} returns the same object flat. Callers read `.id` /
 * `.number` / `.formatted` off the top level, so normalise here at the seam -
 * the same job `extractItems` does for the list endpoints.
 *
 * Live incident 2026-08-05: without this, the first real purchase ever placed
 * stored `String(response.number)` as the literal "[object Object]" and left
 * `id` undefined. A null tracking-number id then skipped SMS enablement AND
 * routing, leaving a paid number that rang nowhere under a garbage e164. Every
 * test passed because the fixtures used the flat shape.
 */
function unwrapPurchasedNumber(res: Record<string, unknown>): Record<string, unknown> {
  const nested = res.number;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return res;
}

export async function buyNumber(
  accountId: string,
  args: { phone_number: string; test?: boolean },
): Promise<Record<string, unknown>> {
  const res = await request<Record<string, unknown>>(`/accounts/${accountId}/numbers`, {
    method: 'POST',
    body: { ...args },
  });
  return unwrapPurchasedNumber(res);
}

export async function updateNumberRouting(
  accountId: string,
  tpnId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return request(`/accounts/${accountId}/numbers/${tpnId}/update_number`, { method: 'POST', body });
}

/**
 * Give a tracking number back, ending its recurring charge.
 *
 * CONFIRMED live 2026-08-12 against sub-account 500002, end to end: releasing
 * the orphaned `+1 609-596-8565` took the account from four numbers to three
 * and ended its 2026-09-05 billing. The `POST …/release` spelling, by
 * contrast, returns the router's generic `{"error":"invalid request"}` - no
 * such route.
 *
 * A missing id answers HTTP 404 carrying CTM's typed
 * `{"status":"error","reason":"object not found"}`. The HTTP status is the
 * part that matters: `request()` builds CtmApiError from `res.status`, so a
 * body-only error would arrive as status 200 and silently defeat the caller's
 * already-released check. Confirmed against a real 404, not a mock.
 *
 * IRREVERSIBLE: the number returns to the carrier pool and cannot be
 * reclaimed. Callers must confirm with the user first.
 */
export async function releaseNumber(accountId: string, tpnId: string): Promise<void> {
  await request(`/accounts/${accountId}/numbers/${tpnId}`, { method: 'DELETE' });
}

export async function createReceivingNumber(
  accountId: string,
  number: string,
): Promise<Record<string, unknown>> {
  return request(`/accounts/${accountId}/receiving_numbers`, { method: 'POST', body: { number } });
}

/** The account's receiving (forward-target) numbers.
 *
 *  Each record carries BOTH ids CTM uses for a receiving number: the `id`
 *  string (RPN…) that the routing endpoints take, and a numeric `filter_id`.
 *  The call webhook's `answered_by.receiving_number_id` is the FILTER_ID -
 *  verified against the live Northwind Services account on 2026-08-07 - which is what
 *  makes "who picked up this forwarded call" answerable at all. */
export async function listReceivingNumbers(
  accountId: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await request<PagedEnvelope>(
    `/accounts/${accountId}/receiving_numbers?per_page=200`,
  );
  return extractItems(res, 'receiving_numbers');
}

export async function addReceivingToTracking(
  accountId: string,
  tpnId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return request(`/accounts/${accountId}/numbers/${tpnId}/dial_routes`, { method: 'PUT', body });
}

export type EnableSmsOutcome = 'ok' | 'alreadyenabled' | 'notfound' | 'failure';

/** Enable long outgoing texts on a tracking number. 404/406 map to typed
 * outcomes (surfaced as warnings on buy/connect), everything else throws. */
export async function enableSms(accountId: string, tpnId: string): Promise<EnableSmsOutcome> {
  try {
    const res = await request<Record<string, unknown>>(
      `/accounts/${accountId}/numbers/${tpnId}/enable_sms?long_outgoing=1`,
      { method: 'POST' },
    );
    const marker = String(res.status ?? res.result ?? res.message ?? 'ok').toLowerCase();
    return marker.includes('already') ? 'alreadyenabled' : 'ok';
  } catch (err) {
    if (err instanceof CtmApiError) {
      if (err.httpStatus === 404) return 'notfound';
      if (err.httpStatus === 406) return 'failure';
    }
    throw err;
  }
}

// ─── Voice Menus ─────────────────────────────────────────────────────────────

export interface CreateVoiceMenuArgs {
  name: string;
  /** Voice-menu items, e.g. a single voicemail-box entry:
   * `{ voice_action_type: 'message', recording: '1', transcribe: '0'|'1',
   *    play_beep: '1', timer: '120' }` (CTM's confirmed voicemail-item shape;
   * see routing.ts's `ensureVoicemailMenu`). */
  items: Array<Record<string, unknown>>;
}

/** Creates a voice menu (e.g. a voicemail box). CONFIRMED endpoint; the exact
 * response envelope is probe-refined, so callers extract the id defensively
 * (mirrors `sendSms`'s sid extraction). */
export async function createVoiceMenu(
  accountId: string,
  args: CreateVoiceMenuArgs,
): Promise<Record<string, unknown>> {
  return request(`/accounts/${accountId}/voice_menus`, {
    method: 'POST',
    body: { name: args.name, items: args.items },
  });
}

// ─── Opt-outs ────────────────────────────────────────────────────────────────

/** Fresh per-send compliance check — never cached. */
export async function isOptedOut(accountId: string, e164: string): Promise<boolean> {
  const digits = e164.replace(/\D/g, '');
  let res: PagedEnvelope;
  try {
    res = await request<PagedEnvelope>(
      `/accounts/${accountId}/opt_out_texts?phone_number=${encodeURIComponent(e164)}`,
    );
  } catch (err) {
    if (err instanceof CtmApiError && err.httpStatus === 404) return false;
    throw err;
  }
  const entries = extractItems<Record<string, unknown>>(res, 'opt_out_texts');
  return entries.some((entry) => {
    const candidate = String(entry.phone_number ?? entry.number ?? entry.phone ?? entry.caller_number ?? '');
    return candidate.replace(/\D/g, '').endsWith(digits.slice(-10));
  });
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

export interface CreateWebhookArgs {
  name: string;
  weburl: string;
  position: string;
  trigger?: string;
  hooktype?: string;
  username?: string;
  password?: string;
}

/** Sends BOTH `position` and `trigger` (CTM's docs/SDKs disagree on which is
 * read — sending both is compatible with either). */
export async function createWebhook(accountId: string, args: CreateWebhookArgs): Promise<Record<string, unknown>> {
  return request(`/accounts/${accountId}/webhooks`, {
    method: 'POST',
    body: {
      name: args.name,
      weburl: args.weburl,
      hooktype: args.hooktype ?? 'call',
      position: args.position,
      trigger: args.trigger ?? args.position,
      ...(args.username ? { username: args.username } : {}),
      ...(args.password ? { password: args.password } : {}),
    },
  });
}

export async function listWebhooks(accountId: string): Promise<Array<Record<string, unknown>>> {
  const res = await request<PagedEnvelope>(`/accounts/${accountId}/webhooks`);
  return extractItems(res, 'webhooks');
}

export async function deleteWebhook(accountId: string, webhookId: string | number): Promise<void> {
  await request(`/accounts/${accountId}/webhooks/${webhookId}`, { method: 'DELETE' });
}

// ─── Calls ───────────────────────────────────────────────────────────────────

/**
 * Fetch one call activity by the CA… sid we store.
 *
 * CTM's call-detail path is keyed by the NUMERIC activity id, not the sid:
 * `/accounts/500001/calls/4367824697` answers 200 while
 * `/accounts/500001/calls/CA96f6f290523bc59bd930eebc84d324c9` - the SAME call -
 * answers `404 {"reason":"call not found"}`. We only ever persist the sid (the
 * numeric id has no column), so resolve it through the list endpoint's `search`
 * term, which matches a sid exactly. Verified live against account 500001,
 * including for calls old enough that the 404 first read as data expiry.
 *
 * A miss is a 200 with `total_entries: 0`, and `search` is free text, so both
 * "no rows" and "some other call" normalize to one typed 404 - callers already
 * treat CtmApiError as "nothing available".
 */
export async function getCall(accountId: string, sid: string): Promise<Record<string, unknown>> {
  const envl = await request<PagedEnvelope>(
    `/accounts/${accountId}/calls?search=${encodeURIComponent(sid)}`,
  );
  const match = extractItems<Record<string, unknown>>(envl, 'calls')[0];
  if (!match || String(match.sid) !== sid) throw new CtmApiError(404, 'call not found');
  return match;
}

/**
 * Dereference the `transcription` URL CTM returns on a call once async
 * transcription finishes (a `.../transcription.json` resource keyed by CTM's
 * numeric call id, NOT the CA… sid — the inline `transcription_text` field
 * is empty until this resolves). Same CTM-host allowlist as the recording
 * fetch (SSRF guard): the path only ever comes from a value CTM itself
 * returned off our own getCall(), never from webhook/user input.
 */
export async function getCallTranscription(transcriptionPath: string): Promise<Record<string, unknown>> {
  if (!isCtmConfigured()) {
    throw new Error(
      'The phone system is not configured. Set CTM_ACCESS_KEY / CTM_SECRET_KEY in environment.',
    );
  }
  const url = /^https?:\/\//i.test(transcriptionPath)
    ? transcriptionPath
    : `${baseUrl()}${transcriptionPath.startsWith('/') ? '' : '/'}${transcriptionPath}`;
  if (!RECORDING_INITIAL_HOSTS.has(new URL(url).hostname)) {
    throw new Error('Transcription fetch blocked: host is not allowlisted.');
  }
  await pace();
  const res = await fetch(url, {
    headers: { Authorization: authHeader(), Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new CtmApiError(res.status, 'transcription fetch failed');
  return (await res.json()) as Record<string, unknown>;
}

/** Page-based iterator over an account's activities (calls AND texts). */
export function listCalls(
  accountId: string,
  params: Record<string, string | number | undefined> = {},
): AsyncGenerator<Array<Record<string, unknown>>, void, void> {
  return paginate<Record<string, unknown>>(`/accounts/${accountId}/calls`, 'calls', params);
}

/**
 * Start a bridge call. CTM rings `call_number` FIRST, then bridges to
 * `to_number` when one is sent (proven live on staging, 2026-10-03). Which
 * shape the click-to-call bridge sends is chosen by the CTM_BRIDGE_RING_CALLER
 * switch (config/bridgeRingCaller.ts); `user_id` / `to_agent` are untested
 * candidates. Only the fields the caller passes are sent.
 */
export async function placeCall(
  accountId: string,
  args: {
    from_number: string;
    call_number: string;
    name?: string;
    user_id?: string;
    to_number?: string;
    to_agent?: string;
  },
): Promise<Record<string, unknown>> {
  // JSON body: an undefined field is dropped by JSON.stringify, never sent as a key.
  return request(`/accounts/${accountId}/calls/`, { method: 'POST', body: { ...args } });
}

/**
 * The phone_access payload CTM returns for one agent. The embed's `accessToken`
 * setter reads the account-binding fields (`account_id` / `user.account`) off
 * this object and forwards the WHOLE thing to the WebRTC device — so callers must
 * pass it through intact, not narrow it to `{ token }`. `valid_until` is a
 * CTM-supplied expiry epoch (absent on some plans); other fields are preserved
 * via the index signature.
 */
export interface PhoneAccessResult {
  token: string;
  valid_until?: number;
  session_id?: string;
  [key: string]: unknown;
}

/**
 * Mint a short-lived softphone access token for one agent (the embedded CTM
 * WebRTC device authenticates with this instead of the agency Access/Secret
 * keys, which never reach the browser). The token is keyed to `email` so CTM
 * binds it to that user's agent; `session_id` is our stable per-user handle.
 * Returns the full CTM payload (see `PhoneAccessResult`). Mirrors `placeCall`:
 * server-to-server, uses `request()`.
 */
export async function requestPhoneAccess(
  accountId: string,
  args: { email: string; first_name: string; last_name: string; session_id: string },
): Promise<PhoneAccessResult> {
  return request<PhoneAccessResult>(
    `/accounts/${accountId}/phone_access`,
    { method: 'POST', body: { ...args } },
  );
}

// ─── Recordings ──────────────────────────────────────────────────────────────

/**
 * Fetch a call recording by sid. Returns the raw Response (caller streams the
 * body under its own size cap). Initial request only to CTM hosts; manual
 * redirect follow (https-only, ≤3 hops) with Authorization dropped once the
 * chain leaves CTM.
 */
export async function getRecordingResponse(accountId: string, callSid: string): Promise<Response> {
  if (!isCtmConfigured()) {
    throw new Error(
      'The phone system is not configured. Set CTM_ACCESS_KEY / CTM_SECRET_KEY in environment.',
    );
  }
  let url = `${baseUrl()}/accounts/${accountId}/calls/${encodeURIComponent(callSid)}/recording`;
  if (!RECORDING_INITIAL_HOSTS.has(new URL(url).hostname)) {
    throw new Error('Recording fetch blocked: initial host is not allowlisted.');
  }

  for (let hop = 0; hop <= RECORDING_MAX_REDIRECTS; hop++) {
    await pace();
    const onCtmHost = RECORDING_INITIAL_HOSTS.has(new URL(url).hostname);
    const res = await fetch(url, {
      headers: onCtmHost ? { Authorization: authHeader() } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new CtmApiError(res.status, 'redirect without location');
      const next = new URL(location, url);
      if (next.protocol !== 'https:') {
        throw new Error('Recording fetch blocked: non-https redirect target.');
      }
      url = next.toString();
      continue;
    }

    if (!res.ok) throw new CtmApiError(res.status, 'recording fetch failed');
    return res;
  }

  throw new Error('Recording fetch blocked: too many redirects.');
}

// ─── SMS ─────────────────────────────────────────────────────────────────────

/** `from` is the CTM tracking-number id ("TPN…"), NOT an E.164 number. CTM
 * auto-splits up to 1600 chars into 160-char segments on long-outgoing-enabled
 * numbers; >1600 would be truncated server-side, so we reject it here. */
export async function sendSms(
  accountId: string,
  args: { from: string; to: string; msg: string; status_callback?: string },
): Promise<Record<string, unknown>> {
  if (args.msg.length > 1600) {
    throw new Error('SMS body exceeds the 1600-character limit.');
  }
  return request(`/accounts/${accountId}/sms`, { method: 'POST', body: { ...args }, form: true });
}

// ─── A2P / Trust Center ──────────────────────────────────────────────────────

export async function getA2pStatus(accountId: string): Promise<Record<string, unknown>> {
  try {
    return await request(`/accounts/${accountId}/trust_center/a2p_campaigns`);
  } catch (err) {
    // Endpoint shape is probe-refined (P6); a 404 here means "unknown", not
    // "no campaigns" — callers treat it as not-ready and surface a check action.
    if (err instanceof CtmApiError && err.httpStatus === 404) {
      logger.warn('[ctm] trust_center/a2p_campaigns returned 404 — A2P status unknown');
      return { status: 'unknown' };
    }
    throw err;
  }
}
