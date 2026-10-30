# Change your password on Login & Security, with a confirmation you can see

**Type:** AFK
**Status:** Released. On staging via #2875 (3504575a), on production via #2883 (main f7a0ab2a, 2026-10-26). Live-checked on staging (spec §2.2 C). Sign-out fix in #2885 (bb942069), found by the live check.
**Spec sections:** §4.1, §4.2, §4.3 (except the Google-only case, slice 06, and My Profile, slice 03)

## Parent

Spec: `md_files/specs/auth/2026-10-25-password-reset-spec.md` (GitHub #2866)

## What to build

Today the Change Password card on Login & Security sets the password straight from the browser, with no server call, and shows no confirmation. In the live test the password changed, but the user saw nothing. This slice moves the card onto the existing server endpoint and makes the result visible.

- The card calls the server change-password endpoint. The browser no longer talks to the auth provider to check or set a password.
- The server takes the user's auth id from the verified sign-in token instead of paging through every auth user by email.
- The server re-checks the current password on a fresh, non-persisting client for each request.
- It rejects a new password equal to the current one: "Choose a password you haven't used here."
- The endpoint gets the auth rate limiter.
- After a successful change, every other session is signed out and the 60 s identity cache is cleared, so a revoked session can't linger. This device stays signed in. The existing audit and notification stay.
- **One shared error-mapping helper**, reused by slices 04, 05 and 07. The provider's breached-password rejection becomes a 422 with code `weak_password` and the copy "This password has appeared in a known data breach, so it isn't safe to use. Choose a different one." Any other provider error becomes a generic 400, "We couldn't update your password. Try again or contact ServWave support.", with the detail logged server-side only. The provider's own message never reaches a response.
- UI: on success, an inline confirmation **and** a toast, "Password updated. You've been signed out on your other devices." The fields clear. A wrong current password shows inline "Current password is incorrect." with no toast and no unhandled rejection.
- Find and fix why the existing "Password updated." message didn't show in the live test. Don't just paper over it.

## Acceptance criteria

- [x] A correct current password plus a valid new one shows the confirmation inline and as a toast, both still visible 5 s later. The new password signs in and the old one fails. *(Checked live on staging 2026-10-26.)*
- [x] The network log shows the server endpoint and no direct browser call to the auth provider.
- [x] A breached new password shows the ServWave message, and the password is unchanged.
- [x] A wrong current password shows "Current password is incorrect.", and the password is unchanged.
- [x] Signed in on two browsers: changing the password in one signs the other out on its next request. *(Checked live on staging 2026-10-26 after the #2885 fix; this device stays signed in.)*
- [x] Backend tests: wrong current gives 400; same-as-current gives 400; success revokes the other sessions; the auth id comes from the token, not an email lookup; `weak_password` maps to the ServWave copy; no provider message ever appears in a response.
- [x] Automated tests use a generated test org with random passwords, never the shared staging test account.

## Blocked by

None - can start immediately. Uses the eye field if slice 01 has landed. It doesn't wait for it.
