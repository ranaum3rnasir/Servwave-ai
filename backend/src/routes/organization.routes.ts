import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { expensiveLimiter } from '../middleware/rate-limit';
import { withOrgContext } from '../middleware/withOrgContext';
import { multerErrorHandler, megabytes } from '../middleware/multerErrors';
import * as orgController from '../controllers/organization.controller';
import { MAX_LOGO_BYTES } from '../controllers/organization.controller';
import * as orgCtmController from '../controllers/organization-ctm.controller';
import * as orgStripeController from '../controllers/organization-stripe.controller';

const router = Router();

// The tightest upload cap in the app, and the clearest reason these handlers are per-route
// rather than one global one: a shared handler quoting the attachment surface's 50MB would
// tell an admin their 3MB logo was fine moments after refusing it.
const logoMulterErrors = multerErrorHandler({
  tooLarge: `That image is too large to upload. Your company logo can be up to ${megabytes(MAX_LOGO_BYTES)}.`,
});

router.get('/', authenticate, attachAbility, canDo('read', 'Organization'), orgController.getOrganization);
// #110 — preview is a read-level action (the Branding page renders at `read`).
// Write actions on the page stay `update`-gated below.
router.get('/preview-pdf', authenticate, attachAbility, expensiveLimiter, canDo('read', 'Organization'), orgController.previewPdf);
router.patch('/', authenticate, attachAbility, canDo('update', 'Organization'), validate(orgController.patchOrgSchema), orgController.updateOrganization);
// `withOrgContext` re-establishes the org AsyncLocalStorage scope that multer's
// stream consumption drops (see middleware/withOrgContext.ts).
// The org's own local part for its business From address (the string before
// the `@`). The domain half is never an org choice - sending is in-house on
// the one shared platform domain - so this is the whole of the sending-address
// surface. ADMIN-only: it changes the address every customer of the org sees.
router.patch('/email-sender', authenticate, attachAbility, canDo('update', 'Organization'), validate(orgController.emailSenderSchema), orgController.updateEmailSender);

router.post('/logo', authenticate, attachAbility, canDo('update', 'Organization'), orgController.upload.single('file'), logoMulterErrors, withOrgContext, orgController.uploadLogo);

// ─── Phone service (CTM) phone/SMS integration (self-org; ADMIN via the update-Organization grant) ───
// The browser-facing paths carry ServWave's own name, never the vendor's.
router.post('/phone/connect', authenticate, attachAbility, canDo('update', 'Organization'), validate(orgCtmController.connectCtmSchema), orgCtmController.connectCtm);
router.post('/phone/check-texting-approval', authenticate, attachAbility, canDo('update', 'Organization'), orgCtmController.checkCtmA2p);
router.post('/phone/disconnect', authenticate, attachAbility, canDo('update', 'Organization'), orgCtmController.disconnectCtm);
// TODO(phone-api-neutral-names): deprecated aliases of the three routes above,
// kept one release for support scripts and a browser still on an old bundle.
// Same guards, same handlers. Remove once nothing calls them.
router.post('/connect-ctm', authenticate, attachAbility, canDo('update', 'Organization'), validate(orgCtmController.connectCtmSchema), orgCtmController.connectCtm);
router.post('/connect-ctm/check-a2p', authenticate, attachAbility, canDo('update', 'Organization'), orgCtmController.checkCtmA2p);
router.post('/disconnect-ctm', authenticate, attachAbility, canDo('update', 'Organization'), orgCtmController.disconnectCtm);

// ─── ServWave Payments (Stripe Connect; self-org, ADMIN via update-Organization) ───
router.post('/stripe/connect', authenticate, attachAbility, canDo('update', 'Organization'), orgStripeController.connectStripe);
router.post('/stripe/account-session', authenticate, attachAbility, canDo('update', 'Organization'), orgStripeController.createStripeAccountSession);
router.post('/stripe/account-link', authenticate, attachAbility, canDo('update', 'Organization'), orgStripeController.createStripeAccountLink);
router.post('/stripe/accept-terms', authenticate, attachAbility, canDo('update', 'Organization'), validate(orgStripeController.acceptPaymentsTermsSchema), orgStripeController.acceptPaymentsTerms);
router.patch('/stripe/statement-descriptor', authenticate, attachAbility, canDo('update', 'Organization'), validate(orgStripeController.updateDescriptorSchema), orgStripeController.updateStatementDescriptor);
router.get('/stripe/status', authenticate, attachAbility, canDo('read', 'Organization'), orgStripeController.getStripeStatus);

export default router;
