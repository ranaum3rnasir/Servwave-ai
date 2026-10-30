/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.27 - no phone, email, call-tracking or payment provider name on any screen
   the Communication section touches.

   CLAUDE.md boundary: a vendor's name never reaches rendered copy, a toast, a tooltip, the DOM, the browser console or
   a URL the user can read. Identifiers, type fields, API paths, env var names and comments may keep the name.

   The scan covers the phone service's screens and everything around them: the Phone, Text and Email pages and their
   tabs, the calls list and call detail, recordings and transcripts, call insights, the Communication tabs on a job,
   lead and customer, the header shortcuts, the bell, and the Settings pages for numbers, mailboxes and communication
   (their string literals, template pieces and JSX text, which carries every label, empty state, toast, tooltip and
   help text, and every URL and query parameter built in code). It also lists every console call in that area.

   The list of names is the one the mobile gate already enforces (e2e/mobile/vendor-terms.ts), extended with the
   other phone and email providers and the carrier-registration jargon the product keeps off every screen. The
   assistant (Servy) is out of scope: it does not work and nothing user-facing consumes it.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findVendorTerms } from '../../e2e/mobile/vendor-terms';
import { consoleCalls, shippedFiles, textLiterals } from './support/textLiterals';

const SRC = path.resolve(__dirname, '..');

/** Providers the mobile gate's list does not name, and the regime jargon ("carrier approval", never the regime's name). */
const MORE_NAMES: Array<{ term: string; pattern: RegExp }> = [
  { term: 'CallRail', pattern: /call\s*rail/i },
  { term: 'Telnyx', pattern: /telnyx/i },
  { term: 'Plivo', pattern: /plivo/i },
  { term: 'Vonage', pattern: /vonage|nexmo/i },
  { term: 'Bandwidth', pattern: /bandwidth\.com/i },
  { term: 'Mailgun', pattern: /mailgun/i },
  { term: 'SendGrid', pattern: /sendgrid/i },
  { term: 'Postmark', pattern: /postmark/i },
  { term: 'A2P', pattern: /\bA2P\b|\b10DLC\b/i },
  { term: 'sub-account', pattern: /sub-account/i },
];

function providersIn(text: string): string[] {
  const named = findVendorTerms([{ source: 'literal', text }]).map((h) => h.term);
  return [...new Set([...named, ...MORE_NAMES.filter((m) => m.pattern.test(text)).map((m) => m.term)])];
}

/** The area, as paths under src. Whole folders, plus the single files that sit beside unrelated ones. */
const AREA: RegExp[] = [
  /^components\/communication\//,
  /^components\/notifications\//,
  /^components\/contact\/PhoneContactActions\./,
  /^components\/layout\/Header\./,
  /^pages\/v2\/V2AppLayout\./,
  /^pages\/v2\/communication\//,
  /^pages\/v2\/routes\/communication\./,
  /^pages\/v2\/WhatsAppGlyph\./,
  /^pages\/phone\//,
  /^pages\/v2\/settings\/(PhoneNumbersSettingsPage|PhoneSmsPage)\./,
  /^pages\/v2\/settings\/components\/(callerId|mailbox)/,
  /^pages\/settings\/(PhoneSmsPage|EmailSenderPage|MainMailboxReaders)\./,
  /^pages\/v2\/reports\/reports\/(CallsReport|CommunicationTrackingReport)\./,
  /^lib\/communication\//,
  /^lib\/api\/(communication|jobCommunications|callJob|emailSender|phoneConnected|phoneNumbers|phoneOrgActions)/,
  /^lib\/(phonePrefill|user-phone)\./,
  /^stores\/(dialer|phoneSheet)\.store\./,
];

/**
 * Literals that name a provider but are never rendered. Each has a reason; an entry that matches nothing fails, so the
 * list can only shrink.
 */
const KNOWN_INTERNAL: Array<{ file?: RegExp; pattern: RegExp; reason: string }> = [
  { pattern: /^\/api\//, reason: 'internal route paths are how the browser talks to the server and are never shown' },
  {
    file: /^lib\/communication\/ctmSoftphone\.ts$/,
    pattern: /.*/,
    reason: 'the phone embed\'s own contract (its script address, element names, event and message names): what its code requires, loaded at runtime and never rendered',
  },
];

describe('no provider name on a screen the Communication section touches (browser side)', () => {
  const files = shippedFiles(SRC)
    .map((f) => ({ file: f, rel: path.relative(SRC, f).split(path.sep).join('/') }))
    .filter((f) => AREA.some((re) => re.test(f.rel)) && !/copilot/i.test(f.rel));
  const used = new Set<number>();

  it('scans the screens: the pages, their tabs, the record tabs, the header and the bell', () => {
    expect(files.length).toBeGreaterThan(60);
    const rels = files.map((f) => f.rel);
    for (const must of [
      'pages/v2/communication/PhonePage.tsx', 'pages/v2/communication/TextPage.tsx', 'pages/v2/communication/InboxPage.tsx',
      'components/communication/phone/SmsInboxView.tsx', 'components/communication/phone/CallsView.tsx',
      'components/communication/JobCommunicationsTab.tsx', 'components/communication/LeadCommunicationsTab.tsx',
      'components/communication/CustomerCommunicationsTab.tsx', 'pages/v2/V2AppLayout.tsx', 'components/notifications/NotificationPanel.tsx',
      'pages/v2/settings/PhoneNumbersSettingsPage.tsx', 'lib/api/communication.ts',
    ]) expect(rels, must).toContain(must);
  });

  it('no string, template piece or JSX text names a provider, except what is never rendered', () => {
    const offenders: string[] = [];
    for (const { file, rel } of files) {
      for (const { text, line } of textLiterals(file)) {
        if (providersIn(text).length === 0) continue;
        const known = KNOWN_INTERNAL.findIndex((k) => (!k.file || k.file.test(rel)) && k.pattern.test(text.trim()));
        if (known >= 0) { used.add(known); continue; }
        offenders.push(`${rel}:${line}  ${JSON.stringify(text.trim().slice(0, 90))}  [${providersIn(text).join(', ')}]`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every internal literal listed still exists, so the list can only shrink', () => {
    for (const { file, rel } of files) {
      for (const { text } of textLiterals(file)) {
        if (providersIn(text).length === 0) continue;
        const known = KNOWN_INTERNAL.findIndex((k) => (!k.file || k.file.test(rel)) && k.pattern.test(text.trim()));
        if (known >= 0) used.add(known);
      }
    }
    expect(KNOWN_INTERNAL.filter((_, i) => !used.has(i)).map((k) => k.pattern.source)).toEqual([]);
    for (const k of KNOWN_INTERNAL) expect(k.reason.length).toBeGreaterThan(10);
  });

  it('prints nothing to the browser console from the area, so no provider response or name can be interpolated into it', () => {
    // The only console code here is the filter that keeps the phone embed's own lines out of the console (it holds
    // the vendor's strings as character codes, so they are not in the bundle either).
    const calls = files
      .filter((f) => f.rel !== 'lib/communication/vendorConsoleFilter.ts')
      .flatMap((f) => consoleCalls(f.file).map((c) => `${f.rel}:${c.line}  ${c.text}`));
    expect(calls).toEqual([]);
  });

  describe('the scanner itself', () => {
    const planted = () => {
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')), 'sample.tsx');
      fs.writeFileSync(tmp, [
        '// CTM in a comment',
        "export const a = 'Texting waits on A2P approval';",
        "export const B = () => <p>Calls come through Twilio</p>;",
        "export const c = (r: any) => { console.error('send failed', r.response); };",
      ].join('\n'));
      return tmp;
    };

    it('sees a name in a label and in JSX text, and ignores one in a comment', () => {
      const named = textLiterals(planted()).filter((l) => providersIn(l.text).length > 0).map((l) => l.text.trim());
      expect(named).toEqual(['Texting waits on A2P approval', 'Calls come through Twilio']);
    });

    it('sees a console call that prints a response', () => {
      expect(consoleCalls(planted()).map((c) => c.line)).toEqual([4]);
    });

    it('lets ordinary words through', () => {
      expect(providersIn('Resend invite')).toEqual([]);
      expect(providersIn('Rendering the call list')).toEqual([]);
    });
  });
});
