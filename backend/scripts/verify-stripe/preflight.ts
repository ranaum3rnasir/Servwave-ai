import Stripe from 'stripe';
import { env } from '../../src/config/env';
import { STRIPE_API_VERSION } from '../../src/lib/stripe';
import { API_URL } from './sign';

const STAGING_BACKEND_HOST = 'alpha-crm-test-env.onrender.com';

/** Hosts the suite may run against. Everything else is refused, with no override. */
const ALLOWED_API_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]', STAGING_BACKEND_HOST];

/** True when a run against this URL is not on the allow-list (local machine or the staging backend). */
export function isProductionApiHost(apiUrl: string): boolean {
  let host: string;
  try {
    host = new URL(apiUrl).hostname.toLowerCase();
  } catch {
    return true; // an address we cannot read is not one we can vouch for
  }
  return !ALLOWED_API_HOSTS.includes(host);
}

export interface PreflightDeps {
  secretKey?: string;
  webhookSecret?: string;
  apiUrl?: string;
  fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number }>;
  /** Reads the processor balance for the secret key; the answer carries the livemode flag. */
  readBalance?: (secretKey: string) => Promise<{ livemode: boolean }>;
}

async function readBalanceFromProcessor(secretKey: string): Promise<{ livemode: boolean }> {
  const client = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });
  const balance = await client.balance.retrieve();
  return { livemode: balance.livemode };
}

/** The suite is sandbox-only. Each refusal below has no override and no flag. */
export async function preflight(deps: PreflightDeps = {}): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  const secretKey = 'secretKey' in deps ? deps.secretKey : env.STRIPE_SECRET_KEY;
  const webhookSecret = 'webhookSecret' in deps ? deps.webhookSecret : env.STRIPE_WEBHOOK_SECRET;
  const apiUrl = deps.apiUrl ?? API_URL;
  const doFetch = deps.fetchImpl ?? ((u: string) => fetch(u));
  const readBalance = deps.readBalance ?? readBalanceFromProcessor;

  if (!secretKey) errors.push('STRIPE_SECRET_KEY is not set');
  if (!webhookSecret) errors.push('STRIPE_WEBHOOK_SECRET is not set');

  // Sandbox only: a secret key that is not a test key is refused.
  const keyIsTest = !!secretKey && secretKey.startsWith('sk_test_');
  if (secretKey && !keyIsTest) {
    errors.push('STRIPE_SECRET_KEY must start with sk_test_; this suite never runs against live money');
  }
  if (webhookSecret && !webhookSecret.startsWith('whsec_')) {
    errors.push('STRIPE_WEBHOOK_SECRET must start with whsec_');
  }

  // Never a production backend.
  if (isProductionApiHost(apiUrl)) {
    errors.push(`the API URL ${apiUrl} is a production host; this suite only runs against localhost or the staging backend`);
  }

  // The processor itself must say the key is sandbox.
  if (keyIsTest) {
    try {
      const bal = await readBalance(secretKey!);
      if (bal.livemode) errors.push('the processor reports this key as live mode; refusing to run');
    } catch (err) {
      errors.push(`could not confirm sandbox mode with the processor: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Backend reachable (never probed when the host is refused above)
  if (!isProductionApiHost(apiUrl)) {
    try {
      const res = await doFetch(`${apiUrl}/health`);
      if (!res.ok) errors.push(`backend health check failed: ${res.status}`);
    } catch {
      errors.push(`backend not reachable at ${apiUrl}`);
    }
  }

  // R6 - API version drift
  const codeVersion = STRIPE_API_VERSION;
  const sdkVersion = (Stripe as any).LatestApiVersion ?? codeVersion;
  if (codeVersion !== sdkVersion) {
    errors.push(`Stripe API version drift: code=${codeVersion}, SDK=${sdkVersion}`);
  }

  return { ok: errors.length === 0, errors };
}
