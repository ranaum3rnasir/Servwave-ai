// V7-09a - the on-demand payer read for an unapplied item (BE-10). The spy sits at the SDK boundary, under the real
// function in lib/stripe.ts. The read is the one deliberate exception to "ServWave's own records only": it asks for the
// card or bank on a payment intent, pinned to the capture's connected account, and hands back only the words a screen
// needs. It never returns an id, an error message, or anything that names the payer.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { intentsRetrieve } = vi.hoisted(() => ({ intentsRetrieve: vi.fn() }));

vi.unmock('../lib/stripe');
vi.mock('stripe', () => ({
  default: class RecordingProcessorClient {
    paymentIntents = { retrieve: intentsRetrieve };
  },
}));

import { retrieveCapturePayerDetail } from '../lib/stripe';
import { env } from '../config/env';

const cardIntent = (over: Record<string, unknown> = {}) => ({
  id: 'pi_secret_1',
  description: 'Invoice payment',
  latest_charge: {
    id: 'ch_secret_1',
    billing_details: { name: 'Pat Payer', email: 'pat@example.test' },
    payment_method_details: { type: 'card', card: { brand: 'visa', last4: '4242' } },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY ??= 'sk_test_recorded';
});

describe('retrieveCapturePayerDetail', () => {
  it('reads a card payment: brand, last four and description only, pinned to the capture\'s account with the latest charge expanded', async () => {
    intentsRetrieve.mockResolvedValue(cardIntent());
    const out = await retrieveCapturePayerDetail('acct_one', 'pi_one');
    expect(out).toEqual({ method: 'card', brand: 'visa', last4: '4242', bank_name: null, description: 'Invoice payment' });
    expect(intentsRetrieve).toHaveBeenCalledTimes(1);
    const [id, params, options] = intentsRetrieve.mock.calls[0];
    expect(id).toBe('pi_one');
    expect(params).toMatchObject({ expand: ['latest_charge'] });
    expect(options).toMatchObject({ stripeAccount: 'acct_one' });
    // Nothing that names the payer or identifies the processor's objects leaves the function.
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/pi_|ch_|Pat|pat@/);
  });

  it('reads a bank payment: the bank name and last four', async () => {
    intentsRetrieve.mockResolvedValue(cardIntent({
      latest_charge: { id: 'ch_2', payment_method_details: { type: 'us_bank_account', us_bank_account: { bank_name: 'First Test Bank', last4: '6789' } } },
      description: null,
    }));
    expect(await retrieveCapturePayerDetail('acct_one', 'pi_one')).toEqual({ method: 'bank', brand: null, last4: '6789', bank_name: 'First Test Bank', description: null });
  });

  it('drops a description that carries a processor id', async () => {
    intentsRetrieve.mockResolvedValue(cardIntent({ description: 'Payment for pi_3Abc123 via cs_test_9' }));
    expect((await retrieveCapturePayerDetail('acct_one', 'pi_one'))?.description).toBeNull();
  });

  it('answers null, never throws and never carries the error text, when the processor errors', async () => {
    intentsRetrieve.mockRejectedValue(Object.assign(new Error('No such payment_intent: pi_secret_9'), { code: 'resource_missing' }));
    expect(await retrieveCapturePayerDetail('acct_one', 'pi_one')).toBeNull();
  });

  it('answers null when the read takes longer than the timeout', async () => {
    intentsRetrieve.mockReturnValue(new Promise(() => undefined));
    const started = Date.now();
    expect(await retrieveCapturePayerDetail('acct_one', 'pi_one', 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('asks nothing without an account or an intent', async () => {
    expect(await retrieveCapturePayerDetail(null, 'pi_one')).toBeNull();
    expect(await retrieveCapturePayerDetail('acct_one', null)).toBeNull();
    expect(intentsRetrieve).not.toHaveBeenCalled();
  });

  it('answers null for a charge with no card or bank details', async () => {
    intentsRetrieve.mockResolvedValue(cardIntent({ latest_charge: null }));
    expect(await retrieveCapturePayerDetail('acct_one', 'pi_one')).toBeNull();
  });
});
