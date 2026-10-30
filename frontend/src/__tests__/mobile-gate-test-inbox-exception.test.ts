/**
 * The gate's `gateTestInbox` accepted exception (Ran, 13 Oct 2026).
 *
 * The gate seeds its customers on the email provider's test inbox (`delivered+<label>@resend.dev`,
 * e2e/mobile/gate-customer.ts) so the payment receipt never bounces. A customer's email renders on
 * the customer pages, and the always-enforced `vendorTerms` check flags the provider's host. Ran
 * allowed ONE narrow exception: the check ignores exactly the address the gate generates and nothing
 * else.
 *
 * Every part of the match is held both ways here: the address the gate builds passes, and every
 * other occurrence of the provider's name still fails (the bare name, the host, a URL, the unlabelled
 * and the support addresses, the address inside a longer token, the address in the console).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateCustomerEmail } from '../../e2e/mobile/gate-customer';
import { findVendorTerms, stripGateTestInbox } from '../../e2e/mobile/vendor-terms';

const GATE = gateCustomerEmail('gate-mgx4k2zq9');
/** What the gate's copy check does with one piece of rendered text. */
const copyHits = (text: string, source = 'text') => findVendorTerms([{ source, text }], { gateTestInbox: true });

describe("the gate's own test-inbox address passes the vendor check", () => {
  it('the address the gate builds is exempt in rendered text', () => {
    expect(findVendorTerms([{ source: 'text', text: GATE }])).not.toEqual([]); // flagged without the exception
    expect(copyHits(GATE)).toEqual([]);
  });

  it('is exempt in the places a customer email renders: a sentence, a field, a list, an accessible name', () => {
    expect(copyHits(`Email\n${GATE}\nPhone`)).toEqual([]);
    expect(copyHits(`Send a receipt to ${GATE}.`)).toEqual([]);
    expect(copyHits(`(${GATE}), (${gateCustomerEmail('dana')})`)).toEqual([]);
    expect(copyHits(`Email ${GATE}`, 'accessible name (aria-label)')).toEqual([]);
    expect(copyHits(GATE, 'placeholder')).toEqual([]);
  });

  it('is exempt for every label the gate builds: the seed suffix, and the three fixed people', () => {
    for (const label of ['gate-mgx4k2zq9', 'dana', 'priya', 'tomas', 'a', 'x-1']) expect(copyHits(gateCustomerEmail(label)), label).toEqual([]);
  });

  it('removes the address and reports what it removed, so the gate can print EXEMPT', () => {
    const r = stripGateTestInbox(`Bill to ${GATE} and ${gateCustomerEmail('dana')}.`);
    expect(r.removed).toEqual([GATE, gateCustomerEmail('dana')]);
    expect(r.text).not.toMatch(/resend/i);
  });

  it('the builder refuses a label the exception would not cover', () => {
    for (const bad of ['', 'Dana', 'a_b', 'a b', 'a@b', 'a+b', 'a.b']) expect(() => gateCustomerEmail(bad), JSON.stringify(bad)).toThrow();
  });
});

describe('every other occurrence of the provider still fails', () => {
  const fails = (text: string, source = 'text') => expect(copyHits(text, source).map((h) => h.term), text).toContain('Resend');

  it('the host, the company site and the API wording', () => {
    fails('resend.com');
    fails('Visit https://resend.com/docs');
    fails('Resend API key');
    fails('Resend dashboard');
    fails('Resend domain');
  });

  it('the host in a URL, with or without a path', () => {
    fails('https://resend.dev/emails');
    fails('resend.dev/delivered+gate-abc@resend.dev');
    fails('See https://resend.dev');
    fails('/customers?email=delivered@resend.dev', 'url');
    fails(`/customers?search=${GATE}`, 'url');
    fails(`Receipts for ${GATE}`, 'title');
  });

  it('the unlabelled and the support addresses', () => {
    fails('delivered@resend.dev');
    fails('support@resend.dev');
    fails('onboarding@resend.dev');
    fails('delivered+@resend.dev');
    fails('delivered+Dana@resend.dev');
    fails('delivered+gate_abc@resend.dev');
    fails('delivered+a.b@resend.dev');
    fails('bounced+gate-abc@resend.dev');
    fails('delivered+gate-abc@sub.resend.dev');
  });

  it('the address inside a longer token', () => {
    fails(`x${GATE}`);
    fails(`my.${GATE}`);
    fails(`${GATE}.com`);
    fails(`${GATE}-copy`);
    fails(`${GATE}/inbox`);
    fails(`${GATE}:8080`);
    fails(`${GATE}?a=1`);
    fails(`https://${GATE}`);
    fails(`mailto:${GATE}`);
    fails(`1${GATE}`);
  });

  it('a longer token is judged exactly as it is without the exception', () => {
    // `resend.devx` is not the provider's host, so the base pattern never flagged it; the exception must not
    // change that either way: it must neither start nor stop flagging.
    for (const t of [`${GATE}x`, `${GATE}9`, `a${GATE}`]) {
      expect(copyHits(t).map((h) => h.term), t).toEqual(findVendorTerms([{ source: 'text', text: t }]).map((h) => h.term));
    }
  });

  it('the exception does not hide a real vendor term next to the address', () => {
    expect(copyHits(`${GATE} powered by Resend API`).map((h) => h.term)).toEqual(['Resend']);
    expect(copyHits(`${GATE} and support@resend.dev`).map((h) => h.term)).toEqual(['Resend']);
    expect(copyHits(`${GATE} and CTM`).map((h) => h.term)).toEqual(['CTM']);
  });

  it('the browser console is not exempted: the check without the option still fails the gate address', () => {
    // measure() judges console lines through findVendorTerms with no option.
    expect(findVendorTerms([{ source: 'browser console', text: `GET failed for ${GATE}` }]).map((h) => h.term)).toEqual(['Resend']);
  });
});

describe('the exception is recorded, owned and printed', () => {
  const parsed = JSON.parse(readFileSync(join(__dirname, '..', '..', 'e2e', 'mobile', 'allowlist.json'), 'utf8'));

  it("allowlist.json records gateTestInbox with Ran's 13 Oct 2026 decision as the reason", () => {
    const x = parsed.acceptedExceptions?.gateTestInbox;
    expect(x?.owner).toBe('Ran');
    expect(x?.reason).toMatch(/13 Oct(ober)? 2026|2026-10-13/);
    expect(x?.reason).toMatch(/test inbox|test-inbox/i);
  });
});
