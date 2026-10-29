import { isTerminalTaskStatus, type LinkedEntity, type TaskPerson, type TaskPriority, type Task } from './types';
import { assessRisk, rankMyDay, computeStats } from './tasks-logic';

export interface ParseContext {
  people: TaskPerson[];
  entities: LinkedEntity[];
  now: Date;
}

export interface ParsedTask {
  title: string;
  /**
   * The single person the NL parser recognised in the sentence ("remind Oved
   * to..."), NOT a Task field - the create dialogs seed their assignee
   * multi-select from it. Left single-valued deliberately: the parser matches
   * one first name and multi-assignee parsing is out of scope for this change.
   */
  assignee_id?: string;
  due_at: string | null;
  linked_entity: LinkedEntity | null;
  priority: TaskPriority;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY = 24 * 60 * 60 * 1000;

function nextWeekday(now: Date, target: number): Date {
  const d = new Date(now);
  let add = (target - d.getUTCDay() + 7) % 7;
  if (add === 0) add = 7;
  d.setUTCDate(d.getUTCDate() + add);
  d.setUTCHours(17, 0, 0, 0);
  return d;
}

function parseDue(text: string, now: Date): { due: string | null; matched: string | null } {
  const lower = text.toLowerCase();
  if (/\btoday\b/.test(lower)) { const d = new Date(now); d.setUTCHours(17, 0, 0, 0); return { due: d.toISOString(), matched: 'today' }; }
  if (/\btomorrow\b/.test(lower)) { const d = new Date(now.getTime() + DAY); d.setUTCHours(17, 0, 0, 0); return { due: d.toISOString(), matched: 'tomorrow' }; }
  if (/\bnext week\b/.test(lower)) { const d = new Date(now.getTime() + 7 * DAY); d.setUTCHours(17, 0, 0, 0); return { due: d.toISOString(), matched: 'next week' }; }
  for (let i = 0; i < WEEKDAYS.length; i++) {
    const day = WEEKDAYS[i] as string;
    if (new RegExp(`\\b${day}\\b`).test(lower)) return { due: nextWeekday(now, i).toISOString(), matched: day };
  }
  return { due: null, matched: null };
}

function matchPerson(text: string, people: TaskPerson[]): TaskPerson | undefined {
  const lower = text.toLowerCase();
  return people.find((p) => {
    const first = (p.name.split(' ')[0] ?? '').toLowerCase();
    return first.length > 0 && new RegExp(`\\b${first}\\b`).test(lower);
  });
}

function matchEntity(text: string, entities: LinkedEntity[]): LinkedEntity | null {
  const lower = text.toLowerCase();
  let best: LinkedEntity | null = null;
  let bestScore = 0;
  for (const e of entities) {
    if (lower.includes(e.id.toLowerCase())) return e;
    // Split label into primary name (before separator) and description (after)
    const parts = e.label.split(/\s*[—–-]\s*/);
    const primaryWords = (parts[0] ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const descWords = (parts[1] ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const primaryMatches = primaryWords.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)).length;
    const descMatches = descWords.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)).length;
    // Bonus: primary name word appears followed by entity-reference context words
    const contextBonus = primaryWords.some((w) =>
      new RegExp(`\\b${w}\\s+(job|lead|customer|estimate|project|install|quote)\\b`).test(lower)
    ) ? 2 : 0;
    const score = primaryMatches * 3 + contextBonus + descMatches;
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
}

function detectPriority(text: string): TaskPriority {
  const lower = text.toLowerCase();
  if (/\b(urgent|asap|emergency)\b/.test(lower)) return 'URGENT';
  if (/\b(high priority|important)\b/.test(lower)) return 'HIGH';
  return 'MEDIUM';
}

function cleanTitle(text: string, removed: string[]): string {
  let t = text;
  for (const r of removed) {
    if (!r) continue;
    t = t.replace(new RegExp(`\\b${r}\\b`, 'ig'), ' ');
  }
  t = t.replace(/\b(remind|tell|ask|please|to|by|for the|for|the|on|urgent|asap|:)\b/ig, ' ');
  return t.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function parse(text: string, ctx: ParseContext): ParsedTask {
  const person = matchPerson(text, ctx.people);
  const entity = matchEntity(text, ctx.entities);
  const { due, matched } = parseDue(text, ctx.now);
  const priority = detectPriority(text);

  const anythingMatched = person || entity || due;
  let title: string;
  if (anythingMatched) {
    const removed: string[] = [person ? (person.name.split(' ')[0] ?? '') : '', matched ?? ''];
    title = cleanTitle(text, removed);
    if (!title) title = text.trim();
  } else {
    title = text.trim();
  }

  return { title, assignee_id: person?.id, due_at: due, linked_entity: entity, priority };
}

function rollup(tasks: Task[], now: Date): string {
  const s = computeStats(tasks, now);
  const parts: string[] = [];
  const lastTrend = s.trend[s.trend.length - 1];
  const doneThisWeek = lastTrend?.done ?? 0;
  // "completed", not "closed": the trend line counts completions only, and now that a task can
  // close by being cancelled the looser word would over-claim what the number describes.
  parts.push(`${doneThisWeek} task${doneThisWeek === 1 ? '' : 's'} completed this week`);
  if (s.blocked > 0) parts.push(`${s.blocked} blocked on parts/customer`);
  const overloaded = s.byAssignee.find((a) => a.open >= 8);
  if (overloaded) parts.push(`assignee ${overloaded.userId} is overloaded (${overloaded.open} open)`);
  if (s.atRisk > 0) parts.push(`${s.atRisk} at risk of slipping`);
  return parts.join('. ') + '.';
}

const TASK_TEMPLATES: Record<string, string[]> = {
  'access control': ['Order parts/controller', 'Schedule install crew', 'Confirm scope with customer', 'Program access panel', 'Enroll badges', 'Test & close out'],
  'cctv': ['Confirm camera count & locations', 'Order cameras/NVR', 'Schedule install', 'Run cabling', 'Configure remote viewing', 'Walk through with customer'],
  'alarm': ['Confirm zones & sensors', 'Order alarm kit', 'Schedule install', 'Program panel', 'Central station test', 'Customer training'],
  'av': ['Confirm AV scope', 'Order equipment', 'Schedule install', 'Mount & wire', 'Calibrate', 'Demo to customer'],
  'hvac': ['Confirm load & equipment specs', 'Order unit & materials', 'Schedule install crew', 'Set & connect unit', 'Charge & commission system', 'Walk through & close out'],
  'plumbing': ['Confirm scope & fixtures', 'Order parts', 'Schedule the work', 'Shut off & rough-in', 'Set fixtures & test', 'Clean up & close out'],
  'electrical': ['Confirm scope & load', 'Pull permit if required', 'Order materials', 'Schedule crew', 'Rough-in & wire', 'Inspect, test & close out'],
};

function suggestTasks(jobType: string): { title: string }[] {
  const key = Object.keys(TASK_TEMPLATES).find((k) => jobType.toLowerCase().includes(k));
  const titles: string[] = key ? (TASK_TEMPLATES[key] ?? []) : ['Confirm scope with customer', 'Order required parts', 'Schedule the work', 'Complete & close out'];
  return titles.map((title) => ({ title }));
}

function suggestAssignee(tasks: Task[], candidateIds: string[]): { userId: string; reason: string } {
  const openCount = (uid: string) =>
    tasks.filter((t) => t.assignee_ids.includes(uid) && !isTerminalTaskStatus(t.status)).length;
  const ranked = [...candidateIds].sort((a, b) => openCount(a) - openCount(b));
  const pick = ranked[0] ?? '';
  return { userId: pick, reason: `lightest load (${openCount(pick)} open tasks)` };
}

export interface TaskAI {
  parse: typeof parse;
  rollup: typeof rollup;
  suggestTasks: typeof suggestTasks;
  suggestAssignee: typeof suggestAssignee;
  assessRisk: typeof assessRisk;
  rankMyDay: typeof rankMyDay;
}

export const taskAI: TaskAI = { parse, rollup, suggestTasks, suggestAssignee, assessRisk, rankMyDay };
