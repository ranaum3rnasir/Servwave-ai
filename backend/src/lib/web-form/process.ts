import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../logger';
import { matchByPhone, matchByEmail } from '../comms-identity';
import { normalizePhone } from '../customer-duplicate';
import { withRequiredCustomerFields } from '../customer-create';
import { withNumberCollisionRetry } from '../number-collision-retry';
import { allocateNumber } from '../numbering';
import { CREATED_BY_CLIENT } from '../created-by';
import type { WebFormSubmissionEvent } from './types';

/**
 * The claim-insert works against either client; the Customer + Lead work owns a
 * transaction of its own, which only the full client can open.
 */
type Db = PrismaClient;

export type WebFormOutcome = 'stored' | 'duplicate';

/**
 * `service_request` is NOT-NULL and the form may carry neither a message nor a
 * selection, so this fallback is load-bearing rather than cosmetic. It is read
 * by the office inside the CRM, so it names no vendor (CLAUDE.md): every
 * capability is ServWave's own.
 */
const FALLBACK_SERVICE_REQUEST = 'Website form submission';

/**
 * The idempotency key for one submission, WITHIN ONE ORG (plan §3f).
 *
 * The payload carries NO entry id by default, so there is usually nothing
 * exact to key on. When the agency adds the hidden Submission ID field the
 * vendor's own id is used verbatim; until then the key is a hash of
 * (form title, contact handle, receive time truncated to the minute).
 *
 * NEITHER BRANCH IS GLOBALLY UNIQUE, and neither is meant to be. The vendor's
 * entry id is the form plugin's PER-SITE sequential counter - every site's
 * second submission is `2` - and the derived hash carries nothing org-specific
 * either, so two orgs whose forms share a default title, hit by the same person
 * in the same minute, produce the same digest. The org is supplied by the
 * ledger's unique key (organization_id, provider, submission_key), not by this
 * function; do not add it here, and do not drop it from there.
 *
 * That derivation is DELIBERATELY IMPERFECT and must not be hardened further:
 *  - the vendor never retries, so there is no re-delivery to collapse;
 *  - the realistic duplicate is a human pressing submit twice, and under plan
 *    §3d.4 a second submission is a legitimate second lead anyway;
 *  - so the only thing this key has to catch is the same submission arriving
 *    twice inside one minute, which is a double-click and nothing else.
 * Widening the window would start silently swallowing real leads.
 */
export function submissionKey(e: WebFormSubmissionEvent, receivedAt: Date): string {
  if (e.vendorSubmissionId) return e.vendorSubmissionId;
  const handle = e.phone ?? e.email ?? '';
  const minute = Math.floor(receivedAt.getTime() / 60_000);
  const digest = crypto
    .createHash('sha256')
    .update(`${e.formTitle ?? ''}|${handle}|${minute}`)
    .digest('hex');
  // Prefixed so a derived key is recognisable as such in the table, and can
  // never collide with a vendor id once the hidden field lands.
  return `sha256:${digest}`;
}

/**
 * Record one submission for an org. Runs AFTER the webhook has been acked.
 *
 * CLAIM-FIRST: the insert IS the lock, the same shape ctm_events uses. A
 * pre-read then insert would be a race on a public endpoint two visitors can
 * hit at once, so the unique index on (organization_id, provider,
 * submission_key) decides and a P2002 means somebody else got there first.
 *
 * "Somebody else" means somebody else IN THIS ORG. The org leads that key on
 * purpose - see the schema comment on `WebFormSubmission` for why ctm_events'
 * global id does not transfer - because this branch stores NOTHING: an org that
 * lost a cross-tenant collision here would get no ledger row, no Customer and no
 * Lead, and the log line below would call it ordinary de-duplication.
 *
 * The claim is deliberately OUTSIDE the Customer + Lead transaction below, and
 * before it. Inside, a rollback would RELEASE the claim, and the retry that
 * rollback invites would then be free to create a second Customer and a second
 * Lead for one submission. Outside, the unique index has already decided who
 * owns this key before any row is minted, so the downstream work runs exactly
 * once per key - and when it fails, the payload is still on disk for a human.
 */
export async function processWebFormSubmission(
  db: Db,
  orgId: string,
  e: WebFormSubmissionEvent,
  payload: Prisma.InputJsonValue,
  receivedAt: Date = new Date(),
  defaultLeadSource: string | null = null,
): Promise<WebFormOutcome> {
  const key = submissionKey(e, receivedAt);
  let submissionId: string | null = null;
  try {
    const row = await db.webFormSubmission.create({
      data: {
        organization_id: orgId,
        provider: e.provider,
        submission_key: key,
        form_title: e.formTitle,
        payload,
        received_at: receivedAt,
      },
      select: { id: true },
    });
    submissionId = row?.id ?? null;
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      // Deliberately no contact handle in the log line.
      logger.info(
        `[web-form] duplicate submission ignored (provider=${e.provider}, form=${e.formTitle ?? 'unknown'})`,
      );
      return 'duplicate';
    }
    throw err;
  }

  await openLead(db, orgId, e, submissionId, defaultLeadSource, key);
  return 'stored';
}

/**
 * Turn a claimed submission into a Customer and a Lead (plan §3d).
 *
 * ONE transaction, wrapped in the number-collision retry: `allocateNumber` has
 * to roll back with the row it numbered, and the retry re-runs the WHOLE unit of
 * work in a fresh transaction, which is only safe because everything in here is
 * a database write. The customer MATCH is inside it too - resolving the row
 * before the transaction opens would make it a snapshot rather than a read the
 * surrounding transaction holds.
 *
 * Failure is contained here on purpose. The ledger row is already committed with
 * the raw payload, so a failure costs the Lead, never the submission: a human
 * can see exactly what arrived and open it by hand. Rethrowing would only add a
 * second, vaguer log line - the claim is committed either way, so there is no
 * retry to enable.
 */
async function openLead(
  db: Db,
  orgId: string,
  e: WebFormSubmissionEvent,
  submissionId: string | null,
  defaultLeadSource: string | null,
  key: string,
): Promise<void> {
  try {
    await withNumberCollisionRetry(
      () =>
        db.$transaction(async (tx) => {
          let customerId = await matchCustomer(tx, orgId, e);
          if (!customerId) {
            customerId = await createCustomer(tx, orgId, e);
            await recordFirstTouchSource(tx, orgId, customerId, resolveSource(e, defaultLeadSource));
          }

          const leadNumber = await allocateNumber(tx, 'lead', orgId);
          const lead = await tx.lead.create({
            data: {
              lead_number: leadNumber,
              organization_id: orgId,
              customer_id: customerId,
              // NOT-NULL, and a form can carry neither field.
              service_request:
                capped(e.message, SERVICE_REQUEST_MAX) ??
                capped(e.selection, SERVICE_REQUEST_MAX) ??
                FALLBACK_SERVICE_REQUEST,
              attribution: attributionOfSubmission(e) ?? Prisma.DbNull,
              // No assignee, no commission owner and no visit row: nobody has
              // picked this up yet, and a placeholder trip would put a lead
              // nobody has read onto the schedule.
              //
              // `source` is deliberately absent. It is a first-touch CUSTOMER
              // attribute and the lead column is dead - see the schema comment.
              ...CREATED_BY_CLIENT,
            },
            select: { id: true },
          });

          // The ledger row is what links a raw payload to what it became, so it
          // is filled INSIDE this transaction: a lead nobody can trace back to
          // the submission that produced it is the audit trail failing in the
          // one case anyone would go looking.
          if (submissionId) {
            await tx.webFormSubmission.update({
              where: { id: submissionId },
              data: { lead_id: lead.id, customer_id: customerId },
            });
          }
        }),
      { label: 'web-form.submission' },
    );
  } catch (err) {
    // Never the phone number, the email address or the submitted name: the key
    // is what a human needs to find the stored payload, and it is a hash or a
    // vendor id, not a contact handle.
    logger.error(
      `[web-form] submission stored but lead creation failed (provider=${e.provider}, key=${key}, form=${
        e.formTitle ?? 'unknown'
      }): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The per-submission marketing attribution written onto `Lead.attribution`.
 *
 * The key names are the ones `lib/ctm/ingest.ts` and `lib/call-tracking/types.ts`
 * already write onto `CallSession.attribution` - source, medium, campaign,
 * keyword, referrer, landing_page, gclid, fbclid, msclkid - so one column reads
 * the same whether the lead came from a call or a form and "which campaign
 * produced revenue" is one UNION rather than two schemas to reconcile. The
 * paid-social and paid-Bing click ids are part of that vocabulary, not an extra:
 * leaving them out would break the shared column for exactly the two channels
 * they exist to identify.
 *
 * Absent values are OMITTED, not stored as empty strings: an empty bucket in a
 * GROUP BY is worse than no bucket, and a row full of blanks makes "this form
 * carried no campaign" indistinguishable from "we never captured campaign at
 * all". Returns null (SQL NULL), never `{}`.
 *
 * ONLY PRIMITIVES, asserted here rather than trusted. `trackingParams` is typed
 * `Record<string, string>` and the adapter's `str()` already drops objects, but
 * the call side's `gclid` is the literal string `[object Object]` on 507 of 507
 * production rows for exactly one reason: a value was `String()`d without
 * anybody checking what it was. The same key names land here, from a second
 * vendor's adapter one day, so the check belongs at the write site.
 * -> md_files/plans/communication/2026-09-18-ctm-gclid-is-object-object.md
 *
 * `gclid` comes from THIS submission's own tracking params and from nowhere
 * else. The phone system's value must never propagate into this column.
 */
function attributionOfSubmission(e: WebFormSubmissionEvent): Prisma.InputJsonObject | null {
  const out: Record<string, string> = {};
  const put = (key: string, raw: unknown) => {
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return;
    const value = String(raw).trim();
    if (!value) return;
    out[key] = value.slice(0, ATTRIBUTION_VALUE_MAX);
  };
  const t: Record<string, unknown> = e.trackingParams ?? {};
  put('source', t.utm_source);
  put('medium', t.utm_medium);
  put('campaign', t.utm_campaign);
  put('keyword', t.utm_term);
  put('referrer', e.referringUrl);
  put('landing_page', e.landingPageUrl);
  put('gclid', t.gclid);
  put('fbclid', t.fbclid);
  put('msclkid', t.msclkid);
  return Object.keys(out).length > 0 ? (out as Prisma.InputJsonObject) : null;
}

/**
 * WHAT A PUBLIC FORM IS ALLOWED TO MAKE LONG.
 *
 * Every column below is Postgres `text`, so the database takes a 95KB value
 * happily and the office then reads it in every list, picker and export this
 * record appears in. A public, unauthenticated writer is the one writer that
 * cannot be trusted to be reasonable, so it agrees with the ceiling the human
 * paths already enforce rather than being the single writer that can exceed it.
 *
 * Each number is taken from an existing rule, not invented:
 *  - 100  `z.string().max(100)` on first_name / last_name (customer.controller)
 *         and on source / ad_source, which is why AD_SOURCE_MAX is the same
 *         number under a name that says which rule it came from.
 *  - 254  RFC 5321's maximum path length. `normalizeEmail` shape-checks and
 *         lowercases but does NOT bound length, so a 95KB local part
 *         normalises perfectly happily.
 *  - 2000 `z.string().min(1).max(2000)` on service_request (lead.controller),
 *         reused for the attribution values because the long ones are URLs and
 *         2000 is also the practical maximum length of one.
 *
 * Truncation is never data loss here: the raw body is in the ledger verbatim.
 */
const NAME_MAX = 100;
const EMAIL_MAX = 254;
const SERVICE_REQUEST_MAX = 2000;
const ATTRIBUTION_VALUE_MAX = 2000;
const AD_SOURCE_MAX = 100;

/** Trim and cap one free-text value, keeping null as null. */
function capped(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Which value is this submission's source: the campaign it names, else the
 * fallback the operator set when provisioning the integration row.
 *
 * In practice `default_lead_source` is what fires today, because the hidden
 * URL-capture fields do not exist on the customer's form yet. That is the
 * INTENDED behaviour and not a gap - the operator sets the fallback precisely so
 * a form with no campaign plumbing still says where the client came from.
 *
 * An empty pair writes NOTHING. A blank string is not an origin, and storing one
 * makes "we never captured it" indistinguishable from "they came from nowhere"
 * in every GROUP BY that reads this column.
 *
 * OPEN QUESTION, deliberately not solved here: R6 wants ONE vocabulary, agreeing
 * with `Organization.source_options`. There is no server-side validation of that
 * today on any path, so a vendor sending "Google Ads" while the org's dropdown
 * offers "Google" still produces two buckets for one thing. That validation is
 * the 2026-08-19 number-source plan's §4a and belongs there, applied to every
 * writer at once - adding it to this one writer would only move the split.
 */
function resolveSource(e: WebFormSubmissionEvent, defaultLeadSource: string | null): string | null {
  for (const candidate of [e.trackingParams?.utm_source, defaultLeadSource]) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    if (value) return value.slice(0, AD_SOURCE_MAX);
  }
  return null;
}

/**
 * Write the customer's origin, once, at creation.
 *
 * BOTH `source` AND the legacy `ad_source`, from the one value, in the one
 * statement. The two columns are kept as mirrors by every human path - the
 * customer form's single "How Did They Hear About Us?" control sets both
 * (CustomerFormPage.tsx) - and they surface on DIFFERENT screens: the customers
 * list column and its filter read `ad_source`, the customer record's own control
 * reads `source`. Writing one alone would give a form-created customer an origin
 * in the list and a blank control on their record, and the first-touch plan's §7
 * ("correctable in one click on the customer record") would be pointing at a
 * control bound to the column nobody wrote. Both are nullable text capped at 100
 * on every path a person can type one.
 *
 * DELIBERATE DEVIATION from the plans, which name only `ad_source`.
 *
 * R3/R4: automation sets the origin once, when it creates the customer, and
 * never rewrites it. A returning customer arriving via a different campaign
 * keeps where they first came from - so this is only ever called on the branch
 * that just MINTED the customer, and the two `null`s in the WHERE are the second
 * lock rather than the only one. BOTH are in the guard, not just the legacy one:
 * a lock that only reads `ad_source` would let an already-set `source` be
 * rewritten, which is the exact thing the lock exists to stop. The submission's
 * own campaign still lands on `Lead.attribution`, so the per-submission detail is
 * not lost; it just does not rewrite who the customer is.
 *
 * `updateMany` with the guard in the WHERE, not a read followed by an update:
 * one statement, so there is no window between deciding and writing. A person
 * may still change this freely afterwards (R5) - that is not this code's
 * business.
 */
async function recordFirstTouchSource(
  tx: Prisma.TransactionClient,
  orgId: string,
  customerId: string,
  source: string | null,
): Promise<void> {
  if (!source) return;
  await tx.customer.updateMany({
    where: { id: customerId, organization_id: orgId, ad_source: null, source: null },
    data: { ad_source: source, source },
  });
}

/**
 * Find the customer this submission belongs to, within the org: normalised
 * PHONE first, then lowercased email. Phone first because it is what the office
 * searches on and what the call path already keys on.
 *
 * Reuses the resolver the call path uses (`lib/comms-identity`), so a person who
 * phones and a person who submits a form resolve to the same customer by the
 * same rules - including the three places a customer keeps a number (the scalar,
 * the legacy secondary, and the phones[] relation the current edit flow writes).
 * Only the CUSTOMER is taken from the match: a vendor resolves with a null
 * `customerId`, which correctly falls through to creating a customer, because a
 * supplier's number appearing on a quote form does not make the supplier the
 * client.
 */
async function matchCustomer(
  tx: Prisma.TransactionClient,
  orgId: string,
  e: WebFormSubmissionEvent,
): Promise<string | null> {
  if (e.phone) {
    const byPhone = await matchByPhone(tx, orgId, e.phone);
    if (byPhone?.customerId) return byPhone.customerId;
  }
  if (e.email) {
    const byEmail = await matchByEmail(tx, orgId, e.email);
    if (byEmail?.customerId) return byEmail.customerId;
  }
  return null;
}

/**
 * Create the customer this submission is the first touch of.
 *
 * `withRequiredCustomerFields` inside the same transaction, because it allocates
 * `customer_number` and that allocation has to roll back with the row.
 *
 * No `ServiceLocation`: the form collects no address, and an empty primary
 * location is worse than none - every address reader would then have a row to
 * find and nothing in it.
 *
 * No invented name. The contact-handle gate guarantees a phone or an email, but
 * a form that asks for neither first name nor company leaves both null rather
 * than getting a placeholder that reads as a person's name in every list.
 */
async function createCustomer(
  tx: Prisma.TransactionClient,
  orgId: string,
  e: WebFormSubmissionEvent,
): Promise<string> {
  const customer = await tx.customer.create({
    data: {
      ...(await withRequiredCustomerFields(tx, orgId, {
        first_name: capped(e.firstName, NAME_MAX),
        last_name: capped(e.lastName, NAME_MAX),
        // The column holds DIGITS ONLY everywhere else (lib/phone-schema.ts), so
        // the E.164 the adapter normalised to is converted back rather than
        // stored as the one odd variant nothing else formats or searches on.
        phone: e.phone ? normalizePhone(e.phone) : null,
        email: capped(e.email, EMAIL_MAX),
      })),
      // The CUSTOMER did this themselves through a public, unauthenticated
      // surface. There is no req.user to attribute it to, and SYSTEM would be a
      // lie in the other direction: the platform did not decide this, a visitor
      // did. LAST in the object so it wins over anything spread above.
      ...CREATED_BY_CLIENT,
    },
    select: { id: true },
  });
  return customer.id;
}
