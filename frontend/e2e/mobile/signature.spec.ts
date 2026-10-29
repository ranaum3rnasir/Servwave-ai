/**
 * Mobile slice 05 (PRD module 10, stories 109/110/119, rubric CMP-14): the public estimate's
 * signature pad on every gate device, with the real drawing library in a real engine.
 *
 * Per device it signs a FRESH sent estimate in the throwaway org (never the shared key-route one,
 * which the gate measures unsigned), and checks:
 *  1. the drawing buffer is the displayed box times the device pixel ratio, the pad is at least
 *     160 px tall (300 px wide at 320) and Clear is a 44 px target;
 *  2. touch on the canvas cannot pan the page, and overscroll is contained around it;
 *  3. ink lands where the pointer went (the old 600x128 buffer put it elsewhere);
 *  4. rotating (width and height swapped) keeps the signature, unstretched, and Approve stays on;
 *  5. a dense full-pad signature still fits the server's 500,000-character cap;
 *  6. the signed estimate submits, and the image the server stored is the pad's buffer with the
 *     ink in the same place and shape (the pixel-ratio-3 devices prove it at 3).
 *
 * Runs on the six device projects with the gate (MOBILE_GATE_ROUTES selecting
 * `public-estimate-open`, or no selection). How to run: ./README.md.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import { ApiClient } from '../helpers/api-client';
import { gateDevice } from './devices';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { sentEstimate } from './seed';

const STATE = 'public-estimate-open';
const SIGNATURE_CAP = 500_000; // estimate.controller.ts approve schema: signature_data max(500000)

test.skip(!selectStates().some((s) => s.id === STATE), `MOBILE_GATE_ROUTES does not select ${STATE}`);

interface Ink {
  /** Dark pixels in the buffer. */
  count: number;
  /** Bounding box of the ink, in CSS px of the pad (buffer px / pixel ratio). */
  minX: number; maxX: number; minY: number; maxY: number;
}

interface PadState {
  box: { width: number; height: number };
  buffer: { width: number; height: number };
  dpr: number;
  ink: Ink;
}

/** The page's only canvas (its accessible name is asserted on its own, after the size checks). */
const canvasLocator = (page: Page) => page.locator('canvas');

/** The pad's box, buffer and ink, read straight off the live canvas. */
async function padState(page: Page): Promise<PadState> {
  return canvasLocator(page).evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    const ctx = canvas.getContext('2d')!;
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let count = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i]! < 128 && data[i + 3]! > 128) {
          count++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return {
      box: { width: r.width, height: r.height },
      buffer: { width: canvas.width, height: canvas.height },
      dpr,
      ink: { count, minX: minX / dpr, maxX: maxX / dpr, minY: minY / dpr, maxY: maxY / dpr },
    };
  });
}

/** Draw a polyline through points given as fractions of the pad's box. */
async function draw(page: Page, points: Array<[number, number]>) {
  const r = (await canvasLocator(page).boundingBox())!;
  const at = ([fx, fy]: [number, number]) => [r.x + fx * r.width, r.y + fy * r.height] as const;
  const [x0, y0] = at(points[0]!);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  // Small timed steps: the library throttles pointer moves (16 ms), so a burst of instant moves
  // would be mostly dropped and the stroke would not reach the points asked for.
  let [px, py] = [x0, y0];
  for (const p of points.slice(1)) {
    const [x, y] = at(p);
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(px + ((x - px) * i) / 10, py + ((y - py) * i) / 10);
      await page.waitForTimeout(20);
    }
    [px, py] = [x, y];
  }
  await page.mouse.up();
}

function expectBufferMatchesBox(s: PadState, label: string) {
  expect(Math.abs(s.buffer.width - s.box.width * s.dpr), `${label}: buffer width ${s.buffer.width} vs box ${s.box.width} x ${s.dpr}`).toBeLessThanOrEqual(1);
  expect(Math.abs(s.buffer.height - s.box.height * s.dpr), `${label}: buffer height ${s.buffer.height} vs box ${s.box.height} x ${s.dpr}`).toBeLessThanOrEqual(1);
}

const aspect = (i: Ink) => (i.maxX - i.minX) / (i.maxY - i.minY);

test('signature pad: sized to the device, survives rotation, submits a correct image', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const device = gateDevice(testInfo.project.name);
  const fixtures: GateFixtures = JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

  const api = await new ApiClient().init();
  let estimate: { estimateId: string; estimateToken: string };
  try {
    estimate = await sentEstimate(api, fixtures.techId);
  } finally {
    await api.dispose();
  }

  await page.goto(`/p/estimates/${estimate.estimateId}?token=${encodeURIComponent(estimate.estimateToken)}`, { waitUntil: 'domcontentloaded' });
  const canvas = canvasLocator(page);
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toBeVisible();
  const approve = page.getByRole('button', { name: /approve estimate/i });
  const clear = page.getByRole('button', { name: /^clear$/i });
  // Agree to the terms first (the throwaway org has some), so Approve tracks the signature alone.
  const terms = page.getByRole('checkbox', { name: /agree to the terms/i });
  if (await terms.count()) await terms.check();

  // 1. Size.
  const initial = await padState(page);
  expectBufferMatchesBox(initial, 'initial');
  expect(initial.box.height, 'pad height').toBeGreaterThanOrEqual(160);
  const viewport = page.viewportSize()!;
  if (viewport.width <= 320) expect(initial.box.width, 'pad width at 320').toBeGreaterThanOrEqual(300);
  const clearBox = (await clear.boundingBox())!;
  expect(clearBox.height, 'Clear height').toBeGreaterThanOrEqual(44);
  expect(clearBox.width, 'Clear width').toBeGreaterThanOrEqual(44);

  // 2. Name, touch and overscroll.
  await expect(canvas).toHaveAccessibleName(/draw your signature/i);
  const styles = await canvas.evaluate((el) => ({
    touchAction: getComputedStyle(el).touchAction,
    overscroll: (() => {
      for (let n: HTMLElement | null = el.parentElement; n; n = n.parentElement) {
        if (getComputedStyle(n).overscrollBehaviorY === 'contain') return 'contain';
      }
      return 'auto';
    })(),
  }));
  expect(styles.touchAction, 'canvas touch-action').toBe('none');
  expect(styles.overscroll, 'overscroll contained around the pad').toBe('contain');

  // 5 (first, then cleared). A dense signature over the whole pad still fits the server's cap.
  const zigzag: Array<[number, number]> = [];
  for (let i = 0; i <= 24; i++) zigzag.push([0.03 + (0.94 * i) / 24, i % 2 ? 0.92 : 0.08]);
  await draw(page, zigzag);
  await draw(page, zigzag.map(([x, y]) => [x, 1 - y] as [number, number]));
  const denseLength = await canvas.evaluate((el) => (el as HTMLCanvasElement).toDataURL('image/png').length);
  testInfo.annotations.push({ type: 'dense signature data URL length', description: String(denseLength) });
  expect(denseLength, 'dense signature data URL length').toBeLessThan(SIGNATURE_CAP);
  await clear.click();
  expect((await padState(page)).ink.count, 'Clear wipes the pad').toBe(0);
  await expect(approve).toBeDisabled();

  // 3. Ink lands under the pointer.
  await draw(page, [[0.15, 0.25], [0.3, 0.75], [0.45, 0.3]]);
  await expect(approve).toBeEnabled();
  const drawn = await padState(page);
  expect(drawn.ink.count, 'ink drawn').toBeGreaterThan(0);
  const slack = 8; // CSS px: stroke width plus curve smoothing
  expect(drawn.ink.minX).toBeGreaterThan(0.15 * drawn.box.width - slack);
  expect(drawn.ink.maxX).toBeLessThan(0.45 * drawn.box.width + slack);
  expect(drawn.ink.minY).toBeGreaterThan(0.25 * drawn.box.height - slack);
  expect(drawn.ink.maxY).toBeLessThan(0.75 * drawn.box.height + slack);
  expect(drawn.ink.maxX - drawn.ink.minX, 'ink spans the drawn width').toBeGreaterThan(0.25 * drawn.box.width); // the curve trails the last pointer move a little

  // 4. Rotate: width and height swapped, then back.
  for (const [w, h, label] of [[viewport.height, viewport.width, 'rotated'], [viewport.width, viewport.height, 'rotated back']] as const) {
    await page.setViewportSize({ width: w, height: h });
    await canvas.scrollIntoViewIfNeeded();
    await expect.poll(async () => {
      const s = await padState(page);
      return Math.abs(s.buffer.width - s.box.width * s.dpr) <= 1 && Math.abs(s.buffer.height - s.box.height * s.dpr) <= 1;
    }, { message: `${label}: buffer follows the box` }).toBe(true);
    const after = await padState(page);
    expectBufferMatchesBox(after, label);
    expect(after.ink.count, `${label}: signature kept`).toBeGreaterThan(0);
    expect(Math.abs(aspect(after.ink) / aspect(drawn.ink) - 1), `${label}: ink not stretched (aspect ${aspect(after.ink).toFixed(2)} vs ${aspect(drawn.ink).toFixed(2)})`).toBeLessThan(0.12);
    expect(after.ink.maxX, `${label}: ink inside the pad`).toBeLessThanOrEqual(after.box.width);
    await expect(approve, `${label}: still signed`).toBeEnabled();
  }
  const atSubmit = await padState(page);

  // 6. Submit, then read back the image the server stored.
  const approved = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/estimates\/[^/]+\/approve/.test(r.url()), { timeout: 60_000 });
  await approve.click();
  const approveRes = await approved;
  expect(approveRes.status(), `approve answered ${approveRes.status()}`).toBe(200);
  // exact: the pad itself is an image whose name also contains "Signature".
  await expect(page.getByRole('img', { name: 'Signature', exact: true })).toBeVisible({ timeout: 30_000 });
  // What the SERVER stored, read back over the public API (not the page's own copy).
  const reader = await new ApiClient().init();
  let storedData: unknown;
  try {
    const { res, body } = await reader.getPublicEstimate(estimate.estimateId, estimate.estimateToken);
    expect(res.ok(), 'public estimate read').toBe(true);
    storedData = body.estimate?.signature_data;
    if (typeof storedData !== 'string') console.log(`[mobile-gate] ${device.id} public read: status=${body.estimate?.status} keys=${Object.keys(body.estimate ?? {}).join(',')} error=${body.error ?? ''}`);
  } finally {
    await reader.dispose();
  }
  expect(typeof storedData, 'stored signature_data').toBe('string');
  const image = await page.evaluate(async (src) => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('stored signature did not decode'));
      img.src = src;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let count = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (data[i]! < 128 && data[i + 3]! > 128) {
          count++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return { width: c.width, height: c.height, src: src.slice(0, 22), count, minX, maxX, minY, maxY };
  }, storedData as string);
  testInfo.annotations.push({ type: 'stored signature', description: `${image.width}x${image.height} at dpr ${atSubmit.dpr} (${device.id})` });
  console.log(`[mobile-gate] ${device.id} signature: pad ${Math.round(atSubmit.box.width)}x${Math.round(atSubmit.box.height)} at dpr ${atSubmit.dpr}, stored ${image.width}x${image.height}, dense data URL ${denseLength} chars`);
  expect(image.src).toBe('data:image/png;base64,');
  expect(image.width, 'stored image is the pad buffer').toBe(atSubmit.buffer.width);
  expect(image.height, 'stored image is the pad buffer').toBe(atSubmit.buffer.height);
  expect(image.count, 'stored image has the ink').toBeGreaterThan(0);
  // Same place and shape as on the pad, in buffer pixels (so at the device's own ratio).
  const d = atSubmit.dpr;
  const tol = 3 * d;
  expect(Math.abs(image.minX - atSubmit.ink.minX * d)).toBeLessThanOrEqual(tol);
  expect(Math.abs(image.maxX - atSubmit.ink.maxX * d)).toBeLessThanOrEqual(tol);
  expect(Math.abs(image.minY - atSubmit.ink.minY * d)).toBeLessThanOrEqual(tol);
  expect(Math.abs(image.maxY - atSubmit.ink.maxY * d)).toBeLessThanOrEqual(tol);
});
