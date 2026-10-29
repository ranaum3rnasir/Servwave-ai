#!/usr/bin/env npx tsx
/**
 * Create (or rotate) an org's external call-tracking integration row and print
 * the webhook URLs to hand to whoever manages the vendor account.
 *
 * Usage:
 *   npx tsx backend/scripts/call-tracking-integration.ts \
 *     --org <organization uuid> --provider callrail \
 *     --signing-key "<company signing key>" [--base-url https://api.servwave.com]
 *
 *   --provider whatconverts needs no --signing-key (that vendor signs nothing).
 *   --disable  flips `enabled` off for the (org, provider) pair; --enable back on.
 *   --rotate   mints a new URL token (the old URL stops working immediately).
 *
 * The signing key is read from the flag only. It is never logged; the printed
 * output holds the URL alone. Never paste a key into a thread, an issue, or a
 * commit. `backend/.env` points at STAGING: run with DATABASE_URL set to the
 * target environment explicitly (backfill scripts have no prod path locally).
 */
import crypto from 'crypto';
import { prisma } from '../src/lib/prisma';
import { runUnscoped } from '../src/lib/tenant-context';
import { isCallTrackingProvider } from '../src/lib/call-tracking/adapters';

const args = process.argv.slice(2);
const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const has = (f: string) => args.includes(f);

function mintToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function main() {
  const orgId = arg('--org');
  const provider = arg('--provider') ?? '';
  const signingKey = arg('--signing-key');
  const baseUrl = (arg('--base-url') ?? 'https://api.servwave.com').replace(/\/+$/, '');

  if (!orgId || !isCallTrackingProvider(provider)) {
    console.error('Required: --org <uuid> --provider callrail|whatconverts [--signing-key ...]');
    process.exit(1);
  }
  if (provider === 'callrail' && !signingKey && !has('--disable') && !has('--enable') && !has('--rotate')) {
    console.error('--signing-key is mandatory for callrail: the receiver rejects every event on a row without one');
    process.exit(1);
  }

  await runUnscoped(async () => {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) {
      console.error(`No organization with id ${orgId}`);
      process.exit(1);
    }

    const existing = await prisma.callTrackingIntegration.findUnique({
      where: { organization_id_provider: { organization_id: orgId, provider } },
    });

    const token = existing && !has('--rotate') ? existing.url_token : mintToken();
    const enabled = has('--disable') ? false : has('--enable') ? true : existing?.enabled ?? true;

    const row = await prisma.callTrackingIntegration.upsert({
      where: { organization_id_provider: { organization_id: orgId, provider } },
      create: { organization_id: orgId, provider, url_token: token, signing_key: signingKey ?? null, enabled },
      update: {
        url_token: token,
        enabled,
        ...(signingKey ? { signing_key: signingKey } : {}),
      },
      select: { id: true, provider: true, url_token: true, enabled: true, signing_key: true, last_event_at: true },
    });

    const base = `${baseUrl}/api/webhooks/call-tracking/${row.provider}/${row.url_token}`;
    console.log(`Organization: ${org.id}`);
    console.log(`Provider:     ${row.provider}`);
    console.log(`Enabled:      ${row.enabled}`);
    console.log(`Signing key:  ${row.signing_key ? 'set' : 'none'}`);
    console.log(`Last event:   ${row.last_event_at ? row.last_event_at.toISOString() : 'never'}`);
    console.log('');
    if (row.provider === 'callrail') {
      console.log(`Pre-Call webhook URL:   ${base}/pre`);
      console.log(`Post-Call webhook URL:  ${base}/post`);
    } else {
      console.log(`Webhook URL:  ${base}`);
    }
  });
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
