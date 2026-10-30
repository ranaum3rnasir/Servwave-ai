/**
 * Spider's message texts (Ran, 15 Oct: the contractor's, exactly). His email, text message and
 * in-app wording from spiderDispatch.service.ts at 3bb6606, built from the alert's content.
 */
import { describe, it, expect } from 'vitest';
import {
  formatHumanReadableDuration,
  resolveServiceAddress,
  spiderAlertHeader,
  spiderAlertEmailHtml,
  spiderAssignedUserName,
  spiderFullTextMessage,
  spiderStageSentence,
  type SpiderMessageContent,
} from '../messages';

const URL = 'https://app.test/leads/lead-1';

const content = (over: Partial<SpiderMessageContent> = {}): SpiderMessageContent => ({
  leadNumber: 'L00042',
  customerName: 'Pat Payer',
  stage: 'CONTACTED',
  timeInStage: '3 hours',
  assignedTo: 'Rita Rep',
  serviceLocation: '12 Elm Street, Testville, MA, 02108',
  leadUrl: URL,
  ...over,
});

describe('formatHumanReadableDuration (his largest whole unit)', () => {
  it.each([
    [0, '1 minute'],
    [59, '1 minute'],
    [60, '1 minute'],
    [119, '1 minute'],
    [120, '2 minutes'],
    [3599, '59 minutes'],
    [3600, '1 hour'],
    [2 * 3600 + 59 * 60, '2 hours'],
    [86_399, '23 hours'],
    [86_400, '1 day'],
    [3 * 86_400 + 5 * 3600, '3 days'],
    [-5, '1 minute'],
  ])('%i seconds reads "%s"', (seconds, text) => {
    expect(formatHumanReadableDuration(seconds)).toBe(text);
  });
});

describe('the stage sentence', () => {
  it('is his sentence for each of the three stages', () => {
    expect(spiderStageSentence('NEW', '2 days')).toBe('This lead was created 2 days ago and has not yet been contacted.');
    expect(spiderStageSentence('CONTACTED', '3 hours')).toBe(
      'This lead was contacted 3 hours ago, but a walkthrough has not yet been scheduled.',
    );
    expect(spiderStageSentence('WALKTHROUGH_COMPLETED', '1 day')).toBe(
      'The walkthrough was completed 1 day ago, but an estimate has not yet been sent.',
    );
  });
});

describe('the header and the full text message (email body, text message)', () => {
  it('reads "Spider Alert - {customer} ({lead number})", the lead number as our lead page shows it', () => {
    expect(spiderAlertHeader(content())).toBe('Spider Alert - Pat Payer (L00042)');
  });

  it('is the header, the stage sentence, a blank line and "View lead: {url}"', () => {
    expect(spiderFullTextMessage(content())).toBe(
      'Spider Alert - Pat Payer (L00042)\n'
        + 'This lead was contacted 3 hours ago, but a walkthrough has not yet been scheduled.\n'
        + '\n'
        + `View lead: ${URL}`,
    );
  });
});

describe('the email HTML', () => {
  const html = spiderAlertEmailHtml(content(), 'Ada Admin');

  it('has his parts in his order', () => {
    const parts = [
      'background-color: #0c2d3a',
      '🕷️ Spider AI Lead Watcher Alert',
      '<h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 20px; font-weight: 600;">Spider Alert - Pat Payer (L00042)</h2>',
      'Hi Ada Admin,',
      'border-left: 4px solid #ef4444',
      'This lead was contacted 3 hours ago, but a walkthrough has not yet been scheduled.',
      'Lead Number:</td>',
      '>L00042</td>',
      'Customer:</td>',
      '>Pat Payer</td>',
      'Assigned To:</td>',
      '>Rita Rep</td>',
      'Current Stage:</td>',
      'color: #dc2626; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Contacted</td>',
      'Time in Stage:</td>',
      '>3 hours</td>',
      'Service Location:</td>',
      '>12 Elm Street, Testville, MA, 02108</td>',
      `href="${URL}"`,
      `View lead: ${URL}`,
    ];
    let from = 0;
    for (const part of parts) {
      const at = html.indexOf(part, from);
      expect(at, `"${part}" after position ${from}`).toBeGreaterThanOrEqual(0);
      from = at + part.length;
    }
  });

  it('greets "Team Member" when the recipient has no name', () => {
    expect(spiderAlertEmailHtml(content(), '  ')).toContain('Hi Team Member,');
  });

  it('escapes every value', () => {
    const out = spiderAlertEmailHtml(content({ customerName: '<b>Pat</b> & "Co"' }), '<i>x</i>');
    expect(out).not.toContain('<b>Pat</b>');
    expect(out).toContain('&lt;b&gt;Pat&lt;/b&gt; &amp; &quot;Co&quot;');
    expect(out).toContain('Hi &lt;i&gt;x&lt;/i&gt;,');
  });
});

describe('the service location (his fallbacks)', () => {
  const loc = (line1: string, extra: Record<string, unknown> = {}) => ({
    address_line1: line1, address_line2: null, city: 'Testville', state: 'MA', zip: '02108', is_primary: false, ...extra,
  });

  it("is the lead's service location, joined with commas", () => {
    expect(resolveServiceAddress({ service_location: loc('12 Elm Street', { address_line2: 'Unit 4' }) }, null)).toBe(
      '12 Elm Street, Unit 4, Testville, MA, 02108',
    );
  });

  it("else the customer's primary location, else their first", () => {
    const customer = { service_locations: [loc('1 First Way'), loc('2 Primary Road', { is_primary: true })] };
    expect(resolveServiceAddress({ service_location: null }, customer)).toBe('2 Primary Road, Testville, MA, 02108');
    expect(resolveServiceAddress({ service_location: null }, { service_locations: [loc('1 First Way')] })).toBe(
      '1 First Way, Testville, MA, 02108',
    );
  });

  it('else "Service location on file"', () => {
    expect(resolveServiceAddress({ service_location: null }, { service_locations: [] })).toBe('Service location on file');
    expect(resolveServiceAddress({ service_location: null }, null)).toBe('Service location on file');
  });
});

describe('who the lead is assigned to (his order)', () => {
  const user = (first: string, last: string) => ({ first_name: first, last_name: last });

  it('is the first assignee, else the owner, else "Unassigned"', () => {
    expect(spiderAssignedUserName({ lead_assignees: [{ user: user('Tom', 'Tech') }], commission_owner: user('Rita', 'Rep') })).toBe('Tom Tech');
    expect(spiderAssignedUserName({ lead_assignees: [], commission_owner: user('Rita', 'Rep') })).toBe('Rita Rep');
    expect(spiderAssignedUserName({ lead_assignees: [], commission_owner: null })).toBe('Unassigned');
  });

  it('never falls back to an email address', () => {
    expect(spiderAssignedUserName({ lead_assignees: [{ user: user(' ', '') }], commission_owner: null })).toBe('Unassigned');
  });
});
