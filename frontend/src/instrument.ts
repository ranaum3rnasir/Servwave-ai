import { useEffect } from 'react';
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from 'react-router-dom';
import * as Sentry from '@sentry/react';

import { loadReplayWhenIdle, sentryBaseOptions } from '@/lib/observability/sentryBase';
import { scrubEventUrls } from '@/lib/observability/scrubUrl';

// Imported FIRST in src/main.tsx (the STAFF entry) so the SDK initializes before the app renders.
// The public pages' entry has its own, lighter `instrument-public.ts`.
// The SDK disables itself when VITE_SENTRY_DSN is unset, so dev/test/CI builds
// without the variable send nothing.
Sentry.init({
  ...sentryBaseOptions(),

  integrations: [
    // Page-load + navigation tracing wired to React Router v7 (declarative
    // <Routes> mode), so transactions are named by route pattern (e.g.
    // "/jobs/:id") rather than the raw URL. Pair with withSentryReactRouterV7Routing
    // in App.tsx.
    Sentry.reactRouterV7BrowserTracingIntegration({
      useEffect,
      useLocation,
      useNavigationType,
      createRoutesFromChildren,
      matchRoutes,
    }),
    // Session Replay is NOT listed here: it is added once the page is idle (mobile slice 47),
    // see `loadReplayWhenIdle`.
  ],

  // Performance tracing: 100% in dev, 10% in production for quota.
  tracesSampleRate: import.meta.env.DEV ? 1.0 : 0.1,
  // Propagate trace headers to the API so browser → Express → DB stitches into a
  // single distributed trace. VITE_API_URL is the backend origin (dev + prod);
  // "/api" covers the same-origin dev proxy.
  tracePropagationTargets: [
    'localhost',
    /^\/api/,
    ...(import.meta.env.VITE_API_URL ? [import.meta.env.VITE_API_URL as string] : []),
  ],
});

// Replay events (their `urls`) reach the SDK only through the event processors, not through beforeSend.
Sentry.addEventProcessor(scrubEventUrls);

loadReplayWhenIdle();
