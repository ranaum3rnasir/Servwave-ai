import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { runUnscoped } from '../lib/tenant-context';
import { rawBodyString } from '../lib/webhooks/shared';
import { isWebFormProvider, parseWebFormSubmission } from '../lib/web-form/adapters';
import { processWebFormSubmission } from '../lib/web-form/process';
import { stripNulDeep } from '../lib/web-form/sanitize';

/**
 * Website-form lead intake receiver —
 *   POST /api/webhooks/web-form/:provider/:urlToken
 *
 * A customer's website takes leads through a form plugin; the plugin posts each
 * submission here instead of emailing the office a notification somebody
 * retypes. Plan: md_files/plans/communication/2026-09-18-web-form-lead-intake.md.
 *
 * Mounted beside the call-tracking receiver under /api/webhooks, so it inherits
 * `unscopedRequest`; the owning org is resolved from the URL token.
 *
 * **NEVER answer a real submission with a 4xx or a 5xx.** This vendor has no
 * retries, no queue and no auto-disable: a non-2xx delivery is not a deferred
 * lead, it is a destroyed one, and nobody is told. Every rejection below is a
 * 200/202 with a log line, and THAT LOG LINE IS THE ONLY ALARM ANYONE GETS.
 *
 * Gates, in order, each fail-closed:
 *  1. `:provider` is a known provider              → else 404, before any query
 *  2. `:urlToken` resolves an ENABLED row for it   → else 404, byte-identical
 *     for unknown, disabled and wrong-provider, so the token space cannot be
 *     probed. The vendor signs nothing at all — no secret, no HMAC, no bearer,
 *     no custom header — so this 32-byte token is the ONLY gate there is.
 *  3. Body parses as JSON                          → else 202 + warn
 *  4. `X-Hook-Test` present and truthy             → 200, stamp last_event_at,
 *     create nothing. This is the agency pressing Save in the plugin: a non-2xx
 *     here blocks the save outright, and the probe's values are field LABELS,
 *     so storing it would open a lead called "First Name".
 *  5. At least one usable contact handle           → else 202 + warn, store
 *     nothing. One of the three cheap defences on a public URL that creates
 *     rows, alongside the 32-byte token and the idempotency key.
 *
 * Rate limiting, the third defence in plan §3f, is still NOT wired: nothing
 * bounds how many submissions one leaked URL may send. What IS bounded is the
 * post-ack work — see WEB_FORM_MAX_IN_FLIGHT — so a flood costs the flooded org
 * its own overflow rather than costing every tenant the shared connection pool.
 *
 * The 200 goes out BEFORE any processing: the plugin fires this inline with the
 * visitor's own form submission on a 5-second timeout, so a slow receiver makes
 * a real customer sit watching a spinner. The work runs fire-and-forget with its
 * own try/catch, the same posture as the call-tracking receiver.
 *
 * And NOTHING before the ack may throw its way out of this handler: Express 4
 * does not adopt a rejected promise from an async handler, so an uncaught throw
 * is not a 500, it is silence until the socket times out. `handleWebFormWebhook`
 * wraps the whole of `receive` for exactly that.
 *
 * Never log a phone number, an email address or a submitted name. The provider,
 * the form title, the submission key and the error message are enough.
 */

/**
 * How many accepted submissions may be in post-ack flight at once, process-wide.
 *
 * NOTHING RATE-LIMITS THIS ENDPOINT. /api/webhooks mounts at app.ts:103, before
 * the global limiter at :129, and the vendor sends no credential of any kind, so
 * anyone holding one leaked URL can post as fast as they like. Each accepted
 * POST opens a transaction that takes an exclusive lock on the org's
 * `organizations` row TWICE via `allocateNumber`, while holding a connection
 * from the PROCESS-WIDE PRISMA POOL EVERY TENANT SHARES. Unbounded, the damage
 * from one org's flood is other organizations' queries failing on pool timeout.
 *
 * So: ack always, and bound what happens afterwards. Past this mark the
 * submission is dropped with an error line. The flooded org loses its own
 * overflow; every other tenant keeps the API.
 *
 * WHY 50, and not the existing rate limiter:
 *  - A real contractor's website takes single-digit submissions in its busiest
 *    hour. At even 200/hour with a 2s unit of work, expected in-flight is ~0.1,
 *    so 50 is well over two orders of magnitude above live traffic and cannot
 *    be reached by a real site.
 *  - The pathological LEGITIMATE case is the database stalling out to the 30s
 *    interactive-transaction ceiling (lib/prisma.ts transactionOptions.timeout)
 *    while submissions keep arriving. Even at one per second — already far past
 *    any real form — in-flight peaks at 30. 50 clears that with headroom.
 *  - Above that it is not a website, it is a flood, and what matters is that the
 *    number of shared-pool waiters is a small fixed one rather than unbounded.
 *    This bounds the blast radius; it does not claim to eliminate pool pressure.
 */
export const WEB_FORM_MAX_IN_FLIGHT = 50;

let inFlight = 0;

/** `X-Hook-Test` is truthy unless it is absent, empty, 'false' or '0'. */
function isTestRequest(req: Request): boolean {
  const header = req.get('X-Hook-Test');
  if (header === undefined) return false;
  const v = header.trim().toLowerCase();
  return v !== '' && v !== 'false' && v !== '0';
}

export async function handleWebFormWebhook(req: Request, res: Response) {
  const provider = String(req.params.provider ?? '');
  try {
    await receive(req, res, provider);
  } catch (err) {
    // THE INVARIANT, RESTORED GENERALLY rather than one gate at a time.
    //
    // Every gate in `receive` answers on purpose. This catches what nobody
    // planned: a transient DB failure on the token lookup, a value shaped to
    // throw inside the adapter, a bug in a future gate. Uncaught, such a throw
    // does not become a 500 - Express 4 does not adopt a rejected promise from
    // an async handler, and there is no process-level `unhandledRejection`
    // handler in this service - so the plugin got NO RESPONSE AT ALL and the
    // socket sat pinned until `server.requestTimeout`. On a vendor with no
    // retries and no queue that is a destroyed submission, silently.
    //
    // It also closes this feature's one PII leak. An unhandled rejection is
    // reported by Sentry's onUnhandledRejection integration, and instrument.ts
    // runs with `sendDefaultPii` + `includeLocalVariables`, so the local
    // variables of the adapter's frames - the submitted name, phone and email -
    // would ship to a third-party error service. Catching it here means there
    // is no unhandled rejection to report. The cost is that this path is no
    // longer visible in Sentry either, which is the trade this file has already
    // made everywhere else: the log line is the alarm.
    //
    // 202, not 500: "we could not understand this at all" still has to be a 2xx.
    logger.error(
      `[web-form] receiver failed before the ack (provider=${provider}) — acked, nothing stored: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (!res.headersSent) res.status(202).json({ received: true, ignored: 'error' });
  }
}

async function receive(req: Request, res: Response, provider: string) {
  if (!isWebFormProvider(provider)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const urlToken = String(req.params.urlToken ?? '');
  if (!urlToken || urlToken.length > 128) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const integration = await prisma.webFormIntegration.findFirst({
    where: { url_token: urlToken, provider, enabled: true },
    select: { id: true, organization_id: true, field_map: true, default_lead_source: true },
  });
  if (!integration) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const rawBody = rawBodyString(req);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    logger.warn(`[web-form] malformed body (provider=${provider}) — acked, ignored`);
    res.status(202).json({ received: true, ignored: 'malformed' });
    return;
  }

  // ONE place, so the mapped fields and the stored payload agree: Postgres
  // accepts a NUL in neither `text` nor `jsonb`, and a single one anywhere in
  // this body makes the ledger INSERT throw AFTER the ack has gone out - no
  // row, no Customer, no Lead, and the vendor never resends. See lib/web-form/
  // sanitize.ts for the three measured Postgres errors. Outside the catch
  // above: a failure here is not "the body was malformed" and must not be
  // reported as one.
  const body = stripNulDeep(parsed);

  const integrationId = integration.id;
  const orgId = integration.organization_id;
  // Carried down rather than re-queried after the ack: the row is already in
  // hand, and it is what a NEW customer's first touch falls back to when the
  // payload names no campaign (plan §3d + first-touch R3/R4).
  const defaultLeadSource = integration.default_lead_source;

  if (isTestRequest(req)) {
    // The save-time probe. Logged at info on purpose: it is the cheapest smoke
    // test we have that the URL the agency pasted actually reaches us.
    logger.info(`[web-form] test request accepted (provider=${provider}) — nothing stored`);
    res.json({ received: true, test: true });
    stampLastEvent(integrationId, provider);
    return;
  }

  const event = parseWebFormSubmission(provider, body, integration.field_map);
  if (!event) {
    // Valid JSON, but not the flat object the plugin sends. Reported apart from
    // the handle gate below: the log line is the only alarm, so it has to name
    // which of the two actually happened.
    logger.warn(`[web-form] body parsed but is not a submission object (provider=${provider}) — acked, ignored`);
    res.status(202).json({ received: true, ignored: 'malformed' });
    return;
  }
  if (!event.phone && !event.email) {
    // No phone we can call and no address we can reply to is not a lead, it is
    // a row nobody can action. Acked so the visitor's page still completes.
    logger.warn(
      `[web-form] submission carried no usable contact handle (provider=${provider}, form=${
        event.formTitle ?? 'unknown'
      }) — acked, not stored`,
    );
    res.status(202).json({ received: true, ignored: 'no_contact' });
    return;
  }

  // STILL MISSING (plan §3f): a per-TOKEN rate limit. Nothing bounds how many
  // submissions one leaked URL may send, so a flood still costs the flooded org
  // its own overflow submissions (dropped below, loudly). What is fixed is the
  // blast radius: it no longer reaches other tenants. A real limiter here has to
  // ACK and drop rather than 429 — every limiter in middleware/rate-limit.ts
  // answers an over-limit with a 429, and a 429 destroys a real lead silently,
  // which is the one outcome this endpoint exists to prevent. The other two
  // defences in §3f (the 32-byte token and the contact-handle rule above) are
  // live.

  res.json({ received: true });

  // Everything below runs after the ack.
  const payload = body as Prisma.InputJsonValue;
  const receivedAt = new Date();

  if (inFlight >= WEB_FORM_MAX_IN_FLIGHT) {
    // ERROR, not info: this IS a lost lead, and the log line is the only alarm.
    logger.error(
      `[web-form] post-ack work at capacity (${inFlight}/${WEB_FORM_MAX_IN_FLIGHT}) — DROPPED a submission (provider=${provider}, form=${
        event.formTitle ?? 'unknown'
      })`,
    );
    return;
  }

  inFlight++;
  setImmediate(() => {
    void runUnscoped(async () => {
      try {
        await processWebFormSubmission(prisma, orgId, event, payload, receivedAt, defaultLeadSource);
      } catch (err) {
        logger.error(
          `[web-form] processing failed (provider=${provider}, form=${event.formTitle ?? 'unknown'}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        // In a `finally` so no path can leak a slot. A leaked counter would
        // wedge the receiver permanently, which is worse than what it prevents.
        inFlight--;
      }
    });
  });

  // A SEPARATE unit of work, and deliberately not awaited ahead of the claim
  // insert. `last_event_at` is a dashboard nicety; the ledger row is the payload
  // archive and the only thing a human could ever recover a lost lead from.
  // Sequenced first inside the same try, one transient connection reset on this
  // cosmetic write took the claim insert, the Customer and the Lead with it -
  // after the 200 had already gone out to a vendor that never resends. Nothing
  // may sit ahead of the claim, so the stamp sits beside it with its own
  // try/catch instead. `process.ts`'s "a failure costs the Lead, never the
  // submission" only holds if this rule holds.
  stampLastEvent(integrationId, provider, receivedAt);
}

/**
 * Stamp "it is firing", for the save-time probe and beside a real submission.
 *
 * Its own setImmediate and its own try/catch: it must never be able to cost the
 * caller anything, whether that is the probe's 200 or a real submission's
 * ledger row.
 */
function stampLastEvent(integrationId: string, provider: string, at: Date = new Date()): void {
  setImmediate(() => {
    void runUnscoped(async () => {
      try {
        await prisma.webFormIntegration.update({
          where: { id: integrationId },
          data: { last_event_at: at },
        });
      } catch (err) {
        logger.error(
          `[web-form] last_event_at update failed (provider=${provider}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  });
}
