import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

// Capture fn must exist before the hoisted vi.mock factory references it.
const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

// Override the global env mock (setup.ts) so the email module initializes a real
// Resend client. Two from-addresses on purpose: business mail rides a dedicated
// subdomain so a contractor's estimate volume can never damage the reputation of
// the domain carrying MFA codes and invite links.
vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'no-reply@servwave.test',
    EMAIL_FROM_BUSINESS: 'no-reply@mail.servwave.test',
    RESEND_API_KEY: 're_test_key',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

vi.mock('../lib/comm-persist', () => ({
  persistTransactionalEmail: vi.fn().mockResolvedValue(undefined),
}));

// sendInvoiceEmail now attaches a rendered PDF — stub the renderer so this suite stays
// focused on sender identity, not pdfmake.
vi.mock('../lib/pdf', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

import { prisma } from '../lib/prisma';

// setup.ts mocks '../lib/email' globally; pull the REAL module here.
let sendInvoiceEmail: typeof import('../lib/email')['sendInvoiceEmail'];
let sendAutomationEmail: typeof import('../lib/email')['sendAutomationEmail'];
let sendMfaCodeEmail: typeof import('../lib/email')['sendMfaCodeEmail'];
let sendUserInviteEmail: typeof import('../lib/email')['sendUserInviteEmail'];
let sendPaymentsActionNeededEmail: typeof import('../lib/email')['sendPaymentsActionNeededEmail'];
let sendPaymentsRateChangeNotice: typeof import('../lib/email')['sendPaymentsRateChangeNotice'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendInvoiceEmail = real.sendInvoiceEmail;
  sendAutomationEmail = real.sendAutomationEmail;
  sendMfaCodeEmail = real.sendMfaCodeEmail;
  sendUserInviteEmail = real.sendUserInviteEmail;
  sendPaymentsActionNeededEmail = real.sendPaymentsActionNeededEmail;
  sendPaymentsRateChangeNotice = real.sendPaymentsRateChangeNotice;
});

beforeEach(() => {
  vi.clearAllMocks();
  resendSend.mockResolvedValue({ id: 'msg_1' });
  // renderInvoicePdfBuffer's own lookup, ahead of the stubbed generateInvoicePdf above.
  (prisma.invoice.findUnique as Mock).mockResolvedValue({ organization_id: ORG_ID, payments: [] });
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';

/** Mock the single org lookup dispatchEmail does (kill switch + display name). */
function mockOrg(name: string | null, enabled = true) {
  (prisma.organization.findUnique as Mock).mockResolvedValue({
    email_sending_enabled: enabled,
    name,
  });
}

const sentFrom = () => resendSend.mock.calls[0][0].from as string;

async function sendCustomerFacingEmail() {
  await sendInvoiceEmail({
    invoiceId: 'inv-1',
    organizationId: ORG_ID,
    to: 'cust@example.com',
    customerName: 'Cust',
    invoiceNumber: 'I00001',
    total: 100,
    amountDue: 100,
    dueDate: '2026-08-01',
    publicUrl: 'https://app.example/i/tok',
  });
}

describe('Outbound sender identity', () => {
  describe('organization display name', () => {
    it('sends customer-facing mail as the organization, on the business domain', async () => {
      mockOrg('Acme Plumbing');

      await sendCustomerFacingEmail();

      expect(sentFrom()).toBe('"Acme Plumbing" <acmeplumbing@mail.servwave.test>');
    });

    it('brands the Automation Center sends too - they reach customers unattended', async () => {
      mockOrg('Acme Plumbing');

      await sendAutomationEmail({
        organizationId: ORG_ID,
        to: 'customer@example.com',
        subject: 'Your appointment is tomorrow',
        text: 'See you then.',
        html: '<p>See you then.</p>',
      });

      expect(sentFrom()).toBe('"Acme Plumbing" <acmeplumbing@mail.servwave.test>');
    });

    it('never sends business mail from the auth domain', async () => {
      mockOrg('Acme Plumbing');

      await sendCustomerFacingEmail();

      expect(sentFrom()).not.toContain('@servwave.test');
      expect(sentFrom()).toContain('@mail.servwave.test');
    });

    it('falls back to the bare address when the org has no usable name', async () => {
      mockOrg('   ');

      await sendCustomerFacingEmail();

      expect(sentFrom()).toBe('no-reply@mail.servwave.test');
    });

    it('falls back to the bare address when the org row is missing entirely', async () => {
      // First call is renderInvoicePdfBuffer's own org lookup (needs a truthy row to render
      // at all); the rest is what this test actually exercises — a missing row everywhere else.
      (prisma.organization.findUnique as Mock)
        .mockResolvedValueOnce({ estimate_template: 'alpha-classic' })
        .mockResolvedValue(undefined);

      await sendCustomerFacingEmail();

      expect(sentFrom()).toBe('no-reply@mail.servwave.test');
    });
  });

  // organization.name is tenant-controlled input landing in a mail header. It gets
  // the same distrust as any user string entering HTML.
  describe('display-name sanitizing', () => {
    it('strips CRLF so an org name cannot inject a header', async () => {
      mockOrg('Acme\r\nBcc: attacker@evil.test');

      await sendCustomerFacingEmail();

      expect(sentFrom()).not.toContain('\r');
      expect(sentFrom()).not.toContain('\n');
      expect(sentFrom()).toBe('"Acme Bcc: attacker@evil.test" <acmebccattackereviltest@mail.servwave.test>');
    });

    it('escapes quotes and backslashes rather than emitting them raw', async () => {
      mockOrg('Bob "The Wrench" O\\Brien');

      await sendCustomerFacingEmail();

      expect(sentFrom()).toBe(
        '"Bob \\"The Wrench\\" O\\\\Brien" <bobthewrenchobrien@mail.servwave.test>'
      );
    });

    it('RFC 2047 encodes a non-ASCII org name', async () => {
      mockOrg('Cafétéria Plomberie');

      await sendCustomerFacingEmail();

      const from = sentFrom();
      // The local part is ASCII by construction - the accented characters are
      // dropped rather than romanized, so the address stays deliverable while
      // the display half carries the real name, encoded.
      expect(from).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <caftriaplomberie@mail\.servwave\.test>$/);
      const encoded = from.slice(from.indexOf('?B?') + 3, from.indexOf('?='));
      expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('Cafétéria Plomberie');
    });

    it('truncates an absurdly long org name', async () => {
      mockOrg('A'.repeat(500));

      await sendCustomerFacingEmail();

      const displayName = sentFrom().split(' <')[0].replace(/"/g, '');
      expect(displayName.length).toBeLessThanOrEqual(64);
    });
  });

  // A few emails are ServWave speaking TO the contractor, not the contractor
  // speaking to their customer. Stamping the org name on those misrepresents who
  // is talking.
  describe('platform-voice senders', () => {
    it('sends the Payments action-needed notice unbranded', async () => {
      mockOrg('Acme Plumbing');

      await sendPaymentsActionNeededEmail({
        organizationId: ORG_ID,
        to: 'admin@acme.test',
        orgName: 'Acme Plumbing',
        fixUrl: 'https://app.example/settings/payments',
      });

      expect(sentFrom()).toBe('no-reply@mail.servwave.test');
    });

    it('sends the Payments rate-change notice unbranded', async () => {
      mockOrg('Acme Plumbing');

      await sendPaymentsRateChangeNotice({
        organizationId: ORG_ID,
        to: 'admin@acme.test',
        orgName: 'Acme Plumbing',
        oldRate: '2.9% + 30c',
        newRate: '2.7% + 30c',
        effectiveDate: 'September 1, 2026',
      });

      expect(sentFrom()).toBe('no-reply@mail.servwave.test');
    });
  });

  // These bypass dispatchEmail by design so a kill switch or a branding change can
  // never take down login. Guard that separation.
  describe('auth-critical mail', () => {
    it('sends MFA codes from the auth domain, unbranded', async () => {
      mockOrg('Acme Plumbing');

      await sendMfaCodeEmail({ to: 'user@example.com', code: '123456' });

      expect(sentFrom()).toBe('no-reply@servwave.test');
    });

    it('sends user invites from the auth domain, unbranded', async () => {
      (prisma.organization.findUnique as Mock).mockResolvedValue({
        name: 'Acme Plumbing',
        logo_url: null,
        brand_color: '#0C2D3A',
      });

      await sendUserInviteEmail({
        to: 'user@example.com',
        firstName: 'Jane',
        inviteUrl: 'https://app.example/invite/abc',
        organizationId: ORG_ID,
      });

      expect(sentFrom()).toBe('no-reply@servwave.test');
    });
  });

  describe('invoice subject', () => {
    it('names the organization, not ServWave', async () => {
      mockOrg('Acme Plumbing');

      await sendCustomerFacingEmail();

      expect(resendSend.mock.calls[0][0].subject).toBe('Invoice I00001 from Acme Plumbing');
    });

    it('degrades to a bare subject when the org name is unavailable', async () => {
      // sendInvoiceEmail's subject line reads renderInvoicePdfBuffer's own org fetch (first
      // call) directly — no name on that row degrades the subject to bare, same as a missing
      // row would. The second call is dispatchEmail's separate org fetch (kill-switch/From).
      (prisma.organization.findUnique as Mock)
        .mockResolvedValueOnce({ estimate_template: 'alpha-classic' })
        .mockResolvedValue(undefined);

      await sendCustomerFacingEmail();

      expect(resendSend.mock.calls[0][0].subject).toBe('Invoice I00001');
    });
  });
});
