/* =============================================================================
   Disabled-action reasons guard (mobile slice 40, rubric TOUCH-05).

   A `title` is a hover tooltip: a touch screen never shows it. So a `<Button>` that
   is disabled and explains itself must use `disabledReason` (tap or Enter opens it as
   helper text; the shell keeps the title for hover), never a bare `title`.

     <Button disabled disabledReason="Save first">     pass
     <Button disabled aria-label="Delete" title="Delete">   pass (title just restates the name)
     <Button disabled title="Save first">                FAIL

   Raw `<button>` elements that still carry a disabled reason as a title are listed in
   RAW_BUTTON_DEFERRED, counted per file as a ratchet: a new one fails, and a fixed one
   must be removed from the list.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { sourceFiles } from './layout-guards/scan';

interface Hit {
  tag: string;
  line: number;
}

function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(start, i + 1);
  }
  return src.slice(start);
}

const hasAttr = (tag: string, name: string) => new RegExp(`\\s${name}(=|\\s|/|>)`).test(tag);

/** Opening tags of `<name` (Button or button) that are disabled and carry a title but no reason. */
export function findTitleOnlyReasons(src: string, name: 'Button' | 'button'): Hit[] {
  const out: Hit[] = [];
  const re = new RegExp(`<${name}(?=[\\s/>])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tag = openingTag(src, m.index);
    if (!hasAttr(tag, 'disabled') || !hasAttr(tag, 'title')) continue;
    if (hasAttr(tag, 'disabledReason')) continue;
    if (hasAttr(tag, 'aria-label')) continue; // the title only restates the name
    out.push({ tag: tag.replace(/\s+/g, ' ').slice(0, 80), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** file (relative to frontend/src) -> number of raw <button> title-only reasons still open. */
const RAW_BUTTON_DEFERRED: Record<string, number> = {
  'components/communication/inbox/ComposeWindow.tsx': 2, // sending-off label
  'components/inventory/AddItemDialog.tsx': 2, // read-only upload / camera
  'components/inventory/ApprovalEmailDialog.tsx': 1, // already-added recipient chip
  'components/inventory/EmailComposeDialog.tsx': 1, // already-added recipient chip
  'components/inventory/EstimateComparisonDialog.tsx': 1,
  'components/inventory/StageDetailDialog.tsx': 1, // upload needs Edit Stage
  'components/inventory/TransferDialog.tsx': 2,
  'features/estimate-workspace/components/EstimateNameTitle.tsx': 1, // read-only title, no reason shown
  'pages/settings/RolesPage.tsx': 1, // v1 page, not routed
};
/** Kit/legacy Buttons whose bare title is a label, not a reason. */
const BUTTON_EXEMPT: Record<string, string> = {
  'components/inventory/POPreviewDialog.tsx': 'title names the action (Clear the signature), not a reason',
};

describe('disabled-action reasons guard (mobile slice 40, TOUCH-05)', () => {
  it('fires on a disabled Button whose reason is only a title', () => {
    expect(findTitleOnlyReasons('<Button disabled title="Save first">Go</Button>', 'Button')).toHaveLength(1);
    expect(
      findTitleOnlyReasons('<Button\n  onClick={go}\n  disabled={!ok}\n  title={ok ? undefined : "Why"}\n>Go</Button>', 'Button'),
    ).toHaveLength(1);
    expect(findTitleOnlyReasons('<button type="button" disabled={x} title="Why">Go</button>', 'button')).toHaveLength(1);
  });

  it('passes a Button with disabledReason, a title that restates an aria-label, and enabled buttons', () => {
    expect(findTitleOnlyReasons('<Button disabled disabledReason="Save first">Go</Button>', 'Button')).toEqual([]);
    expect(findTitleOnlyReasons('<Button disabled aria-label="Delete" title="Delete">x</Button>', 'Button')).toEqual([]);
    expect(findTitleOnlyReasons('<Button title="Go">Go</Button>', 'Button')).toEqual([]);
    expect(findTitleOnlyReasons('<Button disabled>Go</Button>', 'Button')).toEqual([]);
    // `disabledReason` must not be mistaken for `disabled`, nor a `title` inside a child element.
    expect(findTitleOnlyReasons('<Button disabledReason="Why"><span title="x" /></Button>', 'Button')).toEqual([]);
  });

  it('no Button in src is disabled with a title as the only carrier of its reason', () => {
    const found: string[] = [];
    for (const [file, src] of sourceFiles()) {
      if (!file.endsWith('.tsx') || BUTTON_EXEMPT[file]) continue;
      for (const h of findTitleOnlyReasons(src, 'Button')) found.push(`${file}:${h.line} ${h.tag}`);
    }
    expect(found).toEqual([]);
  });

  it('raw <button> title-only reasons do not grow (ratchet)', () => {
    const counts: Record<string, number> = {};
    for (const [file, src] of sourceFiles()) {
      if (!file.endsWith('.tsx')) continue;
      const n = findTitleOnlyReasons(src, 'button').length;
      if (n) counts[file] = n;
    }
    expect(counts).toEqual(RAW_BUTTON_DEFERRED);
  });
});
