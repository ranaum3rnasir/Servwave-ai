import { devices } from '@playwright/test';

/**
 * The six mobile-gate device projects (PRD module 12: D1, D2, D3, D7, D11 and the D0 control).
 *
 * Every one comes from Playwright's own device descriptors, so each carries its viewport, touch,
 * pixel ratio, user agent and default engine (WebKit for the Apple devices). `touch` decides
 * whether the touch-only checks (44 px primary controls, 16 px text inputs) apply.
 */
export interface GateDevice {
  /** Project name, also the device key in allowlist.json. */
  id: string;
  /** Name in Playwright's `devices` table. */
  descriptor: keyof typeof devices;
  touch: boolean;
  /** Viewport override, only for the desktop control (the descriptor is 1280x720 already). */
  viewport?: { width: number; height: number };
  /** Context options laid over the descriptor (Firefox: touch on, no `isMobile`, which it lacks). */
  extra?: { hasTouch?: boolean; isMobile?: boolean; deviceScaleFactor?: number };
  /** The rubric's matrix id (D0-D15, 01-audit-rubric.md); the sweep report names devices by it. */
  matrix?: string;
}

export const GATE_DEVICES: GateDevice[] = [
  { id: 'iphone-se', descriptor: 'iPhone SE', touch: true }, // 320x568, WebKit
  { id: 'galaxy-s24', descriptor: 'Galaxy S24', touch: true }, // 360x780, Chromium
  { id: 'iphone-15', descriptor: 'iPhone 15', touch: true }, // 393x659, WebKit
  { id: 'landscape-phone', descriptor: 'iPhone 17 Pro Max landscape', touch: true }, // 838x390, WebKit
  { id: 'ipad-mini', descriptor: 'iPad Mini', touch: true }, // 768x1024, WebKit
  { id: 'desktop', descriptor: 'Desktop Chrome', touch: false, viewport: { width: 1280, height: 720 } },
];

/**
 * The rest of the rubric's device matrix (slice 62). They are projects only in the full sweep
 * (MOBILE_GATE_SWEEP=1, `npm run test:mobile:sweep`), so a slice's own run stays on the six above.
 * D14 (Moto G4 at 4x CPU) is not here: its job is the performance budget, which Lighthouse runs
 * with exactly that emulation (lighthouse-budget.ts).
 */
export const SWEEP_DEVICES: GateDevice[] = [
  { id: 'iphone-17-pro-max', descriptor: 'iPhone 17 Pro Max', touch: true, matrix: 'D4' }, // 440x763, WebKit
  { id: 'pixel-7', descriptor: 'Pixel 7', touch: true, matrix: 'D5' }, // 412x839, Chromium
  { id: 'iphone-se-landscape', descriptor: 'iPhone SE landscape', touch: true, matrix: 'D6' }, // 568x320, WebKit
  { id: 'pixel-7-landscape', descriptor: 'Pixel 7 landscape', touch: true, matrix: 'D8' }, // 863x360, Chromium
  { id: 'fold-cover', descriptor: 'Galaxy Z Fold 7 Cover', touch: true, matrix: 'D9' }, // 360x764, Chromium
  { id: 'fold-unfolded', descriptor: 'Galaxy Z Fold 7', touch: true, matrix: 'D10' }, // 984x1016, Chromium
  { id: 'ipad-mini-landscape', descriptor: 'iPad Mini landscape', touch: true, matrix: 'D12' }, // 1024x768, WebKit
  { id: 'tab-s9', descriptor: 'Galaxy Tab S9', touch: true, matrix: 'D13' }, // 640x1024: exactly sm
  // Gecko: no `isMobile` in Firefox, so a 360x740 desktop-Firefox context with touch on.
  { id: 'firefox', descriptor: 'Desktop Firefox', touch: true, viewport: { width: 360, height: 740 }, extra: { hasTouch: true }, matrix: 'D15' },
];

for (const d of GATE_DEVICES) d.matrix ??= { 'iphone-se': 'D1', 'galaxy-s24': 'D2', 'iphone-15': 'D3', 'landscape-phone': 'D7', 'ipad-mini': 'D11', desktop: 'D0' }[d.id];

export const DEVICE_IDS = GATE_DEVICES.map((d) => d.id);
export const SWEEP_DEVICE_IDS = SWEEP_DEVICES.map((d) => d.id);

export function gateDevice(projectName: string): GateDevice {
  const d = [...GATE_DEVICES, ...SWEEP_DEVICES].find((x) => x.id === projectName);
  if (!d) throw new Error(`Not a mobile-gate device project: ${projectName}`);
  return d;
}

/** Playwright `use` block for a device: the descriptor, with its engine as browserName. */
export function deviceUse(d: GateDevice) {
  const { defaultBrowserType, ...desc } = devices[d.descriptor];
  return { ...desc, ...(d.viewport ? { viewport: d.viewport } : {}), ...(d.extra ?? {}), browserName: defaultBrowserType };
}
