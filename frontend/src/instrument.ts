import { useEffect } from 'react';
import {
  createRoutesFromChildren,
  matchRoutes,
  useLocation,
  useNavigationType,
} from 'react-router-dom';
import * as Sentry from '@sentry/react';

// Imported FIRST in src/main.tsx so the SDK initializes before the app renders.
// The SDK disables itself when VITE_SENTRY_DSN is unset, so dev/test/CI builds
// without the variable send nothing.
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  // MODE is "production" for every `vite build`, so staging and prod would be
  // indistinguishable; each Vercel project sets VITE_SENTRY_ENVIRONMENT.
  environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,

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
    // Session Replay with strict masking — this is a customer CRM, so every text
    // node is masked and all media is blocked by default.
    Sentry.replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
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

  // Session Replay sampling: record 10% of all sessions, but 100% of any session
  // that hits an error.
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});
