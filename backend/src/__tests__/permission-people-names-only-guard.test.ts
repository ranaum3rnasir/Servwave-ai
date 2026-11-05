/* =============================================================================
   Roles & Permissions security, M3 (ticket 29): a guard, read from the source, so a new answer can't hand people's
   contact fields or the Admin flag to everyone.

   The people lists answer through `lib/users/peopleRow.ts`: an Admin gets the full record, everyone else names only.
   This guard reads the server code (controllers, routes, middleware, lib and services; not the copilot, not scripts or
   seeds) and finds each place a PERSON is read with their contact or Admin fields (email, phone, phone_ext, is_admin,
   has_login) or as a whole row:
     - a direct read of people (`.user.findMany`, `.findFirst`, `.findUnique`), with its select written in place, named
       (`select: someSelect`) or spread in (`select: { ...someSelect }`), from the same file or an imported one;
     - a person hanging off a record (any relation the schema points at the User model, e.g. `dispatcher: { select }`);
     - raw SQL that reads the users table with those fields.
   Every such read, one by one, must be named below with its field set, how many times it occurs and why. There is no
   exemption for a whole function: the people lists' non-Admin branches read `namesOnlySelect`, which carries none of the
   fields, and their Admin branches are named here. A new people list, a new person on a record carrying their email, or
   a new field on a named read fails until someone decides, on purpose, what a non-Admin gets.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative } from 'path';

const SRC = join(__dirname, '..');
const SCHEMA = readFileSync(join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');

/** Where answers, alerts and mail are built. The copilot is dead code (CLAUDE.md); scripts and seeds never answer anyone. */
const SCANNED = ['controllers', 'routes', 'middleware', 'lib', 'services'];
const NOT_SCANNED = [join('services', 'copilot')];

/** The fields that make a person's row more than a name: how to reach them, and whether they are an Admin. */
const CONTACT = /\b(email|phone|phone_ext|is_admin|has_login)\s*:\s*true\b/g;
const CONTACT_COLUMN = /\b(email|phone|phone_ext|is_admin|has_login)\b/gi;

/** Every field name the schema points at the User model, and the names some model also uses for a plain column. */
function userRelationNames(schema: string): { relations: string[]; alsoScalar: Set<string> } {
  const relations = new Set<string>();
  const scalars = new Set<string>();
  for (const model of schema.matchAll(/^model \w+ \{([\s\S]*?)^\}/gm)) {
    for (const line of model[1]!.split('\n')) {
      const [name, type] = line.trim().split(/\s+/);
      if (!name || !type || name.startsWith('//') || name.startsWith('@@')) continue;
      if (/^User\??(\[\])?$/.test(type)) relations.add(name);
      else scalars.add(name);
    }
  }
  return { relations: [...relations].sort(), alsoScalar: new Set([...relations].filter((r) => scalars.has(r))) };
}
const { relations: USER_RELATIONS, alsoScalar: ALSO_SCALAR } = userRelationNames(SCHEMA);

/** The balanced `open`…`close` block starting at `at` (which holds `open`). */
function blockAt(src: string, at: number, open: string, close: string): string {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

const FUNCTION_START = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*[=:]/gm;

/** The top-level function or constant a position sits in. */
function enclosing(src: string, pos: number): string {
  let name = '<top>';
  for (const m of src.matchAll(FUNCTION_START)) {
    if (m.index! > pos) break;
    name = (m[1] ?? m[2])!;
  }
  return name;
}

/** A source file as the scan sees it: its text, and where it lives (to follow its imports). */
type Source = { text: string; path: string | null };

/** The file an import names, if it is one of ours. */
function importedFile(from: Source, spec: string): Source | null {
  if (!from.path || !spec.startsWith('.')) return null;
  const base = join(dirname(from.path), spec.replace(/\.js$/, ''));
  for (const path of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(path)) return { text: readFileSync(path, 'utf8'), path };
  }
  return null;
}

/** The `{ … }` a constant is declared as, in this file or the file it is imported from. Null when it can't be seen. */
function constantBlock(name: string, from: Source, depth = 0): string | null {
  if (depth > 4) return null;
  const decl = new RegExp(`\\bconst\\s+${name}\\b[^=;]*=\\s*\\{`).exec(from.text);
  if (decl) return expandSpreads(blockAt(from.text, decl.index + decl[0].length - 1, '{', '}'), from, depth + 1);
  for (const imp of from.text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    for (const part of imp[1]!.split(',')) {
      const [original, local] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if ((local ?? original) !== name || !original) continue;
      const file = importedFile(from, imp[2]!);
      return file ? constantBlock(original, file, depth + 1) : null;
    }
  }
  return null;
}

/** A block with every `...someConstant` replaced by what that constant holds. One the scan can't see counts as contact. */
function expandSpreads(block: string, from: Source, depth = 0): string {
  return block.replace(/\.\.\.([A-Za-z_]\w*)\b(?!\s*\()/g, (_all, name: string) => constantBlock(name, from, depth) ?? 'email: true /* unseen */');
}

/** Every select inside a piece of source: written in place, named, or spread in, each expanded. */
function selectBlocks(args: string, from: Source): string[] {
  const inPlace = [...args.matchAll(/\bselect\s*:\s*\{/g)].map((m) => expandSpreads(blockAt(args, m.index! + m[0].length - 1, '{', '}'), from));
  const named = [...args.matchAll(/\bselect\s*:\s*([A-Za-z_]\w*)/g)].map((m) => constantBlock(m[1]!, from) ?? 'email: true /* unseen */');
  return [...inPlace, ...named];
}

/** Leaves out every `include: { … }` block: an include adds relations to the WHOLE row, it never narrows it. */
function withoutIncludes(args: string): string {
  let out = args;
  for (let m = /\binclude\s*:\s*\{/.exec(out); m; m = /\binclude\s*:\s*\{/.exec(out)) {
    const body = blockAt(out, m.index + m[0].length - 1, '{', '}');
    out = out.slice(0, m.index) + out.slice(m.index + m[0].length - 1 + body.length);
  }
  return out;
}

const fieldsIn = (text: string, pattern: RegExp) => [...new Set([...text.matchAll(pattern)].map((x) => x[1]!.toLowerCase()))].sort();

/** Each read of a person's contact or Admin fields in one file, as `file › function: fields`. */
function personReadsIn(file: string, from: Source): string[] {
  // A `_count` of a relation is a number, not a person.
  const src = from.text.replace(/_count\s*:\s*\{\s*select\s*:\s*\{[^{}]*\}\s*\}/g, '');
  const found: string[] = [];
  const add = (pos: number, fields: string[]) => found.push(`${file} › ${enclosing(src, pos)}: ${fields.join(',')}`);

  for (const m of src.matchAll(/\.user\.(findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow)\(/g)) {
    const args = withoutIncludes(blockAt(src, m.index! + m[0].length - 1, '(', ')'));
    const selects = selectBlocks(args, from);
    // No select at all reads the whole person, contact fields and Admin flag included.
    const fields = selects.length ? fieldsIn(selects.join('\n'), CONTACT) : ['<whole row>'];
    if (fields.length) add(m.index!, fields);
  }

  const relation = new RegExp(`\\b(${USER_RELATIONS.join('|')})\\s*:\\s*(\\{\\s*select\\s*:|true\\b)`, 'g');
  for (const m of src.matchAll(relation)) {
    if (m[2] === 'true') {
      // `name: true` on a relation is the whole person; on a plain column of the same name it is just that column.
      if (!ALSO_SCALAR.has(m[1]!)) add(m.index!, ['<whole row>']);
      continue;
    }
    const body = expandSpreads(blockAt(src, src.indexOf('{', m.index! + m[1]!.length), '{', '}'), from);
    const fields = fieldsIn(body, CONTACT);
    if (fields.length) add(m.index!, fields);
  }

  // Raw SQL: any template text that reads the users table together with one of the fields.
  for (const m of src.matchAll(/`[^`]*`/g)) {
    if (!/\b(from|join)\s+(?:"?public"?\.)?"?users"?(?:\s|$|")/i.test(m[0])) continue;
    const fields = fieldsIn(m[0], CONTACT_COLUMN);
    if (fields.length) add(m.index!, [`raw SQL ${fields.join(',')}`]);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  if (NOT_SCANNED.some((skip) => relative(SRC, dir) === skip)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

const FILES = SCANNED.flatMap((dir) => sourceFiles(join(SRC, dir)));

/** Every read the scan finds, with how many times each `file › function: fields` occurs. */
function countReads(reads: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of reads) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
}
const FOUND = countReads(FILES.flatMap((path) => personReadsIn(relative(SRC, path), { text: readFileSync(path, 'utf8'), path })));

// ── The reasons, once each ──────────────────────────────────────────────────────────────────────────────────────
const ON_RECORD = 'Kept by ruling Q2 (ticket 29): a person already on a record keeps the fields its call and email actions use.';
const CHECK = 'Read to decide or validate something (eligibility, the Admin flag, a refusal, a match); not put in the answer.';
const MAIL = 'Read to send that person an email, text, call or alert; not put in the answer.';
const OWN = 'The signed-in person\'s own record or sign-in (or the invitee\'s own invite); never a colleague\'s.';
const ADMIN = 'Behind an Admin-only route (requireAdmin, requireSpiderAdmin or the Owner): only an Admin gets the answer.';
const ADMIN_BRANCH = 'The Admin branch of a people list: runs only when seesFullPeopleRecords(req) is true; the other branch reads namesOnlySelect.';
const PICKUP_TICKET = 'Kept by ruling Q4 (ticket 29): the inventory roster carries the email only to Edit stock holders, for the pickup-ticket email.';
const NOT_ANSWERED = 'Server-side only (a job, a sync, a cleanup or a merge field); never put in an answer to a person.';
const CHECK_THEN_MAIL = 'Read to check eligibility, then to alert or email the people named; not put in the answer.';
const ON_RECORD_CALENDAR = 'Calendar-entry participants are people on a record, the same kind as ruling Q2 (ticket 29); left unchanged and raised with the conductor.';
const TEAMMATE = 'Ruling Q3 b1 (ticket 29): teammates named by id resolve to addresses on the server for the send; the address never goes in the answer.';

/**
 * Every read of a person's contact or Admin fields, keyed `file › function: fields`, with why it is fine. A number after
 * the reason is how many such reads that function holds (one when absent). Adding or widening a line here is a decision
 * about what a non-Admin gets: make it on purpose.
 */
const ALLOWED: Record<string, string | [string, number]> = {
  'controllers/auth.controller.ts › acceptInvite: email,has_login': OWN,
  'controllers/auth.controller.ts › acceptInviteTerms: email,has_login': OWN,
  'controllers/auth.controller.ts › getInvite: email,has_login,phone,phone_ext': OWN,
  'controllers/auth.controller.ts › login: email': OWN,
  'controllers/auth.controller.ts › mfaEnable: email': OWN,
  'controllers/auth.controller.ts › mfaResend: email': OWN,
  'controllers/comm-agents.controller.ts › getPhoneAgent: email': ON_RECORD,
  'controllers/comm-agents.controller.ts › listPhoneAgents: email': ON_RECORD,
  'controllers/comm-agents.controller.ts › listTeamMembers: email': ADMIN_BRANCH,
  'controllers/comm-calls.controller.ts › createCall: phone,phone_ext': OWN,
  'controllers/comm-threads.controller.ts › resolveSmsDestination: phone': MAIL,
  'controllers/comm-whatsapp-email.controller.ts › assignEmailThread: is_admin': CHECK,
  'controllers/inv-assets.controller.ts › loadTargetUser: <whole row>': CHECK,
  'controllers/inv-po.controller.ts › PO_INCLUDE: email': ON_RECORD,
  'controllers/inv-techs-jobs.controller.ts › listTechs: <whole row>': PICKUP_TICKET,
  'controllers/job.controller.ts › dispatchTechUnassigned: email,phone': MAIL,
  'controllers/job.controller.ts › jobDetailSelect: email': ON_RECORD,
  'controllers/job.controller.ts › jobDetailSelect: email,phone': [ON_RECORD, 3],
  'controllers/job.controller.ts › jobListSelect: phone': ON_RECORD,
  'controllers/job.controller.ts › jobSlotRefusal: is_admin': CHECK,
  'controllers/job.controller.ts › rescheduleVisit: phone,phone_ext': NOT_ANSWERED,
  'controllers/job.controller.ts › setDispatcher: is_admin': CHECK,
  'controllers/job.controller.ts › setSoldBy: is_admin': CHECK,
  'controllers/job.controller.ts › stampedVisitOccurrence: phone,phone_ext': NOT_ANSWERED,
  'controllers/job.controller.ts › validateCrew: email,is_admin,phone,phone_ext': CHECK_THEN_MAIL,
  'controllers/job.controller.ts › visitMilestoneHandler: phone,phone_ext': NOT_ANSWERED,
  'controllers/lead.controller.ts › dispatchWalkthroughPerformerRemoved: email,phone': MAIL,
  'controllers/lead.controller.ts › dispatcherRefusal: is_admin': CHECK,
  'controllers/lead.controller.ts › leadDetailSelect: email': [ON_RECORD, 3],
  'controllers/lead.controller.ts › leadListSelect: phone': ON_RECORD,
  'controllers/lead.controller.ts › ownerRefusal: is_admin': CHECK,
  'controllers/lead.controller.ts › setDispatcher: is_admin': CHECK,
  'controllers/password-reset.controller.ts › sendMyPasswordLink: email,has_login': OWN,
  'controllers/password-reset.controller.ts › sendUserPasswordReset: email,has_login,is_admin': ADMIN,
  'controllers/service-plan.controller.ts › scheduleVisit: is_admin': CHECK,
  'controllers/spider.controller.ts › getSpiderHistoryFilters: email': ADMIN,
  'controllers/spider.controller.ts › historyItems: email': ADMIN,
  'controllers/task.controller.ts › entityAccess: is_admin': CHECK,
  'controllers/task.controller.ts › update: email,phone': MAIL,
  'controllers/task.controller.ts › watchersOutsidePool: is_admin': CHECK,
  'controllers/timeclock.controller.ts › createOtReview: <whole row>': CHECK,
  'controllers/user-avatar.controller.ts › resolveTargetUser: is_admin': CHECK,
  'controllers/user-mailbox.controller.ts › moveUserMailbox: is_admin': ADMIN,
  'controllers/user.controller.ts › answerRevoke: email,has_login,is_admin,phone,phone_ext': ADMIN,
  'controllers/user.controller.ts › changeMyPassword: email,has_login': OWN,
  'controllers/user.controller.ts › deactivate: <whole row>': ADMIN,
  'controllers/user.controller.ts › erasePersonalData: email,is_admin': ADMIN,
  'controllers/user.controller.ts › getById: email,has_login,is_admin,phone,phone_ext': ADMIN_BRANCH,
  'controllers/user.controller.ts › invite: email,is_admin': ADMIN,
  'controllers/user.controller.ts › list: email,has_login,is_admin,phone,phone_ext': ADMIN_BRANCH,
  'controllers/user.controller.ts › lockPersonForChange: is_admin': CHECK,
  'controllers/user.controller.ts › permanentDelete: email,is_admin': ADMIN,
  'controllers/user.controller.ts › revokeLogin: email,has_login,is_admin,phone,phone_ext': ADMIN,
  'controllers/user.controller.ts › revokeLogin: has_login': [ADMIN, 2],
  'controllers/user.controller.ts › revokeOutcome: has_login': ADMIN,
  'controllers/user.controller.ts › update: <whole row>': ADMIN,
  'controllers/workflow.controller.ts › testWorkflow: email': OWN,
  'lib/auth-user.ts › resolveAppUser: email,has_login,is_admin,phone,phone_ext': [OWN, 2],
  'lib/auth-user.ts › stillMaySignIn: raw SQL has_login': CHECK,
  'lib/calendar-entries/participants.ts › resolveParticipantDisplay: email': ON_RECORD_CALENDAR,
  'lib/ctm/ingest.ts › ingestCall: email': NOT_ANSWERED,
  'lib/ctm/ingest.ts › resolveAssignedAnswerer: email': NOT_ANSWERED,
  'lib/ctm/ingest.ts › resolveExternalAnswerer: email,phone': NOT_ANSWERED,
  'lib/ctm/smsThread.ts › matchActiveStaffByPhone: email,phone': CHECK,
  'lib/e2e-org.ts › teardownTestOrg: email': NOT_ANSWERED,
  // Re-audit N8: whether a mailbox being handed on came from an Admin (then it is the Owner's to hand on).
  'lib/mailbox/handover.ts › handOverMailbox: is_admin': CHECK,
  'lib/password-reset.ts › requestPasswordReset: email': MAIL,
  // Ticket 37: the access stamp read on every request (the sign-in and switch caches key on it); the person's own row.
  'lib/permissions/accessStamp.ts › readAccessStamp: raw SQL has_login,is_admin': CHECK,
  'lib/permissions/alertSomeone.ts › alertSomeone: is_admin': CHECK,
  'lib/permissions/conversionPeople.ts › resolveConversionPeople: is_admin': CHECK,
  'lib/permissions/logisticOrderApprovers.ts › peopleWhoCanReachOrder: is_admin': CHECK,
  'lib/permissions/switchHolders.ts › activeSwitchHolders: is_admin': CHECK,
  'lib/permissions/switches/store.ts › countPeopleByRole: is_admin': CHECK,
  'lib/permissions/switches/store.ts › loadPerson: is_admin': CHECK,
  'lib/permissions/switches/store.ts › presetRoleOfPerson: is_admin': CHECK,
  'lib/permissions/switches/store.ts › resolveSwitches: is_admin': CHECK,
  'lib/permissions/switches/store.ts › resolveSwitchesForPeople: is_admin': CHECK,
  'lib/users/admin-change-alert.ts › alertOwnerOfAdminChange: email': MAIL,
  'lib/users/openRecords.ts › announceTaskTakeovers: email,phone': MAIL,
  'lib/users/openRecords.ts › reassignOpenRecords: is_admin': CHECK,
  'lib/users/owner-handover.ts › approveOwnerHandover: email': MAIL,
  'lib/users/owner-handover.ts › requestOwnerHandover: email': MAIL,
  'lib/users/owner.ts › refuseUnlessOwnerForPerson: is_admin': CHECK,
  'lib/users/teammateAddresses.ts › teammateAddresses: email': TEAMMATE,
  'services/automations/context.ts › loadEntityBundle: email,phone': [NOT_ANSWERED, 6],
  'services/automations/context.ts › loadEntityBundle: email,phone,phone_ext': [NOT_ANSWERED, 2],
  'services/automations/context.ts › loadTaskPeople: email,phone': NOT_ANSWERED,
  'services/automations/priceMergeFields.ts › staffWithoutSeePrices: email,is_admin': CHECK_THEN_MAIL,
  'services/automations/recipients.ts › resolveAudienceKey: email,phone': [MAIL, 2],
  'services/notifications/conversationAlertRecipients.ts › conversationAlertAudience: is_admin': CHECK,
  'services/notifications/emailReplyAlerts.ts › ringReplyPeople: is_admin': CHECK,
  'services/notifications/filterByAccess.ts › filterByConversationAccess: is_admin': CHECK,
  'services/notifications/filterByAccess.ts › filterRecipientsByAccess: is_admin': CHECK,
  'services/notifications/stepHolderEmails.ts › stepHolderEmails: email': MAIL,
  'services/payment-reconciler/checkout-effects.ts › CHECKOUT_INVOICE_SELECT: email': MAIL,
  'services/spider/recipients.ts › resolveSpiderRecipients: email,phone': [MAIL, 2],
  'services/walkthrough.service.ts › validatePerformers: email,is_admin,phone': CHECK_THEN_MAIL,
};

const expectedCounts = () => Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, Array.isArray(v) ? v[1] : 1]));

describe('a person\'s contact fields and Admin flag reach an answer only on purpose (M3, ticket 29)', () => {
  it('reads the server code it says it does, and finds person reads in it (the scan is reading real source)', () => {
    const scanned = FILES.map((f) => relative(SRC, f));
    for (const dir of SCANNED) expect(scanned.some((f) => f.startsWith(`${dir}/`)), dir).toBe(true);
    expect(scanned.some((f) => f.startsWith('services/copilot/'))).toBe(false);
    expect(Object.keys(FOUND).length).toBeGreaterThan(40);
  });

  it('names every read of a person\'s contact or Admin fields, as often as it occurs, with its reason (and nothing that is gone)', () => {
    expect(FOUND).toEqual(expectedCounts());
  });

  it('the people list, a person\'s details and the team list read names only unless the requester is an Admin', () => {
    const read = (file: string, fn: string) => {
      const src = readFileSync(join(SRC, file), 'utf8');
      const start = src.search(new RegExp(`^export async function ${fn}\\(`, 'm'));
      return blockAt(src, src.indexOf('{', src.indexOf(')', start)), '{', '}');
    };
    for (const [file, fn] of [['controllers/user.controller.ts', 'list'], ['controllers/user.controller.ts', 'getById'], ['controllers/comm-agents.controller.ts', 'listTeamMembers']] as const) {
      const body = read(file, fn);
      expect(body, `${file} › ${fn}`).toMatch(/if \(!seesFullPeopleRecords\(req\)\) \{/);
      // The non-Admin branch: the first block after the check, answered from the names-only select or mapper.
      const branch = blockAt(body, body.indexOf('{', body.indexOf('if (!seesFullPeopleRecords(req))')), '{', '}');
      expect(branch, `${file} › ${fn}`).toMatch(/namesOnly(Select|TeamMember)?\b/);
      expect(fieldsIn(branch, CONTACT), `${file} › ${fn}`).toEqual([]);
      expect(branch, `${file} › ${fn}`).toMatch(/return;\s*\}$/);
    }
    const users = readFileSync(join(SRC, 'routes', 'user.routes.ts'), 'utf8');
    expect(users).toMatch(/router\.get\('\/', [^\n]*userController\.list\)/);
    expect(users).toMatch(/router\.get\('\/:id', [^\n]*userController\.getById\)/);
    expect(readFileSync(join(SRC, 'routes', 'comm-shared.routes.ts'), 'utf8')).toMatch(/router\.get\('\/team-members', [^\n]*listTeamMembers\)/);
  });

  it('would fail for each shape a new leak could take (the guard can fail)', () => {
    const planted = `
import { userSelect } from './user.controller';
import { namesOnlySelect } from '../lib/users/peopleRow';
const CONTACT_SELECT = { email: true, phone: true };
export async function listCrewContacts(req, res) {
  res.json({ people: await prisma.user.findMany({ where: tenantWhere(req), select: { id: true, first_name: true, email: true } }) });
}
export async function listEveryone(req, res) {
  res.json({ people: await prisma.user.findMany({ where: tenantWhere(req) }) });
}
export const visitSelect = { assignees: { select: { user: { select: { id: true, phone: true } } } } };
export async function listBySpread(req, res) {
  res.json({ people: await prisma.user.findMany({ select: { id: true, ...CONTACT_SELECT } }) });
}
export async function listByImportedSpread(req, res) {
  res.json({ people: await prisma.user.findMany({ select: { ...userSelect } }) });
}
export async function leakyNonAdminBranch(req, res) {
  if (!seesFullPeopleRecords(req)) {
    res.json({ users: await prisma.user.findMany({ select: { id: true, first_name: true, email: true } }) });
    return;
  }
  res.json({ users: await prisma.user.findMany({ select: namesOnlySelect }) });
}
export async function rawRoster(orgId) {
  return prisma.$queryRaw\`SELECT id, first_name, email FROM users WHERE organization_id = \${orgId}\`;
}
export async function namesOnlyList(req, res) {
  res.json({ people: await prisma.user.findMany({ select: { id: true, first_name: true, last_name: true } }) });
}`;
    const plantedPath = join(SRC, 'controllers', 'planted.controller.ts');
    expect(personReadsIn('controllers/planted.controller.ts', { text: planted, path: plantedPath })).toEqual([
      'controllers/planted.controller.ts › listCrewContacts: email',
      'controllers/planted.controller.ts › listEveryone: <whole row>',
      'controllers/planted.controller.ts › listBySpread: email,phone',
      'controllers/planted.controller.ts › listByImportedSpread: email,has_login,is_admin,phone,phone_ext',
      'controllers/planted.controller.ts › leakyNonAdminBranch: email',
      'controllers/planted.controller.ts › visitSelect: phone',
      'controllers/planted.controller.ts › rawRoster: raw SQL email',
    ]);
  });
});
