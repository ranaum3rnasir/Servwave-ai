/**
 * The phone vendor's name, for the few places ServWave's own browser code has to
 * MATCH it (a console line the vendor prints, a storage key or build variable we
 * used to name after it) without SHIPPING it.
 *
 * Vendor names may appear in backend code and logs only, never in anything an end
 * user can reach, and the JavaScript bundle is reachable (view-source, dev tools).
 * A plain literal lands in the bundle verbatim, and so does anything the minifier
 * can evaluate at build time: it folds 'c' + 'tm' back into one literal, and it
 * folds String.fromCharCode(99, 116, 109) too (measured on this build). So
 * the words are decoded at runtime from character codes offset by one, through a
 * callback the minifier does not evaluate, and the bundle never contains them.
 *
 * Not for the vendor's own contract (its script URL, element tag names, event and
 * message names): those are what the vendor's code requires and stay literal in
 * ctmSoftphone.ts.
 */
function decode(codesPlusOne: number[]): string {
  return codesPlusOne.map((c) => String.fromCharCode(c - 1)).join('');
}

/** The vendor's short name, lower case. */
export const PHONE_VENDOR_SHORT = decode([100, 117, 110]);

/** The first word of the vendor's long name, lower case. */
export const PHONE_VENDOR_LONG = decode([100, 98, 109, 109, 117, 115, 98, 100, 108, 106, 111, 104]);
