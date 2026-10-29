import { test, expect, type Page } from '@playwright/test';

/**
 * Mobile slice 08: a deploy never strands a user on the error screen.
 *
 * What a deploy does to an open tab: the tab's entry script still names the OLD hashed lazy
 * chunks, and those files are gone. The host answers a missing path with the app's HTML
 * (the SPA rewrite), so the module import fails. The spec reproduces exactly that: it serves
 * an entry whose sign-in chunk name points at a file that no longer exists, answers that file
 * with HTML, and counts real document loads. The page must reload by itself exactly once; if
 * the chunk is still missing after that, it shows the Reload error state, never the generic
 * error screen and never a loop.
 *
 * Why not just abort the real chunk on the first load and let it through on the second:
 * WebKit can answer the reloaded page's import of the SAME url from the failure it remembers
 * without asking the network, so that variant cannot recover on WebKit. A real deploy never
 * retries the same url (the reloaded entry names the new chunk), and neither does this spec.
 */

// The sign-in page is a lazy route chunk, and it is public, so no session is needed.
const ROUTE = '/login';
const ENTRY = /\/assets\/index-[\w-]+\.js(\?.*)?$/;
const LIVE_CHUNK_NAME = /LoginPage-[\w-]+\.js/g;
const GONE_CHUNK_NAME = 'LoginPage-gone0ld1.js';
const GONE_CHUNK = /\/assets\/LoginPage-gone0ld1\.js(\?.*)?$/;

const VENDOR_TERMS =
  /\b(vercel|render|supabase|vite|webpack|sentry|cloudflare|ctm|calltrackingmetrics|twilio|resend|stripe)\b/i;

/** Keep the run local: nothing leaves the machine (no error reporting, no auth calls). */
async function isolate(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  await page.route(
    (url) => url.origin !== origin,
    (route) => route.abort(),
  );
}

/**
 * Serves the entry as the PREVIOUS build would have: its sign-in chunk renamed to a file the
 * server no longer has. `oldBuildLoads` is how many page loads get the old entry before the
 * new one is served. Returns a counter of requests for the gone chunk.
 */
async function simulateDeploy(page: Page, oldBuildLoads: number): Promise<() => number> {
  let oldEntriesServed = 0;
  let goneChunkRequests = 0;
  await page.route(ENTRY, async (route) => {
    if (oldEntriesServed >= oldBuildLoads) return route.continue();
    oldEntriesServed += 1;
    const response = await route.fetch();
    const body = (await response.text()).replace(LIVE_CHUNK_NAME, GONE_CHUNK_NAME);
    return route.fulfill({
      response,
      body,
      headers: { ...response.headers(), 'cache-control': 'no-store' },
    });
  });
  // The SPA rewrite: a missing asset comes back as the app's HTML, not as a script.
  await page.route(GONE_CHUNK, (route) => {
    goneChunkRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: { 'cache-control': 'no-store' },
      body: '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
    });
  });
  return () => goneChunkRequests;
}

/** Counts full document loads of the top frame (initial load + every reload). */
function countDocumentLoads(page: Page): () => number {
  let loads = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads += 1;
  });
  return () => loads;
}

async function expectInsideViewport(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal page scroll').toBeLessThanOrEqual(0);
  const viewport = page.viewportSize();
  const box = await page.getByRole('button', { name: 'Reload' }).boundingBox();
  expect(box).not.toBeNull();
  if (box && viewport) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  }
}

test.describe('stale lazy chunk after a deploy', () => {
  test('reloads once, then shows the Reload error state, and never loops', async ({ page, baseURL }) => {
    await isolate(page, baseURL!);
    // Every load gets the old entry: the reload cannot help, as when a deploy is still rolling out.
    const goneChunkRequests = await simulateDeploy(page, Number.POSITIVE_INFINITY);
    const documentLoads = countDocumentLoads(page);

    await page.goto(ROUTE);

    const prompt = page.getByTestId('chunk-reload-prompt');
    await expect(prompt).toBeVisible();
    expect(documentLoads(), 'the initial load plus exactly one automatic reload').toBe(2);
    expect(goneChunkRequests()).toBeGreaterThanOrEqual(1);

    // Not the generic error screen.
    await expect(page.getByTestId('error-boundary-fallback')).toHaveCount(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    // No loop: the count holds while the page sits there.
    await page.waitForTimeout(4_000);
    expect(documentLoads()).toBe(2);
    await expect(prompt).toBeVisible();

    // Copy and placement.
    expect((await prompt.innerText()).trim()).not.toMatch(VENDOR_TERMS);
    expect(await page.title()).not.toMatch(VENDOR_TERMS);
    await expectInsideViewport(page);

    // Reload is the user's retry: one reload, and with the chunk still gone, the prompt again
    // (the guard holds, so no automatic reload rides on top of it).
    await page.getByRole('button', { name: 'Reload' }).click();
    await expect.poll(documentLoads).toBe(3);
    await expect(page.getByTestId('chunk-reload-prompt')).toBeVisible();
    await page.waitForTimeout(3_000);
    expect(documentLoads()).toBe(3);
  });

  test('the one reload picks up the new build and the page loads', async ({ page, baseURL }) => {
    await isolate(page, baseURL!);
    // Only the first load is the old build; the reload gets the deployed one.
    const goneChunkRequests = await simulateDeploy(page, 1);
    const documentLoads = countDocumentLoads(page);

    await page.goto(ROUTE);

    await expect(page.locator('input[type="email"]')).toBeVisible();
    expect(goneChunkRequests()).toBe(1);
    expect(documentLoads()).toBe(2);
    await expect(page.getByTestId('chunk-reload-prompt')).toHaveCount(0);
    await expect(page.getByTestId('error-boundary-fallback')).toHaveCount(0);
  });
});
