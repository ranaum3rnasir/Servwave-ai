import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { logAudit } from '../lib/audit';
import {
  isCtmConfigured,
  listAccounts,
  createAccount,
  listWebhooks,
  createWebhook,
  deleteWebhook,
  getA2pStatus,
  CtmApiError,
} from '../lib/ctm/client';
import { stopRunningSync, syncNumbers } from '../lib/ctm/numberSync';
import { textingNotSwitchedOn } from '../lib/ctm/userCopy';

/**
 * CTM connect / disconnect / A2P-check for the requesting user's own org.
 * Routes are gated canDo('update','Organization') — the repo's ADMIN-only
 * idiom (organization.routes.ts precedent; DISPATCHER/SALES lack the grant).
 */

// Positions provisioned at connect (see master plan §1 + v3.1 addendum §A.3 -
// `starts` covers both directions; the alias handling lives in the webhook
// controller).
//
// `outbound_text` is deliberately ABSENT. It was provisioned here from the
// start and, measured live 2026-08-01, was registered on both connected CTM
// accounts (500001 hook 274748, 500002 hook 274595 - `disabled: false`, no
// conditions) and had fired ZERO times in 21 days. Every outbound text arrived
// on `status_change` instead, as a full `direction: msg_outbound` activity.
// CTM stores a position string it does not recognize rather than rejecting it
// (same silent-acceptance behavior as the `type=tollfree` search param, PR
// #1140), so provisioning this only advertised coverage that never existed.
// The webhook controller still ACCEPTS the position, so nothing breaks if CTM
// ever starts firing it.
//
// A hook carries TWO independent names, and they are not always the same
// string: `ctmPosition` is validated against CTM's own trigger list, while
// `path` is the segment our route dispatches on (ctm-webhook.controller's
// isKnownPosition). Probed live against account 500001 on 2026-08-05, CTM
// REJECTS `starts` outright - HTTP 406, {"position":["is not included in the
// list"]} - and accepts `start`. So no org has ever had a call-start hook: the
// connect logged one warning and moved on. Sending `start` while keeping the
// `starts` path fixes the provision without touching the ingest side, which is
// already written and tested for `starts`.
const POSITIONS_TO_PROVISION: ReadonlyArray<{ ctmPosition: string; path: string }> = [
  { ctmPosition: 'start', path: 'starts' },
  { ctmPosition: 'end', path: 'end' },
  { ctmPosition: 'inbound_text', path: 'inbound_text' },
  { ctmPosition: 'status_change', path: 'status_change' },
];

// Validation copy for connect. A screen shows a failed validation through
// extractApiError, which prints `field: message` whenever the issue has a
// field, so every problem is reported on the body as a whole (no field) in
// words that name neither the request's fields nor the phone vendor.
const MAX_NAME = 200;
const MAX_ACCOUNT_ID = 40;
const CHOOSE_ACCOUNT = 'Choose an existing phone account or create a new one.';
const NAME_NEW_ACCOUNT = 'Enter a name for the new phone account.';
const NAME_TOO_LONG = `Keep the new phone account name to ${MAX_NAME} characters or fewer.`;
const UNKNOWN_ACCOUNT = 'That phone account was not found.';

// Connect warnings reach an admin in the response body, so they are plain
// words: no vendor name, no env var, no provider outcome code. The raw detail
// goes to the server log instead.
const HOOKS_NOT_SET_UP = 'Live call and text updates are not set up yet. Contact ServWave support.';
const HOOKS_PARTLY_SET_UP =
  'Some live call and text updates could not be set up. Contact ServWave support.';
const TEXTING_CHECK_FAILED =
  'Texting approval could not be checked. Texting stays off until the check succeeds.';

/** Trimmed text, undefined when absent or blank, null when not text at all. */
function textValue(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  return value.trim() || undefined;
}

/** Exactly one of: an existing account id (at most MAX_ACCOUNT_ID
 *  characters), or `createNew: true` with a name (at most MAX_NAME
 *  characters). Parses to the trimmed values. A body that is not an object at
 *  all (a list, JSON null, a bare string) gets the same plain copy as a
 *  missing choice, never Zod's "Expected object, received array".
 *
 *  The browser sends the account as `account_id`. TODO(phone-api-neutral-names):
 *  the old `ctm_account_id` request key is still accepted for one release
 *  (support scripts, an old bundle); a body naming two different accounts is
 *  refused. The parsed output keeps the internal `ctm_account_id` key, which
 *  never leaves the server. */
export const connectCtmSchema = z
  .object(
    { account_id: z.unknown(), ctm_account_id: z.unknown(), createNew: z.unknown(), name: z.unknown() },
    { errorMap: () => ({ message: CHOOSE_ACCOUNT }) },
  )
  .transform((b, ctx) => {
    const fail = (message: string) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      return z.NEVER;
    };
    if (b.createNew !== undefined && typeof b.createNew !== 'boolean') return fail(CHOOSE_ACCOUNT);
    const createNew = b.createNew === true;
    const neutralId = textValue(b.account_id);
    const legacyId = textValue(b.ctm_account_id);
    if (neutralId !== undefined && legacyId !== undefined && neutralId !== legacyId) return fail(CHOOSE_ACCOUNT);
    const accountId = neutralId !== undefined ? neutralId : legacyId;
    if (accountId === null || !!accountId === createNew) return fail(CHOOSE_ACCOUNT);
    if (createNew) {
      const name = textValue(b.name);
      if (!name) return fail(NAME_NEW_ACCOUNT);
      if (name.length > MAX_NAME) return fail(NAME_TOO_LONG);
      return { createNew: true as const, name };
    }
    if (accountId!.length > MAX_ACCOUNT_ID) return fail(UNKNOWN_ACCOUNT);
    return { ctm_account_id: accountId! };
  });

function webhookBaseUrl(): string | null {
  if (!env.BACKEND_PUBLIC_URL || !env.CTM_WEBHOOK_TOKEN) return null;
  return env.BACKEND_PUBLIC_URL.replace(/\/+$/, '');
}

function weburlFor(path: string): string | null {
  const base = webhookBaseUrl();
  if (!base) return null;
  return `${base}/api/webhooks/ctm/${path}?token=${env.CTM_WEBHOOK_TOKEN}`;
}

/** Idempotent: re-running connect never duplicates hooks (diff by weburl). */
async function provisionWebhooks(accountId: string, warnings: string[]): Promise<string[]> {
  const base = webhookBaseUrl();
  if (!base) {
    warnings.push(HOOKS_NOT_SET_UP);
    logger.warn(
      '[ctm-connect] webhooks not provisioned: BACKEND_PUBLIC_URL and/or CTM_WEBHOOK_TOKEN are not set',
    );
    return [];
  }
  const existing = await listWebhooks(accountId);
  const existingUrls = new Set(existing.map((h) => String(h.weburl ?? h.url ?? '')));
  const provisioned: string[] = [];
  let anyRefused = false;
  for (const { ctmPosition, path } of POSITIONS_TO_PROVISION) {
    const weburl = weburlFor(path)!;
    if (existingUrls.has(weburl)) {
      provisioned.push(ctmPosition);
      continue;
    }
    try {
      await createWebhook(accountId, {
        name: `servwave-${ctmPosition}`,
        weburl,
        position: ctmPosition,
        username: 'servwave',
        password: env.CTM_WEBHOOK_TOKEN!,
      });
      provisioned.push(ctmPosition);
    } catch (err) {
      // A position CTM rejects is survivable — a partial provision still leaves
      // the other hooks live (and the backfill covers gaps), so surface it
      // instead of failing the whole connect.
      const reason = err instanceof CtmApiError ? err.reason : 'request failed';
      anyRefused = true;
      logger.warn(`[ctm-connect] provisioning '${ctmPosition}' failed: ${reason}`);
    }
  }
  if (anyRefused) warnings.push(HOOKS_PARTLY_SET_UP);
  return provisioned;
}

function a2pApproved(status: Record<string, unknown>): boolean {
  const campaigns = Array.isArray(status.a2p_campaigns)
    ? status.a2p_campaigns
    : Array.isArray(status.campaigns)
      ? status.campaigns
      : Array.isArray(status)
        ? (status as unknown[])
        : [];
  return campaigns.some((c) =>
    String((c as Record<string, unknown>)?.status ?? '').toLowerCase().includes('approv'),
  );
}

export async function connectCtm(req: Request, res: Response) {
  try {
    if (!isCtmConfigured()) {
      res.status(503).json({ error: 'The phone system is not configured — contact support' });
      return;
    }
    const orgId = req.user!.organization_id;
    const warnings: string[] = [];

    let accountId: string;
    if (req.body.createNew) {
      const created = await createAccount(String(req.body.name));
      const newId = (created.id ?? (created.account as Record<string, unknown> | undefined)?.id) as
        | string
        | number
        | undefined;
      if (newId === undefined || newId === null) {
        res
          .status(502)
          .json({ error: 'The phone system did not return an account id for the new account' });
        return;
      }
      accountId = String(newId);
    } else {
      accountId = String(req.body.ctm_account_id);
      // Reachability = claim validation: the id must be one of OUR agency's
      // sub-accounts (a random/foreign id must not be connectable).
      const accounts = await listAccounts();
      const reachable = accounts.some((a) => String(a.id ?? a.account_id ?? '') === accountId);
      if (!reachable) {
        res.status(422).json({ error: UNKNOWN_ACCOUNT });
        return;
      }
    }

    try {
      await prisma.organization.update({
        where: { id: orgId },
        data: { ctm_account_id: accountId },
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        // Unique(ctm_account_id) — another org already claimed this account.
        res
          .status(409)
          .json({ error: 'That account is already connected to another organization' });
        return;
      }
      throw err;
    }

    // The same number sync the Sync button runs: every page of numbers,
    // texting switched on where it is off, names filled, one audit entry.
    const sync = await syncNumbers({ orgId, accountId, trigger: 'connect', req });
    for (const { e164, outcome } of sync.textingFailed) {
      warnings.push(textingNotSwitchedOn(e164));
      logger.warn(`[ctm-connect] enable_sms for ${e164} returned ${outcome}`);
    }
    const numbersImported = sync.read;
    const webhooksProvisioned = await provisionWebhooks(accountId, warnings);

    let smsReady = false;
    try {
      smsReady = a2pApproved(await getA2pStatus(accountId));
    } catch (err) {
      warnings.push(TEXTING_CHECK_FAILED);
      logger.warn('[ctm-connect] A2P status check failed:', err);
    }
    await prisma.organization.update({ where: { id: orgId }, data: { ctm_sms_ready: smsReady } });

    void logAudit({
      req,
      action: 'ctm.connected',
      resourceType: 'Organization',
      resourceId: orgId,
      metadata: { ctm_account_id: accountId, numbersImported, webhooksProvisioned },
    });

    // The account id stays out of this body (Ran: "the account ID cannot be
    // exposed"); the audit entry above is where it is recorded.
    res.json({
      connected: true,
      numbers_imported: numbersImported,
      webhooks_provisioned: webhooksProvisioned,
      sms_ready: smsReady,
      // Manual per-org onboarding steps (owner-executed — Ran's 2026-07-09
      // decision): consent greeting + retention are set upstream by ServWave,
      // not here. Surfaced to org admins, so they point at ServWave support and
      // never at (or hint at) the provider behind the phone service.
      manual_steps: [
        'Contact ServWave support to set the recording-consent greeting and retention policy.',
        'Verify recording toggles (inbound/outbound) match the org’s policy.',
      ],
      warnings,
    });
  } catch (err) {
    logger.error('Failed to connect CTM:', err);
    if (err instanceof CtmApiError) {
      res.status(502).json({ error: 'The phone system request failed' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function checkCtmA2p(req: Request, res: Response) {
  try {
    if (!isCtmConfigured()) {
      res.status(503).json({ error: 'The phone system is not configured — contact support' });
      return;
    }
    const orgId = req.user!.organization_id;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { ctm_account_id: true },
    });
    if (!org?.ctm_account_id) {
      res.status(409).json({ error: 'Organization is not connected to a phone system' });
      return;
    }
    const smsReady = a2pApproved(await getA2pStatus(org.ctm_account_id));
    await prisma.organization.update({ where: { id: orgId }, data: { ctm_sms_ready: smsReady } });
    res.json({ sms_ready: smsReady });
  } catch (err) {
    logger.error('Failed to check CTM A2P status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function disconnectCtm(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { ctm_account_id: true },
    });
    if (!org?.ctm_account_id) {
      res.status(409).json({ error: 'Organization is not connected to a phone system' });
      return;
    }

    // Delete only OUR hooks (weburl on our backend origin); the org's own
    // CTM config is never touched. Invisible-rollback guarantee (plan §7).
    const base = webhookBaseUrl();
    if (isCtmConfigured() && base) {
      try {
        const hooks = await listWebhooks(org.ctm_account_id);
        for (const hook of hooks) {
          const url = String(hook.weburl ?? hook.url ?? '');
          const hookId = hook.id;
          if (url.startsWith(base) && hookId !== undefined && hookId !== null) {
            await deleteWebhook(org.ctm_account_id, String(hookId));
          }
        }
      } catch (err) {
        logger.warn('CTM webhook cleanup during disconnect failed (continuing):', err);
      }
    }

    // A number sync may be running (a screen opened, a call on a new number).
    // Stop it and let a write already in flight land first, so it cannot put
    // the numbers back to active after they are marked inactive below. Bounded
    // (STOP_SYNC_WAIT_MS, 20s) so a hung provider call cannot hang this
    // request; a run still going after that stores nothing more, because it
    // checks the stop flag before every write and re-reads the org's account
    // after reading the list.
    await stopRunningSync(orgId);

    await prisma.organization.update({
      where: { id: orgId },
      data: { ctm_account_id: null, ctm_sms_ready: false },
    });

    // CTM-sourced numbers are unusable once the account is detached — leaving
    // them 'active' would let sendSms/click-to-call pick a dead TPN (both
    // resolve the from-number with status:'active'). A future re-connect's
    // number sync reactivates every number the account reports as active.
    await prisma.phoneNumber.updateMany({
      where: { organization_id: orgId, source: 'ctm' },
      data: { status: 'inactive' },
    });

    void logAudit({
      req,
      action: 'ctm.disconnected',
      resourceType: 'Organization',
      resourceId: orgId,
      metadata: { ctm_account_id: org.ctm_account_id },
    });

    res.json({ connected: false });
  } catch (err) {
    logger.error('Failed to disconnect CTM:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
