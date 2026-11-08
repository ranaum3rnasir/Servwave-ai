import { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';
import { initAuthListener } from '@/lib/auth-listener';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as KitToaster } from '@/ui-kit/components/ui/sonner';
import { TooltipProvider as KitTooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { v2Routes } from '@/pages/v2/V2Routes';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useAuthStore } from '@/stores/auth.store';

initAuthListener();

/**
 * There are no page imports here any more.
 *
 * The route table is built entirely by `v2Routes()` from `pages/v2/routes/`,
 * where each module declares its own routes and its own lazy imports. The
 * original page components still exist under `src/pages/` - some 60 test files
 * import them, and four settings tabs are still mounted from there by
 * `pages/v2/routes/settings.routes.tsx` - but nothing is routed from this file.
 */

// The QueryClient itself moved to lib/queryClient.ts so the auth store can clear it on
// sign-out - see clearQueryCache() there.

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="text-text-secondary">Loading...</div>
    </div>
  );
}

// Wraps React Router's <Routes> so Sentry names navigation transactions by the
// matched route pattern (e.g. "/jobs/:id") instead of the raw URL.
const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes);

function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <SentryRoutes>
        {/* THE route table. Every path in the app is declared once, by the module
            that owns it, under `pages/v2/routes/`. There is no second layer and no
            feature flag: this design owns the bare paths.

            Nothing legacy is routed here any more. Every entry this file used to
            declare had a counterpart in that tree, so keeping one would have meant
            two <Route>s claiming one path and letting React Router's ranking pick
            the winner - see `pages/v2/__tests__/routeUniqueness.test.ts`, which
            fails the build if that ever happens again. */}
        {v2Routes()}
        <Route path="*" element={<Navigate to="/" replace />} />
      </SentryRoutes>
    </Suspense>
  );
}

function AppWithAbility() {
  const ability = useAuthStore((s) => s.ability);
  return (
    <AbilityProvider ability={ability}>
      {/* One TooltipProvider for the whole app so every kit <Tooltip> shares a
          single delay timer - sweeping across a toolbar does not re-pay the
          open delay on each icon. */}
      <KitTooltipProvider delayDuration={320}>
        <BrowserRouter>
          <ErrorBoundary>
            <AppRoutes />
          </ErrorBoundary>
          <Toaster />
          {/* The kit's sonner toaster, mounted alongside the app's own. Two
              separate systems: the routed pages call sonner's, while dialogs and
              components still shared with the unrouted originals call the app's.
              Neither intercepts the other.

              The hotkey is a SENTINEL, not an empty array. sonner registers its
              document keydown listener unconditionally - no prop removes it -
              and tests `hotkey.every(k => event[k] || event.code === k)`.
              `[].every(...)` is vacuously TRUE, so an empty array makes every
              keystroke an expand-and-focus press, which is worse than the
              default it was meant to disable. A string that is neither a
              KeyboardEvent property nor a valid event.code can never match,
              which is as close to off as the API allows. The default, Alt+T,
              would otherwise pull focus into the toast list from any
              page. */}
          <KitToaster hotkey={['__sonner_hotkey_disabled__']} />
        </BrowserRouter>
      </KitTooltipProvider>
    </AbilityProvider>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppWithAbility />
    </QueryClientProvider>
  );
}
