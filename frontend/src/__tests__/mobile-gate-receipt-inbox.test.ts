/**
 * The gate's seeded customers can receive mail, so their address must be one that accepts it.
 *
 * Since the payments work the "Payment Received" receipt ignores the organisation's outgoing-email
 * switch, so every gate run's throwaway org sends one receipt to the customer it records a payment
 * for. A customer on a domain that cannot resolve (`.invalid`, `.test`, `.example`) makes that
 * receipt bounce, and bounces hurt the staging sending domain. The email provider publishes a test
 * inbox that accepts mail and never bounces; the gate seeds its customers with that address.
 *
 * These tests hold the rule from the outside: they run the gate's own seed code against a recording
 * stand-in for the API and read the addresses it would have created, and they read the visual
 * baseline seed's literal people from source (that file registers a Playwright setup on import, so
 * it cannot be imported here).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gateCustomerEmail, gateCustomerLabel } from '../../e2e/mobile/gate-customer';
import { sentEstimate } from '../../e2e/mobile/seed';

const MOBILE_DIR = path.resolve(__dirname, '..', '..', 'e2e', 'mobile');
const read = (f: string) => fs.readFileSync(path.join(MOBILE_DIR, f), 'utf8');
/** Code only: a comment that names a helper is not a call to it. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Domains that never resolve: a message to one of these bounces. */
const NON_RESOLVING = /@[^@\s'"`]*\.(invalid|test|example|localhost)(?![\w-])/i;
/** The provider's test inbox: accepts mail, delivers nowhere, never bounces (a `+label` is allowed). */
const TEST_INBOX = /^delivered(\+[A-Za-z0-9._-]+)?@resend\.dev$/;

/** Just enough of the API client for `sentEstimate`, recording every customer it is asked to create. */
function recordingApi() {
  const customers: Array<Record<string, unknown>> = [];
  const ok = (body: unknown) => Promise.resolve({ res: { ok: () => true, status: () => 200 }, body });
  const api = {
    get suffix() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); },
    createCustomer: async (data: Record<string, unknown>) => { customers.push(data); return { id: `cust-${customers.length}`, ...data }; },
    addLocation: async () => ({ id: 'loc-1' }),
    createLead: () => ok({ lead: { id: 'lead-1' } }),
    contactLead: () => ok({}),
    scheduleWalkthrough: () => ok({}),
    completeWalkthrough: () => ok({}),
    createEstimate: () => ok({ estimate: { id: 'est-1' } }),
    raw: () => ok({ estimate: { public_token: 'tok' } }),
  } as unknown as Parameters<typeof sentEstimate>[0];
  return { api, customers };
}

describe('the customers the gate seeds', () => {
  it('can all receive mail: every seeded customer address is the provider test inbox', async () => {
    const { api, customers } = recordingApi();
    await sentEstimate(api, 'tech-1');
    await sentEstimate(api, 'tech-1', 'board');
    expect(customers.length).toBeGreaterThan(0);
    for (const c of customers) {
      expect(c.email, `a seeded customer needs an email that accepts mail, got ${c.email}`).toMatch(TEST_INBOX);
      expect(c.email).not.toMatch(NON_RESOLVING);
    }
  });

  it('keeps each seeded address short enough for a 320 px phone: no longer than the old @e2e-qa.invalid one (30 characters)', async () => {
    // The customers list and the job page show the email in a truncating span. At 37 characters
    // (`delivered+gate-<11 char suffix>@resend.dev`) the gate's `overflow` check measured that span 2 px past
    // the iPhone SE's edge on `customers` and `job-detail`; the previous address was 30 characters and fit.
    const { api, customers } = recordingApi();
    await sentEstimate(api, 'tech-1');
    for (const c of customers) expect(String(c.email).length, String(c.email)).toBeLessThanOrEqual(30);
    // And with the real suffix the API client generates (time in base 36 plus three random characters).
    const real = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    expect(gateCustomerEmail(gateCustomerLabel(real)).length).toBeLessThanOrEqual(30);
  });

  it('gives each seeded customer its own address, so the duplicate-customer guard never fires', async () => {
    const { api, customers } = recordingApi();
    await sentEstimate(api, 'tech-1');
    await sentEstimate(api, 'tech-1');
    await sentEstimate(api, 'tech-1');
    const emails = customers.map((c) => String(c.email).toLowerCase());
    expect(new Set(emails).size).toBe(emails.length);
  });

  it('includes the visual baseline seed: its fixed people, one of whom pays an invoice, are on the test inbox too', () => {
    const block = read('visual-setup.ts').match(/const PEOPLE = \{[\s\S]*?\n\};/);
    expect(block, 'visual-setup.ts must keep a PEOPLE block').not.toBeNull();
    const people = block![0].split('\n').filter((l) => /^\s+\w+: \{/.test(l));
    expect(people.length).toBeGreaterThan(0);
    for (const line of people) {
      // Every person's address comes from the gate's one builder, never a literal on a dead domain.
      expect(line, `visual seed person: ${line.trim().slice(0, 40)}`).toMatch(/email: gateCustomerEmail\('[a-z0-9-]+'\)/);
      expect(line).not.toMatch(NON_RESOLVING);
    }
    const labels = people.map((l) => l.match(/gateCustomerEmail\('([^']+)'\)/)![1]);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of labels) expect(gateCustomerEmail(l)).toMatch(TEST_INBOX);
  });

  it('is not built by the shared helper whose address is on a domain that never resolves', () => {
    // helpers/workflow-builders.ts createCustomerWithLocation seeds `@e2e-qa.invalid`; other suites
    // own that helper. No gate file may use it for a customer.
    const offenders = fs.readdirSync(MOBILE_DIR)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /\bcreateCustomerWithLocation\b/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

describe('the gate documents the truth about its mail', () => {
  it('no longer claims the throwaway org emails no one', () => {
    for (const f of ['seed.ts', 'visual-setup.ts']) {
      expect(read(f), `${f} still says the gate emails no one`).not.toMatch(/must not email anyone/i);
    }
    expect(read('README.md')).not.toMatch(/without emailing anyone/i);
  });
});
