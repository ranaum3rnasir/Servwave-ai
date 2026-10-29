// A sales request that says only "we'd like more numbers" is unactionable: the
// inbox cannot tell who wrote it or which account they are on. The body carries
// the identity the server knows - org, plan, person, role - so a reply can start
// from the account rather than from a question.
import { describe, it, expect } from 'vitest';
import {
  buildSalesRequestEmail,
  SALES_TOPIC_LABELS,
  type SalesRequestDetails,
} from '../sales-request-email';

const base: SalesRequestDetails = {
  organization: {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Acme Plumbing',
    plan: 'PRO',
    isDemo: false,
    city: 'Richmond',
    state: 'VA',
    phone: '(804) 555-0142',
    phoneModuleConnected: true,
    userCount: 12,
  },
  sender: {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Dana Reyes',
    email: 'dana@acmeplumbing.com',
    role: 'ADMIN',
  },
  topic: 'limits',
  subject: 'Increase call / text limits (Main)',
  message: 'We keep hitting the calling allowance halfway through the month.',
};

function bodies(d: SalesRequestDetails) {
  const { text, html } = buildSalesRequestEmail(d);
  return { text, html, both: `${text}\n${html}` };
}

describe('buildSalesRequestEmail', () => {
  it('names the organization, its id and its plan', () => {
    const { text, html } = bodies(base);
    for (const body of [text, html]) {
      expect(body).toContain('Acme Plumbing');
      expect(body).toContain('11111111-1111-1111-1111-111111111111');
      expect(body).toContain('PRO');
    }
  });

  it('names the person who wrote it, their login email and their role', () => {
    const { text, html } = bodies(base);
    for (const body of [text, html]) {
      expect(body).toContain('Dana Reyes');
      expect(body).toContain('dana@acmeplumbing.com');
      expect(body).toContain('Admin');
    }
  });

  it('says what they are asking for, in words, not just the free text', () => {
    const { both } = bodies(base);
    expect(both).toContain(SALES_TOPIC_LABELS.limits);
  });

  it('falls back to a written label when no preset topic was picked', () => {
    const { both } = bodies({ ...base, topic: null });
    expect(both).toContain('Custom message');
  });

  it('carries the account context a reply needs - size, location, phone module', () => {
    const { both } = bodies(base);
    expect(both).toContain('12');
    expect(both).toContain('Richmond, VA');
    expect(both).toContain('Connected');
  });

  it('flags a demo org so sales does not treat it as a paying account', () => {
    const { both } = bodies({
      ...base,
      organization: { ...base.organization, isDemo: true },
    });
    expect(both).toContain('Demo');
  });

  it('always includes the message the owner actually wrote', () => {
    const { text, html } = bodies(base);
    for (const body of [text, html]) {
      expect(body).toContain('We keep hitting the calling allowance halfway through the month.');
    }
  });

  it('escapes the message rather than letting it inject markup', () => {
    const { html } = bodies({ ...base, message: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('tolerates an org with no location, no phone and an unknown headcount', () => {
    const { text } = bodies({
      ...base,
      organization: {
        ...base.organization,
        city: null,
        state: null,
        phone: null,
        userCount: null,
        phoneModuleConnected: false,
      },
    });
    expect(text).toContain('Acme Plumbing');
    expect(text).toContain('Not connected');
    expect(text).not.toContain('null');
  });
});
