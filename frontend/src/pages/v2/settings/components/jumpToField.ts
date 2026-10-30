/** Scrolls a field into view and puts the cursor in it. */
export function jumpToField(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  el.focus({ preventScroll: true });
}

