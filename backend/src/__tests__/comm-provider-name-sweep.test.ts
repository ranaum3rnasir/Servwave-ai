/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.27 - no phone, email, call-tracking or payment provider name reaches a user
   from the Communication section's server code.

   CLAUDE.md boundary: a vendor's name never reaches rendered copy, and "an error thrown in the backend that reaches
   the UI through extractApiError is user-visible copy": the throw site is de-branded, not just the component. Backend
   logs, route paths, env var names, columns, webhook handlers and comments may keep the name.

   Two scans, both by the TypeScript compiler (comments and identifiers are never looked at):
     - the files that answer a request in the Communication area (its controllers, routes and the gates in front of
       them) are scanned for ANY string literal that names a provider, except an argument of logger.* / console.*
       and the few internal literals KNOWN_INTERNAL lists with their reason;
     - the library code behind them (the phone service client, the sending code, the alert templates) is scanned
       where a literal is shown to a person: an Error message or a copy-bearing property.
   Then every registered notification template is rendered, so a name that arrives by a join is caught too.

   Out of scope by path: the assistant (services/copilot). It does not work and nothing user-facing consumes it.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { renderTemplate, VERB_RULES } from '../services/notifications/templates';

const SRC = path.resolve(__dirname, '..');

/**
 * Phone, call-tracking, email, payment and hosting providers, and the carrier-registration jargon the product keeps off
 * every screen ("carrier approval", never the regime's name). Words that are also ordinary English UI verbs are matched
 * only in their vendor forms: "Resend invite" is fine, "resend.com" or "Resend API" is not.
 */
const PROVIDER_NAMES: Array<{ term: string; pattern: RegExp }> = [
  { term: 'CTM', pattern: /\bCTM\b/i },
  { term: 'CallTrackingMetrics', pattern: /call\s*tracking\s*metrics/i },
  { term: 'CallRail', pattern: /call\s*rail/i },
  { term: 'Twilio', pattern: /twilio/i },
  { term: 'Telnyx', pattern: /telnyx/i },
  { term: 'Plivo', pattern: /plivo/i },
  { term: 'Vonage', pattern: /vonage|nexmo/i },
  { term: 'Bandwidth', pattern: /bandwidth\.com/i },
  { term: 'Resend', pattern: /resend\.(com|dev)\b|\bResend\s+(API|dashboard|domain|account|webhook)\b/ },
  { term: 'Mailgun', pattern: /mailgun/i },
  { term: 'SendGrid', pattern: /sendgrid/i },
  { term: 'Postmark', pattern: /postmark/i },
  { term: 'Stripe', pattern: /\bstripe\b/i },
  { term: 'Supabase', pattern: /supabase/i },
  { term: 'Render', pattern: /onrender\.com|\brender\.com\b|\bRender\s+(dashboard|service|deploy|account)/i },
  { term: 'Vercel', pattern: /vercel/i },
  { term: 'Sentry', pattern: /\bsentry\b/i },
  { term: 'A2P', pattern: /\bA2P\b|\b10DLC\b/i },
  { term: 'sub-account', pattern: /sub-account/i },
];

const namesAProvider = (text: string): string[] => PROVIDER_NAMES.filter((p) => p.pattern.test(text)).map((p) => p.term);

/**
 * Literals that name a provider but are never rendered to a user. Each needs a reason, and an entry that no longer
 * matches anything fails the test, so the list can only shrink.
 */
const KNOWN_INTERNAL: Array<{ pattern: RegExp; reason: string; used?: boolean }> = [
  { pattern: /^ctm$/, reason: 'the stored source of a phone number row; the API sends "servwave" for it (presentNumberSource)' },
  { pattern: /^ctm\.(connected|disconnected)$/, reason: 'audit-log action keys; no screen reads the audit log' },
  { pattern: /^\/api\/webhooks\/ctm\//, reason: 'the webhook address registered with the provider; it is never shown' },
  { pattern: /^X-CTM-/, reason: 'header names the provider\'s webhook sends' },
  { pattern: /^callrail$/, reason: 'the provider id in a call-tracking webhook path; the sender reads it, no screen shows it' },
  { pattern: /^Resend webhook event already processed/, reason: 'thrown inside the email provider\'s webhook handler and answered to the sender' },
];

type Hit = { file: string; line: number; text: string };

const isText = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail =>
  ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n);

/** Inside the arguments of a `logger.x(...)` or `console.x(...)` call: backend logs may name a vendor. */
function inLogCall(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n) && /^(logger|console)\./.test(n.expression.getText())) return true;
  }
  return false;
}

const COPY_PROPERTIES = /^(error|message|warning|title|body|subject|label|summary|description|reason|text|html|hint|detail|note|[a-z_]*_warning|[a-z_]*_message)$/i;

/** Is this literal an Error message, a value in a response body, or a copy-bearing property? */
function inCopyPosition(n: ts.Node): boolean {
  let node: ts.Node = n;
  if (n.parent && ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.parent.right === n
    && ts.isPropertyAccessExpression(n.parent.left)) return COPY_PROPERTIES.test(n.parent.left.name.text);
  while (node.parent && (ts.isTemplateSpan(node.parent) || ts.isTemplateExpression(node.parent) || ts.isBinaryExpression(node.parent)
    || ts.isParenthesizedExpression(node.parent) || ts.isConditionalExpression(node.parent) || ts.isAsExpression(node.parent))) node = node.parent;
  const p = node.parent;
  if (!p) return false;
  if (ts.isNewExpression(p) && /Error$/.test(p.expression.getText())) return true;
  if (ts.isCallExpression(p) && /\.(json|send)$/.test(p.expression.getText())) return true;
  if (ts.isPropertyAssignment(p)) {
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : '';
    return COPY_PROPERTIES.test(name);
  }
  return false;
}

/** The provider-naming literals of a source text, outside log calls; `onlyCopy` keeps only those shown to a person. */
function providerLiterals(file: string, rel: string, onlyCopy: boolean): Hit[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    // A registry's `exception:` field is a developer note, never rendered.
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'exception') return;
    if (isText(node) && namesAProvider(node.text).length > 0 && !inLogCall(node) && (!onlyCopy || inCopyPosition(node))) {
      hits.push({ file: rel, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text.trim().slice(0, 100) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The assistant does not work and nothing user-facing consumes it (CLAUDE.md): out of scope by path.
      if (['__tests__', 'node_modules', 'scripts'].includes(entry.name) || /copilot/.test(entry.name)) continue;
      sourceFiles(full, out);
    } else if (/\.ts$/.test(entry.name) && !/copilot/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !/^seed/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Files that answer a request in the Communication area, and the gates in front of them. */
const ANSWERS_A_REQUEST = /^(controllers\/(comm-|job-communications|organization-ctm|ctm-webhook|resend-webhook|call-tracking-webhook)|routes\/comm-|middleware\/(requirePhoneSetupOrg|requireFeature|canGuard))/;
/** The code behind them, where a literal is shown to a person only as an error or a piece of copy. */
const BEHIND_THEM = /^(lib\/(ctm|communication|email)|services\/(notifications|email|sms|automations)|controllers\/(comm-|job-communications|organization-ctm))/;

describe('no provider name reaches a user from the Communication section (server side)', () => {
  const files = sourceFiles(SRC).map((f) => ({ file: f, rel: path.relative(SRC, f) }));
  const answering = files.filter((f) => ANSWERS_A_REQUEST.test(f.rel));
  const behind = files.filter((f) => BEHIND_THEM.test(f.rel));

  it('scans a real set of files, and none of the assistant\'s', () => {
    expect(answering.length).toBeGreaterThan(15);
    expect(behind.length).toBeGreaterThan(30);
    expect(files.filter((f) => /copilot/.test(f.rel))).toEqual([]);
  });

  const unexplained = (hits: Hit[]) => hits.filter((h) => {
    const known = KNOWN_INTERNAL.find((k) => k.pattern.test(h.text));
    if (known) known.used = true;
    return !known;
  });

  it('no literal in a controller, route or gate of the section names a provider, except the internal ones listed', () => {
    const offenders = unexplained(answering.flatMap((f) => providerLiterals(f.file, f.rel, false)))
      .map((h) => `${h.file}:${h.line}  ${JSON.stringify(h.text)}`);
    expect(offenders).toEqual([]);
  });

  it('no error message or copy-bearing literal in the code behind the section names a provider', () => {
    const offenders = unexplained(behind.flatMap((f) => providerLiterals(f.file, f.rel, true)))
      .map((h) => `${h.file}:${h.line}  ${JSON.stringify(h.text)}`);
    expect(offenders).toEqual([]);
  });

  it('every internal literal listed still exists, so the list can only shrink', () => {
    answering.flatMap((f) => providerLiterals(f.file, f.rel, false)).forEach((h) => KNOWN_INTERNAL.forEach((k) => { if (k.pattern.test(h.text)) k.used = true; }));
    expect(KNOWN_INTERNAL.filter((k) => !k.used).map((k) => k.pattern.source)).toEqual([]);
    for (const k of KNOWN_INTERNAL) expect(k.reason.length).toBeGreaterThan(10);
  });

  it('every registered notification template renders without naming a provider', () => {
    const verbs = Object.keys(VERB_RULES);
    expect(verbs.length).toBeGreaterThan(20);
    const data = {
      amount: 125, invoice_number: 'I00001', estimate_number: 'E00001', customer_name: 'Pat Example', org_name: 'Example Org',
      reason: 'AMOUNT_MISMATCH', method: 'CARD', rate: 0.5, kind: 'invoice', caller_name: 'Pat Example', from_number: '+15555550100',
      to_number: '+15555550199', number_label: 'Main line', preview: 'Can you come Thursday?', subject: 'Quote', sender: 'Pat Example',
      job_number: 'J00001', lead_number: 'L00001', direction: 'inbound', channel: 'sms',
    };
    let rendered = 0;
    const offenders: string[] = [];
    for (const verb of verbs) {
      for (const variant of ['call', 'voicemail', 'text', 'email', 'card']) {
        for (const reason of ['AMOUNT_MISMATCH', 'NO_RECIPIENT', 'SMS_NOT_READY', 'NOT_CONNECTED']) {
          let t;
          try { t = renderTemplate(verb, { ...data, variant, reason }); } catch { continue; }
          rendered += 1;
          const text = `${t.title} ${t.body ?? ''}`;
          if (namesAProvider(text).length > 0) offenders.push(`${verb}/${variant}/${reason}: ${text.slice(0, 80)}`);
        }
      }
    }
    expect(rendered).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  describe('the scanner itself', () => {
    const planted = () => {
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')), 'sample.ts');
      fs.writeFileSync(tmp, [
        '// CTM in a comment',
        "logger.error('CTM request failed:', e);",
        "export const a = () => { throw new Error('The CTM account is down'); };",
        "export const b = (res: any) => res.status(409).json({ error: 'Texting waits on A2P approval' });",
        "export const c = { SMS_NOT_READY: 'Texting is not active until Twilio approves it' };",
        "export const d = { source: 'ctm' };",
      ].join('\n'));
      return tmp;
    };

    it('flags a name in an error, a response and a lookup table, and ignores a log line and a comment', () => {
      expect(providerLiterals(planted(), 'sample.ts', false).map((h) => h.text)).toEqual([
        'The CTM account is down', 'Texting waits on A2P approval', 'Texting is not active until Twilio approves it', 'ctm',
      ]);
    });

    it('in copy-only mode keeps what is thrown or sent and drops a stored value and a lookup table', () => {
      expect(providerLiterals(planted(), 'sample.ts', true).map((h) => h.text)).toEqual([
        'The CTM account is down', 'Texting waits on A2P approval',
      ]);
    });

    it('lets ordinary words through: resending, rendering and a sentry are not providers', () => {
      expect(namesAProvider('Resend the invoice')).toEqual([]);
      expect(namesAProvider('Rendering the page')).toEqual([]);
      expect(namesAProvider('Resend API key')).toEqual(['Resend']);
    });
  });
});
