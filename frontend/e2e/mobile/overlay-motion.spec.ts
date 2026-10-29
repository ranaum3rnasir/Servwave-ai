/**
 * Mobile slice 16: overlays follow reduced motion where they portal, and no scrim blurs on a
 * touch screen.
 *
 * The overlay primitives portal to <body>, outside the shell (`.app`) the old reduced-motion rule
 * was scoped to, so on a signed-in page this spec opens one of each the way the app opens them:
 * the kit Dialog and Sheet, the app's own Dialog and Sheet (sixty-odd older dialogs), the kit
 * Popover, and a toast from each of the app's two toasters. It mounts them through the dev
 * server's own module graph (the same React, Radix and stylesheet instances the page runs), so
 * what is measured is the real primitive under the real CSS, on each device engine.
 *
 *  - reduced motion: every opened surface and scrim computes `animation-name: none` and zero
 *    transition durations;
 *  - control (no preference): the same dialog DOES animate, so the first test cannot pass on a
 *    measurement that never sees an animation;
 *  - scrims: on the touch projects no dialog or sheet scrim computes a backdrop blur, and the
 *    image tile's blurred filler is display:none; the desktop control keeps both.
 *
 * MOBILE_GATE_ROUTES selects it with `home` (the page it opens on). Runs with the gate (same
 * projects, same session slots).
 */
import { expect, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));

interface Reading {
  probe: string;
  animationName: string;
  animationDuration: string;
  transitionDuration: string;
  backdrop: string;
  display: string;
}

/**
 * Mount one of each overlay primitive, open, into the running app, and fire one toast from each
 * toaster. Every surface measured carries `data-motion-probe`; the scrims are found next to them.
 */
async function openEveryOverlay(page: Page) {
  await page.evaluate(async () => {
    const abs = (p: string) => new URL(p, location.origin).href;
    // The exact pre-bundled React URLs the app itself imports, so the probes share its instances.
    const entry = await (await fetch(abs('/src/main.tsx'))).text();
    const dep = (name: string) => {
      const m = entry.match(new RegExp(`"(/node_modules/\\.vite/deps/${name}\\.js\\?v=[^"]+)"`));
      if (!m) throw new Error(`no ${name} import in the dev server's main.tsx`);
      return abs(m[1]!);
    };
    const cjs = (m: any) => (m && m.default ? m.default : m);
    const React = cjs(await import(dep('react')));
    const ReactDOM = cjs(await import(dep('react-dom_client')));
    const h = React.createElement;
    const kitDialog = await import(abs('/src/ui-kit/components/ui/dialog.tsx'));
    const appDialog = await import(abs('/src/components/ui/dialog.tsx'));
    const kitSheet = await import(abs('/src/ui-kit/components/ui/sheet.tsx'));
    const appSheet = await import(abs('/src/components/ui/sheet.tsx'));
    const kitPopover = await import(abs('/src/ui-kit/components/ui/popover.tsx'));
    const tile = await import(abs('/src/components/ui/uploaded-image.tsx'));
    const sonner = await import(abs('/src/ui-kit/components/ui/sonner.tsx'));
    const appToast = await import(abs('/src/components/ui/use-toast.ts'));

    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const Probes = () =>
      h('div', null,
        h(kitDialog.Dialog, { open: true },
          h(kitDialog.DialogContent, { 'data-motion-probe': 'kit dialog', 'aria-describedby': undefined },
            h(kitDialog.DialogTitle, null, 'Motion probe'))),
        h(appDialog.Dialog, { open: true },
          h(appDialog.DialogContent, { 'data-motion-probe': 'app dialog', 'aria-describedby': undefined },
            h(appDialog.DialogTitle, null, 'Motion probe'))),
        h(kitSheet.Sheet, { open: true },
          h(kitSheet.SheetContent, { 'data-motion-probe': 'kit sheet', 'aria-describedby': undefined },
            h(kitSheet.SheetTitle, null, 'Motion probe'))),
        h(appSheet.Sheet, { open: true },
          h(appSheet.SheetContent, { 'data-motion-probe': 'app sheet', 'aria-describedby': undefined },
            h(appSheet.SheetTitle, null, 'Motion probe'))),
        h(kitPopover.Popover, { open: true },
          h(kitPopover.PopoverTrigger, null, 'Probe anchor'),
          h(kitPopover.PopoverContent, { 'data-motion-probe': 'kit popover' }, 'Motion probe')),
        h('div', { 'data-motion-probe-tile': '', style: { width: '200px', height: '100px' } },
          h(tile.UploadedImage, { src: pixel, alt: 'probe', backdrop: true, className: 'h-full w-full' })),
      );
    const host = document.createElement('div');
    host.id = 'motion-probe-root';
    document.body.appendChild(host);
    ReactDOM.createRoot(host).render(h(Probes));
    sonner.toast('Motion probe kit toast');
    appToast.toast({ title: 'Motion probe app toast' });
  });
  // Let the portals mount and the toasts enter, but read well inside a 150-400 ms animation.
  await page.locator('[data-motion-probe="kit popover"]').waitFor({ state: 'attached', timeout: 10_000 });
  // `.first()`: a toaster also writes the text into its screen-reader announcement region.
  await page.getByText('Motion probe kit toast').first().waitFor({ state: 'attached', timeout: 10_000 });
  await page.getByText('Motion probe app toast').first().waitFor({ state: 'attached', timeout: 10_000 });
}

/** The computed motion and backdrop of every probe, its scrim, and the two toasts. */
function readProbes(): Reading[] {
  const read = (probe: string, el: Element | null): Reading[] => {
    if (!el) return [{ probe: `${probe} (missing)`, animationName: '?', animationDuration: '?', transitionDuration: '?', backdrop: '?', display: '?' }];
    const cs = getComputedStyle(el);
    const backdrop = [cs.getPropertyValue('backdrop-filter'), cs.getPropertyValue('-webkit-backdrop-filter')].find((f) => f && f !== 'none') || 'none';
    return [{ probe, animationName: cs.animationName, animationDuration: cs.animationDuration, transitionDuration: cs.transitionDuration, backdrop, display: cs.display }];
  };
  const out: Reading[] = [];
  for (const el of document.querySelectorAll('[data-motion-probe]')) {
    const probe = el.getAttribute('data-motion-probe')!;
    out.push(...read(probe, el));
    // Dialogs and sheets render their scrim as the element just before the content.
    if (/dialog|sheet/.test(probe)) out.push(...read(`${probe} scrim`, el.previousElementSibling));
  }
  const toastLi = (text: string) => [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(text)) ?? null;
  out.push(...read('kit toast', toastLi('Motion probe kit toast')));
  out.push(...read('app toast', toastLi('Motion probe app toast')));
  const filler = document.querySelector('[data-motion-probe-tile] img[aria-hidden="true"]');
  out.push(...read('image tile filler', filler));
  return out;
}

const still = (r: Reading) =>
  r.animationName.split(',').every((n) => n.trim() === 'none') && r.transitionDuration.split(',').every((d) => parseFloat(d) === 0);

async function openAndRead(page: Page, session: Parameters<typeof signIn>[1], testInfo: { attach: (n: string, o: { body: string; contentType: string }) => Promise<void> }) {
  const notes: string[] = [];
  await signIn(page, session, notes);
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);
    await openEveryOverlay(page);
    const readings = await page.evaluate(readProbes);
    await testInfo.attach('overlay-motion.json', { body: JSON.stringify({ notes, readings }, null, 1), contentType: 'application/json' });
    return readings;
  } finally {
    await keepSession(page, session);
  }
}

test.describe('reduced motion reaches the portalled overlays', () => {
  test.use({ reducedMotion: 'reduce' });
  test('dialog, sheet, popover and toast open without animating', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    const readings = await openAndRead(page, session, testInfo);
    const surfaces = readings.filter((r) => !/filler/.test(r.probe));
    expect(surfaces.map((r) => r.probe)).toEqual(expect.arrayContaining(['kit dialog', 'app dialog', 'kit sheet', 'app sheet', 'kit popover', 'kit toast', 'app toast']));
    expect(surfaces.filter((r) => !still(r)), 'overlays that still animate under reduced motion').toEqual([]);
  });
});

test.describe('control: no motion preference', () => {
  test.use({ reducedMotion: 'no-preference' });
  test('the same dialog and sheet DO animate (the reduced-motion test can fail)', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    const readings = await openAndRead(page, session, testInfo);
    for (const probe of ['kit dialog', 'app dialog', 'kit sheet']) {
      const r = readings.find((x) => x.probe === probe);
      expect(r && !still(r), `${probe} animates without reduced motion: ${JSON.stringify(r)}`).toBe(true);
    }
  });
});

test.describe('no backdrop blur on a touch screen', () => {
  test.use({ reducedMotion: 'reduce' });
  test('scrims and image tiles blur on the desktop control only', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    const touch = gateDevice(testInfo.project.name).touch;
    const readings = await openAndRead(page, session, testInfo);
    const scrims = readings.filter((r) => /scrim$/.test(r.probe));
    expect(scrims.map((r) => r.probe)).toEqual(['kit dialog scrim', 'app dialog scrim', 'kit sheet scrim', 'app sheet scrim']);
    const filler = readings.find((r) => r.probe === 'image tile filler')!;
    if (touch) {
      expect(scrims.filter((r) => r.backdrop !== 'none'), 'scrims with a backdrop blur on a touch screen').toEqual([]);
      expect(filler.display, 'the image tile filler is not rendered on a touch screen').toBe('none');
    } else {
      // The desktop keeps its frosted kit and app scrims (the app sheet never had one).
      for (const s of scrims.filter((r) => r.probe !== 'app sheet scrim')) expect(s.backdrop, s.probe).toMatch(/blur\(3px\)/);
      expect(filler.display).toBe('block');
    }
  });
});
