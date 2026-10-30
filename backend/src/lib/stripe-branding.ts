import { prisma } from './prisma';
import { logger } from './logger';
import { env } from '../config/env';
import { updateAccountBranding, type AccountBranding } from './stripe';

/**
 * Payments go-live slice 36 (PRD Module 1): the contractor's colour and logo are pushed to the
 * connected account's branding settings, which is where the hosted checkout reads them. Only
 * settings.branding is written: on a processor-controlled account the platform may not write the
 * business profile (the name), and one refused parameter fails the whole update.
 *
 * Called after an org save that touched the colour, after a logo upload (the new bytes are
 * handed in), and once when onboarding finishes (`logo: 'stored'` reads the saved logo back).
 * It reads the org's current values, so a burst of saves ends on the last one. It never throws:
 * a processor failure is logged, and the save that triggered it has already succeeded.
 */
export async function syncOrgBranding(
  orgId: string,
  opts: { logo?: { data: Buffer; mime: string } | 'stored' } = {},
): Promise<void> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { brand_color: true, logo_url: true, stripe_account_id: true },
    });
    if (!org?.stripe_account_id) return;
    const branding: AccountBranding = {
      ...(org.brand_color ? { primaryColor: org.brand_color } : {}),
    };
    const logo = opts.logo === 'stored' ? await fetchStoredLogo(org.logo_url) : opts.logo;
    if (logo) branding.logo = logo;
    await updateAccountBranding(org.stripe_account_id, branding);
  } catch (err) {
    logger.error(`[branding-sync] could not update the payout account branding for org ${orgId}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const LOGO_MIMES = ['image/png', 'image/jpeg'];
/** Slice 33b: a logo larger than this is not read (the processor's own limit is 512 KB). */
const LOGO_MAX_BYTES = 4 * 1024 * 1024;
/** Where the app's own storage serves public files. */
const STORAGE_PUBLIC_PREFIX = '/storage/v1/object/public/';

/** True only for a URL on the app's own storage host, under its public prefix. */
function isOwnStorageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const own = new URL(env.SUPABASE_URL);
    return parsed.protocol === own.protocol
      && parsed.host === own.host
      && !parsed.username && !parsed.password
      && parsed.pathname.startsWith(STORAGE_PUBLIC_PREFIX)
      && !parsed.pathname.split('/').includes('..');
  } catch {
    return false;
  }
}

/**
 * Slice 33b: safe by construction. Only the app's own storage is fetched, a redirect is refused
 * (never followed), and the body is read up to a cap, so a stored value that was ever wrong cannot
 * point this server at an internal address or make it hold an unbounded download.
 */
async function fetchStoredLogo(url: string | null): Promise<{ data: Buffer; mime: string } | undefined> {
  if (!url || !isOwnStorageUrl(url)) return undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!res.ok || !LOGO_MIMES.includes(mime)) return undefined;
    const announced = Number(res.headers.get('content-length') ?? 0);
    if (announced > LOGO_MAX_BYTES || !res.body) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LOGO_MAX_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    return { data: Buffer.concat(chunks), mime };
  } catch {
    return undefined; // the colour still goes
  }
}
