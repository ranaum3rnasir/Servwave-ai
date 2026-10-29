# SERV10X-17 — Google-path QA workbook (for Ran, manual)

Covers the 3 scenarios that need a real Google account: **C1, C2, C3**.
Everything else already passed automated QA — see `2026-07-13-serv10x-17-qa-RESULTS.md`.

**Target:** https://servwave-demo.vercel.app
**Admin login:** `admin@alphacrm.com` / `Admin123!@#`

---

## Before you start

1. **Have two things ready:**
   - A **real Gmail/Google account you control** that is **NOT already in the demo org** (check it's not one of: `ranro3@gmail.com`, `ranroffe@servwave.com`, `info@servwave.com`, or any `@alphacrm.com` address). This is your **C1/C2 test account**. A `+alias` on an existing Gmail works fine (e.g. `youraddress+servqa@gmail.com`) as long as Google will let you sign in with it.
   - Access to **`ranro3@gmail.com`**'s Google login (already in the org, pre-cutover, no terms row) — this is your **C3 account**. If you don't have its Google credentials handy, skip C3 and just do C1+C2.

2. **Use an Incognito/Private browser window** for the whole session. This avoids Chrome auto-signing you into a Google account that's already cached, which would make it hard to tell which account you actually authenticated as.

3. Keep this doc open and check boxes as you go — at the end, tell me pass/fail for each and I'll log it.

---

## Email Check — Invite CTA and Google-user messaging

**Goal:** verify the invite email has been updated with the correct copy for the new consent flow.

When you send the invite in C1 (step 3), check the email that lands in your test account's inbox:

- [ ] 1. Open the invite email sent to your C1/C2 test Google account.
- [ ] 2. Find the main CTA button.

**✅ Expected:**
- The button reads **"Accept your invitation"** (not "Set your password").
- If the email mentions Google sign-in (likely in the body text), it should direct users to the invite link to complete setup, **not** to the login page.

- [ ] **PASS** / [ ] **FAIL** (if FAIL, copy the exact button text or message)

---

## C1 — New user, Google AFTER accepting consent → should SUCCEED

**Goal:** prove a brand-new invited user can accept the Terms by ticking the consent checkbox and completing Google sign-in on the invite page.

- [ ] 1. In the incognito window, log in as admin (`admin@alphacrm.com`).
- [ ] 2. Go to **Settings → Users & Teams → + Invite User**.
- [ ] 3. Fill in a first/last name, and for **Email** use your C1 test Google account (the one from step 1 above). Role doesn't matter (Technician is fine). Click **Send invite**.
- [ ] 4. Open the invite link — either from the email that lands in that Google account's inbox, or copy it from wherever the app shows it after sending.
- [ ] 5. **Check the ToS consent checkbox**, then click **Continue with Google**.
- [ ] 6. Complete the Google sign-in flow with that account.

**✅ Expected result:** Sign-in **succeeds**. You land on the dashboard (or `/tech/today` if role = Technician). No error, no 403, no consent prompt.

- [ ] **PASS** / [ ] **FAIL** (if FAIL, copy the exact error text or screenshot it)

---

## C2 — Alternative path: accept via password instead of Google → also WORKS

**Goal:** prove that the ToS consent can also be accepted via password (alternative to the Google-first path), and that subsequent Google sign-in works.

**Note:** The **primary recommended path** on the invite page is now **check consent checkbox → Continue with Google** (no password setup required). This scenario tests the alternative password path.

- [ ] 1. Go back to the **same invite link** from C1 (still valid — reusable token).
- [ ] 2. This time, fill in a password (≥8 characters) in both fields, **check the consent checkbox**, and click **Set password & sign in**.
- [ ] 3. Confirm you land on the dashboard (or `/tech/today` if role = Technician).
- [ ] 4. **Sign out.**
- [ ] 5. Go to the normal **login page** → click **Continue with Google** → sign in with the **same** Google account.

**✅ Expected result:** Google sign-in **succeeds** — you land on the dashboard/`/tech/today`, no error, no consent prompt.

- [ ] **PASS** / [ ] **FAIL** (if FAIL, copy the exact error text)

---

## C3 — Grandfathered user (pre-cutover) → NEVER gated

**Goal:** prove an existing user created before 2026-07-09 is exempt from the Google gate, even with zero terms rows.

- [ ] 1. Sign out / stay in incognito.
- [ ] 2. On the login page, click **Continue with Google**, sign in as **`ranro3@gmail.com`**.

**✅ Expected result:** Sign-in **succeeds immediately** — no consent screen, no error, straight to the dashboard.

- [ ] **PASS** / [ ] **FAIL** (if FAIL, copy the exact error text)

---

## C4 — Abandon Google, then set password → idempotency check

**Goal:** prove that if a user ticks the consent checkbox, starts the Google flow, abandons it at the Google account picker, and then returns to set a password instead, there is exactly one `terms_acceptances` row (no double-write / race condition).

- [ ] 1. Go back to the **same invite link** from C1/C2 (still valid).
- [ ] 2. **Check the ToS consent checkbox** (this triggers a consent record write).
- [ ] 3. Click **Continue with Google**.
- [ ] 4. At the Google account picker, **do NOT select an account** — close the browser tab or go back (abandon the Google OAuth flow).
- [ ] 5. Go back to the invite link (should still be valid).
- [ ] 6. **Fill in a password** (≥8 characters) in both fields. **Ensure the consent checkbox is still checked**, and click **Set password & sign in**.
- [ ] 7. Confirm you land on the dashboard (or `/tech/today`).
- [ ] 8. Verify via Supabase SQL that there is **exactly one** `terms_acceptances` row for that user. Open the [Supabase dashboard](https://supabase.com) for this project, go to the SQL Editor, and run:
   ```sql
   SELECT user_id, context, created_at FROM terms_acceptances WHERE user_id = '<user_uuid>' ORDER BY created_at;
   ```
   (Replace `<user_uuid>` with the UUID of your test user. You can find it in the `auth.users` table or by querying `SELECT id, email FROM auth.users WHERE email = 'your-test-email@...';`)

**✅ Expected result:**
- Sign-in with password **succeeds** — you land on the dashboard.
- The SQL query returns **exactly one row**.
- That row has `context = 'invite_acceptance_google'` (from the consent write in step 2-3, before the abandon).
- **No duplicate** `terms_acceptances` row exists for this user.

- [ ] **PASS** / [ ] **FAIL** (if FAIL, copy the exact SQL result or error message)

---

## Cleanup (do this after C1/C2, not C3 — `ranro3@gmail.com` is a real ongoing account, don't touch it)

The C1/C2 test user needs to be removed so it doesn't linger in the demo org:

1. Go to **Settings → Users & Teams**.
2. Find the row for your C1/C2 test user.
3. Click **Deactivate** (this becomes available only after — the **Delete** button appears once a user is Inactive).
4. Switch the filter to **inactive**, find the row again, click **Delete**.

If **Delete** isn't available or errors out, just tell me — I can remove it directly via the database (same way I cleaned up my own test user last time).

---

## When you're done

Send me:
- Pass/fail for the **Email Check**, **C1**, **C2**, **C3**, and **C4** (and C3 skip note if you didn't have `ranro3@gmail.com` credentials handy)
- Any exact error text that didn't match what's expected above
- For C4: the SQL query result showing the single `terms_acceptances` row (or the count if there was an error)
- Confirmation you cleaned up the C1/C2 test user (or ask me to do it)

Once all checks pass, SERV10X-17 is fully QA'd and ready to promote `staging` → `main`. I'll prep that PR when you give the word.
