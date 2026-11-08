#!/usr/bin/env npx tsx
/**
 * Create (or rotate) an org's website-form integration row and print the webhook
 * URL to hand to whoever manages the site.
 *
 * Usage:
 *   npx tsx backend/scripts/web-form-integration.ts \
 *     --org <organization uuid> --provider forminator [--base-url https://api.servwave.com]
 *
 *   --disable  flips `enabled` off for the (org, provider) pair; --enable back on.
 *   --rotate   mints a new URL token (the old URL stops working immediately).
 *   --show     prints the current row without changing anything.
 *   --source   sets default_lead_source (what the source falls back to when the
 *              payload names no campaign).
 *
 * THE URL IS THE CREDENTIAL. This vendor authenticates nothing - no secret, no
 * HMAC, no bearer, no custom header - so anyone holding the URL can post leads
 * into the org. Send it the way you would send a key, and --rotate if it leaks.
 * Never paste it into an issue or a commit.
 *
 * The receiver must be live and answering 200 BEFORE the site is configured:
 * saving the connection fires a test POST, and a non-2xx blocks the save.
 *
 * `backend/.env` points at STAGING: run with DATABASE_URL set to the target
 * environment explicitly (backfill scripts have no prod path locally).
 */
import crypto from 'crypto';
import { prisma } from '../src/lib/prisma';
import { runUnscoped } from '../src/lib/tenant-context';
import { isWebFormProvider } from '../src/lib/web-form/adapters';

const args = process.argv.slice(2);
const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const has = (f: string) => args.includes(f);

function mintToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function main() {
  const orgId = arg('--org');
  const provider = arg('--provider') ?? '';
  const defaultSource = arg('--source');
  const baseUrl = (arg('--base-url') ?? 'https://api.servwave.com').replace(/\/+$/, '');

  if (!orgId || !isWebFormProvider(provider)) {
    console.error('Required: --org <uuid> --provider forminator [--source "..."] [--rotate|--enable|--disable|--show]');
    process.exit(1);
  }

  await runUnscoped(async () => {
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org) {
      console.error(`No organization with id ${orgId}`);
      process.exit(1);
    }

    const existing = await prisma.webFormIntegration.findUnique({
      where: { organization_id_provider: { organization_id: orgId, provider } },
    });

    if (has('--show')) {
      if (!existing) {
        console.error(`No web-form integration for organization ${orgId} / provider ${provider}`);
        process.exit(1);
      }
      report(existing, baseUrl);
      return;
    }

    const token = existing && !has('--rotate') ? existing.url_token : mintToken();
    const enabled = has('--disable') ? false : has('--enable') ? true : existing?.enabled ?? true;

    const row = await prisma.webFormIntegration.upsert({
      where: { organization_id_provider: { organization_id: orgId, provider } },
      create: {
        organization_id: orgId,
        provider,
        url_token: token,
        enabled,
        default_lead_source: defaultSource ?? null,
      },
      update: {
        url_token: token,
        enabled,
        ...(defaultSource !== undefined ? { default_lead_source: defaultSource } : {}),
      },
      select: {
        provider: true,
        url_token: true,
        enabled: true,
        default_lead_source: true,
        last_event_at: true,
        organization_id: true,
      },
    });

    report(row, baseUrl);
  });
}

function report(
  row: {
    organization_id: string;
    provider: string;
    url_token: string;
    enabled: boolean;
    default_lead_source: string | null;
    last_event_at: Date | null;
  },
  baseUrl: string,
): void {
  console.log(`Organization:  ${row.organization_id}`);
  console.log(`Provider:      ${row.provider}`);
  console.log(`Enabled:       ${row.enabled}`);
  console.log(`Default source:${row.default_lead_source ? ` ${row.default_lead_source}` : ' none'}`);
  console.log(`Last event:    ${row.last_event_at ? row.last_event_at.toISOString() : 'never'}`);
  console.log('');
  console.log(`Webhook URL:   ${baseUrl}/api/webhooks/web-form/${row.provider}/${row.url_token}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
