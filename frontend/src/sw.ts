/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

// Injected by vite-plugin-pwa at build time
precacheAndRoute(self.__WB_MANIFEST);

// A new deploy installs a new worker next to the running one and LEAVES IT WAITING. It does
// not call skipWaiting() on install (it used to, and so swapped the cache under open pages):
// the page shows "Update available" and posts SKIP_WAITING when it is safe, meaning the user
// tapped Update or the page is in the background, and never while a form holds unsaved work
// (src/lib/platform/serviceWorkerUpdate.ts). A page with no worker yet is unaffected: the very
// first install has nothing to wait behind, so it activates and claims the page straight away.
// If every tab closes first, the waiting worker activates on its own at the next visit.
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
// Posted by the page's update controller once taking over is safe.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
