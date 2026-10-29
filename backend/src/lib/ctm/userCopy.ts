/**
 * Phone-service copy that reaches a person (a response body an admin's screen
 * shows, often as a toast). Plain words only: no vendor name, no provider
 * outcome code - the raw detail goes to the server log at the call site.
 * Shared so connect and buy can never drift apart.
 */

/** A number whose texting the phone service did not switch on. */
export function textingNotSwitchedOn(e164: string): string {
  return `Texting could not be switched on for ${e164}.`;
}
