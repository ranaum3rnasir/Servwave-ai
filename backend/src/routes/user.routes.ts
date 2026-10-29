import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { multerErrorHandler, megabytes } from '../middleware/multerErrors';
import { passwordChangeLimiter, passwordLinkLimiter, adminPasswordResetLimiter } from '../middleware/rate-limit';
import * as userController from '../controllers/user.controller';
import * as passwordResetController from '../controllers/password-reset.controller';
import * as avatarController from '../controllers/user-avatar.controller';
import { MAX_AVATAR_BYTES } from '../controllers/user-avatar.controller';

const router = Router();

// memoryStorage, image-only. Route-level limit sits ABOVE the handler's real 8MB cap so an
// oversized photo 400s with the handler's precise message instead of multer's own error.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Quotes the handler's 8MB cap, not the 10MB route ceiling: 8MB is the number a user is
// actually held to, and a file that trips multer here is over both. Worded impersonally
// ("A profile photo") because both avatar routes share it - /me/avatar sets your own,
// /:id/avatar is an admin setting someone else's.
const avatarMulterErrors = multerErrorHandler({
  tooLarge: `That image is too large to upload. A profile photo can be up to ${megabytes(MAX_AVATAR_BYTES)}.`,
});

// All user routes require authentication and ability attachment
router.use(authenticate, attachAbility);

// Self-service routes — MUST precede /:id so "me" isn't parsed as an id. No canDo: any
// authenticated user manages their own profile/password/avatar.
router.patch('/me', validate(userController.meUpdateSchema), userController.updateMe);
// Limited BEFORE validation so a malformed attempt counts too (password reset spec §4.2).
// A user with no password (Google-only) is refused before validation, with a message that says so.
router.post('/me/password', passwordChangeLimiter, userController.refuseWithoutPassword, validate(userController.changePasswordSchema), userController.changeMyPassword);
router.get('/me/password-status', userController.getMyPasswordStatus);
// "Set a password by email" (slice 06): the reset link goes to the caller's own address on file.
// Limited per user on every request (each one may send an email), before anything is looked up.
router.post('/me/password/email-link', passwordLinkLimiter, passwordResetController.sendMyPasswordLink);
// `withOrgContext` MUST come AFTER multer — multer's stream consumption drives the
// continuation outside authenticate's AsyncLocalStorage org scope (withOrgContext.ts).
router.post('/me/avatar', avatarUpload.single('file'), avatarMulterErrors, withOrgContext, avatarController.setAvatar);
router.delete('/me/avatar', avatarController.deleteAvatar);

/**
 * The ASSIGNEE PICKER's roster (scoped assignee pool, slice 3). Who this requester may put on a
 * piece of work — id, name, role, department, avatar, and nothing else.
 *
 * NO `canDo`, AND THAT IS THE POINT. `GET /` below is gated on `read User`, which DEFAULT_GRANTS
 * gives to DISPATCHER and TECHNICIAN only. A salesperson scheduling a walkthrough on their own
 * lead therefore 403'd on the roster and saw an empty, disabled picker. This route is reachable by
 * any authenticated session and does its gating in the handler, where `?purpose=` is readable.
 * A POOL-GOVERNED purpose (`jobCrew`, `walkthroughPerformer`, `task`) is answered by
 * `resolveAssigneePoolForRequest` — `org` for a holder of that purpose's grant, `self` for
 * everyone else — and the `directory` purpose, which names a people list no pool rule governs, is
 * answered by `read User` instead, which is what gated those surfaces before this route existed.
 * Either way a non-holder's whole response is their own row. See the handler's docblock.
 *
 * DECLARED BEFORE `/:id`, and that ordering is load-bearing. Express matches in declaration order,
 * so `/:id` would otherwise swallow `assignable`, hand it to a handler gated on `read User`, and
 * answer 403 — the exact symptom this route was built to remove, from a route that looks fine.
 */
router.get('/assignable', userController.listAssignable);

router.get('/', canDo('read', 'User'), userController.list);
router.post('/', canDo('create', 'User'), validate(userController.createUserSchema), userController.create);
router.post('/invite', canDo('create', 'User'), validate(userController.inviteUserSchema), userController.inviteUser);
router.post('/:id/invite', canDo('create', 'User'), userController.invite);
router.post('/:id/revoke-login', canDo('update', 'User'), userController.revokeLogin);
// "Send password reset" (password reset spec §7, slice 07): emails the person the same reset link as
// "Forgot password?". Edit users; limited per admin on every request; the target is org-scoped.
// A malformed :id answers the handler's own 404 before Prisma runs (P2023 screen), after canDo so a
// caller without the grant still gets 403.
router.post('/:id/password-reset', canDo('update', 'User'), adminPasswordResetLimiter, requireUuidParam('id', 'User not found'), passwordResetController.sendUserPasswordReset);
// Per-user permission overrides (RBAC Phase 2). Managing a user's permissions is an admin
// action → both gated on `update User` (read User alone, e.g. a dispatcher, is not enough).
router.get('/:id/permissions', canDo('update', 'User'), userController.getPermissions);
router.put('/:id/permissions', canDo('update', 'User'), validate(userController.putPermissionsSchema), userController.putPermissions);
router.get('/:id', canDo('read', 'User'), userController.getById);
router.patch('/:id', canDo('update', 'User'), validate(userController.updateUserSchema), userController.update);
router.delete('/:id', canDo('delete', 'User'), userController.deactivate);
router.delete('/:id/permanent', canDo('delete', 'User'), userController.permanentDelete);
router.post('/:id/mfa/reset', canDo('delete', 'User'), userController.resetMfa);
router.post('/:id/avatar', canDo('update', 'User'), avatarUpload.single('file'), avatarMulterErrors, withOrgContext, avatarController.setAvatar);
router.delete('/:id/avatar', canDo('update', 'User'), avatarController.deleteAvatar);

export default router;
