/**
 * "Is a modal surface open right now?", read from the one place every modal leaves a mark: the
 * page body. A Radix dialog or sheet locks body scroll (`data-scroll-locked`) and makes the page
 * behind it inert (`pointer-events: none`); a hand-built overlay (`useOverlay`) sets
 * `overflow: hidden`. Anything shown over a modal either covers the form the user is typing in
 * or cannot be tapped, so the update prompt waits for this to be false.
 */
export function isModalOpen(doc: Document = document): boolean {
  const body = doc.body;
  if (!body) return false;
  return (
    body.hasAttribute('data-scroll-locked') ||
    body.style.pointerEvents === 'none' ||
    body.style.overflow === 'hidden'
  );
}

/** Calls `listener` whenever the body's lock marks may have changed. Returns the unsubscribe. */
export function subscribeModalOpen(listener: () => void, doc: Document = document): () => void {
  if (!doc.body || typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(doc.body, { attributes: true, attributeFilter: ['style', 'data-scroll-locked', 'class'] });
  return () => observer.disconnect();
}
