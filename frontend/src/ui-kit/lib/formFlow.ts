/* =============================================================================
   Form flow (mobile slice 38, rubric KB-05 and A11Y-07).

   One form-level helper, adopted by the lead, customer, job and invoice create
   forms. It works on the <form> element, not on each field, so the forms keep
   their own field markup (react-hook-form `register`, controlled blocks,
   third-party typeaheads) and only say two things:

     const flow = useFormFlow();
     <form {...flow.formProps} onSubmit={form.handleSubmit(save, flow.focusFirstInvalid)}>
       ...
       {error && <p data-error-for="first_name">{error}</p>}

   What it does:

   1. Action keys. The text fields of the form, in page order, get the Next key
      and the last one gets Done (or `lastKey`: Send, Go). A textarea gets no key
      (its Return inserts a line) but still counts in the order. A field that
      names its own key (`enterKeyHint`, or a field kind such as search) keeps it.
      The order is kept up to date as sections open and close.
   2. Next moves on. On a touch pointer (the same rule as autofocus,
      src/ui-kit/lib/autoFocus.ts), Return on a Next field focuses the next
      field instead of submitting a half-filled form. A field that handled Return
      itself (a suggestion list picking a row) wins. A mouse-and-keyboard desktop
      keeps Return-to-submit exactly as before.
   3. Errors are linked. An element marked `data-error-for="<id or name> ..."` is
      added to each named field's aria-describedby, and the field is marked
      aria-invalid, so the message is announced when focus lands. Both are taken
      back when the message goes.
   4. A failed submit lands on the first error. `focusFirstInvalid()` waits for
      the errors to render (react-hook-form calls it before React commits them),
      then focuses the first invalid field in page order. A field already fully in
      view stays put (the page does not move); one that is off screen, clipped or
      under a sticky bar is scrolled to the middle of its scroller first.

   The attributes it writes are marked (`data-form-flow-*`), so it only ever
   undoes its own changes.
   ============================================================================= */
import * as React from 'react';

import { canAutoFocus } from './autoFocus';

export type FormFlowLastKey = 'done' | 'send' | 'go';

export interface FormFlowOptions {
  /** The action key of the last field. Done unless the form sends something. */
  lastKey?: FormFlowLastKey;
}

/** Input types that open a keyboard and so take an action key. */
const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'search', 'password', 'number']);

const KEY_MARK = 'data-form-flow-key';
const DESCRIBED_MARK = 'data-form-flow-describedby';
const INVALID_MARK = 'data-form-flow-invalid';

function isShown(el: HTMLElement): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  // Real browsers: display:none / visibility:hidden. jsdom has no layout, so it is skipped there.
  const check = (el as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === 'function' ? check.call(el) : true;
}

function isFlowField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) {
    return !el.disabled && !el.readOnly && el.tabIndex >= 0 && isShown(el);
  }
  if (!(el instanceof HTMLInputElement)) return false;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  return TEXT_TYPES.has(type) && !el.disabled && !el.readOnly && el.tabIndex >= 0 && isShown(el);
}

/** The fields that take part in the Next/Done order, in page order. */
export function flowFields(form: HTMLFormElement): (HTMLInputElement | HTMLTextAreaElement)[] {
  return Array.from(form.querySelectorAll('input, textarea')).filter(isFlowField);
}

/** Sets Next on every field but the last text input, `lastKey` on that one. */
export function applyActionKeys(form: HTMLFormElement, lastKey: FormFlowLastKey = 'done'): void {
  const fields = flowFields(form);
  const inputs = fields.filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);
  const lastIndex = fields.length - 1;
  // Fields that left the order (disabled, hidden) give back the key we set.
  form.querySelectorAll(`[${KEY_MARK}]`).forEach((el) => {
    if (!inputs.includes(el as HTMLInputElement)) {
      if (el.getAttribute('enterkeyhint') === el.getAttribute(KEY_MARK)) el.removeAttribute('enterkeyhint');
      el.removeAttribute(KEY_MARK);
    }
  });
  for (const el of inputs) {
    const current = el.getAttribute('enterkeyhint');
    const ours = el.getAttribute(KEY_MARK);
    // The field named its own key: leave it.
    if (current !== null && current !== ours) {
      if (ours !== null) el.removeAttribute(KEY_MARK);
      continue;
    }
    const key = fields.indexOf(el) === lastIndex ? lastKey : 'next';
    if (current !== key) el.setAttribute('enterkeyhint', key);
    if (ours !== key) el.setAttribute(KEY_MARK, key);
  }
}

function tokens(value: string | null): string[] {
  return (value ?? '').split(/\s+/).filter(Boolean);
}

function resolveField(form: HTMLFormElement, ref: string): HTMLElement | null {
  const byId = form.ownerDocument.getElementById(ref);
  if (byId && form.contains(byId)) return byId;
  const byName = form.querySelector(`[name="${CSS.escape(ref)}"]`);
  return byName instanceof HTMLElement ? byName : null;
}

let errorIdSeq = 0;

/** Links every `data-error-for` message to its field(s), and unlinks messages that went away. */
export function linkFieldErrors(form: HTMLFormElement): void {
  const wanted = new Map<HTMLElement, Set<string>>();
  form.querySelectorAll<HTMLElement>('[data-error-for]').forEach((msg) => {
    if (!msg.id) msg.id = `form-flow-error-${++errorIdSeq}`;
    for (const ref of tokens(msg.getAttribute('data-error-for'))) {
      const field = resolveField(form, ref);
      if (!field) continue;
      if (!wanted.has(field)) wanted.set(field, new Set());
      wanted.get(field)!.add(msg.id);
    }
  });

  // Undo what we added and is no longer wanted.
  form.querySelectorAll<HTMLElement>(`[${DESCRIBED_MARK}]`).forEach((field) => {
    const keep = wanted.get(field) ?? new Set<string>();
    const added = tokens(field.getAttribute(DESCRIBED_MARK));
    const stale = added.filter((id) => !keep.has(id));
    if (stale.length) {
      const rest = tokens(field.getAttribute('aria-describedby')).filter((id) => !stale.includes(id));
      if (rest.length) field.setAttribute('aria-describedby', rest.join(' '));
      else field.removeAttribute('aria-describedby');
      const left = added.filter((id) => keep.has(id));
      if (left.length) field.setAttribute(DESCRIBED_MARK, left.join(' '));
      else field.removeAttribute(DESCRIBED_MARK);
    }
  });
  form.querySelectorAll<HTMLElement>(`[${INVALID_MARK}]`).forEach((field) => {
    if (wanted.has(field)) return;
    const before = field.getAttribute(INVALID_MARK);
    if (field.getAttribute('aria-invalid') === 'true') {
      if (before === '') field.removeAttribute('aria-invalid');
      else field.setAttribute('aria-invalid', before ?? 'false');
    }
    field.removeAttribute(INVALID_MARK);
  });

  // Add what is wanted and missing. Idempotent: a second pass changes nothing.
  wanted.forEach((ids, field) => {
    const described = tokens(field.getAttribute('aria-describedby'));
    const added = tokens(field.getAttribute(DESCRIBED_MARK));
    const missing = [...ids].filter((id) => !described.includes(id));
    if (missing.length) {
      field.setAttribute('aria-describedby', [...described, ...missing].join(' '));
      field.setAttribute(DESCRIBED_MARK, [...added, ...missing.filter((id) => !added.includes(id))].join(' '));
    }
    if (field.getAttribute('aria-invalid') !== 'true') {
      if (!field.hasAttribute(INVALID_MARK)) field.setAttribute(INVALID_MARK, field.getAttribute('aria-invalid') ?? '');
      field.setAttribute('aria-invalid', 'true');
    }
  });
}

const FOCUSABLE = 'input, textarea, select, button, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusTarget(el: HTMLElement): HTMLElement | null {
  const candidate = el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE);
  if (!candidate || (candidate as HTMLInputElement).disabled || !isShown(candidate)) return null;
  if (candidate instanceof HTMLInputElement && candidate.type === 'hidden') return null;
  return candidate;
}

/** The first invalid field of the form in page order, or null when there is none. */
export function firstInvalidField(form: HTMLFormElement): HTMLElement | null {
  linkFieldErrors(form);
  for (const el of Array.from(form.querySelectorAll<HTMLElement>('[aria-invalid="true"]'))) {
    const target = focusTarget(el);
    if (target) return target;
  }
  return null;
}

/**
 * True when the whole field is on screen (inside the window and inside every
 * scroller that holds it) and nothing, such as a sticky bar, sits on top of it.
 */
function isComfortablyVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  let top = 0;
  let bottom = window.innerHeight;
  let left = 0;
  let right = window.innerWidth;
  for (let node = el.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    const clips = (value: string) => value !== '' && value !== 'visible';
    if (!clips(style.overflowY) && !clips(style.overflowX)) continue;
    const box = node.getBoundingClientRect();
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
    left = Math.max(left, box.left);
    right = Math.min(right, box.right);
  }
  if (rect.top < top || rect.bottom > bottom || rect.left < left || rect.right > right) return false;
  if (typeof document.elementFromPoint !== 'function') return true;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return !hit || hit === el || el.contains(hit) || (hit instanceof HTMLLabelElement && hit.control === el);
}

/**
 * Brings a field into view and focuses it. A field that is already fully on
 * screen and uncovered is left where it is: `scrollIntoView` scrolls every
 * ancestor, the document included, so centring it would nudge the whole page
 * (and clip the top bar) wherever the page has a few pixels of slack, as it does
 * in landscape. Only a field that is off screen, clipped by its scroller or
 * under a sticky bar is centred (clear of sticky bars).
 */
export function revealAndFocus(el: HTMLElement): void {
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: isComfortablyVisible(el) ? 'nearest' : 'center', inline: 'nearest' });
  }
  el.focus({ preventScroll: true });
}

/** How many frames focusFirstInvalid waits for the errors to render. */
const MAX_FRAMES = 10;

export interface FormFlow {
  /** Spread on the <form>. Carries its own `ref` and `onKeyDown`. */
  formProps: {
    ref: React.RefCallback<HTMLFormElement>;
    onKeyDown: React.KeyboardEventHandler<HTMLFormElement>;
  };
  /**
   * Call on a failed submit (react-hook-form's `onInvalid`, or a hand-rolled
   * check). Focuses the first invalid field once the errors have rendered.
   */
  focusFirstInvalid: () => void;
}

export function useFormFlow(options: FormFlowOptions = {}): FormFlow {
  const lastKey = options.lastKey ?? 'done';
  const formRef = React.useRef<HTMLFormElement | null>(null);
  const observerRef = React.useRef<MutationObserver | null>(null);

  const ref = React.useCallback<React.RefCallback<HTMLFormElement>>((form) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    formRef.current = form;
    if (!form) return;
    const sync = () => {
      applyActionKeys(form, lastKey);
      linkFieldErrors(form);
    };
    sync();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(sync);
    // Only what changes the order or the errors. Our own writes (enterkeyhint,
    // aria-describedby) are not watched; aria-invalid is, and a second pass is a no-op.
    observer.observe(form, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-error-for', 'aria-invalid', 'disabled', 'readonly', 'hidden', 'type', 'enterkeyhint', 'id', 'name'],
    });
    observerRef.current = observer;
    // A new lastKey re-attaches (React calls the old ref with null first).
  }, [lastKey]);

  React.useEffect(() => () => observerRef.current?.disconnect(), []);

  const onKeyDown = React.useCallback<React.KeyboardEventHandler<HTMLFormElement>>((event) => {
    if (event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.getAttribute('enterkeyhint') !== 'next') return;
    // A desktop keyboard keeps Return-to-submit.
    if (canAutoFocus()) return;
    const form = event.currentTarget;
    const fields = flowFields(form);
    const next = fields[fields.indexOf(target) + 1];
    if (!next) return;
    event.preventDefault();
    revealAndFocus(next);
  }, []);

  const focusFirstInvalid = React.useCallback(() => {
    let frames = 0;
    const attempt = () => {
      const form = formRef.current;
      if (!form) return;
      const field = firstInvalidField(form);
      if (field) {
        revealAndFocus(field);
        return;
      }
      if (++frames < MAX_FRAMES) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  }, []);

  return React.useMemo(() => ({ formProps: { ref, onKeyDown }, focusFirstInvalid }), [ref, onKeyDown, focusFirstInvalid]);
}
