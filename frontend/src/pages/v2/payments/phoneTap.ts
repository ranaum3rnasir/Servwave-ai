/**
 * Phone tap targets for the Payments page (payments go-live, final polish): at phone width every control on the page,
 * in its drawers and in its dialogs is at least 44px tall. One string, put once on the page's root and once on each
 * overlay that renders outside it (a drawer, a dialog, a sheet), so no control repeats its own class and the kit's
 * defaults stay as they are for the rest of the app.
 *
 * Min-height beats the kit's fixed heights, so a 34px select grows to 44px without a size change on desktop. Checkboxes,
 * radios and switches are left alone (they are drawn small inside a larger labelled row), and a link that sits inside a
 * stacked card becomes a block 44px tall instead of a 15px line of text.
 */
export const PHONE_TAP_AREA = [
  'max-sm:[&_button:not([role=checkbox]):not([role=radio]):not([role=switch])]:min-h-11',
  'max-sm:[&_[role=combobox]]:min-h-11',
  'max-sm:[&_[role=option]]:min-h-11',
  'max-sm:[&_input:not([type=checkbox]):not([type=radio]):not([type=file])]:min-h-11',
  'max-sm:[&_a]:inline-flex max-sm:[&_a]:min-h-11 max-sm:[&_a]:items-center',
].join(' ');
