# Keep the reset link working when a new password is rejected as breached

**Type:** AFK
**Status:** Released. On staging via #2879 (f995d19a), on production via #2883 (main f7a0ab2a, 2026-10-26). Live-checked on staging (spec §2.2 C).
**Spec sections:** §5.1 step 4, §5.2 "A rejected password must not burn the link"

## Parent

Spec: `md_files/specs/auth/2026-10-25-password-reset-spec.md` (GitHub #2866)

## What to build

Verifying the reset token uses it up **before** the new password is checked. Without this slice, a user who picks a breached password would have to request a new email.

When setting the password fails as breached:

- The server generates a fresh recovery token for the same user. It sends no email.
- It revokes the session the verification created.
- It returns 422 with the `weak_password` code, the ServWave breached-password copy, and the new token.
- The reset page swaps in the new token, shows the message, and lets the user try another password on the same page.

Only a caller who just presented a valid token gets a replacement, so this grants nothing new.

## Acceptance criteria

- [x] With a valid link, choosing a breached password shows the ServWave message. Choosing another password on the same page then succeeds without a new email. *(Checked live on staging 2026-10-25.)*
- [x] The replacement token works once, and the original token no longer works.
- [x] Backend test: a breached password returns 422 with the ServWave copy and a fresh token that then works. Frontend test: the page swaps in the returned token and retries.

## Blocked by

- 04 - Reset a forgotten password from the sign-in page
