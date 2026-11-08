import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { isCtmConfigured, requestPhoneAccess, type PhoneAccessResult } from '../lib/ctm/client';

/**
 * POST /api/communication/phone-access
 *
 * Mint a short-lived CTM softphone access token for the logged-in agent so the
 * embedded WebRTC device can authenticate WITHOUT the agency Access/Secret keys
 * ever reaching the browser. The token is keyed to the user's email (→ their CTM
 * agent); `session_id` is the user's id.
 *
 * `authenticate` (401) + `requireFeature('phone')` (402) run as route
 * middleware, so this controller only guards the CTM connection (409
 * PHONE_NOT_CONNECTED when the platform or org isn't wired to CTM) and translates
 * an upstream CTM failure into a typed 502 PHONE_TOKEN_FAILED. No DB writes. The
 * codes are ServWave's own words, never the vendor's (CLAUDE.md boundary).
 */
export async function createPhoneAccessToken(req: Request, res: Response) {
  try {
    // Platform keys absent → a token can't be minted. Skip the org read.
    if (!isCtmConfigured()) {
      res.status(409).json({ error: 'Phone system is not connected', code: 'PHONE_NOT_CONNECTED' });
      return;
    }

    const org = await prisma.organization.findUnique({
      where: { id: req.user!.organization_id },
      select: { ctm_account_id: true },
    });
    if (!org?.ctm_account_id) {
      res.status(409).json({ error: 'Phone system is not connected', code: 'PHONE_NOT_CONNECTED' });
      return;
    }

    let result: PhoneAccessResult;
    try {
      result = await requestPhoneAccess(org.ctm_account_id, {
        email: req.user!.email,
        first_name: req.user!.first_name,
        last_name: req.user!.last_name,
        session_id: req.user!.id,
      });
    } catch (err) {
      // Any failure here is upstream (CTM) — a typed 502, never a leak of the
      // request/creds. client.ts keeps CtmApiError.reason safe to log.
      logger.warn('[ctm] phone-access token request failed:', err);
      res.status(502).json({
        error: 'The phone system could not issue an access token',
        code: 'PHONE_TOKEN_FAILED',
      });
      return;
    }

    // Proxy the FULL phone_access payload back: the embed's `accessToken` setter
    // binds the WebRTC device to the account using account_id / user.account from
    // this object — narrowing it to { token } leaves the device unauthenticated.
    // The response is browser-bound by design; the agency Access/Secret keys live
    // only in OUR request header (client.ts), never in this body. `sessionId` is
    // added in camelCase alongside CTM's fields per the embed's convention.
    //
    // `email` is REQUIRED for the same reason, and its absence is what left the
    // softphone stuck on "Connecting..." (live, account 500002, 2026-08-06).
    // The shipped device_embed builds the WebRTC iframe URL straight off this
    // body:
    //   accessGranted(e){ const s=e.token, t=e.sessionId, i=e.email;
    //     iframe.src = `.../embed_device?token=${s}&session=${t}&email=${i}` }
    // and the phone control reads the same two keys off its `ctm:access`
    // message. CTM's own phone_access response carries only
    // {status, token, valid_until}, so anything the device reads must be added
    // here - otherwise the URL is built with the literal string "undefined",
    // the device never registers, and nothing errors anywhere.
    res.json({
      ...result,
      sessionId: result.session_id ?? req.user!.id,
      email: req.user!.email,
    });
  } catch (err) {
    logger.error('Failed to mint phone access token:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
