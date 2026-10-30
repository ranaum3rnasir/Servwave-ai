import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo, canSetRoleFields } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import { withOrgContext } from '../middleware/withOrgContext';
import { requireFeature } from '../middleware/requireFeature';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { multerErrorHandler, megabytes } from '../middleware/multerErrors';
import { passwordChangeLimiter, passwordLinkLimiter, adminPasswordResetLimiter } from '../middleware/rate-limit';
import * as userController from '../controllers/user.controller';
import * as passwordResetController from '../controllers/password-reset.controller';
import * as permissionController from '../controllers/user-permission.controller';
import * as userMailboxController from '../controllers/user-mailbox.controller';
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
// A direct create needs Create users; an invite and a resend need Invite users (S01.12). Naming a role on a create,
// an invite or an update needs Manage roles and permissions on top.
router.post('/', canDo('create', 'User'), canSetRoleFields(), validate(userController.createUserSchema), userController.create);
router.post('/invite', canDo('invite', 'User'), canSetRoleFields(), validate(userController.inviteUserSchema), userController.inviteUser);
router.post('/:id/invite', canDo('invite', 'User'), userController.invite);
router.post('/:id/revoke-login', canDo('update', 'User'), userController.revokeLogin);
// "Send password reset" (password reset spec §7, slice 07): emails the person the same reset link as
// "Forgot password?". Edit users; limited per admin on every request; the target is org-scoped.
// A malformed :id answers the handler's own 404 before Prisma runs (P2023 screen), after canDo so a
// caller without the grant still gets 403.
router.post('/:id/password-reset', canDo('update', 'User'), adminPasswordResetLimiter, requireUuidParam('id', 'User not found'), passwordResetController.sendUserPasswordReset);
// A person's switches (S01.20): every read and write needs Manage roles and permissions; nobody writes their own set.
router.get('/:id/permissions', canDo('manage_roles', 'Role'), permissionController.getPersonSwitches);
router.put('/:id/permissions', canDo('manage_roles', 'Role'), validate(permissionController.putPersonSwitchesSchema), permissionController.putPersonSwitches);
router.post('/:id/permissions/reset', canDo('manage_roles', 'Role'), validate(permissionController.resetPersonSwitchesSchema), permissionController.resetPersonSwitchValues);
router.post('/:id/permissions/save-as-role', canDo('manage_roles', 'Role'), validate(permissionController.saveAsRoleSchema), permissionController.saveSwitchesAsNewRole);
router.get('/:id/permissions/change-log', canDo('manage_roles', 'Role'), permissionController.getPersonChangeLog);
router.get('/:id', canDo('read', 'User'), userController.getById);
router.patch('/:id', canDo('update', 'User'), canSetRoleFields(), validate(userController.updateUserSchema), userController.update);
// Deactivating is an Edit users action on every path (this one and the is_active field above); Delete users is only
// the permanent delete and the two-step login reset (S01.12).
// A user's mailbox address (PRD 10, S10.25): the name part only, under Edit users and the Email plan feature. The
// sign-in email is a different thing and is never changed here.
router.put('/:id/mailbox-address', requireFeature('email'), canDo('update', 'User'), validate(userMailboxController.setMailboxAddressSchema), userMailboxController.setMailboxAddress);
// A leaver's mailbox handed on later, to another person or to the main mailbox (S10.22): Edit users and the Email plan feature.
router.put('/:id/mailbox-handover', requireFeature('email'), canDo('update', 'User'), validate(userMailboxController.moveMailboxSchema), userMailboxController.moveUserMailbox);
router.delete('/:id', canDo('update', 'User'), validate(userController.deactivateUserSchema), userController.deactivate);
router.delete('/:id/permanent', canDo('delete', 'User'), userController.permanentDelete);
router.post('/:id/mfa/reset', canDo('delete', 'User'), userController.resetMfa);
router.post('/:id/avatar', canDo('update', 'User'), avatarUpload.single('file'), avatarMulterErrors, withOrgContext, avatarController.setAvatar);
router.delete('/:id/avatar', canDo('update', 'User'), avatarController.deleteAvatar);

export default router;
