# Password Reset, Forgot Password and Password Reveal — Spec

**Date:** 2026-10-25
**Issue:** #2866
**Status:** Decisions approved by Ran on 2026-10-25 (§9). Live tests done 2026-10-25 (§2.2) and the spec corrected to match. Ready for implementation; nothing is built yet.
**Scope:** a user managing their **own** password, plus an admin "Send password reset" action (§7).

---

## 1. Summary

| # | What | Today | This spec |
|---|---|---|---|
| A | Change your own password while signed in | Two separate screens. Live test: the Login & Security form changes the password but **shows no confirmation** and bypasses the server. A breached password is rejected with the provider's raw wording (§2.2). | One screen (Login & Security) on one server path; My Profile links to it (§4). |
| B | Forgot password (signed out) | **Does not exist.** No link on the login page, no reset email, no reset page. Confirmed live on staging and production. | New "Forgot password?" flow. The email is sent by ServWave, not by the auth provider's mailer (§5). |
| C | Show/hide password ("eye") | Does not exist. | Animated eye toggle on the login page and every other password field (§6). |
| D | Admin helps a locked-out employee | No in-app way; only the auth dashboard or a broken script. | "Send password reset" action on Users & Teams, sending the same email (§7). |

The reported symptom, "no reset link is sent", is explained by B: nothing in the product ever asks for a link.

---

## 2. Evidence

### 2.1 Code (reviewed 2026-10-24/25 on `main` at `836fc54`)

1. **No forgot-password entry point.**
   - `frontend/src/pages/v2/auth-public/LoginPage.tsx` (the live login page) offers only email + password, Google, and the email-code step.
   - `frontend/src/pages/v2/routes/auth-public.routes.tsx` has no forgot or reset route.
2. **No reset email is ever requested.**
   - Nothing calls `resetPasswordForEmail`, recovery `generateLink` or `reauthenticate`, in either frontend or backend.
   - ServWave's own auth emails (invite, 2FA code) go through `backend/src/lib/email.ts`, not the auth provider's mailer. The provider's mailer is unused and probably not configured.
3. **A provider recovery link would not work even if one were sent.**
   - The browser client uses `detectSessionInUrl: true` (`frontend/src/lib/supabase.ts`).
   - `frontend/src/lib/auth-listener.ts` does not handle `PASSWORD_RECOVERY`.
   - The link would silently sign the user in, never ask for a new password, and skip the email-code 2FA gate. That gate only runs on `POST /api/auth/login`.
4. **The invite link cannot be reused as a reset.** `acceptInvite` returns 409 for an existing login, and the "Send invite" button only shows for users without a login.
5. **Two separate change-password implementations.**
   - *Settings › Login & Security* (`frontend/src/pages/v2/settings/SecurityPage.tsx`, `changePassword`) talks to the auth provider **from the browser**: `signInWithPassword`, then `updateUser`.
   - *Settings › My Profile* (`frontend/src/pages/v2/settings/MyProfilePage.tsx`) calls `POST /api/users/me/password`. The backend checks the current password and sets the new one with the admin API.
6. **Smaller defects found on the way:**
   - My Profile says "Google users can also set a password", but the form requires a current password that a Google-only user does not have.
   - `changeMyPassword` finds the user's login by paging through **every** auth user, up to 10,000 (`findSupabaseAuthIdByEmail`). The verified token already carries the auth id.
   - `backend/src/reset-tech-password.ts` passes the app user id where the auth id is needed, so it probably fails for invited users.
   - My Profile's `submitPassword` awaits `mutateAsync` without a catch, so a failed change also throws an unhandled promise rejection.

### 2.2 Live tests

**B. Forgot password — confirmed absent (2026-10-24).** `/login` loaded in Chromium on staging (`servwave-demo.vercel.app`) and production (`app.servwave.com`). Both show only Email, Password, **Sign In** and **Sign in with Google**. There is no "Forgot password?" link anywhere. A fake login returns "Invalid email or password" with no reset offer.

**A. Signed-in change: tested live on 2026-10-25.**

The test used the staging test user from the test org: an Admin (Owner), with no 2FA prompt. Production was explored read-only; no form was submitted there.

| Check | Production (read-only) | Staging |
|---|---|---|
| User menu | Name, email, clock-in, "Settings", "Sign Out". **No password item.** | Same |
| *My Profile* | "Change Password" card: Current, New, Confirm, **Update Password** | Same. **Not submitted** (see below) |
| *Login & Security* | "Change Password" card (`#sec-current-password`, `#sec-new-password`, `#sec-confirm-password`, **Update password**), plus the 2FA switches | Same, and submitted (results below) |
| *Users & Teams*, own row | Edit, Revoke login, Deactivate. The Edit dialog covers name and phone only. **No reset or send-link option.** | Same |
| `/forgot-password`, `/reset-password` | n/a | Both redirect to `/login`. The routes don't exist. |

**Login & Security › Change Password, original → temporary password:**
- **Requests:** `POST <auth>/token` 200 (re-check of the current password), then `PUT <auth>/user` 200. There was **no `/api/` call at all**, so the change was never audited, never notified, and never rate-limited.
- **The password did change.** A fresh login with the temporary password worked (`POST /api/auth/login` 200). The original password then failed (401).
- **The UI showed nothing.** No success message appeared; the test checked at 1.5 s and 5 s. The user cannot tell that it worked.
  - The code does render `"Password updated."` on success, and the error message did display (next block). So the cause is not yet known. Confirm it by hand during the build.
  - This alone is enough to make users think "password reset doesn't work".

**Login & Security, temporary password → back to the original:**
- **Requests:** `PUT <auth>/user` returned **422 `weak_password`, reason `pwned`**. The staging auth project has **leaked-password protection turned on**, and it rejected the original test password because that password appears in public breach lists.
- **The UI showed the provider's raw text:** "Password is known to be weak and easy to guess, please choose a different one."
- **Consequence: the test account was left on the temporary password** (see the open item at the end of this section).

**My Profile › Change Password: not run**, because the first round trip could not be undone.
- Code expectation: it calls `POST /api/users/me/password`. That runs `updateUserById`, which applies the same breached-password check. On failure, the backend currently returns the provider's raw `error.message` as a 400, and the card shows it in a "Password change failed" toast.

**Sign out (production):** `POST /api/auth/logout` 200. The browser's own sign-out call then gets 403 `session_not_found`, because the backend already revoked every session. This is harmless console noise and out of scope here.

**Conclusion for Part A:**
- The visible change-password form works for a user who knows their password, but it gives no confirmation and it skips the server.
- When the provider rejects a password, the user sees vendor wording.
- None of the signed-in screens offers a reset by email.

**Open item:** the staging test account has to be put back on a known, strong password, and `STAGING_TEST_PASSWORD` updated to match. Production is unaffected: staging and production use **separate** auth projects (confirmed from each site's loaded scripts), and nothing was submitted on production.

### 2.3 Auth provider settings

**Known:**
- Leaked-password protection is **on** in the staging auth project (§2.2). On production it is **unknown**; turn it on there too.
- Staging and production use separate auth projects.

**Not yet checked** (needs dashboard access):
- Whether the auth provider has custom SMTP configured. After §5 ships this stops mattering for resets.
- The auth provider's Site URL and redirect allow-list.
- The "Secure password change" and "Email OTP expiry" settings. §5 depends on the expiry setting.

---

## 3. Principles

1. **One server path for every password write.** The browser never calls the auth provider to set a password. All writes go through the backend, which audits, rate-limits and applies policy.
2. **ServWave sends ServWave's emails.** Reset emails go out through `backend/src/lib/email.ts`, branded like the invite. No vendor name appears in the email, the page, toasts or error text.
3. **A reset never signs anyone in.** After a reset, the user signs in normally, so the email-code 2FA gate still applies.
4. **Don't reveal whether an account exists.** The forgot-password response is identical for known and unknown emails.
5. **No password literals anywhere.** This includes tests that touch real accounts (`CLAUDE.md`).

---

## 4. Part A — Change your own password (signed in)

### 4.1 Behaviour
- **One form, on *Login & Security › Change Password*** (decision §9.1). It calls **`POST /api/users/me/password`**. Remove the browser-side `signInWithPassword` + `updateUser` from `SecurityPage.tsx`.
- *My Profile* drops its own password card. In its place is a short "Password" row, "Change your password in Login & Security", which links to `/settings/security`. Remove `useChangeMyPassword`'s second form, along with the duplicate-implementation notes in both files' docblocks.
- Fields: Current password, New password, Confirm new password, each with the eye toggle (§6).
- Validation, client and server: new password at least 8 characters, confirm must match, new must differ from current. Hint under New password: "At least 8 characters. Don't reuse a password from another site."
- **Breached password** (the provider's leaked-password check, on in staging per §2.2): show inline "This password has appeared in a known data breach, so it isn't safe to use. Choose a different one." **Never** show the provider's own wording.
- Success: an inline confirmation in the card **and** a toast: "Password updated. You've been signed out on your other devices." Both must actually appear; today the form changes the password silently (§2.2). Fields clear. The user stays signed in on this device; **all other sessions are signed out** (decision §9.2).
- Wrong current password: inline error "Current password is incorrect." No toast and no unhandled rejection.
- A user without a password (Google-only): show "You sign in with Google. To also sign in with a password, use **Set a password by email**". That button sends the §5 reset email to their own address. Do not show a current-password field they cannot fill.

### 4.2 Backend changes (`backend/src/controllers/user.controller.ts`)
- Resolve the auth id from the verified token. `verifyToken` in `backend/src/middleware/authenticate.ts` already holds `data.user.id` from `getUser(token)`. Expose it on the request (e.g. `req.user.auth_id`) and drop `findSupabaseAuthIdByEmail` from this path.
- Re-verify the current password on a **fresh, non-persisting client per request**, not the shared `supabaseAuth`.
- Reject `new === current` with 400 "Choose a password you haven't used here."
- After `updateUserById`, revoke the user's other sessions with `supabaseAdmin.auth.admin.signOut(<request JWT>, 'others')`. Then call `clearTokenCache(user.id)` so the 60 s identity cache can't keep a revoked session alive. `logout` already uses the same pattern with `'global'`. Keep the existing audit (`user.password_changed`) and notification emit.
- Apply `authLimiter` to `POST /me/password` (it has none today).
- **Map provider errors; never pass `error.message` through** (today line ~1115 returns it raw). A `weak_password` error (HTTP 422, code `weak_password`) becomes `422 { error: <breached-password copy from §4.1>, code: 'weak_password' }`. Any other provider error becomes `400 { error: 'We couldn't update your password. Try again or contact ServWave support.' }`, with the detail logged server-side only. Put this mapping in one helper and reuse it in §5.2 and §7.

### 4.3 Acceptance criteria
- **Given** a signed-in user on *My Profile*, **then** there is no password form, only a link to *Login & Security*.
- **Given** a signed-in password user on *Login & Security*, **when** they enter the correct current password and a valid new one, **then** they see the "Password updated" confirmation (inline and as a toast, still visible 5 s later), can sign out and sign in with the new password, and the old password fails. The network log shows `POST /api/users/me/password`, and no direct browser call to the auth provider.
- **Given** a new password that is in a known breach list, **then** they see the breached-password message in ServWave wording, and the password is unchanged.
- **Given** a wrong current password, **then** they see "Current password is incorrect." and the password is unchanged.
- **Given** a Google-only user, **then** no current-password form is shown, and "Set a password by email" sends the reset email.
- **Given** the user is signed in on two browsers, **when** they change the password in one, **then** the other is signed out on its next request.

---

## 5. Part B — Forgot password

### 5.1 User flow
1. `/login` shows a **"Forgot password?"** link under the Password label, right-aligned, keyboard-reachable. It carries the typed email over as `?email=`.
2. **`/forgot-password`** (public, same `AuthCard` layout):
   - Title "Reset your password". Email field, button "Send reset link", link "Back to sign in".
   - On submit, always show: "If an account exists for **{email}**, we've sent a link to reset your password. It expires in 1 hour. Check your spam folder if it doesn't arrive." Offer "Send again", available after 60 s.
3. The email, from the org's sender name and branded like the invite:
   - Subject: "Reset your ServWave password".
   - Body: "Hi {first name}, we received a request to reset the password for {email}." Button "Reset password". Then "This link expires in 1 hour and can be used once. If you didn't ask for this, you can ignore this email — your password won't change."
   - No vendor names.
4. **`/reset-password?token=…`** (public):
   - Title "Choose a new password". New password and Confirm, both with the eye toggle. Button "Update password".
   - Success: redirect to `/login?reset=1`, which shows "Your password was updated. Sign in with your new password."
   - Invalid, expired or used token: "This reset link is invalid or has expired." plus a button "Send a new link" (goes to `/forgot-password`).
   - Breached password: show the §4.1 message and let the user try another password **on the same page, without a new email** (see §5.2).

### 5.2 API (`backend/src/routes/auth.routes.ts`, `backend/src/controllers/auth.controller.ts`)
| Endpoint | Guards | Behaviour |
|---|---|---|
| `POST /api/auth/password/forgot` `{ email }` | `unscopedRequest`, `authLimiter`, plus a send limiter like `mfaResendLimiter` (per IP, and per email: at most 3 per 15 min) | Lower-case the email. Find an **active** app user with `has_login = true` and an auth account. If none, do nothing. If found, call `supabaseAdmin.auth.admin.generateLink({ type: 'recovery', email })` (this **does not** send an email), build `${FRONTEND_URL}/reset-password?token=<properties.hashed_token>`, and send via a new `sendPasswordResetEmail()` in `lib/email.ts`. **Always** return `200 { ok: true }` after a similar delay, whichever branch ran. Audit `user.password_reset_requested` when a user matched. |
| `POST /api/auth/password/reset` `{ token, password }` | `unscopedRequest`, `authLimiter` | Validate the password (at least 8). On a fresh non-persisting client, call `verifyOtp({ type: 'recovery', token_hash: token })`, which is single-use and expires per the provider. On failure, return `400 { error: 'This reset link is invalid or has expired.' }`. On success, `updateUserById(user.id, { password })`, then revoke **all** sessions for that user with `admin.signOut(<access_token from verifyOtp>, 'global')`. That also discards the session `verifyOtp` created. Then call `clearTokenCache` for the matching app user. Return `200`. Audit `user.password_reset`, emit `security.password_changed`. |

- **A rejected password must not burn the link.** `verifyOtp` uses the token up before `updateUserById` checks the new password. If `updateUserById` then fails with `weak_password`:
  - Call `generateLink({ type: 'recovery' })` again for the same user. This sends no email.
  - Return `422 { code: 'weak_password', error: <§4.1 copy>, token: <new hashed_token> }`. The page swaps in the new token and the user retries.
  - Only a caller who just presented a valid token gets the replacement, so this grants nothing new. Revoke the `verifyOtp` session in this branch too.
- **Token in the URL:** the link carries a hashed, single-use token. The reset page sends it in a POST body only, and `/reset-password` must not log the query string. Strip the token from the address bar on load with `history.replaceState`, so it doesn't sit in browser history.
- **Expiry:** governed by the provider's email OTP expiry. Set it to **3600 s**, the value the copy promises, on staging and production (§2.3).
- **Why not the provider's own `resetPasswordForEmail`:** it sends through the provider's mailer (unbranded, unconfigured, and showing a vendor domain), and its link lands in the browser as a silent sign-in (§2.1 item 3).

### 5.3 Frontend
- `frontend/src/pages/v2/auth-public/ForgotPasswordPage.tsx` and `ResetPasswordPage.tsx`, lazy-loaded.
- Register them in `auth-public.routes.tsx` and `auth-public.paths.ts`, public and outside `ProtectedRoute`, like `/accept-invite`.
- Add the link to `LoginPage.tsx`. Preserve `#email`, `#password` and both "Sign In" accessible names; `e2e/global-setup.ts` depends on them.
- `auth-listener.ts`: add a `PASSWORD_RECOVERY` case that signs the browser client out and routes to `/forgot-password`. This is a guard in case a provider-sent link ever reaches the app (e.g. someone uses the dashboard).

### 5.4 Acceptance criteria
- **Given** a signed-out user on `/login`, **when** they click "Forgot password?", **then** `/forgot-password` opens with their typed email filled in.
- **Given** a registered active user, **when** they request a link, **then** one email arrives from ServWave within a minute, and its link opens "Choose a new password".
- **Given** an unknown email, **then** the on-screen message and response are identical and no email is sent.
- **Given** a valid link, **when** they set a new password, **then** they land on `/login` with the success notice, the new password works, the old one fails, and 2FA (if enrolled) is still asked.
- **Given** a valid link, **when** the user picks a breached password, **then** they see the breached-password message, can choose another on the same page, and succeed without requesting a new email.
- **Given** a link that was already used or is over 1 hour old, **then** "This reset link is invalid or has expired." shows with "Send a new link".
- **Given** a fourth request for the same email within 15 minutes, **then** the UI message is unchanged and no email is sent.
- **Given** a deactivated user, or a user whose login was revoked, **then** no email is sent.

---

## 6. Part C — Password reveal (eye icon)

### 6.1 Component
- New `frontend/src/ui-kit/components/ui/passwordInput.tsx`. It wraps the kit `Input` and uses its existing `endIcon` slot (documented there as "clear, reveal, unit").
- The toggle is a real `<button type="button">`:
  - `aria-label` is "Show password" or "Hide password".
  - `aria-pressed` reflects the state.
  - `aria-controls` points to the input.
  - Hit area at least 32×32 px, with the visible focus ring.
- The icons are lucide `Eye` and `EyeOff`, which are already a dependency.

### 6.2 Animation
- Use `framer-motion`, which is already used and respects the app's `MotionConfig`.
- The icons cross-fade and rotate slightly: opacity 0→1, scale 0.8→1, rotate -15°→0, over about 150 ms with easeOut. The slash on `EyeOff` draws in with `pathLength` 0→1.
- Under reduced motion the swap is instant.

### 6.3 Behaviour
- Clicking toggles `type="password"` and `type="text"`. Focus stays in the field and the caret position is kept. Clicking does not submit the form.
- The field **resets to hidden** after a successful submit, when the page unmounts, and when the user switches to the 2FA code step.
- Keep `autocomplete`: `current-password` on login, `new-password` on the reset, change and invite pages. Changing `type` must not break password-manager autofill.
- Use the same component on: login, forgot/reset password, accept invite, and Login & Security.

### 6.4 Acceptance criteria
- **Given** a typed password, **when** the eye is clicked, **then** the characters show, the icon animates to "eye-off", the label reads "Hide password", and focus stays in the field.
- **Given** a keyboard user, **when** they Tab to the eye and press Space or Enter, **then** it toggles and the form is not submitted.
- **Given** reduced motion, **then** the icon swaps with no animation.

---

## 7. Admin "Send password reset" (in scope, decision §9.4)
- On *Users & Teams*, for active users with a login, add a row action "Send password reset".
  - It is gated on `update User` and calls `POST /api/users/:id/password-reset`, which uses the same email path as §5.2 (same email, same 1-hour single-use link).
  - Confirm dialog: "Send a password reset link to {name} at {email}? Their current password keeps working until they set a new one."
  - Success toast: "Reset link sent to {email}." If the email could not be sent: "We couldn't send the email. Try again or contact ServWave support."
  - The admin never sees or sets the password. Audit `user.password_reset_sent_by_admin` with the actor.
  - The per-email send limit from §5.2 applies, so an admin cannot email-bomb a user.
- It gives an admin a way to help a locked-out employee without the auth dashboard or a script.
- Delete `backend/src/reset-tech-password.ts`. It passes the wrong id and sets a password chosen by someone other than the user.

**Acceptance criteria**
- **Given** an admin on *Users & Teams*, **when** they choose "Send password reset" on a user with a login and confirm, **then** that user gets the §5 email and the admin sees "Reset link sent to {email}."
- **Given** a user without a login, or a deactivated user, **then** the action is not offered. The API returns 400 if it is called anyway.
- **Given** a role without `update User`, **then** the action is hidden and the API returns 403.

---

## 8. Tests

| Layer | Cases |
|---|---|
| Backend unit/integration (vitest + supertest) | Forgot: known user sends one email (sender mocked); unknown, deactivated or revoked user sends none; identical response bodies; rate limit. Reset: valid token sets password and revokes sessions; used, expired or garbage token returns 400 with the generic message; short password returns 400; a breached password returns 422 with ServWave wording **and a fresh token** that then works. Change: wrong current returns 400; same-as-current returns 400; success revokes other sessions; the auth id comes from the token, not an email lookup; `weak_password` maps to the ServWave copy, and no provider `error.message` ever reaches a response. Admin send: sends for an active user with a login; 400 for no login or deactivated; 403 without `update User`; obeys the per-email limit. |
| Frontend unit (vitest + RTL) | `PasswordInput`: toggles type, aria-label and aria-pressed; doesn't submit; resets after submit; reduced motion. Login page keeps `#email`, `#password` and both "Sign In" names, and shows "Forgot password?". Forgot page always shows the same confirmation. Reset page handles the invalid-token state, strips the token from the URL, and on `weak_password` swaps in the returned token and lets the user retry. Login & Security shows the success confirmation and the breached-password message. |
| E2E (Playwright, generated test org from `backend/src/lib/e2e-org.ts`, random passwords only) | Full round trip on staging: request link, read it from the test mailbox or a test-mode email capture, set a new password, sign in, and confirm the old password fails. Change password on Login & Security, and confirm other sessions are signed out. Admin "Send password reset" from Users & Teams. Eye toggle on login. |
| Guards | `.gitleaks.toml` must stay green: no password literals. A copy test asserts no vendor name appears in the new pages or email. |

**Testing rule (from the 2026-10-25 live test).** Automated tests must **never** change the password of a shared, long-lived test account such as the one behind `STAGING_TEST_EMAIL`. Use users from a generated test org. A manual round trip may fail to restore the original, and on 2026-10-25 it did, because the breach check rejected the original password. Any shared test account must use a long, randomly generated password.

---

## 9. Decisions (approved by Ran, 2026-10-25)

1. **One change-password screen.** The form lives on *Login & Security*, and *My Profile* links to it (§4.1).
2. **Sign out other sessions** on both a change (all other devices) and a reset (every device) (§4.2, §5.2).
3. **Reset link lifetime: 1 hour**, single use (§5).
4. **Admin "Send password reset" is built now**, as part of this work (§7).
5. **Password rule stays at 8+ characters.** A strength meter is a separate, later change.

---

## 10. Rollout
- Build on a feature branch, then go to staging and run the §8 E2E plus a manual check with the test org. Then promote to main (`.claude/skills/ship-changes`).
- Before production, set the provider's email OTP expiry to 3600 s and add `/reset-password` to the redirect allow-list (harmless; the link goes through our page).
- Turn on leaked-password protection in the production auth project if it is off, so production matches staging (§2.3).
- Release note for customers (draft for review): "You can now reset a forgotten password from the sign-in page, and show or hide your password while typing."
