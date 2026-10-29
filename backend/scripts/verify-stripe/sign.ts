import Stripe from 'stripe';
import { env } from '../../src/config/env';
import { STRIPE_API_VERSION } from '../../src/lib/stripe';

const stripe = new Stripe(env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion });

export function signEvent(event: object): { payload: string; signature: string } {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: env.STRIPE_WEBHOOK_SECRET!,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return { payload, signature };
}

export async function postWebhook(event: object): Promise<{ status: number; body: any }> {
  const { payload, signature } = signEvent(event);
  const res = await fetch('http://localhost:3000/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
  return { status: res.status, body: await res.json() };
}
