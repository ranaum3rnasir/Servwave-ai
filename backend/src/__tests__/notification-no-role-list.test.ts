/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.29 - no alert is addressed by a role name any more.

   Two structural guards, so a later change cannot put one back:

   1. Every verb in the verb registry (VERB_RULES) is in VERBS_WITHOUT_ROLE_LISTS (the resolver tells the people the caller found,
      never a role). A verb added without a decision fails here. S10.10 moved the last verb off a role list (a customer's email
      reply), so there is no second set and no role-list loader any more.
   2. A scan of the notification code: no file under services/notifications compares a role name or reads a role to choose who is
      told.

   Automation recipients are a product feature (a rule can be addressed to "all admins"), not an alert role list: pinned below, and the
   automations folder is outside the scan by path.

   There is no database here; the real-database suites drive each alert through its door.
   ========================================================================== */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { VERB_RULES } from '../services/notifications/templates';
import { VERBS_WITHOUT_ROLE_LISTS } from '../services/notifications/resolveRecipients';
import { prisma } from '../lib/prisma';
import { resolveAudience, type AudienceContext } from '../services/automations/recipients';

const SRC = join(__dirname, '..');

describe('every alert verb is accounted for', () => {
  const allVerbs = Object.keys(VERB_RULES);

  it('is in the set that reads no role list, and there is no other set', () => {
    expect(allVerbs.filter((v) => !VERBS_WITHOUT_ROLE_LISTS.has(v))).toEqual([]);
  });

  it('has the communication alerts off every role list: calls and texts (S08.22, S08.23) and email (S10.10)', () => {
    for (const verb of ['communication.call_missed', 'communication.sms_inbound', 'communication.email_inbound']) {
      expect(VERBS_WITHOUT_ROLE_LISTS.has(verb), verb).toBe(true);
    }
  });

  it('lists no verb the registry does not know', () => {
    expect([...VERBS_WITHOUT_ROLE_LISTS].filter((v) => !allVerbs.includes(v))).toEqual([]);
  });
});

/**
 * What choosing a recipient by role looks like in code: a built-in role name in quotes, a role compared or filtered on, or the role
 * lists themselves. Returns what each file does that matches, so a failure names the line.
 */
export function findRoleBasedRecipients(files: Array<{ path: string; text: string }>): string[] {
  const patterns: Array<[string, RegExp]> = [
    ['a built-in role name', /['"`](ADMIN|DISPATCHER|SALES|TECHNICIAN)['"`]/],
    ['a role compared', /\.role\s*[!=]==?\s/],
    ['a role filter', /\brole\s*:\s*(\{|(?!true\b)[a-zA-Z_'"`])/],
    ['the role lists', /\b(loadRoleHolders|roleHolders|RoleHolders)\b/],
  ];
  const found: string[] = [];
  for (const file of files) {
    file.text.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*(\*|\/\*).*$/, '');
      for (const [what, re] of patterns) if (re.test(code)) found.push(`${file.path}:${i + 1} ${what}: ${line.trim()}`);
    });
  }
  return found;
}

const sourceFilesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFilesUnder(full);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });

describe('no alert recipient is computed from a role name', () => {
  const read = (dir: string) => sourceFilesUnder(join(SRC, dir)).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }));

  it('flags each way of choosing a recipient by role (the scan can fail)', () => {
    const flagged = (text: string) => findRoleBasedRecipients([{ path: 'x.ts', text }]).length;
    expect(flagged("const admins = await prisma.user.findMany({ where: { organization_id, role: 'ADMIN' } });")).toBe(2);
    expect(flagged('const admins = users.filter((u) => u.role === admin);')).toBe(1);
    expect(flagged('const ids = roleHolders.ADMIN;')).toBe(1);
    expect(flagged("if (user.role == 'DISPATCHER') tell(user);")).toBeGreaterThan(0);
    // Words in a comment are not code.
    expect(flagged("// every Admin and Dispatcher used to be told ('ADMIN')\n * role: 'ADMIN' was the old rule")).toBe(0);
  });

  it('finds none anywhere in the notification code: no file reads a role list any more', () => {
    const files = read('services/notifications');
    expect(files.length).toBeGreaterThan(10);
    expect(findRoleBasedRecipients(files)).toEqual([]);
  });

  it('has the customer email reply alert (S10.10) name people by what they may read and hold, never by a role', () => {
    const alert = read('services/notifications').filter((f) => f.path === 'services/notifications/emailReplyAlerts.ts');
    expect(alert).toHaveLength(1);
    expect(alert[0]!.text).toMatch(/readersOfConversation\(/);
    // Its last fallback is the company's Admins, by the Admin flag (AL-18), never a role name.
    expect(alert[0]!.text).toMatch(/people\.filter\(isSuperUser\)/);
    expect(findRoleBasedRecipients(alert)).toEqual([]);
  });

  it('has the call and text fallback (S08.24) name the company\'s Admins by the flag, never a role', () => {
    const fallback = read('services/notifications').filter((f) => f.path === 'services/notifications/conversationAlertFallback.ts');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.text).toMatch(/activeAdmins\(organizationId\)/);
    expect(findRoleBasedRecipients(fallback)).toEqual([]);
  });

  it('lets only the customer email reply alert tell people without asking the access filter again (readersChecked)', () => {
    // `readersChecked` skips emit's row-scope filter for people already put through the single read of the conversation, so no other
    // door may set it: a caller handing in unchecked ids would bypass the filter.
    const setters = sourceFilesUnder(SRC)
      .map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }))
      .filter((f) => /readersChecked\s*:/.test(f.text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')))
      .map((f) => f.path)
      .sort();
    expect(setters).toEqual(['services/notifications/emailReplyAlerts.ts']);
  });

  it('finds none in the code that sends the moved alerts or the owner emails', () => {
    const paths = [
      'lib/owner-payment-notices.ts', 'lib/payments-notifications.ts', 'lib/unapplied-capture.ts',
      'services/payment-reconciler/checkout-effects.ts', 'services/payment-reconciler/index.ts',
      'controllers/auth.controller.ts', 'controllers/inv-po.controller.ts', 'controllers/inv-stages.controller.ts',
      'controllers/inv-stock.controller.ts', 'controllers/price-book.controller.ts',
      'controllers/resend-webhook.controller.ts',
    ];
    const files = paths.map((p) => ({ path: p, text: readFileSync(join(SRC, p), 'utf8') }));
    const hits = findRoleBasedRecipients(files);
    // auth.controller reads roles to sign people in, not to choose who is told.
    expect(hits.filter((h) => !h.startsWith('controllers/auth.controller.ts'))).toEqual([]);
  });
});

// Automation recipients are a product feature: a rule can be addressed to all admins or all dispatchers, whatever the alert rules say.
// They live outside services/notifications, so the scan above does not reach them; this pins that they are unchanged.
describe('automation recipients are unchanged', () => {
  beforeEach(() => vi.clearAllMocks());
  const ctx = (): AudienceContext => ({
    organizationId: 'org-1', entity: 'job', customer: null, assignees: [], watchers: [], dispatcher: null, salesperson: null, creator: null, eventRecipient: null,
  });

  // "All admins" is the people with the Admin flag (P15); "all dispatchers" is still the active people on the Dispatcher role.
  it.each([['all_admins', { is_admin: true }], ['all_dispatchers', { role: 'DISPATCHER' }]] as const)('%s still means the active people it always meant', async (key, who) => {
    (prisma.user.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'u1', email: 'u1@example.test', first_name: 'A', last_name: 'B', phone: null }]);
    const audience = await resolveAudience(key, ctx());
    expect(audience.users.map((u) => u.id)).toEqual(['u1']);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { organization_id: 'org-1', ...who, is_active: true } }));
  });
});

// There is no per-role notification setting: no table or column keyed by role holds a notification preference, and the notification
// routes are the person's own bell (list, counts, read, act, dismiss) and nothing that sets what a role is told.
describe('there are no per-role notification settings', () => {
  it('has no notification or alert model with a role column', () => {
    const schema = readFileSync(join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1]!, body: m[2]! }));
    const aboutNotifying = models.filter((m) => /notif|alert/i.test(m.name));
    expect(aboutNotifying.map((m) => m.name).sort()).toEqual(['Notification', 'NotificationRecipient', 'SpiderAlert']);
    for (const m of aboutNotifying) {
      expect(m.body.split('\n').filter((l) => /^\s*(\w*role\w*)\s/i.test(l)), m.name).toEqual([]);
    }
  });

  it('has notification routes for the signed-in person\'s own bell only', () => {
    const routes = readFileSync(join(SRC, 'routes', 'notification.routes.ts'), 'utf8');
    const verbs = [...routes.matchAll(/router\.(get|post|patch|put|delete)\('([^']*)'/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    expect(verbs).toEqual(['get /', 'get /unread-count', 'patch /:id/act', 'patch /:id/dismiss', 'patch /:id/read', 'patch /seen', 'post /read-all'].sort());
  });
});
