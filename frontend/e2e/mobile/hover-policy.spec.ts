/**
 * Mobile slice 15 (TOUCH-03, TOUCH-04): hover only where hover exists; no action only a hover
 * can reveal.
 *
 * On every touch project a technician deletes a job, lead and task photo and document without
 * hovering; on the iPad project inventory locations and categories are edited and deleted by tap;
 * after a tap no button stays in its hover look; and on the desktop control the same actions are
 * still hidden until their row is hovered, then work.
 *
 * Each test seeds its own files and inventory rows in the gate's throwaway org (names carry the
 * project, so the six projects never touch each other's rows) and deletes them through the UI.
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects it by the
 * route it opens: `job-detail`, `lead-detail`, `tasks`, `inventory`.
 */
import { expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { FIXTURES_DIR } from '../helpers/api-client';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE, gateBackend } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test, type Session } from './session';
import { press, tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

/** An API context as the gate's signed-in admin (the worker's own session: no extra login). */
async function adminApi(session: { current: Session }): Promise<APIRequestContext> {
  const token = JSON.parse(session.current.value).access_token as string;
  return request.newContext({ baseURL: gateBackend(), extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

async function ok(label: string, res: import('@playwright/test').APIResponse) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) throw new Error(`seed step "${label}" failed: ${res.status()} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const FILES = {
  photo: { file: 'test-photo.jpg', mime: 'image/jpeg' },
  doc: { file: 'test-document.pdf', mime: 'application/pdf' },
} as const;

async function upload(api: APIRequestContext, entity: 'JOB' | 'LEAD' | 'TASK', id: string, kind: keyof typeof FILES, name: string) {
  const f = FILES[kind];
  await ok(`upload ${kind} to ${entity}`, await api.post(`/api/attachments/${entity}/${id}`, {
    multipart: {
      file: { name: f.file, mimeType: f.mime, buffer: fs.readFileSync(path.join(FIXTURES_DIR, f.file)) },
      display_name: name,
      description: '',
      context: 'OTHER',
    },
  }));
}

/** How visible the element really is: its own opacity times every ancestor's. */
const shown = (l: Locator) =>
  l.evaluate((el) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return Math.round(o * 100) / 100;
  });

/**
 * Use a row action the way this device can. Touch: it is visible with nothing hovered, and a tap
 * runs it. Desktop: it is hidden until its row is hovered, then a click runs it.
 */
async function useRowAction(page: Page, touch: boolean, row: Locator, action: Locator) {
  await action.scrollIntoViewIfNeeded();
  if (touch) {
    // Polled: a panel's own entry fade can still be running (it multiplies in from an ancestor).
    await expect.poll(() => shown(action), { message: 'visible on touch with nothing hovered' }).toBe(1);
    await tap(action);
    return;
  }
  await page.mouse.move(0, 0);
  await expect.poll(() => shown(action), { message: 'hidden at rest on the desktop control' }).toBe(0);
  // Hovered again on every poll: the gate's projects share one job, so another project's upload or
  // delete can re-flow the list under the pointer between the hover and the read.
  await expect
    .poll(async () => {
      await row.hover();
      return shown(action);
    }, { message: 'revealed by hovering its row' })
    .toBe(1);
  await action.click();
}

/** Confirm the app's confirm dialog with its danger button. */
async function confirmDelete(page: Page, label = 'Delete') {
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: label, exact: true }) }).last();
  await expect(dialog).toBeVisible();
  const button = dialog.getByRole('button', { name: label, exact: true });
  await press(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), button);
  await expect(dialog).toBeHidden();
}

/**
 * After a tap, the tapped button keeps its rest look. Touch emulation leaves the tapped element in
 * `:hover` (as a phone does; measured on all five touch projects), so this proves the hover rule
 * itself does not apply here. Use a button whose tap changes nothing else.
 */
async function expectNoStickyHover(button: Locator) {
  const look = () => button.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { background: cs.backgroundColor, color: cs.color, hovered: el.matches(':hover') };
  });
  const rest = await look();
  await tap(button);
  await button.page().waitForTimeout(400); // past every 150-240 ms colour transition
  const after = await look();
  expect(after.hovered, 'the emulated tap left the button in :hover (otherwise this check proves nothing)').toBe(true);
  expect({ background: after.background, color: after.color }, 'tapped button kept its hover look').toEqual({ background: rest.background, color: rest.color });
}

function run(stateId: string, title: string, body: (a: { page: Page; api: APIRequestContext; touch: boolean; tag: string; project: string }) => Promise<void>) {
  test(title, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(stateId), `MOBILE_GATE_ROUTES does not select ${stateId}`);
    const device = gateDevice(testInfo.project.name);
    const notes: string[] = [];
    await signIn(page, session, notes);
    const api = await adminApi(session);
    try {
      await body({ page, api, touch: device.touch, tag: `${testInfo.project.name} ${Date.now() % 100000}`, project: testInfo.project.name });
    } finally {
      await keepSession(page, session).catch(() => {});
      await api.dispose();
    }
  });
}

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

run('job-detail', 'job photo and document delete without hovering (job overview)', async ({ page, api, touch, tag }) => {
  const { jobId } = fixtures();
  const photo = `Gate photo ${tag}`;
  const doc = `Gate doc ${tag}`;
  // A second photo of this run's own, so the grid always holds a neighbour for the tile (a job with
  // several photos is the normal case). Only one extra: the card lists 8 photos and the gate's
  // projects add theirs to the same job.
  const extras = [`Gate photo B ${tag}`];
  await upload(api, 'JOB', jobId, 'photo', photo);
  for (const name of extras) await upload(api, 'JOB', jobId, 'photo', name);
  await upload(api, 'JOB', jobId, 'doc', doc);
  await open(page, `/jobs/${jobId}`);

  await expect(page.getByRole('button', { name: `Delete ${photo}` })).toBeAttached({ timeout: 20_000 });

  // Each tile's own buttons sit inside the tile: on a narrow tile the Actions and Delete buttons
  // used to spill over the neighbour, and the neighbour's Actions button covered this Delete.
  for (const name of [photo, ...extras]) {
    const del = page.getByRole('button', { name: `Delete ${name}` });
    await del.scrollIntoViewIfNeeded();
    const spill = await del.evaluate((el) => {
      const tile = el.closest('.group');
      if (!tile) return 'no tile';
      const box = tile.getBoundingClientRect();
      const out: string[] = [];
      for (const b of Array.from(tile.querySelectorAll('button'))) {
        const r = b.getBoundingClientRect();
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`${b.getAttribute('aria-label')} ${Math.round(r.left - box.left)}..${Math.round(r.right - box.left)} of ${Math.round(box.width)}`);
      }
      return out.join('; ');
    });
    expect(spill, `buttons of the "${name}" photo tile stay inside the tile`).toBe('');
  }

  // The selected Overview tab: a tap changes nothing (no overlay, no state), so any change in its
  // look is the kit Button's hover style sticking.
  if (touch) await expectNoStickyHover(page.getByRole('tab', { name: 'Overview', selected: true }));

  const photoDelete = page.getByRole('button', { name: `Delete ${photo}` });
  await useRowAction(page, touch, photoDelete.locator('xpath=ancestor::div[contains(@class,"group")][1]'), photoDelete);
  await confirmDelete(page);
  await expect(page.getByRole('button', { name: `Delete ${photo}` })).toHaveCount(0);

  const docDelete = page.getByRole('button', { name: `Delete ${doc}` });
  await useRowAction(page, touch, docDelete.locator('xpath=ancestor::div[contains(@class,"group")][1]'), docDelete);
  await confirmDelete(page);
  await expect(page.getByRole('button', { name: `Delete ${doc}` })).toHaveCount(0);

  for (const name of extras) {
    const extra = page.getByRole('button', { name: `Delete ${name}` });
    await useRowAction(page, touch, extra.locator('xpath=ancestor::div[contains(@class,"group")][1]'), extra);
    await confirmDelete(page);
    await expect(page.getByRole('button', { name: `Delete ${name}` })).toHaveCount(0);
  }
});

/** A file tile in AttachmentSection (lead attachments tab, task drawer): delete it. */
async function deleteSectionTile(page: Page, touch: boolean, scope: Locator, name: string) {
  const tile = scope.locator('div.group').filter({ hasText: name }).last();
  await expect(tile).toBeVisible();
  await useRowAction(page, touch, tile, tile.getByRole('button', { name: 'Delete attachment' }));
  await confirmDelete(page);
  await expect(scope.locator('div.group').filter({ hasText: name })).toHaveCount(0);
}

run('lead-detail', 'lead photo and document delete without hovering (lead attachments)', async ({ page, api, touch, tag }) => {
  const { leadId } = fixtures();
  const photo = `Gate photo ${tag}`;
  const doc = `Gate doc ${tag}`;
  await upload(api, 'LEAD', leadId, 'photo', photo);
  await upload(api, 'LEAD', leadId, 'doc', doc);
  await open(page, `/leads/${leadId}`);
  const tab = page.getByRole('tab', { name: /Attachments/ });
  await press(touch, tab);
  const panel = page.getByRole('tabpanel');
  await deleteSectionTile(page, touch, panel, photo);
  await deleteSectionTile(page, touch, panel, doc);
});

run('tasks', 'task photo and document delete without hovering (task drawer)', async ({ page, api, touch, tag }) => {
  const created = await ok('create task', await api.post('/api/tasks', { data: { title: `Gate task ${tag}` } }));
  const taskId = (created.task?.id ?? created.id) as string;
  const photo = `Gate photo ${tag}`;
  const doc = `Gate doc ${tag}`;
  await upload(api, 'TASK', taskId, 'photo', photo);
  await upload(api, 'TASK', taskId, 'doc', doc);
  try {
    await open(page, `/tasks?task=${taskId}`);
    const files = page.getByRole('region', { name: 'Files' });
    await expect(files).toBeVisible({ timeout: 20_000 });
    await deleteSectionTile(page, touch, files, photo);
    await deleteSectionTile(page, touch, files, doc);
  } finally {
    await api.delete(`/api/tasks/${taskId}`).catch(() => {});
  }
});

run('inventory', 'inventory locations and categories edit and delete by tap (tablet) or hover (desktop)', async ({ page, api, touch, project }) => {
  test.skip(touch && project !== 'ipad-mini', 'the inventory criterion is the iPad project (plus the desktop control)');
  const tag = `${project} ${Date.now() % 100000}`;
  const van = `Gate van ${tag}`;
  const category = `Gate category ${tag}`;
  const loc = await ok('create location', await api.post('/api/inventory/locations', { data: { name: van, type: 'truck' } }));
  const cat = await ok('create category', await api.post('/api/price-book/categories', { data: { name: category } }));
  try {
    await inventoryRowActions(page, touch, van, category);
  } finally {
    // The org purge leaves inventory locations alone (PURGE_EXEMPT), so a location this test
    // failed to delete through the UI would make the gate's teardown fail and leak the org.
    // A 404 here means the UI already deleted it.
    const locationId = loc.location?.id ?? loc.id;
    const categoryId = cat.data?.id ?? cat.category?.id ?? cat.id;
    if (locationId) await api.delete(`/api/inventory/locations/${locationId}`).catch(() => {});
    if (categoryId) await api.delete(`/api/price-book/categories/${categoryId}`).catch(() => {});
  }
});

async function inventoryRowActions(page: Page, touch: boolean, van: string, category: string) {
  await open(page, '/inventory');
  const pressHere = (l: Locator) => press(touch, l);

  // Locations: edit opens the editor, delete removes the location.
  const locationRow = () => page.locator('div.group').filter({ hasText: van }).last();
  await pressHere(page.getByRole('button', { name: /^All Locations/ }));
  await useRowAction(page, touch, locationRow(), locationRow().getByRole('button', { name: 'Edit location' }));
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await pressHere(page.getByRole('button', { name: /^All Locations/ }));
  await useRowAction(page, touch, locationRow(), locationRow().getByRole('button', { name: 'Delete location' }));
  await confirmDelete(page, 'Delete location');
  await pressHere(page.getByRole('button', { name: /^All Locations/ }));
  await expect(page.locator('div.group').filter({ hasText: van })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Categories: same, from the category filter.
  const categoryTrigger = page.getByRole('button', { name: /All Categories/ }).first();
  await pressHere(categoryTrigger);
  await useRowAction(page, touch, page.locator('div.group').filter({ hasText: category }).last(), page.getByRole('button', { name: `Edit ${category}` }));
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await pressHere(categoryTrigger);
  await useRowAction(page, touch, page.locator('div.group').filter({ hasText: category }).last(), page.getByRole('button', { name: `Delete ${category}` }));
  await confirmDelete(page);
  await pressHere(categoryTrigger);
  await expect(page.getByRole('button', { name: `Delete ${category}` })).toHaveCount(0);
}
