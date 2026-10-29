/**
 * The one place the app reloads the page to recover from a stale chunk.
 *
 * Its own module so a test can replace it: jsdom's `location.reload` cannot be spied on.
 */
export function reloadPage(): void {
  window.location.reload();
}
