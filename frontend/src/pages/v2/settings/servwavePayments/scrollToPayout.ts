export const PAYOUT_CARD_ID = 'sec-payout';

/**
 * Takes the person to the Payout account card: scrolls the settings canvas (not the window) so the card sits at
 * the top, then moves focus to its heading. "Set up payments", "Resume setup", "Fix now" and "Connect bank" use it;
 * none of them navigates, so the address does not change.
 */
export function scrollToPayout() {
  const card = document.getElementById(PAYOUT_CARD_ID);
  if (!card) return;
  const canvas = card.closest<HTMLElement>('.canvas-body');
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduce ? 'auto' : 'smooth';
  if (canvas && typeof canvas.scrollTo === 'function') {
    const top = card.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop - 16;
    canvas.scrollTo({ top: Math.max(0, top), behavior });
  } else {
    card.scrollIntoView?.({ block: 'start', behavior });
  }
  const heading = card.querySelector<HTMLElement>('[role="heading"]');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
}
