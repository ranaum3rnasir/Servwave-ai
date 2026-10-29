/**
 * What the full sweep means to run (mobile slice 62): every device project and every state id.
 * The setup project writes it at the start of a sweep so the report (sweep.mjs, plain JS, which
 * cannot read the TypeScript lists) can say what did NOT run, not only what did.
 */
import { devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_DEVICES, SWEEP_DEVICES } from './devices';
import { isSweep, selectStates } from './routes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SWEEP_DIR = path.resolve(HERE, '..', 'test-results-mobile');
export const SWEEP_PLAN_FILE = path.join(SWEEP_DIR, 'sweep-plan.json');

export function sweepPlan() {
  return {
    devices: [...GATE_DEVICES, ...SWEEP_DEVICES].map((d) => {
      const desc = devices[d.descriptor]!;
      const vp = d.viewport ?? desc.viewport;
      return { id: d.id, matrix: d.matrix, viewport: `${vp.width}x${vp.height}`, engine: desc.defaultBrowserType };
    }),
    states: selectStates('', true).map((s) => s.id),
  };
}

export function writeSweepPlan() {
  if (!isSweep()) return;
  fs.mkdirSync(SWEEP_DIR, { recursive: true });
  fs.writeFileSync(SWEEP_PLAN_FILE, JSON.stringify(sweepPlan(), null, 1));
}
