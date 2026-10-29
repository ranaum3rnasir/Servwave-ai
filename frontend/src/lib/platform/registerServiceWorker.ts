/**
 * Registers the offline-cache service worker for the STAFF app, and watches it for updates.
 *
 * This replaces the `registerSW.js` script the PWA plugin used to inject into every page's HTML
 * (it is now configured with `injectRegister: false`). That script ran on public estimate and
 * invoice pages too, installing the staff app's precache on a customer's phone. Only the staff
 * entry (`main.tsx`) calls this; `public-main.tsx` never does, and the build check
 * `scripts/check-public-bundle-budget.mjs` fails if the public page ever registers one.
 *
 * Same registration as the injected script: `/sw.js` at scope `/` once the page has loaded, so
 * registration never competes with first paint.
 *
 * Updates (mobile slice 67): a new deploy installs a new worker that WAITS. This module reports
 * it to `updateController` (see `serviceWorkerUpdate.ts`), which decides when it is applied and
 * the page reloads, never while work is unsaved. A long-lived phone tab may not navigate for
 * days, so it also asks the browser to check for a new worker when the page comes back to the
 * foreground and once an hour.
 */
import { hasUnsavedWork, subscribeUnsavedWork } from '@/ui-kit/lib/unsavedWork';

import { reloadPage } from './reloadPage';
import { createUpdateController } from './serviceWorkerUpdate';

/** How often an open page asks the browser for a newer worker. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000;

let waitingWorker: ServiceWorker | null = null;

/** The one update controller of this page. The "Update available" prompt reads it. */
export const updateController = createUpdateController({
  hasUnsavedWork,
  subscribeUnsavedWork,
  isPageHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  activateWaitingWorker: () => waitingWorker?.postMessage({ type: 'SKIP_WAITING' }),
  reload: reloadPage,
});

/** Reports a worker that is installed and waiting, once it is replacing a running one. */
function reportWaiting(worker: ServiceWorker | null | undefined, hadController: boolean) {
  // With no controller this is the very first install: nothing to replace, nothing to prompt.
  if (!worker || !hadController) return;
  waitingWorker = worker;
  updateController.markUpdateWaiting();
}

function watchRegistration(registration: ServiceWorkerRegistration, win: Window, hadController: boolean) {
  reportWaiting(registration.waiting, hadController);

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed') reportWaiting(installing, hadController);
    });
  });

  const check = () => {
    registration.update().catch(() => {
      // Offline or mid-deploy: the next check tries again.
    });
  };
  win.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  win.document.addEventListener('visibilitychange', () => {
    if (win.document.visibilityState === 'visible') check();
    updateController.pageVisibilityChanged();
  });
}

export function registerServiceWorker(win: Window = window): void {
  if (!('serviceWorker' in navigator)) return;

  // A page with no worker yet is being claimed by the FIRST install, which fires a controller
  // change too. That is not an update and must not reload the page.
  const hadController = navigator.serviceWorker.controller != null;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) updateController.controllerChanged();
  });

  const register = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => watchRegistration(registration, win, hadController))
      .catch(() => {
        // A browser that blocks workers (private mode, strict settings) still runs the app.
      });
  };

  if (win.document.readyState === 'complete') register();
  else win.addEventListener('load', register);
}
