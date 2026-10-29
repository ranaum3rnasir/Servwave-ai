import Stripe from 'stripe';
import { env } from '../../src/config/env';
import { STRIPE_API_VERSION } from '../../src/lib/stripe';

export async function preflight(): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  if (!env.STRIPE_SECRET_KEY) errors.push('STRIPE_SECRET_KEY is not set');
  if (!env.STRIPE_WEBHOOK_SECRET) errors.push('STRIPE_WEBHOOK_SECRET is not set');

  // R3 — must be test keys
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    errors.push('STRIPE_SECRET_KEY must start with sk_test_ in non-live mode');
  }
  if (env.STRIPE_WEBHOOK_SECRET && !env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
    errors.push('STRIPE_WEBHOOK_SECRET must start with whsec_');
  }

  // Backend reachable
  try {
    const res = await fetch('http://localhost:3000/api/health');
    if (!res.ok) errors.push(`backend health check failed: ${res.status}`);
  } catch {
    errors.push('backend not reachable at http://localhost:3000');
  }

  // R6 — API version drift
  const codeVersion = STRIPE_API_VERSION;
  const sdkVersion = (Stripe as any).LatestApiVersion ?? codeVersion;
  if (codeVersion !== sdkVersion) {
    errors.push(`Stripe API version drift: code=${codeVersion}, SDK=${sdkVersion}`);
  }

  return { ok: errors.length === 0, errors };
}
