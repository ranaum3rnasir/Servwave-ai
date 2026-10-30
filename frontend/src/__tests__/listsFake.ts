/**
 * An in-memory stand-in for the Job types and Lead/Customer sources endpoints, installed over the mocked axios client.
 * It answers the way the real routes do (the `{ items, counts }` list, `NAME_EXISTS` 409 for a case-insensitive
 * duplicate, a cap 409, a delete refused while the row is used, a reorder that must name every active id), so a card
 * test drives the whole round trip instead of stubbing each call.
 */
import { vi } from 'vitest';
import type api from '@/lib/axios';

export interface FakeRow {
  id: string;
  name: string;
  sort_order: number;
  archived: boolean;
  used_count: number;
}

export interface FakeList {
  rows: FakeRow[];
  /** Create is refused with the cap message at this many rows (the real cap is 500). */
  cap?: number;
}

const refuse = (status: number, data: Record<string, unknown>) => Promise.reject({ response: { status, data } });

/** `n` rows named `${prefix} ${i}`, in order. */
export function makeRows(prefix: string, n: number, used = (i: number) => i % 7): FakeRow[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i + 1}`, name: `${prefix} ${i + 1}`, sort_order: i, archived: false, used_count: used(i) }));
}

export function row(id: string, name: string, extra: Partial<FakeRow> = {}): FakeRow {
  return { id, name, sort_order: 0, archived: false, used_count: 0, ...extra };
}

function listBody(l: FakeList) {
  const items = l.rows.map((r) => ({ ...r })).sort((a, b) => a.sort_order - b.sort_order);
  const archived = items.filter((r) => r.archived).length;
  return { items, counts: { active: items.length - archived, archived } };
}

export function installListsServer(
  mockApi: ReturnType<typeof vi.mocked<typeof api>>,
  lists: Record<string, FakeList>,
  fallback: (method: string, url: string, body?: unknown) => unknown = () => ({}),
) {
  let seq = 1000;
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];

  const handle = (method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: unknown) => {
    calls.push({ method, url, body });
    const m = /^(\/api\/(?:job-types|lead-sources))(?:\/([^/]+))?(?:\/(archive|unarchive))?$/.exec(url);
    const list = m ? lists[m[1]!] : undefined;
    if (!m || !list) {
      const out = fallback(method, url, body);
      return out instanceof Promise ? out : Promise.resolve({ data: out });
    }
    const id = m[2];
    const action = m[3];
    const find = () => list.rows.find((r) => r.id === id);

    if (method === 'get') return Promise.resolve({ data: listBody(list) });
    if (method === 'post' && id === 'reorder') {
      const ids = (body as { ordered_ids: string[] }).ordered_ids;
      const active = list.rows.filter((r) => !r.archived);
      if (ids.length !== active.length || !ids.every((x) => active.some((r) => r.id === x))) return refuse(400, { error: 'Send all active rows when reordering' });
      ids.forEach((x, n) => (list.rows.find((r) => r.id === x)!.sort_order = n));
      return Promise.resolve({ data: undefined, status: 204 });
    }
    if (method === 'post' && !id) {
      const name = (body as { name: string }).name;
      const clash = list.rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
      if (clash) return refuse(409, { code: 'NAME_EXISTS', name: clash.name, error: `Job type “${clash.name}” already exists.` });
      if (list.cap !== undefined && list.rows.length >= list.cap) return refuse(409, { error: 'This list can hold up to 500 items.' });
      const created = { id: `new-${++seq}`, name, sort_order: list.rows.reduce((a, r) => Math.max(a, r.sort_order), -1) + 1, archived: false, used_count: 0 };
      list.rows.push(created);
      return Promise.resolve({ data: { item: { ...created } } });
    }
    const target = find();
    if (!target) return refuse(404, { error: 'Not found' });
    if (method === 'patch') {
      const name = (body as { name: string }).name;
      const clash = list.rows.find((r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase());
      if (clash) return refuse(409, { code: 'NAME_EXISTS', name: clash.name, error: `“${clash.name}” already exists.` });
      target.name = name;
      return Promise.resolve({ data: { item: { ...target } } });
    }
    if (method === 'post' && action === 'archive') {
      target.archived = true;
      return Promise.resolve({ data: { item: { ...target } } });
    }
    if (method === 'post' && action === 'unarchive') {
      target.archived = false;
      target.sort_order = list.rows.reduce((a, r) => Math.max(a, r.sort_order), -1) + 1;
      return Promise.resolve({ data: { item: { ...target } } });
    }
    if (method === 'delete') {
      if (target.used_count > 0) return refuse(409, { error: 'In use and cannot be removed.' });
      list.rows.splice(list.rows.indexOf(target), 1);
      return Promise.resolve({ data: undefined, status: 204 });
    }
    return Promise.resolve({ data: {} });
  };

  mockApi.get.mockImplementation(((url: string) => handle('get', url)) as never);
  mockApi.post.mockImplementation(((url: string, body?: unknown) => handle('post', url, body)) as never);
  mockApi.patch.mockImplementation(((url: string, body?: unknown) => handle('patch', url, body)) as never);
  mockApi.delete.mockImplementation(((url: string, cfg?: { data?: unknown }) => handle('delete', url, cfg?.data)) as never);
  return { calls, lists };
}

type ToastCall = [unknown, { id?: string; duration?: number; action?: { label: string; onClick: () => void } }?];

/** The "Saved · detail" toasts a card raised, newest last, with the Undo that went with each. */
export async function savedToasts(toastFn: { mock: { calls: unknown[][] } }) {
  const { renderToStaticMarkup } = await import('react-dom/server');
  return (toastFn.mock.calls as ToastCall[])
    .filter(([node]) => typeof node === 'object' && node !== null)
    .map(([node, opts]) => ({
      text: renderToStaticMarkup(node as never).replace(/<[^>]+>/g, ''),
      id: opts?.id,
      duration: opts?.duration,
      undo: opts?.action?.onClick,
      undoLabel: opts?.action?.label,
    }));
}

// --- Tags and Task categories -------------------------------------------------------------------------------------

export interface FakeTag {
  id: string;
  name: string;
  color: string;
  usage_count: number;
}

export interface FakeCategory {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  task_counts: { open: number; done: number };
}

export interface TagsAndCategories {
  tags: FakeTag[];
  categories: FakeCategory[];
}

export const tag = (id: string, name: string, extra: Partial<FakeTag> = {}): FakeTag => ({ id, name, color: '#6B7280', usage_count: 0, ...extra });
export const category = (id: string, name: string, extra: Partial<FakeCategory> = {}): FakeCategory => ({
  id,
  name,
  color: '#6B7280',
  sort_order: 0,
  task_counts: { open: 0, done: 0 },
  ...extra,
});

/**
 * The tag and task-category routes the way the real ones answer: `{ tags }` (with `usage_count`), `{ tag }` / `{ category }`
 * for a write, a plain 409 for a case-different duplicate, and the three-way category delete. Plugs into
 * `installListsServer` as its fallback so one page test drives all four cards.
 */
export function tagsAndCategoriesHandler(data: TagsAndCategories) {
  let seq = 5000;
  return (method: string, url: string, body?: unknown): unknown => {
    const b = (body ?? {}) as Record<string, string>;
    let m = /^\/api\/tags(?:\/([^/]+))?$/.exec(url);
    if (m) {
      const id = m[1];
      const find = () => data.tags.find((t) => t.id === id);
      if (method === 'get') return { tags: [...data.tags].sort((a, c) => a.name.localeCompare(c.name)).map((t) => ({ ...t })) };
      if (method === 'post') {
        const clash = data.tags.find((t) => t.name.toLowerCase() === b.name!.toLowerCase());
        if (clash) return refuse(409, { error: 'Tag already exists', tag: clash });
        const created = { id: `tag-${++seq}`, name: b.name!, color: b.color!, usage_count: 0 };
        data.tags.push(created);
        return Promise.resolve({ data: { tag: { ...created } }, status: 201 });
      }
      const target = find();
      if (!target) return refuse(404, { error: 'Not found' });
      if (method === 'patch') {
        const clash = b.name ? data.tags.find((t) => t.id !== id && t.name.toLowerCase() === b.name!.toLowerCase()) : undefined;
        if (clash) return refuse(409, { error: 'A tag with that name already exists' });
        if (b.name) target.name = b.name;
        if (b.color) target.color = b.color;
        return Promise.resolve({ data: { tag: { ...target } } });
      }
      if (method === 'delete') {
        data.tags.splice(data.tags.indexOf(target), 1);
        return Promise.resolve({ data: undefined, status: 204 });
      }
    }
    m = /^\/api\/task-categories(?:\/([^/]+))?$/.exec(url);
    if (m) {
      const id = m[1];
      const find = () => data.categories.find((c) => c.id === id);
      if (method === 'get') return { categories: [...data.categories].sort((a, c) => a.sort_order - c.sort_order).map((c) => ({ ...c })) };
      if (method === 'post') {
        const clash = data.categories.find((c) => c.name.toLowerCase() === b.name!.toLowerCase());
        if (clash) return refuse(409, { error: 'A category with that name already exists' });
        const created = category(`cat-${++seq}`, b.name!, { color: b.color!, sort_order: data.categories.length });
        data.categories.push(created);
        return Promise.resolve({ data: { category: { ...created } }, status: 201 });
      }
      const target = find();
      if (!target) return refuse(404, { error: 'Not found' });
      if (method === 'patch') {
        const clash = b.name ? data.categories.find((c) => c.id !== id && c.name.toLowerCase() === b.name!.toLowerCase()) : undefined;
        if (clash) return refuse(409, { error: 'A category with that name already exists' });
        if (b.name) target.name = b.name;
        if (b.color) target.color = b.color;
        return Promise.resolve({ data: { category: { ...target } } });
      }
      if (method === 'delete') {
        const total = target.task_counts.open + target.task_counts.done;
        data.categories.splice(data.categories.indexOf(target), 1);
        const moved = b.mode === 'move' ? data.categories.find((c) => c.id === b.target_id) ?? null : null;
        return Promise.resolve({ data: { mode: b.mode, task_count: total, target: moved, deleted_task_ids: b.mode === 'delete_tasks' ? Array.from({ length: total }, (_, i) => `task-${i}`) : [] } });
      }
    }
    return {};
  };
}
