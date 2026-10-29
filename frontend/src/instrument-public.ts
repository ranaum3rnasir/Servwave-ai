import * as Sentry from '@sentry/react';

import { loadReplayWhenIdle, sentryBaseOptions } from '@/lib/observability/sentryBase';
import { scrubEventUrls } from '@/lib/observability/scrubUrl';

// Imported FIRST in src/public-main.tsx (the page a customer's estimate or invoice link opens).
//
// Errors only. The staff entry also installs page-load and navigation TRACING; that integration,
// with the web-vitals and span machinery behind it, is a large part of the SDK's weight and this
// page has a 200 KB budget (mobile slice 47). So customer pages report errors (and, once idle,
// replays of sessions that hit one) but not performance traces. Re-adding the tracing integration
// here will fail the build's public-bundle check; raise it with the budget, not around it.
Sentry.init({
  ...sentryBaseOptions(),
});

// Replay events (their `urls`) reach the SDK only through the event processors, not through beforeSend.
Sentry.addEventProcessor(scrubEventUrls);

loadReplayWhenIdle();
