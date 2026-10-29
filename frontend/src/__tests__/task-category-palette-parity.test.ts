/**
 * The task category palette is enforced twice - by the manager's swatches (TAG_COLORS, which
 * both tag pickers also draw from) and by the API, which refuses any other color
 * (TASK_CATEGORY_COLORS in backend/src/lib/tasks/categories.ts). The two packages cannot share a
 * module, so this reads the backend file and fails the moment the lists drift: a color the picker
 * offers but the API refuses, or the reverse.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TAG_COLORS } from '@/lib/tag-colors';

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_CATEGORIES = resolve(HERE, '..', '..', '..', 'backend', 'src', 'lib', 'tasks', 'categories.ts');

function backendPalette(): string[] {
  const src = readFileSync(BACKEND_CATEGORIES, 'utf8');
  const block = src.match(/export const TASK_CATEGORY_COLORS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error('TASK_CATEGORY_COLORS not found in backend/src/lib/tasks/categories.ts');
  return [...block[1].matchAll(/'(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1].toUpperCase());
}

describe('task category palette - frontend and API agree', () => {
  it('the API accepts exactly the colors the swatches offer, in the same order', () => {
    expect(backendPalette()).toEqual(TAG_COLORS.map((c) => c.toUpperCase()));
  });
});
