/**
 * Mobile slice 15 (rubric TOUCH-03, TOUCH-04): hover only where hover exists, and no action that
 * only a hover can reveal.
 *
 * Three halves, all measured on what actually ships rather than on a class name:
 *
 * 1. The Tailwind config, compiled with the REAL config: every `hover:` / `group-hover:` utility
 *    lands inside the can-hover media query (so a tap on a phone cannot leave a button stuck in
 *    its hover look), the `touch:` and `can-hover:` variants exist, and `hover-reveal` is visible
 *    by default and hidden-until-hover only under can-hover.
 * 2. Every hand-written `:hover` rule in `src/**.css` sits inside the same media query.
 * 3. A ratchet over the source: an element hidden at rest and revealed by hover (the rubric's own
 *    detect pattern) is allowed only where this file says why, so a new one cannot land.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import postcss, { type AtRule, type Node, type Root, type Rule } from 'postcss';
import tailwindcss from 'tailwindcss';
import { describe, expect, it } from 'vitest';

const FRONTEND = resolve(__dirname, '../../..');
const SRC = join(FRONTEND, 'src');

/** The REAL config (plain JS, so loaded by path rather than a typed import). */
async function loadTailwindConfig(): Promise<Record<string, unknown>> {
  const mod = (await import(/* @vite-ignore */ join(FRONTEND, 'tailwind.config.js'))) as { default: Record<string, unknown> };
  return mod.default;
}

/** The query Tailwind's `hoverOnlyWhenSupported` emits; `can-hover:` must agree with it. */
const CAN_HOVER = '(hover: hover) and (pointer: fine)';
const COARSE = '(pointer: coarse)';

async function compile(classes: string): Promise<Root> {
  const config = {
    ...(await loadTailwindConfig()),
    content: [{ raw: `<div class="${classes}"></div>`, extension: 'html' }],
    safelist: [],
  };
  const out = await postcss([tailwindcss(config as never)]).process('@tailwind utilities;', { from: undefined });
  return out.root;
}

/** The params of every @media rule wrapping `node`, innermost first. */
function mediaAncestors(node: Node): string[] {
  const out: string[] = [];
  for (let p = node.parent; p && p.type !== 'root'; p = p.parent) {
    if (p.type === 'atrule' && (p as AtRule).name === 'media') out.push((p as AtRule).params.replace(/\s+/g, ' ').trim());
  }
  return out;
}

function rulesMatching(root: Root, test: (selector: string) => boolean): Rule[] {
  const found: Rule[] = [];
  root.walkRules((r) => {
    if (test(r.selector)) found.push(r);
  });
  return found;
}

const decl = (r: Rule, prop: string) => r.nodes.find((n) => n.type === 'decl' && n.prop === prop) as { value: string } | undefined;

describe('Tailwind hover policy (TOUCH-03)', () => {
  it('puts every hover: utility inside the can-hover media query', async () => {
    const root = await compile('hover:bg-primary hover:text-danger hover:underline');
    const hovers = rulesMatching(root, (s) => s.includes(':hover'));
    expect(hovers.length).toBeGreaterThanOrEqual(3);
    for (const r of hovers) expect(mediaAncestors(r), r.selector).toContain(CAN_HOVER);
  });

  it('puts group-hover: and peer-hover: utilities inside the same query', async () => {
    const root = await compile('group group-hover:text-primary peer peer-hover:opacity-100');
    const hovers = rulesMatching(root, (s) => s.includes(':hover'));
    expect(hovers.length).toBeGreaterThanOrEqual(2);
    for (const r of hovers) expect(mediaAncestors(r), r.selector).toContain(CAN_HOVER);
  });

  it('has a touch: variant for coarse pointers', async () => {
    const root = await compile('touch:min-h-11');
    const [r] = rulesMatching(root, (s) => s.includes('touch\\:min-h-11'));
    expect(r, 'touch:min-h-11 produced no rule').toBeDefined();
    expect(mediaAncestors(r!)).toContain(COARSE);
  });

  it('has a can-hover: variant on the same query hover: uses', async () => {
    const root = await compile('can-hover:opacity-0');
    const [r] = rulesMatching(root, (s) => s.includes('can-hover\\:opacity-0'));
    expect(r, 'can-hover:opacity-0 produced no rule').toBeDefined();
    expect(mediaAncestors(r!)).toContain(CAN_HOVER);
  });
});

describe('hover-reveal: visible by default, hidden until hover only under can-hover (TOUCH-04)', () => {
  it('never hides the element outside the can-hover query', async () => {
    const root = await compile('group hover-reveal');
    const rules = rulesMatching(root, (s) => s.includes('.hover-reveal'));
    expect(rules.length, 'hover-reveal produced no rule').toBeGreaterThan(0);
    const hidingOutside = rules.filter((r) => decl(r, 'opacity')?.value === '0' && !mediaAncestors(r).includes(CAN_HOVER));
    expect(hidingOutside.map((r) => r.selector)).toEqual([]);
  });

  it('hides at rest and reveals on row hover, keyboard focus and an open menu under can-hover', async () => {
    const root = await compile('group hover-reveal');
    const inQuery = rulesMatching(root, (s) => s.includes('.hover-reveal')).filter((r) => mediaAncestors(r).includes(CAN_HOVER));
    const hidden = inQuery.filter((r) => decl(r, 'opacity')?.value === '0').map((r) => r.selector);
    expect(hidden).toContain('.hover-reveal');
    const shown = inQuery.filter((r) => decl(r, 'opacity')?.value === '1').flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    expect(shown).toEqual(expect.arrayContaining([
      '.group:hover .hover-reveal',
      '.group:focus-within .hover-reveal',
      '.hover-reveal:focus-within',
    ]));
  });
});

// ─── 2. hand-written :hover rules ─────────────────────────────────────────────

function walkFiles(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, ext, out);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

describe('hand-written :hover rules (TOUCH-03)', () => {
  const cssFiles = walkFiles(SRC, /\.css$/);

  it('finds the stylesheets it is meant to police', () => {
    const rel = cssFiles.map((f) => relative(FRONTEND, f).split(sep).join('/'));
    expect(rel).toEqual(expect.arrayContaining(['src/ui-kit/components/layout/shell.css', 'src/styles/schedule-dark.css']));
  });

  /**
   * The copilot's own two controls (the top-bar pill and the sidebar's AI row). The copilot is
   * out of service and its button is left exactly as it is by decision (PRD module 7), so these
   * two rules are not touched here.
   */
  const COPILOT_SELECTORS = new Set(['.tb-pill:hover', '.sb-item.is-ai:hover']);

  it('wraps every :hover selector in the can-hover media query', () => {
    const unguarded: string[] = [];
    for (const file of cssFiles) {
      const root = postcss.parse(readFileSync(file, 'utf8'), { from: file });
      root.walkRules((r) => {
        if (!r.selector.includes(':hover')) return;
        if (COPILOT_SELECTORS.has(r.selector.trim())) return;
        const guarded = mediaAncestors(r).some((m) => m.includes('hover: hover'));
        if (!guarded) unguarded.push(`${relative(FRONTEND, file)}:${r.source?.start?.line} ${r.selector.replace(/\s+/g, ' ')}`);
      });
    }
    expect(unguarded).toEqual([]);
  });
});

// ─── 3. hover-only reveals in the source ──────────────────────────────────────

/** The rubric's TOUCH-04 detect pattern: something hover turns visible. */
const REVEAL = /(?:group-hover|group-hover\/[\w-]+|peer-hover):(?:opacity-100|visible|block|flex|inline|grid)\b|(?<![\w-])hover:(?:opacity-100|visible|block|flex)\b/;

/**
 * Lines still matching the pattern, per file, and why each is not a hover-only action on a live
 * screen. Keyed by count, not line number, so an unrelated edit above does not churn it. Lower a
 * count when you fix one; never raise it.
 */
const ALLOWED: Record<string, { count: number; why: string }> = {
  'src/components/ui/toast.tsx': { count: 1, why: 'toast close: mobile slice 27 (the toaster) owns it' },
  'src/components/ui/sheet.tsx': { count: 1, why: 'close is opacity-70 at rest, never hidden; hover only brightens it' },
  'src/ui-kit/components/crm/recordCard.tsx': { count: 1, why: 'no importer: renders on no screen' },
  'src/ui-kit/components/crm/kanbanBoard/kanbanColumn.tsx': { count: 1, why: 'column "..." button has no handler: there is no action to reveal' },
  'src/components/dashboard/widgets/NeedsAttention.tsx': { count: 1, why: 'decorative chevron; the whole row is the tap target' },
  'src/pages/v2/dashboard/widgets/needsAttention.tsx': { count: 1, why: 'decorative chevron; the whole row is the tap target' },
  'src/components/inventory/ApprovalsView.tsx': { count: 1, why: 'no importer: renders on no screen' },
  'src/components/jobs/items/ProductThumb.tsx': { count: 1, why: 'decorative zoom glyph; the whole thumbnail is the button' },
  'src/pages/v2/leads/LeadDetailPage.tsx': { count: 1, why: 'decorative pencil in an estimate row; the whole row opens the estimate' },
  'src/components/data/ContactCell.tsx': { count: 1, why: 'used only by the v1 LeadsPage/CustomersPage, which no route renders' },
  'src/pages/inventory/PriceBookPage.tsx': { count: 3, why: 'v1 page; /inventory/price-book renders pages/v2/inventory/PriceBookPage' },
};

describe('hover-only reveals (TOUCH-04)', () => {
  const files = walkFiles(SRC, /\.tsx?$/).filter((f) => !/\.(test|stories)\.tsx?$/.test(f));

  it('allows a hover-revealed element only where it is not an action on a live screen', () => {
    const counts: Record<string, number> = {};
    const lines: string[] = [];
    for (const file of files) {
      const rel = relative(FRONTEND, file).split(sep).join('/');
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // Comments that describe the old pattern are not class strings.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (!REVEAL.test(line)) return;
        counts[rel] = (counts[rel] ?? 0) + 1;
        lines.push(`${rel}:${i + 1}`);
      });
    }
    const over = Object.entries(counts)
      .filter(([rel, n]) => n > (ALLOWED[rel]?.count ?? 0))
      .map(([rel, n]) => `${rel}: ${n} hover-only reveal line(s), allowed ${ALLOWED[rel]?.count ?? 0}`);
    expect(over, `use the hover-reveal class instead (visible on touch). Lines:\n${lines.join('\n')}`).toEqual([]);
  });
});
