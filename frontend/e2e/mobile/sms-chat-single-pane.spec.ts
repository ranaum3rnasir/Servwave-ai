/**
 * Mobile slice 69 (VP-05, VP-06, VP-12, SCR-02, KB-06 [D], PERF-04): text messages and chat show one
 * pane at a time below md, the open conversation is in the URL, the messages are the page's only
 * vertical scroller, and Send stays on screen, above the on-screen keyboard.
 *
 * The throwaway org has no text threads and the phone service is not connected, so the thread list
 * and the contact directory are answered by test doubles (page.route, GET only); every other write
 * under /api/communication is answered locally too, and a send fails the test. NOTHING is sent and
 * nothing is written to the phone service. The doubles carry made-up names and numbers.
 *
 * - Phones (< 768, the three touch phones): the list alone first; tapping a conversation shows the
 *   thread alone and puts `threadId` in the URL; the browser's Back returns to the list; a reload on
 *   the thread keeps it. In the thread: no second vertical scroller (the canvas does not scroll
 *   under the messages), no sideways overflow, Send inside the screen at its own centre, and above a
 *   simulated keyboard (the visual viewport is shrunk the way iOS Safari presents one; what a real
 *   keyboard adds is on the real-device checklist).
 * - From md up (landscape phone 838x390, iPad Mini, the desktop control): both panes, the first
 *   conversation open, Send on screen without scrolling, no nested scroller.
 * - PERF-04: the text-messages page with a 300-customer directory renders fewer than 1,500 nodes at
 *   393 (the list is a page at a time on a phone); the desktop control still draws every row.
 * - Chat (/communication/whatsapp) is a demo-org page, so the double also marks the session's org as
 *   a demo one and answers the chat list; the same flows run on it (one pane below md, `chatId` in
 *   the URL, Back, Send on screen and above the keyboard; both panes from md up).
 *
 * MOBILE_GATE_ROUTES selects it by the `comm-text` and `comm-whatsapp` route ids.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const PHONES = ['iphone-se', 'galaxy-s24', 'iphone-15'];

declare global {
  interface Window { __setKeyboard?: (px: number) => void }
}

/** Swap in a visual viewport a test can shrink from the bottom (see keyboard-inset.spec.ts). */
async function simulateKeyboard(page: Page) {
  await page.addInitScript(() => {
    const fake = new EventTarget();
    let keyboard = 0;
    Object.defineProperties(fake, {
      height: { get: () => window.innerHeight - keyboard },
      width: { get: () => window.innerWidth },
      offsetTop: { value: 0 },
      offsetLeft: { value: 0 },
      pageTop: { value: 0 },
      pageLeft: { value: 0 },
      scale: { value: 1 },
    });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    window.__setKeyboard = (px: number) => {
      keyboard = px;
      fake.dispatchEvent(new Event('resize'));
    };
  });
}

const CUSTOMERS = Array.from({ length: 300 }, (_, i) => ({
  id: `gate-c${String(i).padStart(3, '0')}`,
  name: `Gate Customer ${String(i).padStart(3, '0')}`,
  type: 'residential',
  site: `${i + 1} Test Lane`,
  contacts: [],
  phones: [`+1212555${String(1000 + i)}`],
}));

const messages = (id: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `${id}_m${i}`,
    direction: i % 2 ? 'out' : 'in',
    body: `Test message ${i} for ${id}`,
    ts: new Date(Date.UTC(2026, 8, 1, 12, 0, i)).toISOString(),
    status: 'delivered',
  }));

const THREADS = [
  { id: 'gate-thr-1', customerId: CUSTOMERS[0].id, channel: 'sms', campaignType: 'customer_care', unread: 0, messages: messages('gate-thr-1', 80) },
  // An unknown number: its header carries the widest set of actions (Create customer, Create lead).
  { id: 'gate-thr-2', customerId: '', channel: 'sms', campaignType: 'customer_care', unread: 0, title: '+12125550177', messages: messages('gate-thr-2', 3) },
];

/** Answer the text-message reads with the doubles above; never let a write reach the server. */
async function doubleTexts(page: Page): Promise<{ sends: string[] }> {
  const sends: string[] = [];
  await page.route((url) => url.pathname.startsWith('/api/communication/'), async (route: Route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    if (req.method() !== 'GET') {
      if (req.method() === 'POST' && pathname.startsWith('/api/communication/sms')) sends.push(`${req.method()} ${pathname}`);
      return route.fulfill({ status: 200, json: {} });
    }
    if (pathname === '/api/communication/threads') return route.fulfill({ json: { threads: THREADS } });
    if (pathname === '/api/communication/contacts') return route.fulfill({ json: { contacts: CUSTOMERS } });
    return route.fallback();
  });
  // The open thread's side panel reads its customer's jobs; the made-up customers do not exist.
  await page.route((url) => /^\/api\/customers\/gate-c\d+/.test(url.pathname), (route: Route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { customer: { id: 'gate', jobs: [] } } }) : route.fulfill({ status: 200, json: {} }),
  );
  return { sends };
}

const CHATS = ['Dana', 'Eli', 'Faye'].map((name, n) => ({
  id: `gate-chat-${n + 1}`,
  name: `Gate ${name}`,
  org: `${name} Test Co`,
  phone: `+1212555${String(2000 + n)}`,
  unread: 0,
  lastAt: '9:00 AM',
  messages: Array.from({ length: n === 0 ? 60 : 3 }, (_, i) => ({
    id: `gate-chat-${n + 1}-m${i}`,
    from: i % 2 ? 'us' : 'them',
    text: `Chat message ${i} from ${name}`,
    at: '9:00 AM',
    status: 'read',
  })),
}));

/** The chat page is demo-only: mark the org a demo one for this page and answer the chat list. */
async function doubleChats(page: Page): Promise<{ sends: string[] }> {
  const sends: string[] = [];
  await page.route((url) => url.pathname === '/api/auth/me', async (route: Route) => {
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (!body?.user) return route.fulfill({ response: res });
    return route.fulfill({ response: res, json: { ...body, user: { ...body.user, org_is_demo: true } } });
  });
  await page.route((url) => url.pathname.startsWith('/api/communication/whatsapp'), async (route: Route) => {
    const req = route.request();
    if (req.method() !== 'GET') {
      // Opening a chat marks it read (a PATCH, answered locally); a POST would be a send.
      if (req.method() === 'POST') sends.push(`${req.method()} ${new URL(req.url()).pathname}`);
      return route.fulfill({ status: 200, json: {} });
    }
    return route.fulfill({ json: { chats: CHATS } });
  });
  return { sends };
}

/** Vertical scrollers that sit inside another (the audit's A4), and whether the page itself moves. */
function scrollerReport() {
  const sig = (el: Element) => el.tagName.toLowerCase() + (el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : '');
  const isY = (el: Element) => {
    const s = getComputedStyle(el);
    return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1;
  };
  const ys = [...document.querySelectorAll('body *')].filter(isY);
  const main = document.querySelector('main');
  return {
    nested: ys.filter((el) => ys.some((o) => o !== el && o.contains(el))).map(sig),
    scrollers: ys.map(sig),
    mainScrolls: main ? main.scrollHeight > main.clientHeight + 1 : false,
    documentScrollsX: document.documentElement.scrollWidth > innerWidth + 1,
    documentScrollsY: document.documentElement.scrollHeight > innerHeight + 1,
    nodes: document.querySelectorAll('*').length,
  };
}

async function expectOnScreenAndTopmost(page: Page, target: ReturnType<Page['locator']>, label: string, bottomLimit: number) {
  const box = (await target.boundingBox())!;
  expect(box, `${label} has a box`).toBeTruthy();
  expect(box.y, `${label} starts on screen`).toBeGreaterThanOrEqual(-0.5);
  expect(box.y + box.height, `${label} ends above ${Math.round(bottomLimit)}`).toBeLessThanOrEqual(bottomLimit + 0.5);
  expect(box.x + box.width, `${label} is inside the width`).toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);
  const topmost = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    // A disabled Send takes no pointer (the kit button says pointer-events-none), which would make
    // it skip the hit-test: give it its pointer back for the probe, so what covers it shows.
    const node = el as HTMLElement;
    const before = node.style.pointerEvents;
    node.style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    node.style.pointerEvents = before;
    const sig = (e: Element) => e.tagName.toLowerCase() + (e.getAttribute('data-slot') ? `[${e.getAttribute('data-slot')}]` : '') + (e.classList.length ? `.${[...e.classList].slice(0, 3).join('.')}` : '');
    return { ok: !!hit && (hit === el || el.contains(hit)), hit: hit ? sig(hit) : 'nothing', parent: hit?.parentElement ? sig(hit.parentElement) : '' };
  });
  expect(topmost.ok, `nothing is painted over ${label} (the point hits ${topmost.hit} in ${topmost.parent})`).toBe(true);
}

test('phones: the list, then the thread, one at a time; Back returns; Send stays on screen and above the keyboard', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('comm-text'), 'MOBILE_GATE_ROUTES does not select comm-text');
  const device = gateDevice(testInfo.project.name);
  test.skip(!PHONES.includes(device.id), 'one pane at a time is below md (the three touch phones)');
  await simulateKeyboard(page);
  const doubles = await doubleTexts(page);
  await signIn(page, session, []);
  try {
    await page.goto('/communication/text', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const list = page.locator('[data-pane="list"]');
    const thread = page.locator('[data-pane="thread"]');
    await expect(list).toBeVisible({ timeout: 20_000 });
    await expect(thread).toBeHidden();
    await expect(list.getByRole('button', { name: /Gate Customer 000/ })).toBeVisible({ timeout: 20_000 });

    // The list alone: the page is bounded, so nothing scrolls twice and nothing is sideways.
    const listReport = await page.evaluate(scrollerReport);
    expect(listReport.nested, 'no vertical scroller inside another on the list').toEqual([]);
    expect(listReport.documentScrollsX, 'the list does not scroll sideways').toBe(false);
    expect(listReport.mainScrolls, 'the canvas does not scroll under the list').toBe(false);

    // Open the conversation: the thread replaces the list, in the URL.
    await press(device.touch, list.getByRole('button', { name: /Gate Customer 000/ }), { timeout: 15_000 });
    await expect(thread).toBeVisible();
    await expect(list).toBeHidden();
    await expect(page).toHaveURL(/threadId=gate-thr-1/);

    // The thread opens on its newest message, and the messages are the only scroller.
    const messagesBox = page.locator('[data-slot="sms-messages"]');
    await expect(messagesBox).toBeVisible();
    const atBottom = await messagesBox.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4);
    expect(atBottom, 'the thread opens on its newest message').toBe(true);
    const threadReport = await page.evaluate(scrollerReport);
    expect(threadReport.nested, 'the messages are the only vertical scroller').toEqual([]);
    expect(threadReport.scrollers.length, 'one scroller in the thread view').toBeLessThanOrEqual(1);
    expect(threadReport.mainScrolls, 'the canvas does not scroll under the messages').toBe(false);
    expect(threadReport.documentScrollsX, 'the thread does not scroll sideways').toBe(false);
    expect(threadReport.documentScrollsY, 'the document does not scroll').toBe(false);

    const height = page.viewportSize()!.height;
    const send = page.locator('[data-slot="sms-composer"]').getByRole('button', { name: /^\s*Send\s*$/ });
    await expectOnScreenAndTopmost(page, send, 'Send', height);

    // The back control is a real target, and the thread header fits the screen.
    const back = page.getByRole('button', { name: 'Back to conversations' });
    const backBox = (await back.boundingBox())!;
    expect(backBox.width, 'the back control is at least 44 px wide').toBeGreaterThanOrEqual(43.5);
    expect(backBox.height, 'the back control is at least 44 px tall').toBeGreaterThanOrEqual(43.5);

    // KB-06: a keyboard covering the bottom 45% of the screen leaves Send above it.
    const kb = Math.round(height * 0.45);
    await page.evaluate((px) => window.__setKeyboard!(px), kb);
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--keyboard-inset'))).toBe(`${kb}px`);
    await page.waitForTimeout(250);
    await expectOnScreenAndTopmost(page, send, 'Send under the keyboard', height - kb);
    const covered = await page.evaluate(scrollerReport);
    expect(covered.nested, 'still one scroller with the keyboard up').toEqual([]);
    expect(covered.mainScrolls, 'the canvas still does not scroll with the keyboard up').toBe(false);
    await page.evaluate(() => window.__setKeyboard!(0));
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--keyboard-inset'))).toBe('0px');
    await page.waitForTimeout(250);
    await expectOnScreenAndTopmost(page, send, 'Send again', height);

    // A reload on the thread keeps the thread (it is in the URL), and Back reaches the list.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page, []);
    await expect(thread).toBeVisible({ timeout: 20_000 });
    await expect(list).toBeHidden();

    await page.getByRole('button', { name: 'Back to conversations' }).click();
    await expect(list).toBeVisible();
    await expect(thread).toBeHidden();
    await expect(page).not.toHaveURL(/threadId/);

    // The browser's own Back is the same move: open, then go back.
    await press(device.touch, list.getByRole('button', { name: /Gate Customer 000/ }), { timeout: 15_000 });
    await expect(thread).toBeVisible();
    await page.goBack();
    await expect(list).toBeVisible();
    await expect(thread).toBeHidden();

    // The unknown-number thread has the longest header (two create actions): all of it fits.
    await press(device.touch, list.getByRole('button', { name: /555-0177/ }).first(), { timeout: 15_000 });
    await expect(thread).toBeVisible();
    const unknown = await page.evaluate(scrollerReport);
    expect(unknown.documentScrollsX, 'the unknown-number header does not push the page sideways').toBe(false);
    await expectOnScreenAndTopmost(page, page.locator('[data-slot="sms-composer"]').getByRole('button', { name: /^\s*Send\s*$/ }), 'Send (unknown number)', height);
    await expect(page.getByRole('button', { name: /Create lead/ })).toBeVisible();
    const lead = (await page.getByRole('button', { name: /Create lead/ }).boundingBox())!;
    expect(lead.x + lead.width, 'Create lead is inside the width').toBeLessThanOrEqual(page.viewportSize()!.width + 0.5);

    expect(doubles.sends, 'nothing was sent').toEqual([]);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

test('from md up: both panes, Send on screen without scrolling, one scroller', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('comm-text'), 'MOBILE_GATE_ROUTES does not select comm-text');
  const device = gateDevice(testInfo.project.name);
  test.skip(PHONES.includes(device.id), 'this is the md-and-up layout (landscape phone, tablet, desktop)');
  const doubles = await doubleTexts(page);
  await signIn(page, session, []);
  try {
    await page.goto('/communication/text', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const list = page.locator('[data-pane="list"]');
    const thread = page.locator('[data-pane="thread"]');
    await expect(list).toBeVisible({ timeout: 20_000 });
    await expect(thread).toBeVisible();
    await expect(page.locator('[data-slot="sms-messages"]')).toBeVisible({ timeout: 20_000 });
    // No back control from md up: both panes are on screen.
    await expect(page.getByRole('button', { name: 'Back to conversations' })).toBeHidden();

    const report = await page.evaluate(scrollerReport);
    expect(report.nested, 'no vertical scroller inside another').toEqual([]);
    expect(report.mainScrolls, 'the canvas does not scroll under the page').toBe(false);
    expect(report.documentScrollsX, 'no sideways scroll').toBe(false);
    expect(report.documentScrollsY, 'the document does not scroll').toBe(false);

    const height = page.viewportSize()!.height;
    const send = page.locator('[data-slot="sms-composer"]').getByRole('button', { name: /^\s*Send\s*$/ });
    await expectOnScreenAndTopmost(page, send, 'Send', height);
    const messagesBox = (await page.locator('[data-slot="sms-messages"]').boundingBox())!;
    expect(messagesBox.height, 'the messages keep some room').toBeGreaterThanOrEqual(60);

    // From md up a pick is plain state: the URL stays as it was.
    await press(device.touch, list.getByRole('button', { name: /555-0177/ }).first(), { timeout: 15_000 });
    expect(page.url()).not.toContain('threadId');
    await expectOnScreenAndTopmost(page, send, 'Send after switching thread', height);
    expect(doubles.sends, 'nothing was sent').toEqual([]);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

test('PERF-04: the text-messages page draws a bounded number of nodes on a phone', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('comm-text'), 'MOBILE_GATE_ROUTES does not select comm-text');
  const device = gateDevice(testInfo.project.name);
  await doubleTexts(page);
  await signIn(page, session, []);
  try {
    await page.goto('/communication/text', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    await expect(page.locator('[data-pane="list"]').getByRole('button', { name: /Gate Customer 001/ })).toBeVisible({ timeout: 20_000 });
    const { nodes } = await page.evaluate(scrollerReport);
    testInfo.annotations.push({ type: 'nodes', description: `${device.id}: ${nodes}` });
    if (PHONES.includes(device.id)) {
      expect(nodes, 'fewer than 1,500 nodes on a phone with 300 customers in the directory').toBeLessThan(1500);
      const rows = await page.locator('[data-pane="list"] button').count();
      expect(rows, 'a page of the directory, not all of it').toBeLessThan(80);
      await page.getByRole('button', { name: /^Show \d+ more/ }).click();
      expect(await page.locator('[data-pane="list"] button').count(), 'the next page is a tap away').toBeGreaterThan(rows);
    } else if (device.id === 'desktop') {
      // The control keeps today's behaviour: every row is drawn.
      expect(await page.locator('[data-pane="list"] button').count(), 'the desktop draws the whole directory').toBeGreaterThan(300);
    }
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

test('chat: one pane below md with the chat in the URL; both panes from md up; Send on screen', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('comm-whatsapp'), 'MOBILE_GATE_ROUTES does not select comm-whatsapp');
  const device = gateDevice(testInfo.project.name);
  const phone = PHONES.includes(device.id);
  if (phone) await simulateKeyboard(page);
  const doubles = await doubleChats(page);
  await signIn(page, session, []);
  try {
    await page.goto('/communication/whatsapp', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const list = page.locator('[data-pane="list"]');
    const thread = page.locator('[data-pane="thread"]');
    expect(page.url(), 'the demo double reached the chat page').toContain('/communication/whatsapp');
    await expect(list.getByRole('button', { name: /Gate Eli/ })).toBeVisible({ timeout: 20_000 });
    const height = page.viewportSize()!.height;
    const send = page.locator('[data-slot="chat-composer"]').getByRole('button', { name: 'Send', exact: true });

    if (phone) {
      await expect(thread).toBeHidden();
      const listReport = await page.evaluate(scrollerReport);
      expect(listReport.nested, 'no vertical scroller inside another on the chat list').toEqual([]);
      expect(listReport.documentScrollsX, 'the chat list does not scroll sideways').toBe(false);
      expect(listReport.mainScrolls, 'the canvas does not scroll under the chat list').toBe(false);

      await press(device.touch, list.getByRole('button', { name: /Gate Dana/ }), { timeout: 15_000 });
      await expect(thread).toBeVisible();
      await expect(list).toBeHidden();
      await expect(page).toHaveURL(/chatId=gate-chat-1/);
      const report = await page.evaluate(scrollerReport);
      expect(report.nested, 'the messages are the only vertical scroller').toEqual([]);
      expect(report.mainScrolls, 'the canvas does not scroll under the messages').toBe(false);
      expect(report.documentScrollsX, 'the chat does not scroll sideways').toBe(false);
      await expectOnScreenAndTopmost(page, send, 'Send', height);

      const kb = Math.round(height * 0.45);
      await page.evaluate((px) => window.__setKeyboard!(px), kb);
      await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--keyboard-inset'))).toBe(`${kb}px`);
      await page.waitForTimeout(250);
      await expectOnScreenAndTopmost(page, send, 'Send under the keyboard', height - kb);
      await page.evaluate(() => window.__setKeyboard!(0));
      await page.waitForTimeout(250);

      await page.getByRole('button', { name: 'Back to chats' }).click();
      await expect(list).toBeVisible();
      await expect(thread).toBeHidden();
      await expect(page).not.toHaveURL(/chatId/);
      await press(device.touch, list.getByRole('button', { name: /Gate Eli/ }), { timeout: 15_000 });
      await expect(thread).toBeVisible();
      await page.goBack();
      await expect(list).toBeVisible();
    } else {
      await expect(list).toBeVisible();
      await expect(thread).toBeVisible();
      await expect(page.getByRole('button', { name: 'Back to chats' })).toBeHidden();
      const report = await page.evaluate(scrollerReport);
      expect(report.nested, 'no vertical scroller inside another').toEqual([]);
      expect(report.mainScrolls, 'the canvas does not scroll under the page').toBe(false);
      expect(report.documentScrollsX, 'no sideways scroll').toBe(false);
      await expectOnScreenAndTopmost(page, send, 'Send', height);
      await press(device.touch, list.getByRole('button', { name: /Gate Eli/ }), { timeout: 15_000 });
      expect(page.url()).not.toContain('chatId');
      await expectOnScreenAndTopmost(page, send, 'Send after switching chat', height);
    }
    expect(doubles.sends, 'nothing was sent').toEqual([]);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});
