import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo, requireAdmin } from '../middleware/canGuard';
import { requireOwner } from '../lib/users/owner';
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
// Managing people is an Admin's alone (AL-18): adding, inviting, changing (a role included), deactivating, deleting and
// erasing a person, their switches, their mailbox, their sign-in and their password reset all check the Admin flag, never
// a switch. Only the two reads above and below follow View users, for names in pickers and on records.
router.post('/', requireAdmin, validate(userController.createUserSchema), userController.create);
router.post('/invite', requireAdmin, validate(userController.inviteUserSchema), userController.inviteUser);
router.post('/:id/invite', requireAdmin, userController.invite);
router.post('/:id/revoke-login', requireAdmin, userController.revokeLogin);
// "Send password reset" (password reset spec §7, slice 07): emails the person the same reset link as
// "Forgot password?". Limited per admin on every request; the target is org-scoped.
// A malformed :id answers the handler's own 404 before Prisma runs (P2023 screen), after the Admin check so a
// non-Admin still gets 403.
router.post('/:id/password-reset', requireAdmin, adminPasswordResetLimiter, requireUuidParam('id', 'User not found'), passwordResetController.sendUserPasswordReset);
// Make Owner (ticket 27, D1): the Owner's alone, whoever the target is. It only emails the Owner an approval link; ownership
// moves when that link is opened (POST /api/auth/owner-approval/approve).
router.post('/:id/make-owner', requireOwner, userController.requestMakeOwner);
// A person's switches (S01.20): every read and write is an Admin's; nobody writes their own set.
router.get('/:id/permissions', requireAdmin, permissionController.getPersonSwitches);
router.put('/:id/permissions', requireAdmin, validate(permissionController.putPersonSwitchesSchema), permissionController.putPersonSwitches);
router.post('/:id/permissions/reset', requireAdmin, validate(permissionController.resetPersonSwitchesSchema), permissionController.resetPersonSwitchValues);
router.post('/:id/permissions/save-as-role', requireAdmin, validate(permissionController.saveAsRoleSchema), permissionController.saveSwitchesAsNewRole);
router.get('/:id/permissions/change-log', requireAdmin, permissionController.getPersonChangeLog);
// Deactivating changes no record (P19). What the person still has open is read here, and moving it to someone else is an
// optional, Admin-only step.
router.get('/:id/deactivation-summary', requireAdmin, userController.deactivationSummary);
router.post('/:id/reassign', requireAdmin, validate(userController.reassignOpenSchema), userController.reassignOpen);
router.get('/:id', canDo('read', 'User'), userController.getById);
router.patch('/:id', requireAdmin, validate(userController.updateUserSchema), userController.update);
// A user's mailbox address (PRD 10, S10.25): the name part only, under the Email plan feature. The sign-in email is a
// different thing and is never changed here.
router.put('/:id/mailbox-address', requireAdmin, requireFeature('email'), validate(userMailboxController.setMailboxAddressSchema), userMailboxController.setMailboxAddress);
// A leaver's mailbox handed on later, to another person or to the main mailbox (S10.22), under the Email plan feature.
router.put('/:id/mailbox-handover', requireAdmin, requireFeature('email'), validate(userMailboxController.moveMailboxSchema), userMailboxController.moveUserMailbox);
// Deactivating (this path or the is_active field above); the permanent delete; the two-step login reset.
router.delete('/:id', requireAdmin, validate(userController.deactivateUserSchema), userController.deactivate);
router.delete('/:id/permanent', requireAdmin, userController.permanentDelete);
// Erasing a deactivated person's personal data keeps the row and every link to it (P19); an Admin's action, never a delete.
router.post('/:id/erase-personal-data', requireAdmin, userController.erasePersonalData);
router.post('/:id/mfa/reset', requireAdmin, userController.resetMfa);
router.post('/:id/avatar', requireAdmin, avatarUpload.single('file'), avatarMulterErrors, withOrgContext, avatarController.setAvatar);
router.delete('/:id/avatar', requireAdmin, avatarController.deleteAvatar);

export default router;
