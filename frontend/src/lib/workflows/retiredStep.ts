/**
 * Copy for the retired in-app step, shared by the v1 and v2 step-config
 * drawers so the two twins cannot drift apart.
 *
 * The in-app step's authoring form is deleted. An organisation holding a
 * legacy step still opens it in the drawer, so the drawer shows this
 * read-only notice instead of an audience picker with nothing in it.
 */
export const RETIRED_IN_APP_STEP_HEADLINE =
  'In-app notifications now come from the bell.';

export const RETIRED_IN_APP_STEP_BODY =
  'This step no longer sends anything. Remove it to publish this automation.';
