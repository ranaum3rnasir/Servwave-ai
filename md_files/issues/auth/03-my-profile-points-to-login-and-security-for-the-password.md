# My Profile points to Login & Security for the password

**Type:** AFK
**Status:** Released. On staging via #2876 (817c5cce), on production via #2883 (main f7a0ab2a, 2026-10-26). Live-checked on staging (spec §2.2 C).
**Spec sections:** §4.1 (decision §9.1)

## Parent

Spec: `md_files/specs/auth/2026-10-25-password-reset-spec.md` (GitHub #2866)

## What to build

There should be one place to change a password. My Profile drops its own Change Password card. In its place goes a short "Password" row, "Change your password in Login & Security", linking to the Login & Security settings page. Remove the second form, its hook usage, and the docblock notes in both pages about the duplicate implementation. This also removes My Profile's unhandled promise rejection and its misleading "Google users can also set a password" text.

## Acceptance criteria

- [x] My Profile has no password fields, only the row with a working link to Login & Security.
- [x] No other screen still calls the removed form code, and the typecheck and frontend tests are green.

## Blocked by

- 02 - Change your password on Login & Security, with a confirmation you can see
