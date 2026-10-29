// Mobile slice 53: the older titled dialog (`components/ui/modal`) rides the adaptive overlay.
//
//   1. Every `<Modal>` in the app states an intent ("form", "choice" or "content"), so its close and
//      footer stop scrolling away on a phone. A new `<Modal>` without one fails here (and does not
//      type-check: `intent` is required).
//   2. The Modal draws all three presentations with the SAME slots: a pinned header with the close,
//      a body that is the only scroller, a pinned footer. A bottom sheet (a "choice") used to fall
//      through to the card layout inside a `p-0` panel, which has no padding at all.
//   3. The full-screen body keeps the card's 16 px rhythm between sibling children.
//   4. At md and up it is the card it is today.
//
// jsdom applies no CSS, so presentation is read from `data-presentation` and the classes that carry
// the geometry. The real-browser side is `e2e/mobile/legacy-modal.spec.ts`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { Modal } from '@/components/ui/modal';
import { DeleteItemDialog } from '@/components/inventory/DeleteItemDialog';
import { sourceFiles } from './layout-guards/scan';

function mockWidth(opts: { belowMd: boolean; shortHeight?: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      (query === MEDIA.belowMd && opts.belowMd) || (query === MEDIA.shortHeight && !!opts.shortHeight),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// 1. Every <Modal> states an intent

/** The opening tag starting at `start`, brace-aware so `=>` and `{...}` do not end it early. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(start, i + 1);
  }
  return src.slice(start);
}

const INTENT = /\sintent=("form"|"choice"|"content"|\{['"](form|choice|content)['"]\})/;

describe('every <Modal> states an intent', () => {
  it('has no <Modal> without a literal intent of form, choice or content', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const [file, src] of sourceFiles()) {
      if (file === 'components/ui/modal.tsx') continue;
      const re = /<Modal(?=[\s/>])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        // A comment that names the tag is not the tag.
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(src.slice(lineStart, m.index + 1))) continue;
        seen++;
        if (!INTENT.test(openingTag(src, m.index))) {
          offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(seen, 'the scan found the Modal sites').toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2-4. The three presentations

function Sample({ intent }: { intent: 'form' | 'choice' | 'content' }) {
  return (
    <Modal
      open
      onClose={() => {}}
      title="Sample"
      subtitle="Sub"
      intent={intent}
      footer={<button type="button">Save</button>}
    >
      <input aria-label="First" />
      <input aria-label="Second" />
    </Modal>
  );
}

describe('Modal presentations', () => {
  it('a choice on a phone is a bottom sheet with the header, body and footer slots', () => {
    mockWidth({ belowMd: true });
    render(<Sample intent="choice" />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(dialog.className).toMatch(/max-h-\[min\(\d+dvh,/);
    const body = dialog.querySelector('[data-slot="modal-body"]')!;
    expect(body, 'the body slot exists in a sheet too').not.toBeNull();
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('overscroll-contain');
    // The footer is a sibling of the body, outside the scroller.
    expect(body.contains(screen.getByRole('button', { name: 'Save' }))).toBe(false);
    expect(screen.getByRole('button', { name: 'Save' }).parentElement!.className).toContain('var(--safe-bottom,0px)');
    // The sheet has no status bar above it: its header is not padded by the top safe area.
    expect(dialog.querySelector('[data-slot="modal-header"]')!.className).not.toContain('safe-area-inset-top');
  });

  it('a form and a content dialog on a phone are full-screen with the same slots', () => {
    mockWidth({ belowMd: true });
    for (const intent of ['form', 'content'] as const) {
      const { unmount } = render(<Sample intent={intent} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('data-presentation', 'fullscreen');
      expect(dialog.className).toContain('h-[calc(100dvh-var(--keyboard-inset,0px))]');
      expect(dialog.querySelector('[data-slot="modal-body"]')).not.toBeNull();
      expect(dialog.querySelector('[data-slot="modal-header"]')!.className).toContain('safe-area-inset-top');
      unmount();
    }
  });

  it('a landscape phone (wide but short) takes a form full-screen and keeps a choice as a card', () => {
    mockWidth({ belowMd: false, shortHeight: true });
    const { unmount } = render(<Sample intent="form" />);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', 'fullscreen');
    unmount();
    render(<Sample intent="choice" />);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', 'card');
  });

  it('keeps the card layout\'s 16 px rhythm between sibling children in the full-screen body', () => {
    mockWidth({ belowMd: true });
    render(<Sample intent="form" />);
    const body = screen.getByRole('dialog').querySelector('[data-slot="modal-body"]')!;
    expect(body.className).toContain('grid');
    expect(body.className).toContain('gap-4');
    // A grid track is floored by its widest nowrap child unless it can shrink to the container.
    expect(body.className).toContain('grid-cols-[minmax(0,1fr)]');
  });

  it('is today\'s card at md and up: no slots, no pinned layout, whatever the intent', () => {
    mockWidth({ belowMd: false });
    for (const intent of ['form', 'choice', 'content'] as const) {
      const { unmount } = render(<Sample intent={intent} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('data-presentation', 'card');
      expect(dialog.querySelector('[data-slot="modal-body"]')).toBeNull();
      expect(dialog.className).not.toContain('h-dvh');
      expect(dialog.className).toContain('max-w-lg');
      unmount();
    }
  });

  it('mounts exactly one dialog and one 44 px-on-touch close in every presentation', () => {
    for (const belowMd of [true, false]) {
      mockWidth({ belowMd });
      for (const intent of ['form', 'choice', 'content'] as const) {
        const { unmount } = render(<Sample intent={intent} />);
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        const closes = screen.getAllByRole('button', { name: 'Close' });
        expect(closes).toHaveLength(1);
        expect(closes[0].className).toContain('touch:size-11');
        unmount();
      }
    }
  });
});

describe('a real legacy dialog on a phone', () => {
  it('Delete item is a bottom sheet whose Delete button is outside the scrolling body', () => {
    mockWidth({ belowMd: true });
    const item = { id: 'i1', name: 'Gate item', sku: 'G-1', stock: [] } as never;
    render(<DeleteItemDialog open onClose={() => {}} item={item} onConfirm={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: /delete item\?/i });
    expect(dialog).toHaveAttribute('data-presentation', 'bottom-sheet');
    const body = dialog.querySelector('[data-slot="modal-body"]')!;
    const del = within(dialog).getByRole('button', { name: 'Delete Item' });
    expect(body.contains(del)).toBe(false);
    expect(dialog.contains(del)).toBe(true);
  });
});
