import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo, canDoAny, requireAdminTo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { requireFeature } from '../middleware/requireFeature';
import { expensiveLimiter } from '../middleware/rate-limit';
import { withOrgContext } from '../middleware/withOrgContext';
import { multerErrorHandler, megabytes } from '../middleware/multerErrors';
import * as orgController from '../controllers/organization.controller';
import { MAX_LOGO_BYTES } from '../controllers/organization.controller';
import * as mainMailboxReadersController from '../controllers/main-mailbox-readers.controller';
import * as orgCtmController from '../controllers/organization-ctm.controller';
import * as orgStripeController from '../controllers/organization-stripe.controller';

const router = Router();

// The tightest upload cap in the app, and the clearest reason these handlers are per-route
// rather than one global one: a shared handler quoting the attachment surface's 50MB would
// tell an admin their 3MB logo was fine moments after refusing it.
const logoMulterErrors = multerErrorHandler({
  tooLarge: `That image is too large to upload. Your company logo can be up to ${megabytes(MAX_LOGO_BYTES)}.`,
});

// Reference data: the company name and preferences, job types, job sources and accepted payment methods are what every
// form fills from, so they are readable by every signed-in person with no switch. Editing them is the Admin flag's alone
// (36b, M17: the Company settings switch retired), checked by `requireAdminTo` on each route below.
router.get('/', authenticate, attachAbility, orgController.getOrganization);
// #110 — preview is a read-level action (the Branding page renders at `read`).
// The page's write actions are the Admin flag's alone (`requireAdminTo`, below).
router.get('/preview-pdf', authenticate, attachAbility, expensiveLimiter, canDo('read', 'Organization'), orgController.previewPdf);
// The company form, payment instructions included, is an Admin's alone.
router.patch('/', authenticate, attachAbility, requireAdminTo('change company settings'), validate(orgController.patchOrgSchema), orgController.updateOrganization);
// `withOrgContext` re-establishes the org AsyncLocalStorage scope that multer's
// stream consumption drops (see middleware/withOrgContext.ts).
// The org's own local part for its business From address (the string before
// the `@`). The domain half is never an org choice - sending is in-house on
// the one shared platform domain - so this is the whole of the sending-address
// surface. Admin only, behind the Email plan feature: it changes the address every customer of the org sees
// and, with it, every person's own address (S10.26).
router.get('/email-sender', authenticate, attachAbility, requireFeature('email'), requireAdminTo('change company settings'), orgController.getEmailSender);
router.patch('/email-sender', authenticate, attachAbility, requireFeature('email'), requireAdminTo('change company settings'), validate(orgController.emailSenderSchema), orgController.updateEmailSender);

// The people who read the main mailbox (PRD 10, S10.8): the Sender Address page's list. Admin only, behind the Email plan
// feature, like the page. `candidates` is declared before `:userId` so the word is never read as a person.
router.get('/email-sender/readers', authenticate, attachAbility, requireFeature('email'), requireAdminTo('change company settings'), mainMailboxReadersController.listReaders);
router.get('/email-sender/readers/candidates', authenticate, attachAbility, requireFeature('email'), requireAdminTo('change who reads the main mailbox'), mainMailboxReadersController.listReaderCandidates);
router.put('/email-sender/readers/:userId', authenticate, attachAbility, requireFeature('email'), requireAdminTo('change who reads the main mailbox'), mainMailboxReadersController.addReader);
router.delete('/email-sender/readers/:userId', authenticate, attachAbility, requireFeature('email'), requireAdminTo('change who reads the main mailbox'), mainMailboxReadersController.removeReader);

router.post('/logo', authenticate, attachAbility, requireAdminTo('change company settings'), orgController.upload.single('file'), logoMulterErrors, withOrgContext, orgController.uploadLogo);

// ─── Phone service (CTM) phone/SMS integration (self-org; an Admin's alone, M8 / D3) ───
// The browser-facing paths carry ServWave's own name, never the vendor's.
router.post('/phone/connect', authenticate, attachAbility, requireAdminTo('change the phone service'), validate(orgCtmController.connectCtmSchema), orgCtmController.connectCtm);
router.post('/phone/check-texting-approval', authenticate, attachAbility, requireAdminTo('change the phone service'), orgCtmController.checkCtmA2p);
router.post('/phone/disconnect', authenticate, attachAbility, requireAdminTo('change the phone service'), orgCtmController.disconnectCtm);
// TODO(phone-api-neutral-names): deprecated aliases of the three routes above,
// kept one release for support scripts and a browser still on an old bundle.
// Same guards, same handlers. Remove once nothing calls them.
router.post('/connect-ctm', authenticate, attachAbility, requireAdminTo('change the phone service'), validate(orgCtmController.connectCtmSchema), orgCtmController.connectCtm);
router.post('/connect-ctm/check-a2p', authenticate, attachAbility, requireAdminTo('change the phone service'), orgCtmController.checkCtmA2p);
router.post('/disconnect-ctm', authenticate, attachAbility, requireAdminTo('change the phone service'), orgCtmController.disconnectCtm);

// ─── ServWave Payments (Stripe Connect; self-org; the payments switches, and the Admin flag) ───
router.post('/stripe/connect', authenticate, attachAbility, canDo('manage_payout_account', 'Organization'), orgStripeController.connectStripe);
// Per-surface permission lives in the controller: the owner surface needs Manage payout account, the viewer surface View payments and payouts.
router.post('/stripe/account-session', authenticate, attachAbility, orgStripeController.createStripeAccountSession);
router.post('/stripe/account-link', authenticate, attachAbility, canDo('manage_payout_account', 'Organization'), orgStripeController.createStripeAccountLink);
router.post('/stripe/accept-terms', authenticate, attachAbility, canDo('manage_payout_account', 'Organization'), validate(orgStripeController.acceptPaymentsTermsSchema), orgStripeController.acceptPaymentsTerms);
router.get('/stripe/statement-descriptor', authenticate, attachAbility, canDo('manage_payout_account', 'Organization'), orgStripeController.getStatementDescriptor);
// Both payments screens read this (the Payments area and the payout account page), so either payments switch opens it (and the
// Admin flag opens everything). The company read every signed-in person holds is deliberately not an arm: the payments status
// is not company-name-level data.
router.get('/stripe/status', authenticate, attachAbility, canDoAny([['view_payments', 'Organization'], ['manage_payout_account', 'Organization']]), orgStripeController.getStripeStatus);
// Same two doors as the status read it answers with: finishing the embedded form (Manage payout account) calls this.
router.post('/stripe/refresh-status', authenticate, attachAbility, canDoAny([['manage_payout_account', 'Organization']]), orgStripeController.refreshStripeStatus);

export default router;
