/**
 * The reader overlay below lg, full-screen at every width there. `intent="content"` already does
 * this below md; between md and lg a content overlay is the centred card, so these classes take
 * the whole screen back from it (tailwind-merge drops the card's own positioning and sizing).
 * Shared by the message reader and the Needs review item, which open the same way.
 */
export const READER_FULLSCREEN =
  'inset-0 h-dvh w-full max-h-none max-w-none translate-x-0 translate-y-0 overflow-hidden rounded-none border-0 shadow-none';
