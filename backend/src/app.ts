import express from 'express';
import * as Sentry from '@sentry/node';
import cors from 'cors';
import helmet from 'helmet';
import { requestLogger } from './middleware/requestLogger';
import { env } from './config/env';
import { parseCorsOrigins } from './lib/cors-origins';
import { generalLimiter } from './middleware/rate-limit';
import { auditAccessDenied } from './middleware/auditAccessDenied';
import { originVerify } from './middleware/originVerify';
import { unscopedRequest } from './middleware/unscopedRequest';
import { globalMulterErrorHandler } from './middleware/multerErrors';
import authRoutes from './routes/auth.routes';
import versionRoutes from './routes/version.routes';
import userRoutes from './routes/user.routes';
import customerRoutes from './routes/customer.routes';
import leadRoutes from './routes/lead.routes';
import tagRoutes from './routes/tag.routes';
import departmentRoutes from './routes/department.routes';
import stateTaxRateRoutes from './routes/state-tax-rate.routes';
import orgTaxRateRoutes from './routes/org-tax-rate.routes';
import customFieldDefinitionsRoutes from './routes/custom-field-definitions.routes';
import settingsRoutes from './routes/settings.routes';
import estimateRoutes from './routes/estimate.routes';
import priceBookRoutes from './routes/price-book.routes';
import scopePresetRoutes from './routes/scope-preset.routes';
import jobRoutes from './routes/job.routes';
import jobSubStatusRoutes from './routes/jobSubStatus.routes';
import lostReasonOptionRoutes from './routes/lostReasonOption.routes';
import searchRoutes from './routes/search.routes';
import attachmentRoutes from './routes/attachment.routes';
import invoiceRoutes from './routes/invoice.routes';
import statementRoutes from './routes/statement.routes';
import dashboardRoutes from './routes/dashboard.routes';
import reportRoutes from './routes/report.routes';
import organizationRoutes from './routes/organization.routes';
import locationRoutes from './routes/location.routes';
import servicePlanRoutes from './routes/service-plan.routes';
import taskRoutes from './routes/task.routes';
import taskCategoryRoutes from './routes/task-category.routes';
import calendarEntryRoutes from './routes/calendar-entry.routes';
import roleRoutes from './routes/role.routes';
import tableViewRoutes from './routes/table-view.routes';
import webhookRoutes from './routes/webhook.routes';
import copilotRoutes from './routes/copilot.routes';
import timeclockRoutes from './routes/timeclock.routes';
import notificationRoutes from './routes/notification.routes';
import workflowRoutes from './routes/workflow.routes';
import aiFarmRoutes from './routes/aiFarm.routes';
import beeRoutes from './routes/bee.routes';
// ─── Inventory module (mounted at /api/inventory) ───
import invCatalogRoutes from './routes/inv-catalog.routes';
import invVendorsRoutes from './routes/inv-vendors.routes';
import invLocationsRoutes from './routes/inv-locations.routes';
import invStockRoutes from './routes/inv-stock.routes';
import invPoRoutes from './routes/inv-po.routes';
import invStagesRoutes from './routes/inv-stages.routes';
import invTechsJobsRoutes from './routes/inv-techs-jobs.routes';
import invAssetsRoutes from './routes/inv-assets.routes';
// ─── Logistic Orders (mounted at /api/logistic-orders) ───
import logisticOrderRoutes from './routes/logistic-order.routes';
import supportRoutes from './routes/support.routes';
// ─── Communication module (mounted at /api/communication) ───
import commCallsRoutes from './routes/comm-calls.routes';
import commThreadsRoutes from './routes/comm-threads.routes';
import commAgentsRoutes from './routes/comm-agents.routes';
import commConfigRoutes from './routes/comm-config.routes';
import commEmailRoutes from './routes/comm-email.routes';
import commSharedRoutes from './routes/comm-shared.routes';
import commManualLogRoutes from './routes/comm-manual-log.routes';
import commWhatsappRoutes from './routes/comm-whatsapp.routes';
import commUsageRoutes from './routes/comm-usage.routes';
import commNumbersRoutes from './routes/comm-numbers.routes';
import commPhoneAccessRoutes from './routes/comm-phone-access.routes';
import commNumberAssignmentsRoutes from './routes/comm-number-assignments.routes';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { assertNoTestRoutesInProduction } from './lib/test-routes-guard';
// ─── E2E test doors (only registered when NODE_ENV!=='production'; each gated by env flag) ───
import { processStripeEvent } from './controllers/webhook.controller';
import { processCtmEvent } from './controllers/ctm-webhook.controller';
import { unwrapActivity } from './lib/ctm/ingest';
import { provisionTestOrg, teardownTestOrg, assertMigratedSchema, assertGlobalFixtures, E2E_ORG_NAME_PREFIX } from './lib/e2e-org';

const app = express();

// Trust the Render reverse proxy so X-Forwarded-For is honored. Without this,
// express-rate-limit's keyGenerator throws on the unrecognized proxy header,
// the throw propagates as an unhandled async rejection under Express 5, and
// the request hangs forever (browser sees a timeout, no response).
// `1` = trust a single hop, which matches Render's ingress.
app.set('trust proxy', 1);

// Middleware
app.use(helmet({ frameguard: { action: 'deny' } }));
// maxAge caches the CORS preflight (OPTIONS) response; without it browsers re-preflight
// every few seconds, adding a round-trip to most requests. Browsers clamp to their own cap.
// Auth is bearer-token only (no cookies anywhere in the app), so credentials:true is
// dead weight — omit it to shrink the surface (F-62).
app.use(cors({ origin: parseCorsOrigins(env), maxAge: 86400 }));
app.use(requestLogger);

// Webhook routes (must be before express.json() for raw body,
// and before the rate limiter — Stripe sends many webhook retries)
app.use('/api/webhooks', unscopedRequest, webhookRoutes);

// Copilot needs a large body for base64 voice clips (~43 KB/s of WAV base64,
// recorder-capped at 30 s); the transcribe schema caps the field tighter. Scope
// the 5mb ceiling to /api/copilot ONLY so the unauthenticated public/auth routers
// can't be made to buffer+parse 5mb of attacker JSON (F-23). Everything else gets
// a 1mb default — well above any legitimate CRM payload, including the ~500KB
// base64 signature_data on estimate-approve / job-complete (capped at 500_000 in
// their Zod schemas), which MUST still POST through this global parser.
// Express applies the FIRST matching parser; a body already parsed by the
// copilot-scoped parser is not re-parsed here (it short-circuits on req._body).
app.use('/api/copilot', express.json({ limit: '5mb' }));
app.use(express.json({ limit: '1mb' }));

// Origin verification — reject any traffic that did NOT come through Cloudflare.
// Cloudflare injects a secret X-Origin-Verify header on every request it forwards
// to this Render origin; a request hitting *.onrender.com directly lacks it and
// gets a 403. Mounted AFTER body parsing and AFTER the /api/webhooks router
// (above), so the Stripe raw-body parser is untouched and webhook requests are
// already handled before they could reach here (/api/webhooks is also on this
// middleware's own exempt allowlist as defense-in-depth). /health is exempt too,
// since Render's platform health check hits the origin directly. Fail-open when
// ORIGIN_VERIFY_SECRET is unset — see middleware/originVerify.ts.
app.use(originVerify);

// Rate limiting
app.use('/api', generalLimiter);

// Budget for the /health DB ping. A stalled query is NOT the same failure as a
// rejected one: the probe below once sat on its very first `SELECT 1` for 49s
// with neither a row nor an error, and an unbounded `await` turns that into a
// hang — the CI boot loop gets 45s of opaque curl timeouts, and on Render the
// platform health check pins a worker until server.requestTimeout (index.ts)
// kills the request, logging nothing either way. 2s is far above a healthy ping
// and far below both deadlines, so /health always answers in time to be read.
const HEALTH_DB_PROBE_TIMEOUT_MS = 2000;

// Health check (DB ping prevents Supabase Free auto-pause)
app.get('/health', async (_req, res) => {
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Promise.resolve() adopts the PrismaPromise rather than assuming it is a
    // native one, so `await`-compatible return values keep behaving as before.
    const probe = Promise.resolve(prisma.$queryRaw`SELECT 1`);
    // Promise.race subscribes to BOTH entries, so a probe that rejects long
    // after the timeout already won is still a handled rejection, not an
    // unhandled one — and the response was already sent and returned by then.
    const timedOut = await Promise.race([
      probe.then(() => false),
      new Promise<boolean>((resolve) => {
        probeTimer = setTimeout(() => resolve(true), HEALTH_DB_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (timedOut) {
      // Deliberately distinct from the reject message below: this line is the
      // only evidence that separates "the DB said no" from "the DB said
      // nothing at all", which is the fact the silent CI boot log lacked.
      logger.error(
        `Health check DB probe timed out after ${HEALTH_DB_PROBE_TIMEOUT_MS}ms: the database accepted the connection but returned neither a result nor an error`
      );
      res.status(503).json({ status: 'ok', db: 'error', timestamp: new Date().toISOString() });
      return;
    }
    res.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    // Log the real cause — a bare 503 here made a prod DB-connection failure
    // (e.g. during an RLS role/pooler switch) impossible to diagnose from logs.
    logger.error('Health check DB probe failed:', err);
    res.status(503).json({ status: 'ok', db: 'error', timestamp: new Date().toISOString() });
  } finally {
    // A fast success leaves the 2s timer still armed, and an armed timer holds
    // a ref on the event loop — every clean shutdown would wait up to 2s for it.
    clearTimeout(probeTimer);
  }
});

// API info
app.get('/api', (_req, res) => {
  res.json({ message: 'ServWave API v0.1.0' });
});

// Audit every denied request (HTTP 403) across all routers below. Passive observer:
// registers a response 'finish' listener and never alters the response. Mounted here
// so it does not observe /health or the /api info route (neither ever 403s).
app.use(auditAccessDenied);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/version', versionRoutes);
app.use('/api/users', userRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/tags', tagRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/state-tax-rates', stateTaxRateRoutes);
app.use('/api/org-tax-rates', orgTaxRateRoutes);
app.use('/api/custom-field-definitions', customFieldDefinitionsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/estimates', estimateRoutes);
app.use('/api/price-book', priceBookRoutes);
app.use('/api/scope-presets', scopePresetRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/job-sub-statuses', jobSubStatusRoutes);
app.use('/api/lost-reason-options', lostReasonOptionRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/statements', statementRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/service-plans', servicePlanRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/task-categories', taskCategoryRoutes);
app.use('/api/calendar-entries', calendarEntryRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/me/table-views', tableViewRoutes);
app.use('/api/copilot', copilotRoutes);
app.use('/api/timeclock', timeclockRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/ai-farm', aiFarmRoutes);
app.use('/api/ai-farm/bee', beeRoutes);
app.use('/api/bee', beeRoutes);


// ─── Inventory module (multiple routers share the /api/inventory base;
// each defines only its own sub-paths, so there are no collisions) ───
app.use('/api/inventory', invCatalogRoutes);
app.use('/api/inventory', invVendorsRoutes);
app.use('/api/inventory', invLocationsRoutes);
app.use('/api/inventory', invStockRoutes);
app.use('/api/inventory', invPoRoutes);
app.use('/api/inventory', invStagesRoutes);
app.use('/api/inventory', invTechsJobsRoutes);
app.use('/api/inventory', invAssetsRoutes);

// ─── Logistic Orders (LO-2): the single stock-deduction document (own base path) ───
app.use('/api/logistic-orders', logisticOrderRoutes);

// ─── In-app contact with the ServWave team ("Reach sales") ───
app.use('/api/support', supportRoutes);

// ─── Communication module (multiple routers share the /api/communication base) ───
// MOUNT ORDER IS LOAD-BEARING. Every router below receives every request under
// this base and falls through when it owns no matching route - but the seven
// phone routers gate with a bare `router.use(authenticate, requireFeature('phone'))`,
// which runs on fall-through traffic too and answers 402 before the owning
// router is ever reached. So the two routers that are NOT phone-gated (email,
// shared) must be mounted ahead of them, or an org that pays for email but not
// phone is 402'd on its own endpoints. The three routers below are path-scoped
// internally, so their own gates never leak onto anyone else, and each
// terminates its own prefixes with a 404 so an unmatched path of theirs can
// never fall through into a phone gate either.
app.use('/api/communication', commEmailRoutes);
app.use('/api/communication', commSharedRoutes);
// Manual Communication Log - NOT phone-gated, so it must be mounted ahead of the phone routers
// for the same reason email and shared are: a bare `router.use(authenticate,
// requireFeature('phone'))` further down answers 402 on fall-through traffic before the owning
// router is ever reached. An org without ServWave Phone is exactly this feature's audience.
app.use('/api/communication', commManualLogRoutes);
app.use('/api/communication', commWhatsappRoutes);
app.use('/api/communication', commUsageRoutes);
app.use('/api/communication', commCallsRoutes);
app.use('/api/communication', commThreadsRoutes);
app.use('/api/communication', commAgentsRoutes);
app.use('/api/communication', commConfigRoutes);
app.use('/api/communication', commNumbersRoutes);
app.use('/api/communication', commPhoneAccessRoutes);
app.use('/api/communication', commNumberAssignmentsRoutes);

// ─── Test-only endpoints (never in production) ───────
if (process.env.NODE_ENV !== 'production') {
  // D16 (2026-07-21) — /api/test/expire-estimates and /api/test/backdate-estimate/:id retired
  // alongside the internal expiration cron they existed to drive (release plan §R1).

  // Delete ALL E2E test data — customers with @e2e.local emails and all cascading entities.
  // Also deletes test users (email @e2e.local) and orphaned polymorphic records.
  // Call this in beforeAll to start with a clean slate.
  app.post('/api/test/cleanup', async (_req, res) => {
    try {
      const result = await prisma.$transaction(async (tx: any) => {
        // 1. Find test customers (by email pattern)
        const testCustomers = await tx.customer.findMany({
          where: { email: { endsWith: '@e2e.local' } },
          select: { id: true },
        });
        const customerIds = testCustomers.map((c: any) => c.id);

        // 2. Find test users (by email pattern) — not the admin seed user
        const testUsers = await tx.user.findMany({
          where: { email: { endsWith: '@e2e.local' } },
          select: { id: true },
        });
        const userIds = testUsers.map((u: any) => u.id);

        if (customerIds.length === 0 && userIds.length === 0) {
          return { deleted: 0, message: 'No test data found' };
        }

        // 3. Find all leads for these customers
        const testLeads = await tx.lead.findMany({
          where: { customer_id: { in: customerIds } },
          select: { id: true },
        });
        const leadIds = testLeads.map((l: any) => l.id);

        // 4. Find all estimates for these leads
        const testEstimates = await tx.estimate.findMany({
          where: { lead_id: { in: leadIds } },
          select: { id: true },
        });
        const estimateIds = testEstimates.map((e: any) => e.id);

        // 5. Find all jobs for these customers
        const testJobs = await tx.job.findMany({
          where: { customer_id: { in: customerIds } },
          select: { id: true },
        });
        const jobIds = testJobs.map((j: any) => j.id);

        // 6. Find all invoices for these jobs
        const testInvoices = await tx.invoice.findMany({
          where: { job_id: { in: jobIds } },
          select: { id: true },
        });
        const invoiceIds = testInvoices.map((i: any) => i.id);

        // All entity IDs for polymorphic cleanup
        const allEntityIds = [...customerIds, ...leadIds, ...estimateIds, ...jobIds, ...invoiceIds];

        // ─── Delete in FK-safe order (leaves first, roots last) ───
        // Parallelize independent deletes at each FK depth level.

        // Polymorphic records + leaf payments (no FK between them)
        const [timeline, notes, attachments, payments, tagAssignments] = await Promise.all([
          tx.timelineEvent.deleteMany({ where: { entity_id: { in: allEntityIds } } }),
          tx.note.deleteMany({ where: { entity_id: { in: allEntityIds } } }),
          tx.attachment.deleteMany({ where: { entity_id: { in: allEntityIds } } }),
          tx.payment.deleteMany({ where: { invoice_id: { in: invoiceIds } } }),
          tx.tagAssignment.deleteMany({ where: { entity_id: { in: allEntityIds } } }),
        ]);

        // Invoices + Jobs (parents of payments, children of estimates/customers)
        const [invoices, jobs] = await Promise.all([
          tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } }),
          tx.job.deleteMany({ where: { id: { in: jobIds } } }),
        ]);

        // Estimate children (send configs, line items — independent of each other)
        const [sendConfigs, lineItems] = await Promise.all([
          tx.estimateSendConfig.deleteMany({ where: { estimate_id: { in: estimateIds } } }),
          tx.estimateLineItem.deleteMany({ where: { estimate_id: { in: estimateIds } } }),
        ]);
        const estimates = await tx.estimate.deleteMany({ where: { id: { in: estimateIds } } });

        // Lead children + leads
        const leadTags = await tx.leadTag.deleteMany({ where: { lead_id: { in: leadIds } } });
        const leads = await tx.lead.deleteMany({ where: { id: { in: leadIds } } });

        // Customer children (independent of each other) then customers
        const [locations, emails] = await Promise.all([
          tx.serviceLocation.deleteMany({ where: { customer_id: { in: customerIds } } }),
          tx.customerEmail.deleteMany({ where: { customer_id: { in: customerIds } } }),
        ]);
        const customers = await tx.customer.deleteMany({ where: { id: { in: customerIds } } });

        // Test users + Stripe events (independent)
        const [users, stripeEvents] = await Promise.all([
          tx.user.deleteMany({ where: { id: { in: userIds } } }),
          tx.stripeEvent.deleteMany({ where: { stripe_event_id: { startsWith: 'evt_test_' } } }),
        ]);

        return {
          customers: customers.count,
          locations: locations.count,
          leads: leads.count,
          estimates: estimates.count,
          jobs: jobs.count,
          invoices: invoices.count,
          payments: payments.count,
          attachments: attachments.count,
          notes: notes.count,
          timeline: timeline.count,
          tagAssignments: tagAssignments.count,
          users: users.count,
          stripeEvents: stripeEvents.count,
        };
      }, { timeout: 120_000 });

      res.json({ success: true, deleted: result });
    } catch (err: any) {
      res.status(500).json({ error: 'Cleanup failed', details: err?.message });
    }
  });

  // ─── Entity-redesign QA-suite doors (all gated by E2E_TEST_DOORS, all under /api/test/ so
  //     assertNoTestRoutesInProduction() refuses to boot if they ever leak to prod) ───

  // Mimic a Stripe webhook through the REAL post-signature money code (no signature).
  // Reuses processStripeEvent so the genuine /api/webhooks/stripe signature path is never weakened.
  app.post('/api/test/stripe-webhook', async (req, res) => {
    if (env.E2E_TEST_DOORS !== 'true') {
      res.status(403).json({ error: 'E2E test doors disabled' });
      return;
    }
    const event = req.body; // express.json() already parsed it; caller supplies {id,type,data,account?}
    if (!event?.id || !event?.type || !event?.data) {
      res.status(400).json({ error: 'Malformed event (need id, type, data)' });
      return;
    }
    await processStripeEvent(event, res);
  });

  // Mimic a CTM webhook through the REAL post-auth ingest code (no token/HMAC).
  // Reuses processCtmEvent so the genuine /api/webhooks/ctm/:position auth path is
  // never weakened. Unlike the Stripe door this one IS org-constrained: the
  // payload's account_id must resolve to an E2E-provisioned org (name prefixed
  // by the provision-org door) — the door can never write into a real org.
  app.post('/api/test/ctm-webhook', async (req, res) => {
    if (env.E2E_TEST_DOORS !== 'true') {
      res.status(403).json({ error: 'E2E test doors disabled' });
      return;
    }
    const { position, payload } = req.body ?? {};
    if (typeof position !== 'string' || !position || !payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Malformed body (need position, payload)' });
      return;
    }
    const activity = unwrapActivity(payload as Record<string, any>);
    const accountId = activity.account_id ?? (payload as Record<string, any>).account_id;
    const org =
      accountId !== undefined && accountId !== null && accountId !== ''
        ? await prisma.organization.findFirst({
            where: { ctm_account_id: String(accountId) },
            select: { name: true },
          })
        : null;
    if (!org || !org.name.startsWith(E2E_ORG_NAME_PREFIX)) {
      res.status(403).json({ error: 'ctm-webhook door is restricted to E2E-provisioned orgs' });
      return;
    }
    // No unknown-number sync from the door: it is unauthenticated, so it must
    // not be a way to make the server call the phone system.
    await processCtmEvent(position, payload as Record<string, unknown>, res, {
      syncUnknownNumbers: false,
    });
  });

  // Provision a throwaway org + confirmed admin (Supabase Auth + Prisma User, id-aligned).
  app.post('/api/test/provision-org', async (_req, res) => {
    if (env.E2E_TEST_DOORS !== 'true') { res.status(403).json({ error: 'E2E test doors disabled' }); return; }
    try { res.json(await provisionTestOrg()); }
    catch (err: any) { res.status(500).json({ error: 'provision failed', details: err?.message }); }
  });

  // Tear down one throwaway org by id (name-guarded purge) + sweep @e2e-qa.invalid Auth users.
  app.post('/api/test/teardown-org', async (req, res) => {
    if (env.E2E_TEST_DOORS !== 'true') { res.status(403).json({ error: 'E2E test doors disabled' }); return; }
    try { await teardownTestOrg(req.body?.organizationId); res.json({ torn_down: true }); }
    catch (err: any) { res.status(500).json({ error: 'teardown failed', details: err?.message }); }
  });

  // Fail fast if the DB is not the post-D3 migrated shape, or the MA tax fixture drifted.
  app.post('/api/test/preflight', async (_req, res) => {
    if (env.E2E_TEST_DOORS !== 'true') { res.status(403).json({ error: 'E2E test doors disabled' }); return; }
    try { await assertMigratedSchema(); await assertGlobalFixtures(); res.json({ ok: true }); }
    catch (err: any) { res.status(412).json({ ok: false, error: err?.message }); }
  });

  // Set a fake Stripe payment_intent on the invoice's latest non-voided payment so that
  // charge.refunded / dispute events can resolve via PI→Payment→org in the webhook door.
  app.post('/api/test/seed-payment-intent', async (req, res) => {
    if (env.E2E_TEST_DOORS !== 'true') { res.status(403).json({ error: 'E2E test doors disabled' }); return; }
    const { invoiceId, paymentIntent } = req.body ?? {};
    const payment = await prisma.payment.findFirst({ where: { invoice_id: invoiceId, voided_at: null }, orderBy: { paid_at: 'desc' } });
    if (!payment) { res.status(404).json({ error: 'no payment to seed' }); return; }
    await prisma.payment.update({ where: { id: payment.id }, data: { stripe_payment_intent_id: paymentIntent } });
    res.json({ seeded: true, paymentId: payment.id });
  });

  // Probe whether a raw prisma.<model>.delete is blocked by an onDelete:Restrict FK.
  // Always rolls back — never commits a destructive delete. 409 = RESTRICT (P2003), else deletable.
  app.post('/api/test/raw-delete-probe', async (req, res) => {
    if (env.E2E_TEST_DOORS !== 'true') { res.status(403).json({ error: 'E2E test doors disabled' }); return; }
    const { model, id } = req.body ?? {};
    try {
      await prisma.$transaction(async (tx: any) => {
        await tx[model].delete({ where: { id } });
        throw new Error('ROLLBACK'); // never actually commit a destructive probe
      });
      res.json({ deletable: true });
    } catch (err: any) {
      if (err?.code === 'P2003') { res.status(409).json({ restricted: true }); return; }
      if (err?.message === 'ROLLBACK') { res.json({ deletable: true }); return; }
      res.status(500).json({ error: err?.message });
    }
  });
}

assertNoTestRoutesInProduction(app);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Sentry error handler — registered after all controllers/routes and before our
// own error-handling middleware, so it captures the error then hands off. No-op
// when Sentry is disabled (no SENTRY_DSN).
Sentry.setupExpressErrorHandler(app);

// Last-resort net for a MulterError from a multipart route that did not mount its own
// `multerErrorHandler`. Registered AFTER Sentry on purpose: every wired route answers its
// own multer aborts before the error ever reaches this far, so anything arriving here is a
// route missing its handler and is worth the Sentry signal. It reports 413 with no size in
// the message — the caps run from 2MB to 100MB and it cannot know which applies.
app.use(globalMulterErrorHandler);

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
