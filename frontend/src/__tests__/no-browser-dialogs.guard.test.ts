/* =============================================================================
   Browser-dialog guard - zero tolerance, not a ratchet.

   No source file may call `window.confirm`, `window.alert`, or `window.prompt`
   (or their bare globals). The sweep that added this took all 22 `confirm` call
   sites to the app's own `ConfirmDialog` (via `useConfirm`) and all 5 `alert`
   sites to the app's own `toast`. Both counts are zero, so unlike the
   raw-<button> ratchet there is no allowance to spend: any reintroduction is a
   regression, and this fails on the first one.

   Two reasons the browser dialogs are not an acceptable fallback here:

   1. They are not the product. Chrome chrome in the middle of the app's own
      design language is the exact inconsistency the design system exists to
      prevent, and it cannot be styled, themed, or given a destructive tone.
   2. They are untestable and un-QA-able. These calls block the renderer and
      live outside the page, so neither Playwright, nor CDP, nor any automated
      browser session can accept one - a real delete path went unverified in
      live QA for exactly this reason. A React dialog or toast is drivable by
      the same tools that drive everything else.

   WHICH REPLACEMENT: `confirm` -> `useConfirm()`, because it asks a question and
   the answer changes what happens next. `alert` -> `toast()`, because it asks
   nothing; making the user dismiss a modal to acknowledge "that file is too
   large" is a worse product than the browser dialog it replaced. `prompt` has
   no call sites and no sanctioned replacement - build a real form.

   MATCHES THE CALL, NOT THE WORD. The bare-global pattern requires the opening
   paren AND a string-literal first argument, so prose in a doc comment ("shaped
   as a drop-in for `window.confirm`") does not trip it, and neither does the
   hook's own object-taking `confirm({ title })`. That distinction is
   deliberate: this repo has a documented history of guards reddening on their
   own explanatory comments, and the fix is to match syntax rather than to ban
   the vocabulary. The trade-off is that a same-named local helper called with a
   string literal would be a false positive; none exists today, and the fix then
   is to rename the helper, not to weaken the guard.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Tests may still spy on `window.confirm` to prove it is NOT called. */
const SKIP_DIRS = new Set(['__tests__', 'node_modules']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `window.X(...)`, or a bare `X(` whose first argument is a string - the globals' only
 * signature. The hook's own `confirm({ title })` takes an OBJECT, which is what separates the two.
 *
 * SCANNED OVER WHOLE-FILE TEXT, NOT LINE BY LINE. The first version of this guard tested each line
 * and therefore missed `confirm(\n  \`Delete bundle ...\`\n)` in PriceBookPage - a real call site,
 * invisible because the opening paren and the string sat on different lines. That is the same
 * multiline blind spot component-api-guard.test.ts records for raw <button> (83 found vs 849
 * actual). `\s` matches newlines in JS regex without any flag, so the whole-text scan closes it.
 */
const callPattern = (name: string) =>
  new RegExp(`\\bwindow\\s*\\.\\s*${name}\\s*\\(|(?<![.\\w])${name}\\s*\\(\\s*['"\`]`, 'g');

/** `confirm` -> useConfirm(), `alert` -> toast(), `prompt` -> a real form. */
const DIALOGS = {
  confirm: 'useConfirm()',
  alert: 'toast()',
  prompt: 'a real form',
} as const;

function findCalls(src: string, name: keyof typeof DIALOGS = 'confirm'): number[] {
  const lines: number[] = [];
  for (const m of src.matchAll(callPattern(name))) {
    lines.push(src.slice(0, m.index).split('\n').length);
  }
  return lines;
}

describe('browser-dialog guard', () => {
  const files = sourceFiles(SRC).map((file) => [file, readFileSync(file, 'utf8')] as const);

  for (const [name, replacement] of Object.entries(DIALOGS)) {
    it(`no source file calls the browser ${name} - use ${replacement} instead`, () => {
      const offenders: string[] = [];
      for (const [file, src] of files) {
        for (const line of findCalls(src, name as keyof typeof DIALOGS)) {
          offenders.push(`${relative(SRC, file)}:${line}`);
        }
      }
      expect(offenders, `Replace with ${replacement}:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it('the confirm pattern fires on real calls and stays quiet on prose and on the hook', () => {
    // Proves the guard works in BOTH directions, so a green run means something.
    expect(findCalls("if (window.confirm('Delete this?')) doIt();")).toHaveLength(1);
    expect(findCalls('const ok = window.confirm(msg);')).toHaveLength(1);
    expect(findCalls('if (confirm("Delete this brand?")) {')).toHaveLength(1);
    // The multiline form the line-based first draft missed.
    expect(findCalls('if (\n  confirm(\n    `Delete bundle "x"?`,\n  )\n) {')).toHaveLength(1);

    expect(findCalls(' * shaped as a drop-in for `window.confirm`.')).toHaveLength(0);
    expect(findCalls('const { confirm, confirmDialog } = useConfirm();')).toHaveLength(0);
    expect(findCalls('const ok = await confirm({ title: t });')).toHaveLength(0);
    expect(findCalls('const ok = await confirm(\n  userId ? { title: a } : { title: b }\n);')).toHaveLength(0);
  });

  it('the alert and prompt patterns fire on real calls and stay quiet on lookalikes', () => {
    expect(findCalls("alert('File must be under 2 MB');", 'alert')).toHaveLength(1);
    expect(findCalls('window.alert(msg);', 'alert')).toHaveLength(1);
    expect(findCalls('alert(\n  `Cannot delete this brand`,\n);', 'alert')).toHaveLength(1);
    expect(findCalls("window.prompt('Name?');", 'prompt')).toHaveLength(1);

    // Member calls and same-suffix identifiers are not the global.
    expect(findCalls("toast.alert('x');", 'alert')).toHaveLength(0);
    expect(findCalls("showAlert('x');", 'alert')).toHaveLength(0);
    expect(findCalls('<Alert variant="destructive">', 'alert')).toHaveLength(0);
    expect(findCalls('buildPrompt(`summarize`);', 'prompt')).toHaveLength(0);
    expect(findCalls("copilot.prompt('hi');", 'prompt')).toHaveLength(0);
  });
});
