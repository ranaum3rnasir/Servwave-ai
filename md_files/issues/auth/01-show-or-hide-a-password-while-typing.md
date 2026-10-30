# Show or hide a password while typing

**Type:** AFK
**Status:** Released. On staging via #2873 (c8c94961), on production via #2883 (main f7a0ab2a, 2026-10-26). Live-checked on staging (spec §2.2 C).
**Spec sections:** §6

## Parent

Spec: `md_files/specs/auth/2026-10-25-password-reset-spec.md` (GitHub #2866)

## What to build

A reusable password field with an animated eye button that reveals and hides what the user is typing. Ship it on the screens that already have password fields: the sign-in page, accept invite, and the Change Password card on Login & Security. The forgot and reset pages (slice 04) use it when they're built.

- The eye is a real button that never submits the form. It is labelled "Show password" / "Hide password", reports its pressed state, and has a hit area of at least 32×32 px with a visible focus ring.
- Eye and eye-off cross-fade with a slight rotate over about 150 ms, and the slash draws in. Under reduced motion the swap is instant.
- Focus and caret position stay in the field. The field goes back to hidden after a successful submit, on unmount, and when sign-in moves to the email-code step.
- Password-manager autofill keeps working: `current-password` on sign-in, `new-password` on the change, reset and invite pages.
- The sign-in page keeps `#email`, `#password` and both "Sign In" accessible names, because the E2E global setup depends on them.

## Acceptance criteria

- [x] With a typed password, clicking the eye shows the characters, the icon animates to eye-off, the label reads "Hide password", and focus stays in the field.
- [x] Tabbing to the eye and pressing Space or Enter toggles it, and the form is not submitted.
- [x] Under reduced motion the icon swaps with no animation.
- [x] The field is hidden again after a successful submit and after the switch to the email-code step.
- [ ] Unit tests cover the toggle, the labels, no submit, the reset-to-hidden, and reduced motion. The existing sign-in E2E still passes. *(Unit tests done; the sign-in E2E was not run locally, and its selectors are pinned by a unit test.)*

## Blocked by

None - can start immediately.
