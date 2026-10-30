# Reset a forgotten password from the sign-in page

**Type:** AFK
**Status:** Released. On staging via #2877 (ff4f8772), on production via #2883 (main f7a0ab2a, 2026-10-26). Live-checked on staging (spec §2.2 C). Sign-out fix in #2885 (bb942069), found by the live check.
**Spec sections:** §3, §5.1 to §5.4 (except breached-password retry, slice 05)

## Parent

Spec: `md_files/specs/auth/2026-10-25-password-reset-spec.md` (GitHub #2866)

## What to build

The full forgot-password path, end to end. Today none of it exists, and that is the reported "no reset link is sent".

1. **Sign-in page:** a "Forgot password?" link under the Password label, right-aligned and keyboard-reachable. It carries the typed email over.
2. **Forgot page** (public): "Reset your password", Email, "Send reset link", "Back to sign in". On submit it **always** shows "If an account exists for {email}, we've sent a link to reset your password. It expires in 1 hour. Check your spam folder if it doesn't arrive." "Send again" becomes available after 60 s.
3. **Server, request:** look for an active user with a login. If one exists, generate a single-use recovery token (the provider sends nothing) and send ServWave's own branded email: subject "Reset your ServWave password", a "Reset password" button, and the 1-hour, single-use, "ignore this if you didn't ask" copy. The response and its timing are identical whether or not a user matched. Rate limits apply per IP and per email (at most 3 per 15 min). Audit the request when a user matched.
4. **Reset page** (public): "Choose a new password", New and Confirm with the eye field, "Update password". It strips the token from the address bar on load, sends it only in a POST body, and never logs it.
5. **Server, reset:** verify the token on a fresh client and set the password. Then sign out **every** session for that user, including the one the verification created, and clear the identity cache. Audit and emit the password-changed event. Errors go through the shared mapping helper from slice 02.
6. On success, go to sign-in with "Your password was updated. Sign in with your new password." A reset never signs anyone in, so 2FA still applies.
7. An invalid, used or expired token shows "This reset link is invalid or has expired." with "Send a new link".
8. **Guard:** if a provider-sent recovery link ever reaches the app, the auth listener signs the browser out and routes to the forgot page instead of silently signing the user in.

No vendor name appears on either page or in the email.

## Acceptance criteria

- [x] "Forgot password?" on sign-in opens the forgot page with the typed email filled in.
- [x] A registered active user gets one email from ServWave within a minute. Its link opens "Choose a new password". *(Checked live on staging; the email arrived in about 1 s.)*
- [x] An unknown email gets the identical message and response, and no email is sent. So do a deactivated user and a user whose login was revoked.
- [x] A valid link sets a new password and lands on sign-in with the notice. The new password works, the old one fails, and 2FA (if enrolled) is still asked. *(Checked live on staging; the test user had no 2FA, so the 2FA part is covered by unit tests only.)*
- [x] A used or over-1-hour link shows the invalid message with "Send a new link".
- [x] A fourth request for the same email within 15 minutes leaves the UI message unchanged and sends no email.
- [x] Backend tests cover every branch above with the email sender mocked. Frontend tests cover the forgot page's single message, the reset page's invalid state, and the token being stripped from the URL.
- [x] A copy test asserts no vendor name in the two pages or the email. gitleaks stays green.
- [ ] E2E round trip on staging with a generated test org. **Open question:** the repo has no test mailbox or email capture today, so the E2E either needs one added here or reads the link from a test-mode hook. Decide while building. Don't skip the round trip. *(Decided: the E2E reads the sent email back from the email provider's API, which returns the body; spec `frontend/e2e/specs/auth/password-reset.spec.ts`, opt-in with `E2E_ASSERT_EMAILS=1`. Written and type-checked; not run in this build because the build machine has no keys. The staging check covers the round trip by hand.)*

## Blocked by

- 02 - Change your password on Login & Security, with a confirmation you can see (the shared error-mapping helper)

Not production-ready until 08 is done: the link lifetime the email promises depends on a provider setting.
