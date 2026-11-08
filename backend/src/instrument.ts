// Sentry initialization. This module is imported FIRST in src/index.ts (before
// ./app) so the SDK can instrument Express, HTTP, and Prisma before those
// modules load.
//
// dotenv is loaded here because this file runs before src/config/env.ts — the
// app's usual dotenv entry point — so without it process.env.SENTRY_DSN would be
// undefined during local/dev boot. dotenv.config() never overrides variables
// already present in the environment, so on Render (env provided by the
// dashboard, no .env file) this is a harmless no-op.
//
// When SENTRY_DSN is unset the SDK disables itself, so local and test runs send
// nothing unless explicitly configured.
import 'dotenv/config';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE,

  // Performance tracing: 100% locally for visibility, 10% in production to fit quota.
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,

  // Full capture (team decision): user/IP/headers plus local-variable values in
  // stack frames, for the richest debugging signal. Sentry's server-side data
  // scrubbing + the project's Data Scrubbing setting strip common secret keys
  // (passwords, tokens, auth headers). Revisit before onboarding external customers.
  sendDefaultPii: true,
  includeLocalVariables: true,
});
