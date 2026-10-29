import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { textingNotSwitchedOn } from '../lib/ctm/userCopy';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';
import {
  isCtmConfigured,
  searchNumbers as ctmSearchNumbers,
  buyNumber as ctmBuyNumber,
  createReceivingNumber,
  updateNumberRouting,
  releaseNumber,
  enableSms,
  CtmApiError,
} from '../lib/ctm/client';
import { normalizeNAPhone } from '../lib/comms-identity';
import { syncNumbers } from '../lib/ctm/numberSync';

/**
 * Numbers platform (master plan §4 comm-numbers row, slice 7).
 *
 * READ/PATCH are plain Communication grants; search/buy/register-byo are gated
 * canDo('update','Organization') — the repo's ADMIN idiom (addendum §A.2:
 * DISPATCHER holds create-Communication, so a Communication gate would let a
 * dispatcher spend money). Search responses are price-stripped server-side:
 * numbers are "included in the plan" — CTM's per-number cost is a platform
 * detail that must never reach the UI (plan §2).
 */

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Where a number's calls actually ring, read off the `route_to` JSON column.
 *  Only the forward destination is a shape we own; anything else in there is
 *  someone else's routing and reads as "not a simple forward". */
export function forwardToOf(routeTo: unknown): string | null {
  if (!routeTo || typeof routeTo !== 'object' || Array.isArray(routeTo)) return null;
  const value = (routeTo as Record<string, unknown>).forward_to;
  return typeof value === 'string' && value ? value : null;
}

/** The stored `source` names the integration a number came through ('ctm' =
 *  bought through the phone service, 'byo' = registered by the org). The
 *  browser gets ServWave's own word for the first, never the vendor's. */
function presentNumberSource(source: string): string {
  return source === 'ctm' ? 'servwave' : source;
}

/** Wire shape for a PhoneNumber row (snake_case; created_at ISO). The number's
 *  id at the phone service travels as `provider_number_id`. */
function mapNumber(row: {
  id: string;
  e164: string;
  formatted: string | null;
  label: string | null;
  source: string;
  type: string | null;
  sms_enabled: boolean;
  ctm_number_id: string | null;
  call_flow_id: string | null;
  route_to?: unknown;
  status: string;
  created_at: Date | string;
}) {
  return {
    id: row.id,
    e164: row.e164,
    formatted: row.formatted,
    label: row.label,
    source: presentNumberSource(row.source),
    type: row.type,
    sms_enabled: row.sms_enabled,
    provider_number_id: row.ctm_number_id,
    // TODO(phone-api-neutral-names): deprecated alias, kept one release for a
    // browser still on an old bundle. No current frontend reads it; remove then.
    ctm_number_id: row.ctm_number_id,
    call_flow_id: row.call_flow_id,
    // Where this number rings. Previously absent entirely, which left the UI
    // unable to show - let alone change - the destination that IS the routing.
    forward_to: forwardToOf(row.route_to),
    status: row.status,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/** Resolve the org's CTM account or write the failure response (503/409) and
 *  return null — mirrors checkCtmA2p's gate order. */
async function requireCtmAccount(req: Request, res: Response): Promise<string | null> {
  if (!isCtmConfigured()) {
    res.status(503).json({ error: 'The phone system is not configured — contact support' });
    return null;
  }
  const org = await prisma.organization.findUnique({
    where: { id: req.user!.organization_id },
    select: { ctm_account_id: true },
  });
  if (!org?.ctm_account_id) {
    res.status(409).json({ error: 'Organization is not connected to a phone system' });
    return null;
  }
  return org.ctm_account_id;
}

// ─── GET /numbers ────────────────────────────────────────────────────────────

export async function listNumbers(req: Request, res: Response) {
  try {
    const rows = await prisma.phoneNumber.findMany({
      where: tenantWhere(req),
      orderBy: { created_at: 'asc' },
    });
    res.json({ numbers: rows.map(mapNumber) });
  } catch (err) {
    logger.error('Failed to list phone numbers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /numbers/sync-if-stale ─────────────────────────────────────────────

/**
 * A phone-numbers screen opening (Communication -> Phone -> Phone numbers, or
 * Settings -> Caller ID). The screen shows its stored list at once and calls
 * this in the background; it replaces its list only when `changed` is true.
 *
 * Same gate and org scoping as GET /numbers: anyone who can read the list may
 * call it, not only admins. A sync's texting switch-on is system policy (Ran,
 * 2026-09-30), not the viewer's act, which is also why the audit entry names
 * no person (see `syncNumbers`).
 *
 * The sync goes through the module's per-org throttle, so a burst of page
 * opens reaches the phone system at most once a minute per org.
 *
 * Never an error for the phone system's sake: with no phone account, or when
 * the phone system fails, the answer is the stored list and `changed: false`.
 * Nothing about a failure reaches the viewer. A failed sync is logged once, by
 * the sync routine; only a failure to read the org's account is logged here.
 *
 * `stillRunning` is true when the sync outlasted the automatic caller's wait
 * (`AUTO_SYNC_WAIT_MS`): the list is the stored one and the run carries on, so
 * the screen asks once more a little later to pick up its result.
 */
export async function syncNumbersIfStale(req: Request, res: Response) {
  const orgId = req.user!.organization_id;
  let result: {
    changed: boolean;
    stillRunning: boolean;
    numbers: Parameters<typeof mapNumber>[0][];
  } | null = null;
  try {
    const org = isCtmConfigured()
      ? await prisma.organization.findUnique({ where: { id: orgId }, select: { ctm_account_id: true } })
      : null;
    if (org?.ctm_account_id) {
      // A sync failure is already logged by the sync routine; it only means
      // the stored list is served.
      const synced = await syncNumbers({ orgId, accountId: org.ctm_account_id, trigger: 'page-open' }).catch(
        () => null,
      );
      if (synced) {
        result = { changed: synced.changed, stillRunning: synced.stillRunning, numbers: synced.numbers };
      }
    }
  } catch (err) {
    logger.warn(`[number-sync] could not read the phone account of org ${orgId}; serving the stored list:`, err);
  }

  try {
    if (!result) {
      const rows = await prisma.phoneNumber.findMany({
        where: tenantWhere(req),
        orderBy: { created_at: 'asc' },
      });
      result = { changed: false, stillRunning: false, numbers: rows };
    }
    res.json({
      changed: result.changed,
      stillRunning: result.stillRunning,
      numbers: result.numbers.map(mapNumber),
    });
  } catch (err) {
    logger.error('Failed to list phone numbers after a background sync:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /numbers/search ────────────────────────────────────────────────────

export const searchNumbersSchema = z.object({
  areacode: z.string().regex(/^\d{3}$/, 'areacode must be a 3-digit area code').optional(),
  type: z.enum(['local', 'tollfree']).optional(),
});

// The NANPA toll-free prefixes. CTM treats one of these in `areacode` as a
// toll-free search in its own right, so it is safe to keep alongside
// searchby=tollfree (833 has inventory; 800 is exhausted).
const TOLL_FREE_AREA_CODES = new Set(['800', '833', '844', '855', '866', '877', '888']);

/** Map our API's `type` onto CTM's actual search vocabulary.
 *
 *  CTM has no `type` parameter - it ignores the key and leaves the search on
 *  its searchby=area default, which returns LOCAL numbers. Toll-free must be
 *  asked for as searchby=tollfree, and a LOCAL areacode sent alongside it
 *  flips CTM back to an area search, so it is dropped. */
export function toCtmSearchParams(body: { areacode?: string; type?: 'local' | 'tollfree' }): {
  searchby?: string;
  areacode?: string;
} {
  if (body.type !== 'tollfree') {
    return body.areacode ? { areacode: body.areacode } : {};
  }
  return {
    searchby: 'tollfree',
    ...(body.areacode && TOLL_FREE_AREA_CODES.has(body.areacode) ? { areacode: body.areacode } : {}),
  };
}

// No pricing key survives, under any spelling (price, cost, monthly_price,
// setup_cost, …) — plan §2's "no price in response".
const PRICING_KEY = /price|cost/i;
function stripPricing(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !PRICING_KEY.test(key)));
}

export async function searchNumbers(req: Request, res: Response) {
  try {
    const accountId = await requireCtmAccount(req, res);
    if (!accountId) return;

    const items = await ctmSearchNumbers(accountId, toCtmSearchParams(req.body));
    res.json({ numbers: items.map(stripPricing) });
  } catch (err) {
    logger.error('Failed to search CTM numbers:', err);
    if (err instanceof CtmApiError) {
      res.status(502).json({ error: 'The phone system request failed' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /numbers/buy ───────────────────────────────────────────────────────

export const buyNumberSchema = z.object({
  phone_number: z.string().trim().min(1).max(40),
  // Routing is mandatory at purchase — an unrouted tracking number would
  // silently eat calls (plan §4 "buy → mandatory routing"). The forward
  // destination is what actually routes: CTM registers it as a receiving
  // number and the TPN dial-routes to it.
  forward_to_e164: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((v) => normalizeNAPhone(v) !== null, {
      message: 'forward_to_e164 must be a North-American phone number (e.g. +12015551234)',
    }),
  // Optional org metadata only — the CRM's CallFlow is a label, not CTM config.
  call_flow_id: z.string().uuid('call_flow_id must be a valid id').optional(),
});

// CTM signals "someone else grabbed it" with reason text, not a stable code.
const NUMBER_GONE = /unavailab|duplicate|already|taken/i;

export async function buyNumber(req: Request, res: Response) {
  try {
    const accountId = await requireCtmAccount(req, res);
    if (!accountId) return;
    const orgId = req.user!.organization_id;
    const warnings: string[] = [];

    // Validated by the schema — normalize to strict E.164 for CTM.
    const forwardTo = normalizeNAPhone(String(req.body.forward_to_e164))!;

    // Optional metadata: when a flow IS named it must be one of OUR org's call
    // flows (foreign/missing → 404, before any money-adjacent CTM call).
    let flow: { id: string } | null = null;
    if (req.body.call_flow_id) {
      flow = await prisma.callFlow.findFirst({
        where: { id: req.body.call_flow_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!flow) {
        res.status(404).json({ error: 'Call flow not found' });
        return;
      }
    }

    // Claim the row BEFORE the money moves.
    //
    // Buy is two untied steps - spend at the provider, then save - and a
    // failure between them loses a number that is already billing. That is not
    // hypothetical: `+1 609-596-8565` was bought on 2026-08-05, still sits on
    // the account with a next_billing_date, and has no row here at all, because
    // the save wrote `[object Object]` as the number. The specific cause was
    // fixed in 46be48d91; the shape of the risk was not.
    //
    // Recording the intent first means a purchase that then fails leaves a
    // visible `failed` row, and one that never resolves leaves a `pending` one.
    // Either is an anomaly somebody can see, which an invisible charge is not.
    const requestedE164 = normalizeNAPhone(String(req.body.phone_number));
    const existing = requestedE164
      ? await prisma.phoneNumber.findFirst({
          where: { organization_id: orgId, e164: requestedE164 },
          select: { id: true, status: true },
        })
      : null;
    // Only a row THIS request created may be marked failed below - re-buying a
    // number the org already owns must never downgrade the working one.
    let claimedId: string | null = null;
    if (requestedE164 && !existing) {
      const claimed = await prisma.phoneNumber.upsert({
        where: { organization_id_e164: { organization_id: orgId, e164: requestedE164 } },
        create: {
          e164: requestedE164,
          source: 'ctm',
          sms_enabled: false,
          status: 'pending',
          organization_id: orgId,
        },
        update: {},
      });
      claimedId = claimed.id;
    }

    /** Best-effort: a marker that cannot be written must not swallow the real
     *  error the caller needs (the typed 409 the UI branches on, in particular). */
    const markClaimFailed = async () => {
      if (!claimedId) return;
      try {
        await prisma.phoneNumber.update({ where: { id: claimedId }, data: { status: 'failed' } });
      } catch (err) {
        logger.error('Failed to mark an unfinished number purchase as failed:', err);
      }
    };

    // test:true unless real purchasing is EXPLICITLY armed. NODE_ENV is not a
    // safe discriminator: Render sets NODE_ENV=production on every service,
    // staging included, which would place a real billed order from a QA click
    // (live QA finding, 2026-07-21). Only CTM_PURCHASE_LIVE=true — set on the
    // production service at go-live — disarms the CTM test flag.
    let purchased: Record<string, unknown>;
    try {
      purchased = await ctmBuyNumber(accountId, {
        phone_number: req.body.phone_number,
        test: process.env.CTM_PURCHASE_LIVE !== 'true',
      });
    } catch (err) {
      await markClaimFailed();
      throw err;
    }
    const tpnId = purchased.id !== undefined && purchased.id !== null ? String(purchased.id) : null;

    // Defence in depth, independent of the provider's response shape: only a
    // genuine E.164 string may become a row. A non-string (the provider once
    // returned the whole number object here) would otherwise stringify to
    // "[object Object]" and be persisted as the org's number, because `??`
    // only catches null. Fall back to the number the caller asked to buy,
    // which the schema already validated.
    const returnedNumber = purchased.number;
    const e164 =
      typeof returnedNumber === 'string' && /^\+[1-9]\d{6,14}$/.test(returnedNumber)
        ? returnedNumber
        : String(req.body.phone_number);

    // SMS enablement is best-effort: 404/406 map to typed outcomes that become
    // warnings — a texting hiccup must never fail a completed purchase.
    // The warnings become a toast, so they are plain words (the same copy as
    // connect); the provider's outcome code goes to the log, never the screen.
    let smsEnabled = false;
    const textingNotOn = textingNotSwitchedOn(e164);
    if (tpnId) {
      try {
        const outcome = await enableSms(accountId, tpnId);
        smsEnabled = outcome === 'ok' || outcome === 'alreadyenabled';
        if (!smsEnabled) {
          warnings.push(textingNotOn);
          logger.warn(`[ctm-buy] enable_sms for ${e164} returned ${outcome}`);
        }
      } catch (err) {
        warnings.push(textingNotOn);
        logger.warn(`[ctm-buy] enable_sms for ${e164} failed:`, err);
      }
    } else {
      warnings.push(textingNotOn);
      logger.warn(`[ctm-buy] purchase of ${e164} returned no tracking-number id; texting not enabled`);
    }

    // Mandatory routing (plan §4 "buy → mandatory routing"): register the
    // forward destination as a receiving number (tolerate "already exists" —
    // re-registering the same phone is CTM's duplicate signal, not a failure)
    // then dial-route the new TPN to it. A routing failure must NEVER lose the
    // purchased row — surface it as a warning and leave route_to NULL so the
    // owner can finish routing in CTM.
    let routeTo: { forward_to: string } | null = null;
    if (tpnId) {
      try {
        try {
          await createReceivingNumber(accountId, forwardTo);
        } catch (err) {
          const alreadyExists =
            err instanceof CtmApiError && /already|exist|duplicate|taken/i.test(err.reason);
          if (!alreadyExists) throw err;
        }
        await updateNumberRouting(accountId, tpnId, { dial_route: 'forward', numbers: [forwardTo] });
        routeTo = { forward_to: forwardTo };
      } catch (err) {
        const reason = err instanceof CtmApiError ? err.reason : 'request failed';
        logger.warn(`[ctm] routing new number ${e164} failed: ${reason}`);
        warnings.push(`Number purchased but routing failed — contact support to finish setup.`);
      }
    } else {
      warnings.push(`Number purchased but routing failed — contact support to finish setup.`);
    }

    // Upsert on (org, e164) — the composite unique doubles as double-buy
    // protection (route_to stays SQL NULL until routing lands).
    const row = await prisma.phoneNumber.upsert({
      where: { organization_id_e164: { organization_id: orgId, e164 } },
      create: {
        e164,
        formatted: typeof purchased.formatted === 'string' ? purchased.formatted : null,
        source: 'ctm',
        ctm_number_id: tpnId,
        call_flow_id: flow?.id ?? null,
        route_to: routeTo ?? undefined,
        sms_enabled: smsEnabled,
        status: 'active',
        organization_id: orgId,
      },
      update: {
        ctm_number_id: tpnId,
        ...(typeof purchased.formatted === 'string' && { formatted: purchased.formatted }),
        ...(flow ? { call_flow_id: flow.id } : {}),
        ...(routeTo ? { route_to: routeTo } : {}),
        sms_enabled: smsEnabled,
        status: 'active',
      },
    });

    // Normally the claim above IS this row, promoted from pending to active by
    // the update branch. If the provider handed back a different number than
    // the one asked for, it is not - and the claim would linger as a pending
    // row for a number nobody owns. Drop it rather than leave a false anomaly
    // among the real ones.
    if (claimedId && claimedId !== row.id) {
      await prisma.phoneNumber
        .delete({ where: { id: claimedId } })
        .catch((err) => logger.error('Failed to clear a superseded number claim:', err));
    }

    void logAudit({
      req,
      action: 'number.purchased',
      resourceType: 'PhoneNumber',
      resourceId: row.id,
      metadata: {
        e164,
        ctm_number_id: tpnId,
        forward_to: routeTo?.forward_to ?? null,
        call_flow_id: flow?.id ?? null,
      },
    });

    res.status(201).json({ number: mapNumber(row), warnings });
  } catch (err) {
    if (err instanceof CtmApiError) {
      if (err.httpStatus === 409 || NUMBER_GONE.test(err.reason)) {
        // Someone else bought it between search and buy — typed so the UI can
        // say "pick another" instead of a generic failure.
        res.status(409).json({
          error: 'That number is no longer available',
          code: 'NUMBER_UNAVAILABLE',
        });
        return;
      }
      logger.error('CTM number purchase failed:', err);
      res.status(502).json({ error: 'The phone system request failed' });
      return;
    }
    logger.error('Failed to buy number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── PATCH /numbers/:id ──────────────────────────────────────────────────────

// Both fields are optional and independent, so a payload may carry either one
// alone. `call_flow_id` was previously REQUIRED here, which is the whole reason
// the forward destination could not be changed without also restating the flow.
export const updateNumberSchema = z
  .object({
    call_flow_id: z.string().uuid('call_flow_id must be a valid id').nullable().optional(),
    // Where calls to this number ring. Editable because it IS the routing: a
    // tech changes phone, or the number moves to someone else, and there is no
    // other way to follow that.
    forward_to_e164: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .refine((v) => normalizeNAPhone(v) !== null, {
        message: 'forward_to_e164 must be a North-American phone number (e.g. +12015551234)',
      })
      .optional(),
  })
  .refine((b) => b.call_flow_id !== undefined || b.forward_to_e164 !== undefined, {
    message: 'Provide call_flow_id and/or forward_to_e164',
  });

export async function updateNumber(req: Request, res: Response) {
  try {
    const row = await prisma.phoneNumber.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      select: { id: true, e164: true, source: true, ctm_number_id: true, route_to: true },
    });
    if (!row) {
      res.status(404).json({ error: 'Number not found' });
      return;
    }

    if (req.body.call_flow_id != null) {
      const flow = await prisma.callFlow.findFirst({
        where: { id: req.body.call_flow_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!flow) {
        res.status(404).json({ error: 'Call flow not found' });
        return;
      }
    }

    // Re-route BEFORE the DB write, and fail the request if the phone system
    // refuses. This is deliberately the opposite of buyNumber's warn-and-carry-on
    // policy: there the money is already spent so the row must survive, whereas
    // here a silent failure would leave the owner believing calls now reach a
    // new phone while they keep ringing the old one.
    let routeTo: { forward_to: string } | null = null;
    if (req.body.forward_to_e164 !== undefined) {
      if (!row.ctm_number_id) {
        res.status(400).json({
          error: 'This number is not managed by the phone system, so its routing cannot be changed',
        });
        return;
      }
      const accountId = await requireCtmAccount(req, res);
      if (!accountId) return;

      const forwardTo = normalizeNAPhone(String(req.body.forward_to_e164))!;
      try {
        // Same two steps as buy, in the same order: the phone system will not
        // dial a destination it has not been told about.
        try {
          await createReceivingNumber(accountId, forwardTo);
        } catch (err) {
          const alreadyExists =
            err instanceof CtmApiError && /already|exist|duplicate|taken/i.test(err.reason);
          if (!alreadyExists) throw err;
        }
        await updateNumberRouting(accountId, row.ctm_number_id, {
          dial_route: 'forward',
          numbers: [forwardTo],
        });
      } catch (err) {
        const reason = err instanceof CtmApiError ? err.reason : 'request failed';
        logger.error(`[ctm] re-routing number ${row.e164} failed: ${reason}`);
        res.status(502).json({
          error: 'The phone system rejected the change - this number still rings its old destination',
        });
        return;
      }
      routeTo = { forward_to: forwardTo };
    }

    const updated = await prisma.phoneNumber.update({
      where: { id: row.id },
      data: {
        ...(req.body.call_flow_id !== undefined && { call_flow_id: req.body.call_flow_id }),
        ...(routeTo && { route_to: routeTo }),
      },
    });

    // Where a customer's calls go is worth an audit row of its own; a flow
    // relabel is not.
    if (routeTo) {
      void logAudit({
        req,
        action: 'number.forwarding_updated',
        resourceType: 'PhoneNumber',
        resourceId: row.id,
        metadata: {
          e164: row.e164,
          previous_forward_to: forwardToOf(row.route_to),
          forward_to: routeTo.forward_to,
        },
      });
    }

    res.json({ number: mapNumber(updated) });
  } catch (err) {
    logger.error('Failed to update phone number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── DELETE /numbers/:id ─────────────────────────────────────────────────────

/**
 * Give a number back and stop its recurring charge (SRVW-240).
 *
 * There was previously no way out at all: buy was a one-way door, so a customer
 * could start a recurring charge from the UI and had no way to stop it.
 *
 * The row is marked released, never deleted. Calls and messages reference the
 * number, and someone reviewing last month's calls should still see which
 * number took them. Releasing also strips the number of every caller-ID role,
 * since a released number is unreachable and presenting it on an outbound call
 * would be worse than presenting nothing.
 *
 * IRREVERSIBLE at the provider - the number goes back to the carrier pool - so
 * the UI confirms before calling this.
 */
export async function releaseNumberById(req: Request, res: Response) {
  try {
    const row = await prisma.phoneNumber.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      select: { id: true, e164: true, source: true, ctm_number_id: true, status: true },
    });
    if (!row) {
      res.status(404).json({ error: 'Number not found' });
      return;
    }

    // Release at the provider FIRST: reporting a release that did not happen
    // would leave the customer believing they had stopped paying for it.
    // A bring-your-own number has nothing to hand back, and an already-released
    // one is done - both skip straight to the local write, which is what makes
    // this safe to press twice.
    if (row.ctm_number_id && row.status !== 'released') {
      const accountId = await requireCtmAccount(req, res);
      if (!accountId) return;
      try {
        await releaseNumber(accountId, row.ctm_number_id);
      } catch (err) {
        // A number the provider does not have is a number that is no longer
        // billing anyone, which is the whole point of the request.
        const alreadyGone = err instanceof CtmApiError && err.httpStatus === 404;
        if (!alreadyGone) {
          const reason = err instanceof CtmApiError ? err.reason : 'request failed';
          logger.error(`[ctm] releasing number ${row.e164} failed: ${reason}`);
          res.status(502).json({
            error: 'The phone system could not release this number - it is still active',
          });
          return;
        }
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      // A released number can no longer be anyone's caller ID.
      await tx.userPhoneNumber.deleteMany({ where: { phone_number_id: row.id } });
      return tx.phoneNumber.update({
        where: { id: row.id },
        data: { status: 'released', is_org_default: false, sms_enabled: false },
      });
    });

    void logAudit({
      req,
      action: 'number.released',
      resourceType: 'PhoneNumber',
      resourceId: row.id,
      metadata: { e164: row.e164, ctm_number_id: row.ctm_number_id, source: row.source },
    });

    res.json({ number: mapNumber(updated) });
  } catch (err) {
    logger.error('Failed to release phone number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /numbers/refresh ───────────────────────────────────────────────────

/**
 * Re-read the account's numbers and make the local list match.
 *
 * The admin's manual Sync button. The work is the shared number sync (the
 * same routine connect runs), so the two can no longer drift apart: it adds
 * missing numbers, switches texting on where it is off, names unnamed numbers
 * and records the audit entry.
 */
export async function refreshNumbers(req: Request, res: Response) {
  try {
    const accountId = await requireCtmAccount(req, res);
    if (!accountId) return;

    const result = await syncNumbers({
      orgId: req.user!.organization_id,
      accountId,
      trigger: 'manual',
      req,
    });

    res.json({
      synced: result.read,
      added: result.added.length,
      texting_enabled: result.textingEnabled.length,
      texting_failed: result.textingFailed.length,
      numbers: result.numbers.map(mapNumber),
    });
  } catch (err) {
    logger.error('Failed to refresh phone numbers:', err);
    if (err instanceof CtmApiError) {
      // Never fall through to "the account has no numbers" - an empty list
      // here would read as "nothing is billing you".
      res.status(502).json({ error: 'The phone system request failed' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── POST /numbers/register-byo ──────────────────────────────────────────────

export const registerByoSchema = z.object({
  e164: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'e164 must be E.164 (e.g. +12015551234)'),
  label: z.string().trim().min(1).max(200).optional(),
});

/** Register a bring-your-own number (v1.1 UI; backend-only for now). Pure DB
 *  row — no CTM calls; SMS stays off until the number is CTM-tracked. */
export async function registerByoNumber(req: Request, res: Response) {
  try {
    const row = await prisma.phoneNumber.create({
      data: {
        e164: req.body.e164,
        label: req.body.label ?? null,
        source: 'byo',
        sms_enabled: false,
        status: 'active',
        organization_id: req.user!.organization_id,
      },
    });
    res.status(201).json({ number: mapNumber(row) });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'This number is already registered' });
      return;
    }
    logger.error('Failed to register BYO number:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
