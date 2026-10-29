/**
 * useMergeInsert — caret-aware "insert {{field}}" wiring for the message forms.
 *
 * Tracks the last-focused text field among the ones it binds, and inserts a
 * merge token at that field's caret (falling back to the primary field, e.g. the
 * body, when nothing has been focused yet). It reads the live DOM node — not a
 * possibly-stale RHF value — so the insertion is correct even mid-typing. Lifted
 * from AutomationEditorPage's `insertMergeField`, generalized to N fields.
 */

import { useCallback, useRef } from 'react';

type FieldEl = HTMLInputElement | HTMLTextAreaElement;

/** Compose a RHF register ref with our own node-capturing ref. */
function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (node: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref && typeof ref === 'object') (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

export function useMergeInsert(
  /** Applies an edited value back into the form (setValue + propagate). */
  apply: (name: string, value: string) => void,
  /** Field that receives an insert when nothing has been focused yet. */
  primaryName: string,
) {
  const nodes = useRef<Record<string, FieldEl | null>>({});
  const lastFocused = useRef<string | null>(null);

  const insert = useCallback(
    (field: string) => {
      const token = `{{${field}}}`;
      const name = lastFocused.current ?? primaryName;
      const el = nodes.current[name];
      // The bound fields mount before anything is clickable, so `el` is present in
      // practice; bail rather than clobber the field's value in the impossible case.
      if (!el) return;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, start) + token + el.value.slice(end);
      apply(name, next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + token.length;
        el.setSelectionRange(pos, pos);
      });
    },
    [apply, primaryName],
  );

  /** Spread onto each text field: captures its node + marks it focused. */
  const bind = useCallback(
    (name: string, rhfRef?: React.Ref<FieldEl>) => ({
      ref: mergeRefs<FieldEl>(rhfRef, (node: FieldEl | null) => {
        nodes.current[name] = node;
      }),
      onFocus: () => {
        lastFocused.current = name;
      },
    }),
    [],
  );

  return { insert, bind };
}
