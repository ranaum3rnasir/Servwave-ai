// Mobile slice 65: every remaining dialog rides the adaptive overlay, and no dialog nests a list
// scroller inside its own body scroller.
//
//   1. The older dialog primitive (`components/ui/dialog`) gives a dialog that states an intent a
//      pinned header, a body that is the ONLY scroller and a pinned footer on a phone, whatever
//      shape the caller poured in (loose rows, a <form>, a hand-rolled button row), and stays
//      exactly today's card at md and up.
//   2. A list that is capped and scrolls on its own as a card flows in the body on a phone.
//   3. Static guards: every <DialogContent> in the app states an intent, and none sets its own
//      viewport-height cap (a `vh` value replaces the primitive's dynamic-viewport cap).
//
// jsdom applies no CSS, so presentation is read from `data-presentation`, the slots and the classes
// that carry the geometry. The real-browser side is `e2e/mobile/remaining-dialogs.spec.ts`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MEDIA } from '@/ui-kit/lib/breakpoints';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useNestedListClass } from '@/ui-kit/hooks/useOverlayPresentation';
import { DialogList } from '@/ui-kit/components/ui/dialogList';
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

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`);

// ---------------------------------------------------------------------------
// 1. The older dialog primitive on a phone

function LoosePoured({ intent }: { intent?: 'form' | 'choice' | 'content' }) {
  return (
    <Dialog open>
      <DialogContent intent={intent} className="max-w-md">
        <DialogHeader><DialogTitle>Loose rows</DialogTitle></DialogHeader>
        <label>Name<input aria-label="Name" /></label>
        <div className="flex justify-end gap-2"><button type="button">Hand-rolled action</button></div>
        <DialogFooter><button type="button">Save</button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe('the older dialog on a phone', () => {
  it('a form is full-screen: pinned header, the body is the only scroller, pinned footer', () => {
    mockWidth({ belowMd: true });
    render(<LoosePoured intent="form" />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-presentation', 'fullscreen');
    const header = slot('dialog-header')!;
    const body = slot('dialog-body')!;
    const footer = slot('dialog-footer')!;
    expect(header, 'a header slot').not.toBeNull();
    expect(body, 'a body slot').not.toBeNull();
    expect(footer, 'a footer slot').not.toBeNull();
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('overscroll-contain');
    expect(body.className).toContain('min-h-0');
    // The loose rows, including the hand-rolled button row, scroll in the body...
    expect(body.contains(screen.getByLabelText('Name'))).toBe(true);
    expect(body.contains(screen.getByRole('button', { name: 'Hand-rolled action' }))).toBe(true);
    // ...and the header and the footer do not.
    expect(body.contains(header)).toBe(false);
    expect(body.contains(footer)).toBe(false);
    expect(footer.contains(screen.getByRole('button', { name: 'Save' }))).toBe(true);
    // The footer is padded above the home indicator; the header clears the status bar.
    expect(footer.className).toContain('var(--safe-bottom,0px)');
    expect(header.className).toContain('safe-area-inset-top');
    // The panel itself does not scroll.
    expect(dialog.className).toContain('overflow-hidden');
  });

  it('the caller\'s own width is the card\'s, and does not narrow the full-screen form', () => {
    mockWidth({ belowMd: true });
    render(<LoosePoured intent="form" />);
    expect(screen.getByRole('dialog').className).toContain('!max-w-none');
  });

  it('a choice is a bottom sheet with the same slots, its header clear of any status bar', () => {
    mockWidth({ belowMd: true });
    render(<LoosePoured intent="choice" />);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(slot('dialog-body')!.className).toContain('overflow-y-auto');
    expect(slot('dialog-header')!.className).not.toContain('safe-area-inset-top');
    expect(slot('dialog-footer')).not.toBeNull();
  });

  it('a dialog with no footer still gets a body, and no empty footer slot', () => {
    mockWidth({ belowMd: true });
    render(
      <Dialog open>
        <DialogContent intent="content">
          <DialogHeader><DialogTitle>Reader</DialogTitle></DialogHeader>
          <p>Something to read</p>
        </DialogContent>
      </Dialog>,
    );
    expect(slot('dialog-body')!.textContent).toContain('Something to read');
    expect(slot('dialog-footer')).toBeNull();
  });

  it('a <form> that wraps the rows and the footer keeps its footer pinned and its body scrolling', () => {
    mockWidth({ belowMd: true });
    render(
      <Dialog open>
        <DialogContent intent="form">
          <DialogHeader><DialogTitle>Wrapped</DialogTitle></DialogHeader>
          <form onSubmit={(e) => e.preventDefault()} data-testid="the-form">
            <input aria-label="Field" />
            <DialogFooter><button type="submit">Submit</button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>,
    );
    const form = screen.getByTestId('the-form');
    // The form is a flex column that can shrink, so the body inside it can scroll.
    expect(form.className).toContain('flex-col');
    expect(form.className).toContain('min-h-0');
    const body = slot('dialog-body')!;
    expect(form.contains(body)).toBe(true);
    expect(body.contains(screen.getByLabelText('Field'))).toBe(true);
    expect(body.contains(screen.getByRole('button', { name: 'Submit' }))).toBe(false);
    expect(slot('dialog-footer')!.contains(screen.getByRole('button', { name: 'Submit' }))).toBe(true);
  });

  it('a fragment of rows is flattened into the one body', () => {
    mockWidth({ belowMd: true });
    render(
      <Dialog open>
        <DialogContent intent="form">
          <DialogHeader><DialogTitle>Fragment</DialogTitle></DialogHeader>
          <>
            <input aria-label="One" />
            <input aria-label="Two" />
          </>
          {false}
          {null}
        </DialogContent>
      </Dialog>,
    );
    expect(document.querySelectorAll('[data-slot="dialog-body"]')).toHaveLength(1);
    const body = slot('dialog-body')!;
    expect(body.contains(screen.getByLabelText('One'))).toBe(true);
    expect(body.contains(screen.getByLabelText('Two'))).toBe(true);
  });

  it('a dialog that lays out its own header, body and footer (layout="own") is not wrapped again', () => {
    mockWidth({ belowMd: true });
    render(
      <Dialog open>
        <DialogContent intent="form" layout="own" className="p-0">
          <div data-testid="own-header">Own header</div>
          <div data-testid="own-body" className="min-h-0 flex-1 overflow-y-auto">
            <input aria-label="Own" />
          </div>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', 'fullscreen');
    expect(slot('dialog-body')).toBeNull();
    expect(screen.getByTestId('own-body').parentElement).toBe(screen.getByRole('dialog'));
  });

  it('is today\'s card at md and up, whatever the intent: no slots, children poured straight in', () => {
    mockWidth({ belowMd: false });
    for (const intent of ['form', 'choice', 'content'] as const) {
      const { unmount } = render(<LoosePoured intent={intent} />);
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('data-presentation', 'card');
      expect(slot('dialog-body')).toBeNull();
      expect(dialog.className).toContain('max-w-md');
      expect(dialog.className).toContain('max-h-[calc(100dvh-2.5rem)]');
      // The header and footer are the plain ones: no border, no pinned padding.
      expect(slot('dialog-header')!.className).not.toContain('border-b');
      expect(slot('dialog-footer')!.className).not.toContain('border-t');
      unmount();
    }
  });

  it('is the card at every width with no intent (a dialog opts in by stating one)', () => {
    mockWidth({ belowMd: true });
    render(<LoosePoured />);
    expect(screen.getByRole('dialog')).toHaveAttribute('data-presentation', 'card');
    expect(slot('dialog-body')).toBeNull();
  });

  it('mounts one dialog and one close button in every presentation', () => {
    for (const belowMd of [true, false]) {
      mockWidth({ belowMd });
      for (const intent of ['form', 'choice', 'content'] as const) {
        const { unmount } = render(<LoosePoured intent={intent} />);
        expect(screen.getAllByRole('dialog')).toHaveLength(1);
        expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
        unmount();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. A list inside a dialog body

function CappedList({ intent }: { intent?: 'form' | 'choice' | 'content' }) {
  // The list is written right here, in the component that renders the dialog: a hook called in
  // THIS component would sit above the dialog's provider, which is why the list is a component.
  return (
    <Dialog open>
      <DialogContent intent={intent}>
        <DialogHeader><DialogTitle>With a list</DialogTitle></DialogHeader>
        <DialogList as="ul" data-testid="list" cap="max-h-56 overflow-y-auto" className="divide-y">
          <li>One</li>
        </DialogList>
      </DialogContent>
    </Dialog>
  );
}

describe('a list inside a dialog body', () => {
  it('is capped and scrolls on its own as a card', () => {
    mockWidth({ belowMd: false });
    render(<CappedList intent="form" />);
    expect(screen.getByTestId('list').className).toBe('max-h-56 overflow-y-auto divide-y');
  });

  it('flows in the body (no cap, no scroller of its own) on a phone, in a sheet and full-screen', () => {
    mockWidth({ belowMd: true });
    for (const intent of ['form', 'choice', 'content'] as const) {
      const { unmount } = render(<CappedList intent={intent} />);
      expect(screen.getByTestId('list').className).toBe('divide-y');
      unmount();
    }
  });

  it('flows in the body on a landscape phone, where a form is full-screen', () => {
    mockWidth({ belowMd: false, shortHeight: true });
    render(<CappedList intent="form" />);
    expect(screen.getByTestId('list').className).toBe('divide-y');
  });

  it('keeps its cap outside any dialog', () => {
    mockWidth({ belowMd: true });
    function Bare() {
      return <ul data-testid="bare" className={useNestedListClass('max-h-56 overflow-y-auto')} />;
    }
    render(<Bare />);
    expect(screen.getByTestId('bare').className).toBe('max-h-56 overflow-y-auto');
  });
});

// ---------------------------------------------------------------------------
// 3. Static guards over every dialog site

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

function dialogContentTags(): Array<{ file: string; line: number; tag: string }> {
  const out: Array<{ file: string; line: number; tag: string }> = [];
  for (const [file, src] of sourceFiles()) {
    const re = /<DialogContent(?=[\s/>])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(src.slice(lineStart, m.index + 1))) continue;
      out.push({ file, line: src.slice(0, m.index).split('\n').length, tag: openingTag(src, m.index) });
    }
  }
  return out;
}

// A literal intent, or the wrapper's own `intent` prop (the shared confirm dialogs pass theirs on).
// A confirmation that takes fields is a form, one that does not is a choice: `intent={children ? 'form' : 'choice'}`.
const INTENT = /\sintent=("form"|"choice"|"content"|\{[^{}]*['"](form|choice|content)['"][^{}]*\}|\{intent\})/;

describe('every dialog content site', () => {
  const tags = dialogContentTags();

  it('the scan finds the sites', () => {
    expect(tags.length).toBeGreaterThan(90);
  });

  it('states an intent: form, choice or content', () => {
    const offenders = tags.filter((t) => !INTENT.test(t.tag)).map((t) => `${t.file}:${t.line}`);
    expect(offenders).toEqual([]);
  });

  it('sets no viewport-height cap of its own (a vh value replaces the dynamic-viewport cap)', () => {
    // `vh` and `svh`-less: 85vh, 90vh, 92vh, calc(100vh - ...). `dvh` is the cap the primitive sets.
    const VH = /(?<![ds])vh\b/;
    const offenders = tags.filter((t) => VH.test(t.tag)).map((t) => `${t.file}:${t.line}`);
    expect(offenders).toEqual([]);
  });
});

describe('a list inside a dialog', () => {
  // A capped list that scrolls on its own, written as a literal in a dialog's file, is a scroller
  // inside the body scroller on a phone. It goes through `<DialogList cap=...>` instead. (An
  // absolutely positioned dropdown is a popover, not a list in the flow: slice 44.)
  const CAPPED = /max-h-(?:\[[^\]]+\]|\d+)[^'"`]*overflow-(?:y-)?auto|overflow-(?:y-)?auto[^'"`]*max-h-(?:\[[^\]]+\]|\d+)/;

  // A capped scroller in a dialog's FILE that is not inside the dialog. Each names why.
  const NOT_IN_A_DIALOG: Array<{ file: string; has: string; why: string }> = [
    { file: 'components/communication/phone/Dialer.tsx', has: 'mt-1.5 max-h-56', why: 'the dialer workspace is a page panel; its results list is not in a dialog' },
    { file: 'components/communication/phone/CallsView.tsx', has: 'radix-popover-trigger-width', why: 'a popover opened from the filter bar, not the transcript dialog' },
    { file: 'pages/v2/reports/components/fieldsPicker.tsx', has: 'lg:grid-cols-6', why: 'the report filter popover that shares this file with the fields dialog' },
    { file: 'pages/reports/JobsReport.tsx', has: 'max-h-[420px]', why: 'the same report filter panel, in the old report page that shares its file with the fields dialog' },
    { file: 'pages/reports/LeadsReport.tsx', has: 'max-h-[420px]', why: 'the same report filter panel, in the old report page' },
    { file: 'pages/reports/SalesReport.tsx', has: 'max-h-[420px]', why: 'the same report filter panel, in the old report page' },
    { file: 'components/communication/inbox/ComposeWindow.tsx', has: 'max-h-64', why: 'the template list inside the Insert template popover, not the compose dialog' },
    { file: 'pages/v2/communication/components/mailboxList.tsx', has: 'aria-label="Mailboxes"', why: 'the Email page rail\'s own list of mailboxes, in the page rail (a column, or the menu overlay below lg); the person picker dialog that shares this file goes through DialogList' },
    { file: 'components/communication/inbox/ComposeWindow.tsx', has: 'w-[540px]', why: 'the docked compose card (md and up); below md the window is a full-screen form dialog with one body scroller (slice 46)' },
  ];

  it('is not capped with its own scroller in a dialog that is full-screen on a phone', () => {
    const offenders: string[] = [];
    for (const [file, src] of sourceFiles()) {
      if (!/<DialogContent|<Modal[\s>]/.test(src)) continue;
      if (file.startsWith('components/ui/')) continue;
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return;
        if (!CAPPED.test(line)) return;
        if (/absolute|Popover|useNestedListClass|DialogList|\bcap=/.test(line)) return;
        if (NOT_IN_A_DIALOG.some((x) => x.file === file && line.includes(x.has))) return;
        offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('keeps each exemption honest: the line it names still exists', () => {
    const all = new Map(sourceFiles());
    for (const x of NOT_IN_A_DIALOG) {
      expect(all.get(x.file)?.includes(x.has), `${x.file} no longer has "${x.has}"`).toBe(true);
    }
  });
});
