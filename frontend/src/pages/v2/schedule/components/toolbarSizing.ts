/**
 * ONE size for every control on the schedule toolbar.
 *
 * Before this the row mixed three heights - `h-7` (Today, the segmented cells), `size-6`
 * (the hour-window nudges) and `size-7` (Plan Mode) - so the controls sat on three
 * different baselines and the row read as ragged however the flexbox was aligned.
 *
 * Import these instead of writing a height at a call site. A control that needs a
 * different height needs a reason, and that reason belongs here rather than inline.
 */

/** Height for any control with a label (buttons, dropdown triggers, segmented cells). */
export const TOOLBAR_CONTROL_H = 'h-7';

/** Square footprint for icon-only controls, so they match TOOLBAR_CONTROL_H exactly. */
export const TOOLBAR_ICON_SIZE = 'size-7';

/** The toolbar's shared type scale. Pulled up with the heights for the same reason. */
export const TOOLBAR_TEXT = 'text-[12px]';

/**
 * The hover affordance every toolbar control shares. The kit's `ghost`/`outline` Buttons
 * bring their own; this is for the controls that do NOT (the dropdown trigger), so a
 * pointer gets the same feedback everywhere on the row.
 */
export const TOOLBAR_HOVER = 'hover:bg-muted transition-colors';
