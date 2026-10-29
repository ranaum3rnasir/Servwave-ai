/* =============================================================================
   Text entry on phones and touch tablets (mobile slice 14, rubric KB-01).

   iOS zooms the page when a focused field's text is under 16 px, and the zoom
   does not undo itself. Every text entry primitive therefore adds the class
   `mobile:!text-base`: the `mobile:` variant (tailwind.config.js) is everything
   that is NOT "md and up with a fine pointer" - phones, a landscape phone, an
   iPad, a narrow window. Nothing is added or removed for a desktop, so desktop
   sizes stay exactly what each call site already renders. It is important
   because Tailwind emits `md:` after any plugin variant, and the legacy
   primitives' own `md:text-sm` would otherwise win on an iPad.

   A caller that names a size of 16 px or more at every width (a title field's
   `text-2xl`) keeps it on touch too: the floor is left out for it, or it would
   shrink the title to 16 px. Each primitive writes the class out literally
   (`!setsLargeTextSize(className) && "mobile:!text-base"`), so the source guard
   can see it.

   The source guard src/__tests__/input-guards/input-size.guard.test.ts keeps
   every text entry element on this shape.
   ============================================================================= */

const LARGE_STEPS = new Set(['base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl']);

/** Pixel size of an arbitrary `text-[...]` value, or null when it is not a length. */
function arbitraryPx(value: string): number | null {
  const m = /^\[(\d*\.?\d+)(px|rem|em)\]$/.exec(value);
  if (!m) return null;
  const n = parseFloat(m[1] ?? '');
  return m[2] === 'px' ? n : n * 16;
}

/**
 * True when a class string sets a font size of 16 px or more at every width
 * (an unprefixed `text-base`, `text-2xl`, `text-[18px]`), so the touch floor
 * is not needed and would only shrink it.
 */
export function setsLargeTextSize(className?: string | null): boolean {
  if (!className) return false;
  return className.split(/\s+/).some((token) => {
    // Split rather than a 'text' + dash literal: the unresolved-class guard reads such literals as classes.
    const dash = token.indexOf('-');
    if (token.includes(':') || dash < 0 || token.slice(0, dash) !== 'text') return false;
    const value = token.slice(dash + 1);
    if (LARGE_STEPS.has(value)) return true;
    const px = arbitraryPx(value);
    return px !== null && px >= 16;
  });
}
