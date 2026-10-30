/**
 * Payments W2: one on/off control everywhere. The Switch Ran approved ("Allow partial payments")
 * is the ui-kit one. The old path stays only as a pure re-export so no second look-alike exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(tsx?|jsx?)$/.test(name) && !/\.(test|stories)\./.test(name)) out.push(p);
  }
  return out;
}

describe('one Switch component', () => {
  it('the legacy components/ui/switch is a pure re-export of the ui-kit Switch', () => {
    const code = readFileSync(join(SRC, 'components/ui/switch.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .trim();
    expect(code).toMatch(/^export \{ Switch \} from ['"]@\/ui-kit\/components\/ui\/switch['"];?$/);
  });

  it('no source file builds its own switch from the Radix primitive, except the ui-kit one', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith(join('ui-kit', 'components', 'ui', 'switch.tsx')))
      .filter((f) => /@radix-ui\/react-switch/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
