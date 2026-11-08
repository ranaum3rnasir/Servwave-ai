import type { Task, TaskPerson, LinkedEntity } from './types';

// "now" anchor the UI uses so the seeded relative dates stay meaningful.
export const MOCK_NOW = new Date('2026-06-07T12:00:00.000Z');

export const MOCK_DEPARTMENTS: { id: string; name: string }[] = [
  { id: 'mgmt',      name: 'Management' },
  { id: 'field',     name: 'Field' },
  { id: 'sales',     name: 'Sales' },
  { id: 'logistics', name: 'Logistics' },
];

export const MOCK_PEOPLE: TaskPerson[] = [
  { id: 'u_emanuel', name: 'Emanuel Dahan', role: 'admin',     department: 'mgmt' },
  { id: 'u_priya',   name: 'Priya',         role: 'manager',   department: 'mgmt' },
  { id: 'u_oved',    name: 'Oved Adani',    role: 'tech',      department: 'field' },
  { id: 'u_sagiv',   name: 'Sagiv Peker',   role: 'logistics', department: 'logistics' },
  { id: 'u_shani',   name: 'Shani Adani',   role: 'sales',     department: 'sales' },
  { id: 'u_ohad',    name: 'Ohad',          role: 'tech',      department: 'field' },
];

// `redacted` is spelled out rather than left off, so a demo row carries the same key set
// `mapRowToTask` produces. A fixture quietly missing a field is how a renderer ends up only ever
// exercised against a shape the API never sends.
export const MOCK_ENTITIES: LinkedEntity[] = [
  { type: 'JOB', id: 'J00934', label: 'Access Control — 194 NJ-17, Paramus', redacted: false },
  { type: 'JOB', id: 'J00953', label: 'Glass/AV — 702 Jersey Ave, Elizabeth', redacted: false },
  { type: 'LEAD', id: 'L00021', label: 'Limon — CCTV install', redacted: false },
  { type: 'CUSTOMER', id: 'C00088', label: 'Gail — 650 E Glen Ave, Ridgewood', redacted: false },
  { type: 'ESTIMATE', id: 'E00012', label: 'Alarm System — Steve', redacted: false },
];

const iso = (d: string) => new Date(d).toISOString();

function base(n: number, over: Partial<Task>): Task {
  const num = `T${String(n).padStart(5, '0')}`;
  return {
    id: `t_${n}`, task_number: num, title: '', description: '',
    status: 'TODO', priority: 'MEDIUM',
    assignee_ids: ['u_oved'], assignees: [{ id: 'u_oved', name: personName('u_oved') }],
    watcher_ids: [],
    due_at: null, linked_entity: null, tags: [], subtasks: [],
    created_by: 'u_emanuel', created_at: iso('2026-06-01T09:00:00Z'),
    updated_at: iso('2026-06-03T09:00:00Z'), completed_at: null,
    activity: [{ id: `a_${n}`, type: 'created', actor_id: 'u_emanuel', at: iso('2026-06-01T09:00:00Z') }],
    comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...over,
  };
}

// Spread of statuses, priorities, due dates (overdue / today / soon / future / done).
export const MOCK_TASKS: Task[] = [
  base(1, { title: 'Order glass for the Limon job', assignee_ids: ['u_sagiv'], assignees: [{ id: 'u_sagiv', name: personName('u_sagiv') }], status: 'IN_PROGRESS', priority: 'HIGH',
    due_at: iso('2026-06-06T17:00:00Z'), linked_entity: MOCK_ENTITIES[2], tags: ['parts'], watcher_ids: ['u_priya'],
    updated_at: iso('2026-06-02T09:00:00Z') }),
  base(2, { title: 'Confirm install window with customer', assignee_ids: ['u_shani'], assignees: [{ id: 'u_shani', name: personName('u_shani') }], status: 'TODO', priority: 'URGENT',
    due_at: iso('2026-06-07T20:00:00Z'), linked_entity: MOCK_ENTITIES[1] }),
  base(3, { title: 'Program access control panel', assignee_ids: ['u_oved'], assignees: [{ id: 'u_oved', name: personName('u_oved') }], status: 'IN_PROGRESS', priority: 'MEDIUM',
    due_at: iso('2026-06-10T17:00:00Z'), linked_entity: MOCK_ENTITIES[0],
    subtasks: [{ id: 's1', text: 'Wire reader', done: true }, { id: 's2', text: 'Enroll badges', done: false }] }),
  base(4, { title: 'Follow up on alarm estimate', assignee_ids: ['u_shani'], assignees: [{ id: 'u_shani', name: personName('u_shani') }], status: 'BLOCKED', priority: 'HIGH',
    due_at: iso('2026-06-05T17:00:00Z'), linked_entity: MOCK_ENTITIES[4], tags: ['follow-up'],
    updated_at: iso('2026-05-30T09:00:00Z') }),
  base(5, { title: 'Site survey notes write-up', assignee_ids: ['u_ohad'], assignees: [{ id: 'u_ohad', name: personName('u_ohad') }], status: 'DONE', priority: 'LOW',
    due_at: iso('2026-06-04T17:00:00Z'), completed_at: iso('2026-06-03T15:00:00Z'),
    linked_entity: MOCK_ENTITIES[3] }),
  base(6, { title: 'Schedule CCTV crew', assignee_ids: ['u_oved'], assignees: [{ id: 'u_oved', name: personName('u_oved') }], status: 'TODO', priority: 'MEDIUM',
    due_at: iso('2026-06-12T17:00:00Z'), linked_entity: MOCK_ENTITIES[2] }),
  base(7, { title: 'Call supplier about buzzer backorder', assignee_ids: ['u_sagiv'], assignees: [{ id: 'u_sagiv', name: personName('u_sagiv') }], status: 'BLOCKED', priority: 'MEDIUM',
    due_at: iso('2026-06-08T17:00:00Z'), tags: ['parts'], updated_at: iso('2026-05-31T09:00:00Z') }),
  base(8, { title: 'Close out bulletproof glass job', assignee_ids: ['u_oved'], assignees: [{ id: 'u_oved', name: personName('u_oved') }], status: 'DONE', priority: 'MEDIUM',
    due_at: iso('2026-06-02T17:00:00Z'), completed_at: iso('2026-06-02T12:00:00Z'), linked_entity: MOCK_ENTITIES[1] }),
  base(9, { title: 'Standalone: order new ladder rack for van 3', assignee_ids: ['u_oved'], assignees: [{ id: 'u_oved', name: personName('u_oved') }], status: 'TODO', priority: 'LOW',
    due_at: iso('2026-06-25T17:00:00Z') }),
  base(10, { title: 'Prep badges for Paramus go-live', assignee_ids: ['u_priya'], assignees: [{ id: 'u_priya', name: personName('u_priya') }], status: 'TODO', priority: 'HIGH',
    due_at: iso('2026-06-09T17:00:00Z'), linked_entity: MOCK_ENTITIES[0], watcher_ids: ['u_emanuel'] }),
];

export function personName(id: string): string {
  return MOCK_PEOPLE.find((p) => p.id === id)?.name ?? id;
}

export function departmentName(id: string): string {
  return MOCK_DEPARTMENTS.find((d) => d.id === id)?.name ?? id;
}

export function personDepartment(personId: string): string | null {
  return MOCK_PEOPLE.find((p) => p.id === personId)?.department ?? null;
}
