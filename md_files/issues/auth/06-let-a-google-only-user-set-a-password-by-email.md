# Let a Google-only user set a password by email

**Type:** AFK
**Status:** Built and reviewed locally (commit 6584ecea on feat/password-reset). Not yet on staging.
**Spec sections:** §4.1 last bullet, §4.3 Google-only case

## Parent

Spec: `md_files/specs/auth/2026-10-25-password-reset-spec.md` (GitHub #2866)

## What to build

A user who signs in only with Google has no current password, so the change form can't work for them. On Login & Security, such a user sees "You sign in with Google. To also sign in with a password, use **Set a password by email**" instead of the form. The button sends the slice 04 reset email to their own address, with the same limits and the same single-use link.

## Acceptance criteria

- [x] A Google-only user on Login & Security sees no current-password field, only the message and the button.
- [ ] The button sends the reset email to the user's own address. The link sets a password, after which both Google and password sign-in work. *(Unit-tested; "both Google and password sign-in work" needs a real Google-only account, checked on staging if one is available.)*
- [x] The per-email send limit applies.
- [x] Tests cover the Google-only branch of the card, and the server's handling of a password-less user.

## Blocked by

- 02 - Change your password on Login & Security, with a confirmation you can see
- 04 - Reset a forgotten password from the sign-in page
