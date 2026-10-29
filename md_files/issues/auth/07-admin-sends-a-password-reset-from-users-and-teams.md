# Admin sends a password reset from Users & Teams

**Type:** AFK
**Status:** Built and reviewed locally (commit 942f95d0 on feat/password-reset). Not yet on staging.
**Spec sections:** §7 (decision §9.4)

## Parent

Spec: `md_files/specs/auth/2026-10-25-password-reset-spec.md` (GitHub #2866)

## What to build

An admin can help a locked-out employee without the auth dashboard or a script.

- On Users & Teams, active users with a login get a row action, "Send password reset". It's gated on `update User`.
- A confirm dialog reads: "Send a password reset link to {name} at {email}? Their current password keeps working until they set a new one."
- The server sends the same email and the same 1-hour, single-use link as slice 04. The per-email limit applies.
- It audits that an admin sent the link, with the actor. The admin never sees or sets the password.
- Success toast: "Reset link sent to {email}." On failure: "We couldn't send the email. Try again or contact ServWave support."
- Delete the old dev script that resets a technician's password. It passes the wrong id and sets a password the user didn't choose.

## Acceptance criteria

- [ ] An admin confirms the action on a user with a login. That user gets the email and the admin sees "Reset link sent to {email}." *(Unit-tested; checked live on staging.)*
- [x] The action isn't offered for a user without a login or a deactivated user, and the API returns 400 if it's called anyway.
- [x] For a role without `update User`, the action is hidden and the API returns 403.
- [x] The per-email limit stops an admin from sending a fourth link within 15 minutes.
- [x] The old reset script is gone, and nothing references it.
- [ ] Backend and E2E tests cover the above, with a generated test org. *(Backend tests done; E2E spec `frontend/e2e/specs/auth/admin-password-reset.spec.ts` written and type-checked, not run in this build.)*

## Blocked by

- 04 - Reset a forgotten password from the sign-in page
