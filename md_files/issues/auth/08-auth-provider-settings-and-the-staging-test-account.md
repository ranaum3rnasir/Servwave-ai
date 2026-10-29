# Auth provider settings and the staging test account

**Type:** HITL (needs Ran, or someone with access to the auth dashboard)
**Spec sections:** §2.2 open item, §2.3, §10

## Parent

Spec: `md_files/specs/auth/2026-10-25-password-reset-spec.md` (GitHub #2866)

## What to build

Settings and cleanup that code can't do, on both auth projects (staging and production are separate).

1. **Restore the staging test account.** The 2026-10-25 live test left it on a temporary password. Set a long, randomly generated password and update `STAGING_TEST_PASSWORD` to match.
2. **Email OTP expiry: 3600 s** on staging and production. The reset email promises 1 hour.
3. **Add `/reset-password` to the redirect allow-list** on both projects. It's harmless, since the link goes through our page.
4. **Turn on leaked-password protection in production** if it's off, so production matches staging.
5. **Record the current settings** in the spec's §2.3: custom SMTP, Site URL, and "Secure password change".

## Acceptance criteria

- [ ] The staging test account signs in with the new password from the environment. No password appears in chat or the repo.
- [ ] OTP expiry reads 3600 s on both projects.
- [ ] The redirect allow-list includes `/reset-password` on both.
- [ ] Production rejects a known-breached password with the ServWave message, once slice 02 is live there.
- [ ] Spec §2.3 is updated with what was found.

## Blocked by

None - can start immediately. Item 1 is urgent. Items 2 to 4 must be done before slices 04 to 07 are promoted to production.
