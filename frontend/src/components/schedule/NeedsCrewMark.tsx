/**
 * The needs-crew signal: a small flag clipped into the card's top-right corner.
 *
 * Chosen on 2026-09-14 over the solid red fill it replaces (design canvas, option 01). Two
 * properties carried the decision, and both are load-bearing here:
 *
 *  - It takes NO layout box. Absolutely positioned, so it cannot take a pixel from the job
 *    number at any card width - the badge-in-a-row approach has a measured failure on record
 *    (SchedulePage.tsx, the all-day pill comment: 62.5px of a 90px pill turned J00315 into J0).
 *  - It touches neither the card's fill nor its border. Those two channels now belong to the
 *    org's own colour choice (EVENT_TYPE_META, the ev-* tokens), and a solid red fill ERASED
 *    that choice - a red job and a red walkthrough were the same card.
 *
 * It is a real element with an accessible name, not a pseudo-element, for the same reason
 * DoubleBookedMark is: a screen reader hears it and a test can find it. The name is a label,
 * never text content: the all-day pill guard (#1734) asserts no "needs crew" TEXT on the pill, and
 * an SVG <title> child IS text content to that query, so unlike DoubleBookedMark there is no
 * tooltip here - the hover peek card already says the words.
 *
 * The 1px diagonal in the surface colour is what keeps the notch legible when the org has
 * chosen a red close to --understaffed for the card underneath.
 *
 * Mounted by all three card renderers (ScheduleCardBody for the member boards, ScheduleEvent
 * for the Standard view and its all-day pill). The wrapper it sits in must be `relative`.
 */
import { cn } from '@/lib/utils';

const SIZE = {
  md: 'h-3 w-3',
  sm: 'h-2.5 w-2.5', // the all-day strip pill is 22px tall; 12px there is a third of the card
} as const;

export function NeedsCrewMark({ size = 'md', className }: { size?: keyof typeof SIZE; className?: string }) {
  return (
    <svg
      role="img"
      aria-label="Needs crew"
      // A stable hook for CSS that must find the notch by identity, not by child position (the
      // Month view one-line rule in schedule-dark.css). Not the aria-label: that is copy.
      data-needs-crew-mark=""
      viewBox="0 0 12 12"
      className={cn('absolute top-0 right-0 text-understaffed pointer-events-none', SIZE[size], className)}
    >
      <path d="M0 0H12V12Z" fill="currentColor" />
      <path d="M0 0L12 12" className="text-surface-light" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
