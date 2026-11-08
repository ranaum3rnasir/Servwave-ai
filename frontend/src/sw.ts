/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

// Injected by vite-plugin-pwa at build time
precacheAndRoute(self.__WB_MANIFEST);

// Take over immediately on every new deploy. Without skipWaiting() the freshly
// built service worker sits in "waiting" until ALL tabs of the app are closed,
// so users keep getting the previously-cached bundle after a deploy (looks like
// "my changes didn't ship"). injectManifest does NOT add this for us, so we must.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
// vite-plugin-pwa's autoUpdate registration posts this when a new SW is detected.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
