/**
 * A full-page navigation that replaces the current history entry.
 *
 * Its own module so a test can replace it: jsdom's `location.replace` cannot be spied on.
 */
export function replaceLocation(url: string): void {
  window.location.replace(url);
}
