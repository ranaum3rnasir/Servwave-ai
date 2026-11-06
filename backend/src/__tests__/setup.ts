import { vi } from 'vitest';

// Lets the shared Prisma client (lib/prisma.ts) deliver `$on('query')` events, which the query counter in
// support/query-counter.ts reads. Test-only: lib/prisma.ts ignores it in production.
process.env.PRISMA_QUERY_EVENTS ??= 'on';

// Mock env before anything else imports it
vi.mock('../config/env', async () => ({ env: (await import('./test-env.js')).testEnv }));

// The live-update pings post to the vendor's broadcast door with plain fetch. A suite that does not stub fetch itself
// must never reach the network through them, so that one address answers as the service does (202) and every other
// address goes through the real fetch.
const fetchBeforeSetup = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('https://test.supabase.co/realtime/')) return Promise.resolve(new Response(null, { status: 202 }));
  return fetchBeforeSetup(input, init);
}) as typeof fetch;

// Mock the Gemini SDK — never hit the network in tests. A class so
// `new GoogleGenAI()` is constructable (an arrow mockImplementation is not).
// The copilot controller test mocks the gemini-generate service for precise
// control; this default keeps any direct import constructable + harmless.
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: vi.fn().mockResolvedValue({ text: 'Test reply.', functionCalls: undefined }),
    };
  },
}));

// Mock rate limiter — passthrough in tests
vi.mock('express-rate-limit', () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  __esModule: true,
}));

// Mock supabase clients. supabaseAdmin (Storage + admin APIs) and supabaseAuth
// (session-based auth) are separate clients in prod; here they SHARE one `auth`
// mock object so existing suites that set expectations on `supabaseAdmin.auth.*`
// (login/refresh/reauth) keep working after those calls moved to supabaseAuth.
vi.mock('../lib/supabase', () => {
  const auth = {
    getUser: vi.fn(),
    signInWithPassword: vi.fn(),
    refreshSession: vi.fn(),
    // Password reset (slice 04): the reset link's token is checked on a fresh client.
    verifyOtp: vi.fn(),
    admin: {
      createUser: vi.fn(),
      deleteUser: vi.fn(),
      updateUserById: vi.fn(),
      // The provider holds no login unless a test says otherwise: an invite clears one left behind for its address, and a
      // permanent delete removes the person's, before either goes ahead (pre-PR review fixes, SR-5).
      listUsers: vi.fn().mockResolvedValue({ data: { users: [], nextPage: null }, error: null }),
      signOut: vi.fn(),
      // Password reset (slice 04): mints the recovery token; the provider sends nothing.
      generateLink: vi.fn(),
      // Slice 06: reads the caller's sign-in methods (is there a password?) by the verified auth id.
      getUserById: vi.fn(),
    },
  };
  return {
    supabaseAdmin: {
      auth,
      storage: {
        from: vi.fn().mockReturnValue({
          upload: vi.fn().mockResolvedValue({ data: { path: 'test/file.jpg' }, error: null }),
          remove: vi.fn().mockResolvedValue({ data: null, error: null }),
          // #2029 — duplicate/revise copy a scope photo's OBJECT, never share its path.
          copy: vi.fn().mockResolvedValue({ data: { path: 'test/copy.jpg' }, error: null }),
          // Direct-to-storage uploads (S1). The client PUTs the bytes itself against a
          // short-lived signed upload URL, and the server reads the LANDED object's real
          // size back off `info` rather than believing what the client declared. Both
          // defaults are inert; a suite exercising the direct path overrides them per-test.
          createSignedUploadUrl: vi.fn().mockResolvedValue({
            data: {
              signedUrl: 'https://test.supabase.co/storage/v1/object/upload/sign/attachments/test/file.mp4?token=mock',
              token: 'mock-upload-token',
              path: 'test/file.mp4',
            },
            error: null,
          }),
          info: vi.fn().mockResolvedValue({ data: { size: 0, contentType: 'application/octet-stream' }, error: null }),
          getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://test.supabase.co/storage/v1/object/public/test/file.jpg' } }),
          createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://test.supabase.co/storage/v1/object/sign/test/file.jpg?token=mock' }, error: null }),
          // Batch variant (P5 stage attachments): echo each requested path back
          // as a mock signed URL so read paths resolve deterministically.
          createSignedUrls: vi.fn().mockImplementation((paths: string[]) =>
            Promise.resolve({
              data: (paths ?? []).map((p) => ({ path: p, signedUrl: `https://test.supabase.co/storage/v1/object/sign/${p}?token=mock`, error: null })),
              error: null,
            })),
        }),
      },
    },
    supabaseAuth: { auth },
    // A fresh client per call in prod (lib/supabase.ts). Here every "fresh" client shares the
    // same auth mock so suites can keep setting expectations on `supabaseAdmin.auth.*`; a suite
    // that needs to tell the clients apart overrides the implementation.
    createIsolatedAuthClient: vi.fn(() => ({ auth })),
  };
});

// Mock CTM client — every suite sees CTM unconfigured unless it re-mocks.
// ctm-client.test.ts vi.unmock()s this to exercise the real module.
vi.mock('../lib/ctm/client', () => ({
  // Mirrors the real constructor. It previously ignored its arguments and left
  // httpStatus at 0 / reason at '', which silently disarmed every branch that
  // discriminates on them - buy's 409 "someone else took it", release's 404
  // "not on the account any more". A test naming such a branch passed without
  // ever reaching it.
  CtmApiError: class CtmApiError extends Error {
    httpStatus: number;
    reason: string;
    constructor(httpStatus: number, reason: string) {
      super(`Phone system API error ${httpStatus}: ${reason}`);
      this.name = 'CtmApiError';
      this.httpStatus = httpStatus;
      this.reason = reason;
    }
  },
  isCtmConfigured: vi.fn().mockReturnValue(false),
  // Phase-0 outbound guard — defaults to "allowed" (mirrors an unset allowlist),
  // so suites that don't opt in behave exactly as before.
  isOutboundAllowed: vi.fn().mockReturnValue(true),
  getCtmForOrg: vi.fn(),
  listAccounts: vi.fn().mockResolvedValue([]),
  createAccount: vi.fn(),
  listNumbers: vi.fn().mockResolvedValue([]),
  searchNumbers: vi.fn().mockResolvedValue([]),
  buyNumber: vi.fn(),
  updateNumberRouting: vi.fn(),
  releaseNumber: vi.fn(),
  createReceivingNumber: vi.fn(),
  // Default empty: an un-warmed roster resolves nothing, so every suite that
  // does not opt in keeps ingesting forwarded calls exactly as it did before.
  listReceivingNumbers: vi.fn().mockResolvedValue([]),
  addReceivingToTracking: vi.fn(),
  createVoiceMenu: vi.fn(),
  enableSms: vi.fn().mockResolvedValue('ok'),
  isOptedOut: vi.fn().mockResolvedValue(false),
  createWebhook: vi.fn(),
  listWebhooks: vi.fn().mockResolvedValue([]),
  deleteWebhook: vi.fn(),
  getCall: vi.fn(),
  getCallTranscription: vi.fn(),
  listCalls: vi.fn(),
  placeCall: vi.fn(),
  requestPhoneAccess: vi.fn(),
  getRecordingResponse: vi.fn(),
  sendSms: vi.fn(),
  getA2pStatus: vi.fn().mockResolvedValue({ status: 'unknown' }),
}));

// Mock stripe service
vi.mock('../lib/stripe', () => ({
  createCheckoutSession: vi.fn().mockResolvedValue({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test' }),
  isStripeConfigured: vi.fn().mockReturnValue(true),
  createRefund: vi.fn().mockResolvedValue({}),
  // Payments go-live slice 29 - cancelling a bank debit that is still processing.
  cancelPaymentIntent: vi.fn(),
  // Slice 11 - the refunds already on a payment intent. Defaults to none.
  listPaymentIntentRefunds: vi.fn().mockResolvedValue([]),
  // Slice 37b - the same lookup by charge, and one payment intent read from a connected account (null = not held).
  listChargeRefunds: vi.fn().mockResolvedValue([]),
  retrieveAccountPaymentIntent: vi.fn().mockResolvedValue(null),
  // Slice 37 - the nightly reconcile's reads of one connected account. Default: nothing there.
  listAccountCharges: vi.fn().mockResolvedValue([]),
  listAccountRefunds: vi.fn().mockResolvedValue([]),
  listAccountDisputes: vi.fn().mockResolvedValue([]),
  listAccountCheckoutSessions: vi.fn().mockResolvedValue([]),
  // Payouts slice P2 - payouts of a connected account, the balance transactions inside one, and why a
  // payment intent failed. Defaults: nothing there.
  listAccountPayouts: vi.fn().mockResolvedValue([]),
  listPayoutBalanceTransactions: vi.fn().mockResolvedValue([]),
  retrieveAccountPayout: vi.fn().mockResolvedValue(null),
  retrievePaymentIntentFailureCode: vi.fn().mockResolvedValue(null),
  // V7-09a - how an unapplied capture was paid, read on demand. Default: the processor cannot say.
  retrieveCapturePayerDetail: vi.fn().mockResolvedValue(null),
  // Payments go-live P10 - answering a dispute: one file token per upload, staging and submit resolve, and the
  // submission count reads zero until a suite says otherwise.
  uploadDisputeEvidenceFile: vi.fn().mockResolvedValue('file_test_evidence'),
  stageDisputeEvidence: vi.fn().mockResolvedValue(undefined),
  submitDisputeEvidence: vi.fn().mockResolvedValue(undefined),
  retrieveDisputeSubmissionCount: vi.fn().mockResolvedValue(0),
  constructWebhookEvent: vi.fn(),
  // Task 3.2 — applicationFees surface for the dashboard-refund + dispute-lost fee-reversal
  // doors. Defaults to "no fee found" (a no-op) so tests unrelated to fee reversal are
  // unaffected; individual webhook tests override .list's resolved value per-call.
  // Task 3.3 — paymentIntents.retrieve for post-commit fee capture. Defaults to a PI with no
  // latest_charge (a safe no-op — captureStripeFees returns early) so any test that
  // incidentally triggers the fire-and-forget capture call is unaffected;
  // reconcile-stripe-fees.test.ts overrides the resolved value per-call.
  getStripeForOrg: vi.fn().mockReturnValue({
    stripe: {
      applicationFees: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        createRefund: vi.fn().mockResolvedValue({}),
      },
      paymentIntents: {
        retrieve: vi.fn().mockResolvedValue({ latest_charge: null }),
      },
      // Payments go-live slice 09: an unmatched dispute asks whether its charge came from a
      // ServWave checkout. Defaults to "no", so the dispute is acknowledged and ignored.
      checkout: {
        sessions: { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) },
      },
    },
    stripeAccount: undefined,
  }),
  // Slice 7 (customer-facing tipping) — chip percentages; nothing persists them (D11).
  CARD_TIP_PRESET_BPS: [1000, 1500, 2000],
  // #2031 slice 5 (F2) — killing a checkout the customer already has open. Defaults to a clean
  // sweep that found nothing, so any test that incidentally triggers the guard is unaffected;
  // deposit-checkout-expiry.test.ts asserts against these directly, and
  // stripe-checkout-expiry.test.ts unmocks this module to test the real implementation.
  expireOpenCheckoutSessionsForInvoice: vi.fn().mockResolvedValue({ expired: [], failed: 0, ok: true }),
  expireCheckoutSession: vi.fn().mockResolvedValue(true),
  retrieveAccount: vi.fn(),
  // Slice 06 — the nightly status refresh proves the platform key once before any org.
  checkPlatformKey: vi.fn().mockResolvedValue(undefined),
  // Task 1.5 — connect/account-session/account-link/status endpoints.
  createConnectedAccount: vi.fn(),
  createAccountSession: vi.fn(),
  createAccountLink: vi.fn(),
  // Slice 36 — branding pushed to the connected account.
  updateAccountBranding: vi.fn().mockResolvedValue(undefined),
}));

// Task 3.3 — post-commit fee reconciliation + nightly sweep. Defaults resolve to no-ops so
// webhook tests unrelated to fee capture are unaffected by the fire-and-forget wiring;
// reconcile-stripe-fees.test.ts unmocks this to test the real implementation, and
// webhook.test.ts asserts against these vi.fn()s directly to test the wiring in isolation.
vi.mock('../lib/reconcile-stripe-fees', () => ({
  captureStripeFees: vi.fn().mockResolvedValue(undefined),
  sweepUncapturedFees: vi.fn().mockResolvedValue({ swept: 0 }),
}));

// Mock numbering allocator — controllers use this to generate per-org sequence numbers.
// Default returns deterministic L00001/E00001/J00001/I00001 strings; numbering.test.ts
// re-mocks per-test with vi.mocked() for specific allocator behavior.
// The rest of the module is the real one (importOriginal): the logistic-order create picks its anchor with pickAnchor and
// mints its number with allocateAnchoredNumber, and a mock without them answered every order create with a 500.
vi.mock('../lib/numbering', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/numbering')>()),
  allocateNumber: vi.fn().mockImplementation((_tx: unknown, entity: string) => {
    const prefix = entity[0].toUpperCase();
    return Promise.resolve(`${prefix}00001`);
  }),
  // SERV10X-61 - per-container estimate numbering (`L00001-1`/`C00001-1`/`J00001-1`). create()
  // calls this instead of allocateNumber for the anchor-based series; without it every create
  // test 500s. Keyed off the container name's first letter to mirror the real prefix scheme.
  // Returns the same { estimate_number, container_kind, container_seq } record the real
  // allocator does - the create paths spread it into `data`, so a bare string here would
  // silently drop the provenance columns from every controller test's assertions.
  allocateContainerEstimateNumber: vi.fn().mockImplementation((_tx: unknown, container: string) =>
    Promise.resolve({
      estimate_number: `${container[0].toUpperCase()}00001-1`,
      container_kind: container.toUpperCase(),
      container_seq: 1,
    })),
  formatContainerEstimateNumber: (containerNumber: string, seq: number) => `${containerNumber}-${seq}`,
}));

// Mock email service
vi.mock('../lib/email', () => ({
  // Email slice 10 (guided domain verification) — the reused Resend client
  // instance. organization-email-domain.test.ts overrides this whole module
  // locally with per-test-controllable domains.* mocks; this default just
  // keeps any OTHER suite that happens to import `resend` from crashing.
  resend: {
    domains: {
      create: vi.fn(),
      get: vi.fn(),
      verify: vi.fn(),
      remove: vi.fn(),
    },
  },
  // Email slice 7 - compose-window sends (POST /api/communication/emails).
  // Defaults to a real-shaped 'sent' result so most controller tests don't
  // need to override it; comm-email-send.test.ts / comm-email-attachments.test.ts
  // re-mock per case for skipped/failed dispatch paths.
  // Slice 37 - the nightly payment reconcile's ops alert.
  sendOpsAlertEmail: vi.fn().mockResolvedValue(true),
  sendComposedEmail: vi.fn().mockResolvedValue({
    status: 'sent',
    providerMessageId: 're_test_compose',
    fromAddress: 'no-reply@mail.test.com',
    fromName: null,
  }),
  // GET /api/communication/sending-identity - the same From a send would use,
  // reported without sending. There is one shared sending domain for every org.
  orgSendingIdentity: vi.fn().mockResolvedValue({
    address: 'acmeplumbing@mail.test.com',
    name: 'Acme Plumbing',
    sendingEnabled: true,
    localPart: 'acmeplumbing',
    localPartIsCustom: false,
    senderDomain: 'mail.test.com',
  }),
  // PATCH /api/organization/email-sender calls these two SYNCHRONOUSLY while
  // building its response, so omitting them is not a stub that returns
  // undefined - it is a TypeError inside the handler and a 500 on every path.
  // Real implementations rather than vi.fn(), because the assertions are about
  // the value the endpoint echoes back.
  effectiveSenderLocalPart: (name: string | null | undefined, explicit: string | null | undefined) =>
    explicit?.trim() ||
    (name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40) ||
    'no-reply',
  senderDomainOf: () => 'mail.test.com',
  // "Reach sales" composer (POST /api/support/sales-request). The recipient is
  // server-owned, so the constant is exported alongside the sender.
  SALES_CONTACT_EMAIL: 'info@servwave.com',
  sendSalesContactEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  sendEstimateEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  sendEstimateWithDepositEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  sendEstimateApprovedNotification: vi.fn().mockResolvedValue(undefined),
  sendDepositPaymentConfirmation: vi.fn().mockResolvedValue(undefined),
  sendDepositReceivedConfirmation: vi.fn().mockResolvedValue(undefined),
  sendRefundNotification: vi.fn().mockResolvedValue(undefined),
  sendInvoiceRefundNotification: vi.fn().mockResolvedValue(undefined),
  sendBankPaymentProcessingEmail: vi.fn().mockResolvedValue(undefined),
  sendBankPaymentFailedEmail: vi.fn().mockResolvedValue({ status: 'sent', providerMessageId: null, fromAddress: 'noreply@example.test', fromName: null }),
  sendDepositPaidAlert: vi.fn().mockResolvedValue(undefined),
  sendInvoiceEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  // SRVW-243 - the customer "your visit is booked / has moved" senders, restored
  // as a DIRECT action behind notify_customer. They resolve to an
  // EmailDispatchResult (the pre-#1003 versions were Promise<void> with a
  // swallowing catch) because the controller reports the outcome to the caller.
  sendJobScheduledEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  sendJobRescheduledEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  // Multi-visit S7 (D19) - "that TRIP is off", which has no pre-S7 equivalent on either parent.
  sendJobVisitCancelledEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  sendWalkthroughScheduledEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  sendWalkthroughRescheduledEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  // Calendar Entries (slice 07) - the three-outcome family for customer participants.
  // calendar-entry-notifications.test.ts re-mocks per case to prove template selection.
  sendCalendarEntryScheduledEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  sendCalendarEntryMovedEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  sendCalendarEntryCancelledEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  sendPaymentReceivedEmail: vi.fn().mockResolvedValue(undefined),
  // Task 1.9 — co-branded action-needed email (billing.payments_action_needed /
  // billing.payments_paused), sent from lib/payments-notifications.ts (sendAccountNotices).
  sendPaymentsActionNeededEmail: vi.fn().mockResolvedValue(undefined),
  // Slice 32 - the owner's payment-event email (dispute, failed bank payment, failed refund, money not applied).
  sendOwnerPaymentNoticeEmail: vi.fn().mockResolvedValue(undefined),
  sendMfaCodeEmail: vi.fn().mockResolvedValue(undefined),
  // Password reset (slice 04): resolves true when the mail provider accepted the message.
  sendPasswordResetEmail: vi.fn().mockResolvedValue(true),
  // Ticket 25 (M6) - the Owner's email when someone becomes or stops being an Admin.
  sendAdminChangeAlertEmail: vi.fn().mockResolvedValue(true),
  sendAutomationEmail: vi.fn().mockResolvedValue({ status: 'sent' }),
  // P2 item 6: the PO sender resolves with the transmitted content so the
  // controller can persist the exact subject/html into InventoryEmail.
  // Stage pickup ticket (inventory Staging) — resolves with sent + content, mirroring the PO sender.
  sendStagePickupEmail: vi.fn().mockResolvedValue({ status: 'sent', subject: 'Pickup Ticket J00001', html: '<html></html>' }),
  // dispatchFailureStatus is a pure classifier two controllers call directly
  // (inv-po, inv-stages) to pick 409 vs 502 for a non-sent dispatch - keep the
  // real logic rather than stubbing it, so those callers exercise the actual
  // 409/502 split instead of hitting undefined() at runtime. Mirrors the real
  // function's org_disabled/suppressed (email slice 4) -> 409 classification.
  dispatchFailureStatus: (result: { status: string; reason?: string }) =>
    result.status === 'skipped' && (result.reason === 'org_disabled' || result.reason === 'suppressed') ? 409 : 502,
  // esc is a pure output-encoding function — automation merge-field rendering
  // depends on its REAL behavior (XSS guard), so never stub it out.
  esc: (value: unknown) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
}));

// Automation dispatch is fire-and-forget via setImmediate — left real, it would
// run AFTER a test finishes and pollute unrelated mocks' call counts (flake
// vector). automation-wiring.test.ts re-mocks it locally with the same shape
// to assert calls; engine/cron tests import the engine directly and are unaffected.
vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));

// Mock logger to suppress output during tests
vi.mock('../lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock prisma with all methods used by controllers
// The access stamp (ticket 37) is read from the database on every signed-in request, so the sign-in and switch caches see a
// change made on any server. A suite with this file's mocked database has no person rows to read it from: its stamp is
// answered as "unchanged", the way the caches behaved for it before ticket 37 (the in-process clears and the TTL). A suite on a
// real database (its own vi.mock of ../lib/prisma) gets the real stamp; the behaviour itself is proven there
// (permission-access-two-servers-db.test.ts and its siblings).
vi.mock('../lib/permissions/accessStamp', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/permissions/accessStamp')>();
  const { prisma } = await import('../lib/prisma.js');
  const mockedDatabase = vi.isMockFunction((prisma as { $queryRaw?: unknown } | undefined)?.$queryRaw);
  if (!mockedDatabase) return real;
  return {
    ...real,
    signInStampOf: () => 'mocked-database',
    readAccessStamp: async () => ({ signIn: 'mocked-database', switches: 'mocked-database' }),
  };
});

vi.mock('../lib/prisma', () => ({
  prisma: {
    customer: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // updateMany: the automated first-touch `ad_source` write (lib/web-form/process.ts) goes
      // through `where: { ad_source: null }`, so the STATEMENT is what stops automation rewriting
      // an existing customer's origin rather than a comment asking the next reader not to.
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    serviceLocation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    customerEmail: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    lead: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    job: {
      // A job-history write asks which of the jobs it touches are in Ready to close (S06.20); nearly every test has none.
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn(),
    },
    note: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    // ─── Scheduler redesign: crew/assignment M2M join tables ───
    // `jobAssignee` OUTLIVES its Prisma model on purpose. Multi-visit S8 dropped the table, and
    // several suites now assert that nothing writes it any more - `expect(mockPrisma.jobAssignee
    // .createMany).not.toHaveBeenCalled()`. That assertion needs a spy to exist. Delete this
    // block and those pins go quiet instead of failing, which is the one thing they are for.
    jobAssignee: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    // SRVW-112 - per-org job sub-status catalog. `findMany` defaults to [] so the suites that
    // never touch sub-statuses are unaffected, and `count` defaults to 0 so create()'s
    // append-index sort_order resolves to a NUMBER in tests rather than an undefined that would
    // silently fall through to the Prisma column default.
    jobSubStatus: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    // Decline-reasons slice B - the per-org estimate decline reason list. `findMany` and `count`
    // default to empty/0 so a suite that never touches the list reads the five built-ins, which
    // is what an un-customised org really answers.
    lostReasonOption: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    // Roles & Permissions S06.14 - the per-org job cancel-reasons list; findMany/count default to empty so a suite that
    // never touches the list reads the six built-ins.
    jobCancelReasonOption: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    // V7-03 - the Lists-page job types and lead/customer sources. findMany defaults to empty, so a suite that never touches
    // the lists reads the org's JSON columns (the no-rows fallback).
    jobType: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    leadSource: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    leadAssignee: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    visitAssignee: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    // Multi-visit S1: safe "nothing here" default so tests that don't exercise visit state
    // (most of the suite) don't need to know it exists.
    //
    // S3: `create` needs a ROW back, not just a resolved promise. POST /assign books a visit
    // whenever the body carries a time and the job has none, and from S3 it reads the created
    // row's id to land the crew on it - so an unconfigured `vi.fn()` returns undefined and 500s
    // any suite that assigns a job without caring about visits at all (job-sub-status did).
    visit: {
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'v0000000-0000-0000-0000-00000000dead', visit_seq: 1 }),
      // Same reason as `create` above, one writer later: cancelWalkthroughRow's guarded write is
      // an `updateMany` (it needs a count, not a row), so it re-reads through `update` with an
      // empty `data` to hand the cancelled row back to the job door, which answers with it. A
      // real client always returns a row there; a bare `vi.fn()` returns undefined, which would
      // make every suite that cancels a visit look like it lost a race it never ran.
      update: vi.fn().mockResolvedValue({ id: 'v0000000-0000-0000-0000-00000000dead', visit_seq: 1 }),
      // Defaulted to "the write landed" because the visit lifecycle writers are CONDITIONAL —
      // completeWalkthroughRow re-tests the status in its WHERE and reads `count` to answer
      // "was I the one that landed the transition". Bare `vi.fn()` returns undefined, which
      // would make every door that completes a visit blow up on the destructure rather than
      // exercise the guard. A suite that wants to test the guard overrides this with an
      // implementation that emulates Postgres — see walkthrough-completion-race.test.ts.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    // Scheduling-notifications slice 08: the append-only milestone log every milestone writer
    // appends to in the same client as the visit write. The job-level verbs (POST /:id/start,
    // /en-route, /arrive) write on the GLOBAL client, so a suite that presses one of them without
    // caring about the log needs this delegate to exist or the door 500s on a TypeError.
    visitMilestoneLog: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    tag: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    leadTag: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    tagAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    customRole: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    termsAcceptance: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    location: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    department: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    estimate: {
      // Roles & Permissions S08.9 - a record's Communication tab reads the estimates whose portal decisions it shows; none by default.
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
    },
    estimateLineItem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    // R5f — line-item + scope-of-work photos. findMany defaults to [] so the remove()/deleteLine
    // Storage-cleanup sweeps (Promise.all'd best-effort reads) don't crash every PRE-EXISTING
    // delete-estimate/delete-line test that doesn't itself set up a photo fixture.
    estimateScopePhoto: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      // #2029 — the per-estimate photo cap counts these before every upload.
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
      // #2029 — duplicate/revise carry a source estimate's photos forward in one write.
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    // Spider lead watcher (#2619). aggregate resolves an empty sum so comm usage reads zero
    // Spider texts unless a suite says otherwise.
    spiderSettings: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
    },
    spiderAlert: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { texts_sent: null } }),
    },
    // Roles & Permissions S05.7 - a job's own phones and emails. The job detail reads the live ones; none by default.
    recordContactEntry: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    // Roles & Permissions S06.1 - the office review round the job-level complete opens: none open, one created.
    jobReview: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'review-1' }),
    },
    // Roles & Permissions S06.10 - the checks on the review's items: none stored.
    jobReviewItemCheck: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // Roles & Permissions S06.11 - the reviewer's decisions on the review's customer items: none stored.
    jobReviewCustomerDecision: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({ id: 'decision-1' }),
    },
    timelineEvent: {
      create: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      // `delete` alongside `deleteMany` so a suite can make an in-memory activity feed honour
      // BOTH removals. comm-manual-log-audit.test.ts needs that: its delete case has to be able
      // to fail if an implementation ever erased the create's audit event alongside the entry.
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    stateTaxRate: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    // SRVW-114 slice 1 - org-defined custom field definitions.
    customFieldDefinition: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    // R5c (2026-07-22) - org-level tax rates. 2026-08-05: these became the authority for an org's
    // rates, so `findFirst` here is the first hop of every tax derivation (lib/tax/resolveTaxRate).
    orgTaxRate: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    appSetting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    priceBookCategory: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    priceBookItem: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    estimateSendConfig: {
      create: vi.fn(),
      update: vi.fn(),
      // #2090 - the customer's own selection re-prices the deposit, and the send-time snapshot
      // every surface reads it off has to move with it. updateMany, not update: an estimate with
      // no send_config must be a no-op, never a throw.
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    estimateVersionSnapshot: {
      findMany: vi.fn().mockResolvedValue([]),
      // #2030 — the reader the snapshot has never had.
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    scopePreset: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    // ─── Entity-redesign new models (Phase 0 adds the mock surface; later phases use them) ───
    customerPhone: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    invoiceLineItem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    // ─── SERV10X-38: job-owned items (Task 3 — job-lines CRUD) ───
    jobLineItem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    refund: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    // Payments go-live slice 09: the dispute record (written only by the payment event reconciler).
    dispute: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    // Payments go-live P10: the files attached to a dispute's evidence (written only by the dispute evidence API).
    disputeEvidenceItem: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      count: vi.fn().mockResolvedValue(0),
    },
    // Payments go-live slice 11: "Payments needing attention" (written with every unapplied capture).
    unappliedCapture: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    credit: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      aggregate: vi.fn(),
    },
    depositCreditApplication: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      aggregate: vi.fn(),
    },
    stripeEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    attachment: {
      // "No files" by default (visits-and-task-categories slice 12): deleting a task now purges its
      // attachments and the task list counts them, so every task suite reaches this delegate.
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    invoice: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    payment: {
      // Roles & Permissions S08.10 - a record's Communication tab reads the payments it shows as entries; none by default.
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    // ─── Service Plans models (service-plans feature OWNS these) ───
    servicePlan: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    servicePlanLineItem: {
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    // ─── Service-plan materials template (LO-5) — mirrors servicePlanLineItem ───
    servicePlanMaterialLine: {
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    planVisit: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    servicePlanTemplate: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    servicePlanTemplateLineItem: {
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({
        estimate_terms: 'Test terms.',
        estimate_notes: '- Test note',
        estimate_payment_terms: '- 70% on acceptance',
      }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      // Task 1.5 — race-safe stripe_account_id claim (connectStripe).
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    userTablePreference: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    // ─── Per-user permission overrides (RBAC Phase 2) ───
    // findMany defaults to [] so every request that merges overrides sees "none" by default.
    // ─── Roles & Permissions switch store (M2) ───
    // findMany defaults to [] so every request that resolves a person's switches sees "no stored
    // values" and falls back to the built-in preset of the role. helpers.mockAuthAs re-establishes it.
    permissionRoleSwitch: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
    },
    permissionUserSwitch: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    permissionChangeLog: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn(),
    },
    // ─── Inventory models (Phase 1 OWNS these — later phases reference, never re-add) ───
    brand: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    // findMany defaults to [] so suites that never touch the new catalog dropdowns
    // are unaffected — the item dialog's option lists simply come back empty.
    finish: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    uomOption: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    vendor: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    // Vendor categories (Purchasing Audit Verdict PR 4). `create` echoes its
    // data under a fixed id so the many suites that post `{ name, category }`
    // for a vendor keep working without caring that the name now resolves to
    // a row; the category suite overrides these per test.
    vendorCategory: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: 'a1000000-0000-4000-8000-00000000c001', ...args.data })),
      update: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    vendorContact: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    branch: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    inventoryLocation: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    stockBalance: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
    stockMovement: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
    purchaseOrder: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    purchaseOrderLine: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    // updateMany added for the editable-record-ids job-rename label cascade
    // (record-renumber.ts refreshes rfqs.job_number in one batched write).
    rfq: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    rfqLine: { create: vi.fn(), deleteMany: vi.fn() },
    rfqQuote: { create: vi.fn(), deleteMany: vi.fn() },
    estimateReservation: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    reservationLine: { create: vi.fn(), deleteMany: vi.fn() },
    inventoryEmail: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    jobStage: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    jobStageLine: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    jobStageAttachment: { findFirst: vi.fn(), create: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    stageAuditEntry: { create: vi.fn(), deleteMany: vi.fn() },
    stockApproval: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    // ─── Logistic Orders (LO-1 schema / LO-2 engine) ───
    // findMany defaults to [] so the pre-tx anchored-LO unwind (collectAnchoredLoUnwind, called by
    // job cancel/delete + invoice void/delete) finds no LOs by default — every pre-LO document-verb
    // test then no-ops the unwind without needing logisticOrder delegates in its tx proxy.
    logisticOrder: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    logisticOrderLine: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn() },
    stockApprovalModification: { create: vi.fn(), deleteMany: vi.fn() },
    itemGroup: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    itemGroupLine: { create: vi.fn(), deleteMany: vi.fn() },
    // ─── Inventory P4: company-tool assets (Asset + append-only AssetEvent ledger) ───
    asset: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    assetEvent: { findMany: vi.fn(), create: vi.fn() },
    // ─── Communication models (Phase 2 OWNS these — later phases reference, never re-add) ───
    callSession: {
      findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(),
    },
    // Manual Communication Log - hand-typed records of conversations that happened off-platform.
    // `findMany` defaults to [] because the three comm aggregators now query this source on every
    // timeline read: without the default, every suite that renders a lead/job/customer timeline
    // and never heard of this table would get `undefined` back and 500.
    manualCommunicationLog: {
      findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
    },
    ctmEvent: {
      findUnique: vi.fn(), create: vi.fn(),
    },
    // Email slice 4 — Resend delivery webhook idempotency ledger, mirrors ctmEvent.
    resendEvent: {
      findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(),
    },
    // Email slice 4 — global TRANSACTIONAL suppression list. findFirst defaults to
    // null ("nothing suppressed") so every OTHER suite that reaches the real
    // dispatchEmail via vi.importActual (email-dispatch.test.ts, email-org-toggle.test.ts, …)
    // sees unchanged pre-slice-4 behavior unless it explicitly overrides this.
    emailSuppression: {
      findFirst: vi.fn().mockResolvedValue(null), upsert: vi.fn(),
    },
    phoneNumber: {
      findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn().mockResolvedValue(0),
    },
    // `findMany` defaults to [] because `resolveServWavePhones` (the ServWave merge fields) now
    // reads this table on every automation bundle load and on every visit-scoped dispatch: without
    // the default, every suite that books, moves or starts a visit and never heard of this table
    // would get `undefined` back and be answered from the resolver's own catch instead - green,
    // and blind to a malformed read. Same idiom as logisticOrder.findMany above.
    userPhoneNumber: {
      findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn().mockResolvedValue(0),
    },
    pendingCallAttribution: {
      // findMany added for the editable-record-ids job-rename label cascade
      // (record-renumber.ts reads every FK-linked/orphaned row before refreshing job_label).
      // upsert: the external call-tracking pre-call stash (idempotent on provider + vendor id).
      findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(),
    },
    // External call-tracking receiver: one row per (org, provider) holding the URL token + key.
    callTrackingIntegration: {
      findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(),
    },
    // Web-form receiver: one row per (org, provider) holding the URL token, plus the
    // submission ledger it claims against (unique on organization_id + provider +
    // submission_key: the vendor's entry id is a PER-SITE counter, so the org leads
    // the key).
    webFormIntegration: {
      findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn(),
    },
    webFormSubmission: {
      findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn(),
    },
    contact: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn(),
    },
    channelIdentity: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn(),
    },
    phoneAgent: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(),
    },
    // findMany defaults to [] so the blocked-list probe ingest now runs on every
    // live inbound activity (findBlockedNumber, lib/communication/blockedNumbers.ts)
    // has an array to scan - without a default every ingest-reaching suite would
    // throw on `.find()` of undefined. Same idiom as logisticOrder.findMany above.
    blockedNumber: {
      findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn(),
    },
    messageThread: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), aggregate: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(),
    },
    // #2049 - per-user read state for SMS threads (mirrors emailReadState
    // below). findMany defaults to [] so a listThreads/getThread/unread-counts
    // call that does not itself care about read state does not need to stub
    // this to avoid an undefined `.map`/`.filter` crash (R2 - the controller
    // reads the result defensively too, `(rows ?? [])`, so an unmocked call in
    // some other suite degrades to "no marker", never a TypeError).
    messageThreadReadState: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    // S08.6 - findMany defaults to [] because the text scope reads the conversations a person has sent in (reply
    // attribution) on every "Linked to me" read, so a suite that does not care about it needs no stub.
    message: {
      findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
    },
    textTemplate: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn(),
    },
    textAutomation: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn(),
    },
    whatsAppChat: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), aggregate: vi.fn(), deleteMany: vi.fn(),
    },
    whatsAppMessage: {
      findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(),
    },
    // #2049 slice 2 - per-user read state for WhatsApp chats (mirrors
    // messageThreadReadState above). findMany defaults to [] so a
    // listWhatsAppChats/getWhatsAppChat/unread-counts call that does not
    // itself care about read state does not need to stub this.
    whatsAppChatReadState: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    email: {
      findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), count: vi.fn(), deleteMany: vi.fn(),
    },
    // Email slice 7 - real files attached to a human-composed send.
    emailAttachment: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn(),
    },
    // Email slice 8b - per-conversation workflow state (assignee, shared
    // snooze, archive). findFirst defaults to null so a reply that supplies a
    // thread_id which resolves to nothing just falls back to a fresh thread
    // rather than every non-reply-path test needing to stub this. `create`
    // defaults to a real-shaped row (every existing sendEmail test composes
    // fresh, so every one of them now also creates a thread) so only tests
    // that actually care about the created thread's shape need to override it.
    emailThread: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      // PRD 10 (S10.7): M11 asks which record conversations a person reaches, so every email read lists conversations.
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'default-thread-id',
          assigned_to_user_id: args?.data?.assigned_to_user_id ?? null,
          snoozed_until: null,
          archived: false,
          organization_id: args?.data?.organization_id,
        })),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    // PRD 10 (S10.4) - every email conversation is placed in a mailbox. findFirst defaults to a mailbox every
    // company and person has (S10.1), so a send path that opens a conversation finds one without every test
    // stubbing it. It is shaped as BOTH the company's main mailbox (an id) and a person's own mailbox with an
    // address (S10.11: a hand-written email goes out from the sender's own address, and a person without one is
    // refused), so a suite that sends mail needs no setup; the ones about "address needed" stub their own.
    mailbox: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'main-mailbox-id',
        status: 'active',
        addresses: [{ local_part: 'jane.smith.acme' }],
        user: { first_name: 'Jane', last_name: 'Smith' },
        organization: { name: 'Acme' },
      }),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    // Email slice 6 - reply tokens (<token>@reply.servwave.com -> thread).
    // findFirst defaults to null so the minting helper's "reuse a live token"
    // lookup misses and mints a fresh one, which is what every send-path test
    // that doesn't care about token reuse should see. findUnique has NO default
    // (undefined would be a silent pass through resolveReplyToken's null gate);
    // tests that resolve a token stub it explicitly.
    replyToken: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...(args?.data ?? {}) })),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    // Email slice 8c - per-user read state (replaces the shared Email.unread
    // column as the source of truth). findMany defaults to [] so a listEmails/
    // getEmail call that doesn't itself care about read state doesn't need to
    // stub this to avoid an undefined `.map`/`.some` crash.
    emailReadState: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn(),
    },
    emailGroup: {
      findMany: vi.fn(),
    },
    emailForwardRule: {
      findMany: vi.fn(),
    },
    callFlow: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
    },
    callGroup: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(),
    },
    trainingScenario: {
      findMany: vi.fn(), findFirst: vi.fn(),
    },
    trainingSession: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(),
    },
    // ─── Copilot (Servy) models ───
    copilotConversation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    copilotMessage: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    copilotAuditEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    // ─── Timeclock models ───
    timeEntry: {
      findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(),
    },
    geofenceConfig: {
      findUnique: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn(),
    },
    geofenceStore: {
      findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(),
    },
    timeClockOtReview: {
      findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn(),
    },
    // ─── Email-OTP 2FA ───
    mfaEmailChallenge: {
      findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(),
      updateMany: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), count: vi.fn(),
    },
    // ─── Tasks (B1 model, B2 API) ───
    task: {
      // Defaults to "this org has no tasks", so an unstubbed findMany does not hand `undefined` to suites that
      // have nothing to do with tasks.
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      // task.controller.ts's update() moves a status with a compare-and-set (updateMany on the
      // status it read). A lone request wins its own claim; the race tests override this.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn(),
      // Slice 11 - the task-deletion service removes tasks in chunks, and the category list
      // counts each category's tasks with one grouped query.
      deleteMany: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn(),
    },
    // ─── Calendar Entries (Slice 02) ───
    calendarEntry: {
      // Slice 09 (schedule search) added a calendarEntry bucket to `scope=schedule` search,
      // reached by several pre-existing search-*.test.ts suites that run as an admin (passes
      // `can('read','CalendarEntry')` via `manage all`) but never mock this delegate. Without a
      // default, those calls resolve `undefined` and 500 — `safeQuery`'s own `?? []` hardening
      // is correct production defence, but a `[]` default here keeps that hardening PRODUCTION
      // -only: a future bucket with a forgotten mock elsewhere fails LOUDLY (undefined does not
      // shape-match), not silently as an empty list nobody notices. Matches the ~35 other
      // `findMany: vi.fn().mockResolvedValue([])` delegates already in this file.
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    calendarEntryParticipant: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      // Slice 07 - notified_at stamping on a successful customer email send.
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // Task categories (visits-and-task-categories slice 08). `findFirst` answers null by default,
    // so a suite that never set a category id is unaffected and one that sends an id it did not
    // stub is refused, never silently accepted.
    taskCategory: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      // Slice 09 - a new category goes to the end of the list (max sort_order + 1).
      aggregate: vi.fn(),
    },
    taskSubtask: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    // ─── In-app Notifications (Phase 1 OWNS these — later phases reference, never re-add) ───
    notification: {
      create: vi.fn(),
      createMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    notificationRecipient: {
      create: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn(),
    },
    // ─── Security/compliance audit trail (audit-logging feature OWNS these) ───
    auditLog: {
      create: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    // ─── Automation Center ───
    automationRule: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    automationRun: {
      create: vi.fn(),
      createMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    // ─── Workflow Builder (Automation Center v2) ───
    workflow: {
      create: vi.fn(),
      createMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn(),
    },
    workflowStep: {
      create: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    workflowVersion: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn(),
    },
    workflowEnrollment: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    workflowStepRun: {
      create: vi.fn(),
      createMany: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    $transaction: vi.fn(),
    // PRD 10 (S10.8): every Email request asks, in one raw read, whether the person reads the main mailbox; no rows = no main mailbox.
    $queryRaw: vi.fn().mockResolvedValue([]),
    $queryRawUnsafe: vi.fn(),
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
  },
}));
