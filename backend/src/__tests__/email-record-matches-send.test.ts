import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

/*
 * The record must match what actually left the building.
 *
 * email-persistence-honesty.test.ts pins the first half of this rule: do not
 * mirror a send that never happened. These are the other half, both found by
 * reading real prod sends on Servwave Demo rather than by reading code.
 *
 * BUG D: the four SRVW-243 notify senders render the admin's message into the
 *   HTML but build `text` from boilerplate alone. Two consequences, and the
 *   second is the serious one: a plain-text client shows wording the admin
 *   never wrote, and persistTransactionalEmail derives the row's snippet/body
 *   from that same `text` - so the Communication tab misquotes an email that
 *   was sent correctly. sendEstimateEmail already interpolates the message
 *   into its text; these four now match that idiom.
 *
 * BUG E: cc reaches Resend and is delivered, but persistTransactionalEmail has
 *   no cc parameter at all, so every mirrored row understates who received the
 *   mail. Confirmed in prod: two sends carried CC art.nakamura@servwave.com and
 *   both rows recorded cc = null. Pre-dates SRVW-243 - every cc-capable sender
 *   has always had it - but the compose dialog makes it reachable from a new
 *   place, and a row that names one recipient for a two-recipient email is the
 *   same class of lie this card exists to remove.
 *
 * Same module-mocking idiom as email-persistence-honesty.test.ts: setup.ts
 * mocks '../lib/email' globally, so the REAL module is pulled in beforeAll.
 */

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'noreply@test.servwave.com',
    EMAIL_FROM_BUSINESS: 'noreply@mail.test.servwave.com',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

// sendEstimateEmail attaches a rendered PDF - stub the renderer so the estimate
// case below exercises persistence rather than pdfmake. Same stub as
// email-persistence-honesty.test.ts.
vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';
import type { OrganizationBrandingSubset } from '../lib/email';

type Email = typeof import('../lib/email');
let email: Email;

beforeAll(async () => {
  email = await vi.importActual<Email>('../lib/email');
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const RECORD = { organizationId: ORG_ID, customerId: CUSTOMER_ID };
const WHEN = new Date('2026-08-18T13:00:00Z');
const TZ = 'America/New_York';

/** Wording no boilerplate would ever produce, so a match cannot be accidental. */
const MESSAGE = 'We had to shuffle the route - our tech will call you 30 minutes out.';
const CC = ['ops@example.com', 'owner@example.com'];

/** A name distinct from both the fixture's own name and the 'ServWave' fallback,
 *  so a match against it cannot be a coincidence with either. */
const ORG_BRANDING: OrganizationBrandingSubset = {
  id: ORG_ID, name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A',
};
/** The literal fallback wrapHtml renders when it gets no org row at all - see email.ts:639-640. */
const SERVWAVE_FALLBACK_HEADER = '<span style="color:#ffffff;font-size:20px;font-weight:700;">ServWave</span>';

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ data: { id: 're_ok' }, error: null });
  (prisma.email.create as Mock).mockResolvedValue({ id: 'email_1' });
  (prisma.organization.findUnique as Mock).mockResolvedValue({
    email_sending_enabled: true,
    name: 'Acme Plumbing',
  });
});

/**
 * Every sender the compose dialog can reach. Each runner takes the optional
 * bits so one table drives both bugs.
 */
const NOTIFY_SENDERS: {
  name: string;
  run: (e: Email, extra: { message?: string; cc?: string[]; org?: OrganizationBrandingSubset }) => Promise<unknown>;
}[] = [
  {
    name: 'sendJobScheduledEmail',
    run: (e, extra) => e.sendJobScheduledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      jobNumber: 'J00001', technicianName: 'Sam Tech', scheduledStart: WHEN,
      serviceAddress: '1 Main St', timezone: TZ, record: RECORD, ...extra,
    }),
  },
  {
    name: 'sendJobRescheduledEmail',
    run: (e, extra) => e.sendJobRescheduledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      jobNumber: 'J00001', newScheduledStart: WHEN, technicianName: 'Sam Tech',
      serviceAddress: '1 Main St', timezone: TZ, record: RECORD, ...extra,
    }),
  },
  {
    name: 'sendWalkthroughScheduledEmail',
    run: (e, extra) => e.sendWalkthroughScheduledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      scheduledDate: WHEN, performerName: 'Sam Tech', serviceAddress: '1 Main St',
      companyName: 'Acme Plumbing', timezone: TZ, record: RECORD, ...extra,
    }),
  },
  {
    name: 'sendWalkthroughRescheduledEmail',
    run: (e, extra) => e.sendWalkthroughRescheduledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      newDate: WHEN, performerName: 'Sam Tech', serviceAddress: '1 Main St',
      timezone: TZ, record: RECORD, ...extra,
    }),
  },
];

describe('BUG D - the admin message must reach the text part, not only the HTML', () => {
  it.each(NOTIFY_SENDERS)('$name sends the message in text/plain', async ({ run }) => {
    await run(email, { message: MESSAGE });

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(resendSend.mock.calls[0][0].text).toContain(MESSAGE);
  });

  it.each(NOTIFY_SENDERS)('$name persists a row quoting the message', async ({ run }) => {
    await run(email, { message: MESSAGE });

    const row = (prisma.email.create as Mock).mock.calls[0][0].data;
    expect(row.snippet).toContain(MESSAGE);
  });

  it.each(NOTIFY_SENDERS)('$name still sends the default wording with no message', async ({ run }) => {
    await run(email, {});

    const text = resendSend.mock.calls[0][0].text as string;
    expect(text).toContain('Jane Doe');
    expect(text).not.toContain(MESSAGE);
  });

  it('keeps the schedule facts in the text even when the admin rewrites the prose', async () => {
    // The details must survive an edit, exactly as the HTML table does - an
    // edited message may add to the email but must never replace what it states.
    await email.sendJobRescheduledEmail({
      organizationId: ORG_ID, to: 'jane@example.com', customerName: 'Jane Doe',
      jobNumber: 'J00001', newScheduledStart: WHEN, technicianName: 'Sam Tech',
      serviceAddress: '1 Main St', timezone: TZ, record: RECORD, message: MESSAGE,
    });

    const text = resendSend.mock.calls[0][0].text as string;
    expect(text).toContain(MESSAGE);
    expect(text).toContain('J00001');
    expect(text).toContain('Sam Tech');
    expect(text).toContain('1 Main St');
  });
});

describe('BUG E - a mirrored row must name everyone who received the mail', () => {
  it.each(NOTIFY_SENDERS)('$name records the cc list it sent', async ({ run }) => {
    await run(email, { cc: CC });

    expect(resendSend.mock.calls[0][0].cc).toEqual(CC);
    const row = (prisma.email.create as Mock).mock.calls[0][0].data;
    expect(row.cc).toBe(CC.join(', '));
  });

  it.each(NOTIFY_SENDERS)('$name leaves cc null when there was none', async ({ run }) => {
    await run(email, {});

    const row = (prisma.email.create as Mock).mock.calls[0][0].data;
    expect(row.cc ?? null).toBeNull();
  });

  it('records cc on the estimate sender too - the gap was never SRVW-243 specific', async () => {
    (prisma.estimate.findUnique as Mock).mockResolvedValue({
      estimate_number: 'E00001', status: 'SENT', created_at: new Date(), subtotal: 100,
      tax_rate: 0, tax_amount: 0, total_amount: 100, signature_data: null, signature_at: null,
      snapshot_terms: null, snapshot_notes: null, snapshot_payment_terms: null,
      organization_id: ORG_ID,
      lead: {
        service_address_line1: null, service_address_line2: null, service_city: null,
        service_state: null, service_zip: null,
        customer: {
          first_name: 'Jane', last_name: 'Doe', company_name: null,
          email: 'jane@example.com', phone: null, service_locations: [],
        },
      },
      line_items: [],
    });

    await email.sendEstimateEmail({
      estimateId: 'est-1',
      org: { id: ORG_ID, name: 'Acme Plumbing', logo_url: null, brand_color: '#0C2D3A' },
      to: 'jane@example.com', cc: CC, customerName: 'Jane Doe', estimateNumber: 'E00001',
      total: '$100.00', publicUrl: 'https://app.example.com/p/estimates/est-1?token=t',
      record: RECORD,
    });

    const row = (prisma.email.create as Mock).mock.calls[0][0].data;
    expect(row.cc).toBe(CC.join(', '));
  });
});

describe('BUG F - the details must read as a sentence when a message precedes it', () => {
  it.each(NOTIFY_SENDERS)('$name leaves the details paragraph reading as a sentence', async ({ run }) => {
    // This one is mine, introduced by BUG D's fix. The details fragment is written to continue
    // "Hi {name}, " inline, so it opens lowercase. With the admin's message
    // between them it starts its own paragraph and has to be capitalised. Prod
    // sent "...this is a test\n\nyour service J00005 has been scheduled..." -
    // visible both in the plain-text part and in the Communication tab snippet.
    await run(email, { message: MESSAGE });

    const text = resendSend.mock.calls[0][0].text as string;
    const paragraphs = text.split('\n\n');
    expect(paragraphs).toHaveLength(3); // greeting / the admin's words / the facts
    expect(paragraphs[2]).not.toMatch(/^[a-z]/);
  });

  it.each(NOTIFY_SENDERS)('$name keeps the details inline after the greeting with no message', async ({ run }) => {
    // The lowercase opening is correct in the no-message shape - it is the same
    // sentence as the greeting. Pinned so the fix above cannot leak into it.
    await run(email, {});

    expect(resendSend.mock.calls[0][0].text as string).toMatch(/^Hi Jane Doe, [a-z]/);
  });
});

/**
 * SRVW-243 header-brand fix. A founder acceptance run on org "ServWave Test" got a
 * schedule-notify email whose HEADER read "ServWave" - the hardcoded wrapHtml fallback,
 * not the org's own name - because none of these five senders ever threaded their org
 * row into the html builder (jobScheduledHtml et al. called wrapHtml with no second
 * argument at all). Every customer must see who they hired, not the platform - the same
 * rule email.ts:80 already states for the From header.
 */
describe('SRVW-243 header-brand fix - the header renders the ORG, not ServWave', () => {
  it.each(NOTIFY_SENDERS)('$name renders the org name in the header when the org row is present', async ({ run }) => {
    await run(email, { org: ORG_BRANDING });

    const html = resendSend.mock.calls[0][0].html as string;
    expect(html).toContain('<span style="color:#ffffff;font-size:20px;font-weight:700;">Acme Plumbing</span>');
    expect(html).not.toContain(SERVWAVE_FALLBACK_HEADER);
  });

  // The fallback exists for the case the org row itself could not be loaded - it must not
  // fire just because a caller forgot to pass one, but that IS what "forgot to pass one"
  // looks like from here: no way to tell the two apart from inside the sender, so this
  // pins the fallback stays reachable rather than becoming dead code.
  //
  // Checks the exact header SPAN, not a bare "not.toContain('Acme Plumbing')" - the
  // walkthrough sender's own `companyName` fixture also happens to be 'Acme Plumbing' and
  // renders in the footer's "Contact us at..." line independently of the header/org fix.
  it.each(NOTIFY_SENDERS)('$name falls back to the ServWave wordmark only when org is genuinely absent', async ({ run }) => {
    await run(email, {});

    const html = resendSend.mock.calls[0][0].html as string;
    expect(html).toContain(SERVWAVE_FALLBACK_HEADER);
    expect(html).not.toContain('<span style="color:#ffffff;font-size:20px;font-weight:700;">Acme Plumbing</span>');
  });
});
