// Helpers for recording a PR's change in the real app (see SKILL.md). No credentials live here: the sign-in comes from
// STAGING_TEST_EMAIL / STAGING_TEST_PASSWORD and is done in an unrecorded browser context.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.PROOF_BASE_URL || 'https://servwave-demo.vercel.app';

/** Signs in off camera once, then opens a recording context that reuses the session. */
async function startRecording({ outDir, viewport = { width: 1440, height: 900 } }) {
  const email = process.env.STAGING_TEST_EMAIL;
  const password = process.env.STAGING_TEST_PASSWORD;
  if (!email || !password) throw new Error('STAGING_TEST_EMAIL and STAGING_TEST_PASSWORD must be set');
  fs.mkdirSync(outDir, { recursive: true });
  const statePath = path.join(outDir, '.signin-state.json');
  const browser = await chromium.launch({ slowMo: 120 });
  if (!fs.existsSync(statePath)) {
    const loginCtx = await browser.newContext();
    const lp = await loginCtx.newPage();
    await lp.goto(BASE + '/login', { waitUntil: 'networkidle' });
    await lp.fill('#email', email);
    await lp.fill('#password', password);
    await lp.click('button[type=submit]');
    await lp.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45000 });
    await loginCtx.storageState({ path: statePath });
    await loginCtx.close();
  }
  const ctx = await browser.newContext({ storageState: statePath, viewport, recordVideo: { dir: outDir, size: viewport } });
  const page = await ctx.newPage();
  const log = [];
  const check = (ok, what) => {
    log.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
    if (!ok) throw new Error('check failed: ' + what);
  };
  // Signed out mid-run (mistake 9): stop instead of recording a login page.
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame() && new URL(f.url()).pathname.startsWith('/login')) log.push('ERROR signed out mid-run');
  });
  async function finish() {
    const video = page.video();
    await ctx.close();
    await browser.close();
    if (video) log.push('video ' + (await video.path()));
    console.log(log.join('\n'));
    return log;
  }
  return { page, check, log, finish, base: BASE, statePath };
}

/** Caption at the TOP, under the app header (mistake 1). Holds it long enough to read. */
async function caption(page, text, holdMs = 3500) {
  await page.evaluate((t) => {
    let el = document.getElementById('proof-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'proof-caption';
      Object.assign(el.style, {
        position: 'fixed', left: '50%', top: '62px', transform: 'translateX(-50%)', zIndex: 2147483647,
        background: 'rgba(15,23,42,0.92)', color: '#fff', font: '600 17px system-ui, sans-serif', padding: '10px 18px',
        borderRadius: '10px', maxWidth: '1100px', textAlign: 'center', pointerEvents: 'none',
      });
      document.body.appendChild(el);
    }
    el.style.display = t ? 'block' : 'none';
    el.textContent = t;
  }, text);
  if (text) await page.waitForTimeout(holdMs);
}

/** Clears the caption, then opens a tab (mistake 2), and waits for it to draw (mistake 4). */
async function openTab(page, name) {
  await caption(page, '');
  await page.getByRole('tab', { name, exact: false }).first().click();
  await page.waitForTimeout(1500);
}

/** Types into a field and confirms the value stuck before anything is submitted (mistake 5). */
async function typeAndConfirm(locator, text, check) {
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await locator.pressSequentially(text, { delay: 20 });
  if ((await locator.inputValue()) !== text) await locator.fill(text);
  check((await locator.inputValue()) === text, `typed into the field: "${text.slice(0, 40)}"`);
}

/** Scrolls the evidence into view and holds it, for the last frames (mistake 3). */
async function showEvidence(page, locator, text, holdMs = 4000) {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await caption(page, text, holdMs);
}

/** A run-unique tag for test records, so a retake never meets its own data (mistake 7). */
const runTag = () => String(Date.now());

module.exports = { startRecording, caption, openTab, typeAndConfirm, showEvidence, runTag, BASE };
