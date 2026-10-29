/**
 * Mobile slice 55: the other five detail headers (customer, invoice, estimate, lead, automation
 * builder) on the shared detail header, on the six device projects.
 *
 * Below sm (640 px) each header stacks: a Back control (44 px) beside the record's name, the
 * record's one primary action full width and 44 px tall, and a labelled, 44 px actions menu, all
 * inside the viewport with no sideways scroll. From sm up it keeps the old row. Read-only: nothing
 * is pressed except to open and close a menu.
 *
 * Also measured here:
 *   - invoice: the customer's name is not squeezed out (it was 0 px wide at 393) and its full
 *     value is in a title;
 *   - estimate: "Generate tasks", "Add item" and "Add scope of work" are inside the viewport
 *     sideways once scrolled to (the section cards' meta rows wrap);
 *   - automation builder: Publish is inside the viewport and 44 px on a phone.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
const SM = 640;

interface Case {
  id: string;
  path: (f: GateFixtures) => string;
  /** The Back control's accessible name on a phone. */
  back: string;
  /** The menu button's accessible name (its text on a phone). */
  menu: string;
  /** The record's one primary action, when the seeded record has one. */
  primary?: RegExp;
  /** The page keeps its Back control from sm up too (estimate: an icon; builder: a text link). */
  backFromSm?: boolean;
  /** The record's visible name, which must keep room beside Back. */
  name?: (page: Page) => Locator;
}

const CASES: Case[] = [
  { id: 'lead-detail', path: (f) => `/leads/${f.leadId}`, back: 'Back to leads', menu: 'Lead actions', primary: /^(Convert to job|Create Estimate)$/, name: (p) => p.getByRole('heading', { level: 1 }).first() },
  { id: 'customer-detail', path: (f) => `/customers/${f.customerId}`, back: 'Back to customers', menu: 'Customer actions', primary: /Create New/, name: (p) => p.getByRole('heading', { level: 1 }).first() },
  { id: 'invoice-detail', path: (f) => `/invoices/${f.invoiceOpen.id}`, back: 'Back to invoices', menu: 'More actions', primary: /^(Send Invoice|Record Payment)$/, name: (p) => p.getByRole('heading', { level: 1 }).first() },
  { id: 'estimate-detail', path: (f) => `/estimates/${f.estimateOpen.id}`, back: 'Back to estimates', menu: 'Actions', primary: /^(Record Payment|Send|Resend|Create Job|View Job|Send a copy)$/, backFromSm: true, name: (p) => p.getByTestId('detail-header').first().getByTitle('Rename estimate') },
  { id: 'automation-new', path: () => '/automations/new', back: 'Back to Automations', menu: 'Actions', primary: /^Publish/, backFromSm: true },
];

async function box(loc: Locator, label: string) {
  const b = await loc.boundingBox();
  expect(b, `${label} is laid out`).not.toBeNull();
  return b!;
}

async function inside(loc: Locator, label: string, vp: { width: number; height: number }) {
  const b = await box(loc, label);
  expect(b.x, `${label} left edge on screen`).toBeGreaterThanOrEqual(-1);
  expect(b.x + b.width, `${label} right edge on screen at ${vp.width}px`).toBeLessThanOrEqual(vp.width + 1);
  return b;
}

async function openPage(page: Page, session: Parameters<typeof signIn>[1], url: string) {
  await signIn(page, session, []);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

for (const c of CASES) {
  test(`detail header: ${c.id}`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(c.id), `MOBILE_GATE_ROUTES does not select ${c.id}`);
    const vp = page.viewportSize()!;
    const phone = vp.width < SM;
    await openPage(page, session, c.path(fixtures()));
    try {
      const header = page.getByTestId('detail-header').first();
      await expect(header).toBeVisible();

      // Nothing in the header sticks out sideways, and it does not scroll sideways itself.
      const over = await header.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const stick: string[] = [];
        el.querySelectorAll('*').forEach((n) => {
          const b = (n as HTMLElement).getBoundingClientRect();
          if (b.width > 0 && (b.right > window.innerWidth + 1 || b.left < -1)) stick.push(`${n.tagName.toLowerCase()} ${Math.round(b.left)}..${Math.round(b.right)}`);
        });
        return { scroll: el.scrollWidth - el.clientWidth, right: Math.round(r.right), stick: stick.slice(0, 5) };
      });
      expect(over.scroll, `the header fits at ${vp.width}px`).toBeLessThanOrEqual(1);
      expect(over.stick, `no header element is past the screen edge at ${vp.width}px`).toEqual([]);

      const back = page.getByRole('button', { name: c.back });
      const menu = header.getByRole('button', { name: c.menu });
      const primary = c.primary ? header.getByRole('button', { name: c.primary }).first() : null;

      // boundingBox() waits for a match, so only measure what is on the page.
      const rect = async (loc: Locator) => ((await loc.count()) ? loc.first().boundingBox({ timeout: 2_000 }).catch(() => null) : null);
      await testInfo.attach(`${c.id}.json`, {
        body: JSON.stringify({
          width: vp.width,
          phone,
          back: await rect(back),
          menu: await rect(menu),
          primary: primary ? await rect(primary) : null,
        }, null, 1),
        contentType: 'application/json',
      });

      if (phone) {
        const backBox = await inside(back, 'Back', vp);
        expect(backBox.width, 'Back is at least 44 px wide').toBeGreaterThanOrEqual(43.5);
        expect(backBox.height, 'Back is at least 44 px tall').toBeGreaterThanOrEqual(43.5);

        const menuBox = await inside(menu, 'the actions menu', vp);
        expect(menuBox.height, 'the actions menu is at least 44 px tall').toBeGreaterThanOrEqual(43.5);
        await expect(menu, 'on a phone the menu is a labelled button').toContainText(c.menu);

        if (primary) {
          const pBox = await inside(primary, 'the primary action', vp);
          expect(pBox.height, 'the primary action is at least 44 px tall').toBeGreaterThanOrEqual(43.5);
          expect(pBox.width, 'the primary action is full width').toBeGreaterThan(vp.width * 0.6);
        }

        // The record's name has room: it is on screen and not squeezed to nothing.
        if (c.name) {
          const hBox = await inside(c.name(page), "the record's name", vp);
          expect(hBox.width, "the record's name has room").toBeGreaterThan(80);
        }

        // The menu opens inside the screen.
        await menu.click();
        const item = page.getByRole('menuitem').first();
        await expect(item).toBeVisible();
        await inside(item, 'the first menu item', vp);
        await page.keyboard.press('Escape');
      } else {
        if (c.backFromSm) await expect(page.getByRole('button', { name: c.back }).or(page.getByRole('link', { name: c.back })).first()).toBeVisible();
        else await expect(back).toHaveCount(0);
        if (primary) await inside(primary, 'the primary action', vp);
        const menuWide = header.getByRole('button', { name: c.menu });
        if (await menuWide.count()) await inside(menuWide.first(), 'the actions menu', vp);
      }

      if (c.id === 'invoice-detail') {
        const name = header.getByRole('heading', { level: 1 }).getByRole('link').first();
        const nBox = await inside(name, "the customer's name", vp);
        expect(nBox.width, "the customer's name is not squeezed out").toBeGreaterThan(40);
        const full = (await name.textContent())?.trim() ?? '';
        expect(await name.getAttribute('title'), 'its full value is reachable').toBe(full);
      }

      if (c.id === 'automation-new') {
        const publish = page.getByRole('button', { name: /^Publish/ }).first();
        await publish.scrollIntoViewIfNeeded();
        const pb = await inside(publish, 'Publish', vp);
        if (phone) expect(pb.height, 'Publish is at least 44 px tall').toBeGreaterThanOrEqual(43.5);
      }

      if (c.id === 'estimate-detail') {
        // The section cards' meta rows wrap, so their buttons stay on screen.
        for (const name of [/^Generate tasks$/, /^Add item$/, /^Add scope of work$/]) {
          const btn = page.getByRole('button', { name }).first();
          if (!(await btn.count())) continue;
          await btn.scrollIntoViewIfNeeded();
          await inside(btn, String(name), vp);
        }
      }
    } finally {
      await keepSession(page, session);
    }
  });
}
