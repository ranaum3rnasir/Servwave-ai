# Password Reset (#2866) — Conductor Brief

**For:** the helper session that ships this work autonomously.
**Go-ahead:** Ran Roffe (CEO, repo owner), 2026-10-25. He is not available to answer questions; stop for him only at the stop points in §7.

**Goal:** ship slices 01-07 of `md_files/specs/auth/2026-10-25-password-reset-spec.md` end to end. They are built and tested locally one after another, reviewed, merged into staging, and promoted to production, with security checks built in at every stage.

## 0. Your role: conductor
You are the conductor. You only delegate, using the Agent tool. You never write or edit product code or tests yourself.

You plan, brief agents with context pointers (file paths, commit hashes, slice files), check their results against the gates below, merge, open PRs and report. Keep briefs short and point at files instead of retyping them.

## 1. Read first
1. `CLAUDE.md`. Every agent you start must be told to obey it. Key rules:
   - No password, token or key literal anywhere in the repo, tests included. Generate random ones at run time.
   - No vendor names (Supabase, Resend, Render, Vercel...) in anything a user can see, including API error text and emails.
   - Never print credential values.
2. The spec, `md_files/specs/auth/2026-10-25-password-reset-spec.md`. It is the source of truth for behaviour, copy and acceptance criteria.
3. The slice files `md_files/issues/auth/01..08`. These are the tickets and their order. Slice 08 is Ran's (dashboard settings); do not do it.
4. The spec, the slices and this brief live on branch `claude/reset-password-issue-4xs1vc`. Bring the spec and slices onto the integration branch as its first commit:
   `git fetch origin claude/reset-password-issue-4xs1vc && git checkout origin/claude/reset-password-issue-4xs1vc -- md_files/specs/auth/2026-10-25-password-reset-spec.md md_files/specs/auth/2026-10-25-password-reset-conductor-brief.md md_files/issues/auth`
5. The repo's shipping flow:
   - `docs/agents/issue-tracker.md` covers branching, the cut-from gate and promotion to main.
   - `.claude/skills/ship-changes/SKILL.md` covers the rest.
   - The spec's file and line references were taken on `main`, so agents must re-locate them on `staging`.
6. **Matt Pocock's skills.** They are not installed in this repo. Clone them outside it, pinned to this commit:
   `git clone https://github.com/mattpocock/skills /tmp/mp-skills && git -C /tmp/mp-skills checkout 5beb35b040e3de97e54fa9e386d7e42d15c295c2`
   - **Use** `skills/engineering/implement-spec/SKILL.md` (your conductor flow), `skills/engineering/tdd/SKILL.md` (with its `tests.md` and `mocking.md`), and `skills/engineering/code-review/SKILL.md`. Every agent reads the relevant SKILL.md by path and follows it.
   - **Adaptations.** These override those skills:
     - **Issue tracker:** use the local slice files. A ticket is closed by updating its slice file's status and ticking the criteria it has proven. Do not create GitHub issues, and do not run `/setup-matt-pocock-skills`.
     - **Order:** slices run **one after another**, not concurrently, in the order 01→07.
     - **Seams:** the tdd skill says to confirm seams with the user, but here they are pre-agreed. They are each slice's acceptance criteria, the spec's §8 test table, and the security cases in §3. The developer writes its seam list into its report instead of asking.
     - **Integration branch:** `feat/password-reset`, cut from `origin/staging`. Today `main` is NOT an ancestor of `staging`, so the gate in issue-tracker.md says to cut from staging. Re-run the gate to confirm.

## 2. Each slice, in order 01→07: one developer agent, then one reviewer agent
- **Developer agent.** A fresh agent, working in a worktree on `slice/NN-<slug>` based on the current tip of `feat/password-reset`.
  - It implements the slice following Matt's tdd skill: red → green, one seam at a time, at the agreed seams.
  - Backend tests use vitest + supertest; frontend tests use vitest + RTL.
  - It keeps `#email`, `#password` and both "Sign In" accessible names on the login page.
  - **Checks.** It runs typecheck and single test files regularly. At the end it runs the full suite:
    - root: `npm run lint`;
    - backend: `npm run typecheck` and `npm test`;
    - frontend: `npx tsc -b` and `npm test`.
    gitleaks (`.gitleaks.toml`) must stay clean.
  - **Commit and report.** It commits as `feat(auth): <slice title> (#2866)` and merges the integration-branch tip into its branch. Then it reports its commit hashes, the seams it tested, and the checks it ran with their results.
- **Reviewer agent.** A fresh agent, never the developer.
  - It runs Matt's code-review skill on the slice diff (`git diff <integration tip before the slice>...slice/NN`), using the slice file and the spec as the spec source.
  - It also checks the §3 security list for anything the slice touches.
  - It re-runs the full checks itself, and reports blocking findings separately from optional ones.
- **Fix loop.** Send blocking findings back to the same developer agent (SendMessage), then run a fresh reviewer pass. Repeat until the reviewer reports no blocking findings and all checks are green. There is no round limit.
- **Merge.** You merge `slice/NN` into `feat/password-reset`, delete the worktree, and update the slice file's status. The next slice starts from the new tip.
- **Slice notes:**
  - **Slice 02** must find and fix the real reason the old "Password updated." message never showed in the live test.
  - **Slice 04:** the automated E2E reads the reset link by asking our email provider's API for the email just sent, provided that API returns the body. Verify that first. If it doesn't, cover everything else in the E2E and document the gap in the slice file.
  - **Slice 07** deletes `backend/src/reset-tech-password.ts`.
  - **Every slice:** no test may change the password of the shared staging test account (STAGING_TEST_EMAIL). Tests use generated users from `backend/src/lib/e2e-org.ts`, with random passwords.

## 3. Security checks (build them in, and review against them)
1. **Account enumeration.**
   - Forgot-password returns the same status, body and timing for known, unknown, deactivated and revoked users.
   - No other response leaks whether an account exists.
2. **Rate limits.**
   - Forgot-password is limited per IP and per email: at most 3 requests per email per 15 min, admin sends included.
   - Every new or changed password endpoint is rate-limited, including `POST /api/users/me/password`.
3. **Reset token.**
   - Single use, and it expires.
   - Sent only in a POST body.
   - Never logged: check request loggers, Sentry breadcrumbs and audit metadata.
   - Stripped from the address bar on load. The reset page sets `Referrer-Policy: no-referrer`, by meta tag or header.
   - A breached-password retry issues a replacement token only to a caller who just presented a valid one.
4. **Sessions.**
   - A change signs out the user's other sessions.
   - A reset signs out all sessions, including the one that token verification creates.
   - The 60 s identity cache is cleared.
   - A reset never signs the user in, so 2FA still applies. The `PASSWORD_RECOVERY` guard is in place.
5. **Authorization.**
   - Admin "Send password reset" requires `update User`.
   - It works **only on users in the admin's own organization**. Test a cross-org attempt and expect 403 or 404.
   - The change endpoint takes the auth id from the verified token, never from input.
6. **Input.**
   - The email is lower-cased and validated.
   - The password length is enforced on the server.
   - No user input is reflected unescaped in the email or the pages, and names in the email are escaped.
   - No open redirect via query parameters.
   - Re-verifying the current password uses a fresh, non-persisting client.
7. **Error copy.** Provider errors are mapped by the one shared helper. No provider message or vendor name reaches any response, page or email; add a copy test that checks this.
8. **Secrets and audit.**
   - No secrets or password literals in the repo, and gitleaks is green.
   - These audit events are recorded: `user.password_changed`, `user.password_reset_requested`, `user.password_reset`, and `user.password_reset_sent_by_admin` with the actor. None of them contains a token or password.

## 4. After all 7 slices: final local reviews (both must pass)
- **Code review.** A dedicated fresh agent runs Matt's code-review skill on `git diff origin/staging...feat/password-reset`, using the spec and slice files as the spec source.
- **Security review.** A separate dedicated fresh agent runs the `/security-review` skill on the same diff. It also checks every item in §3, and may use the repo's `backend-security-coder`, `api-security-best-practices` and `auth-implementation-patterns` skills.
- **Fixes.** Blocking findings go to one fresh fixer agent. Then both reviews run again, until nothing blocking remains.
- **Optional findings.** Fix the plainly correct ones. List the rest, each with a reason, in the final report.
- **Full check.** Then an agent runs lint, typecheck, the unit tests and `npm run build` in both workspaces, plus this feature's E2E specs locally where they can run. All must be green.

## 5. Staging
**Ran's go-ahead:** open PRs into `staging` and merge them yourself, with admin permissions. Use `gh pr merge --admin --squash` if `gh` works here; otherwise use the GitHub MCP merge tool.
- **One PR per slice, in order 01→07.**
  - Each PR comes from its own branch based on the current `origin/staging` and carries only that slice's commits. The commit with the spec, brief and slice files rides with slice 01's PR.
  - After each squash-merge, rebase the next slice's commits onto the new `origin/staging` with `git rebase --onto`.
  - Check each PR's file count. If it is wildly larger than what the slice touched, the base is wrong; re-cut it.
- **PR body:** what the slice does, how it was tested, and `Refs #2866`. Slice 07's body uses `Fixes #2866` instead. End every body with this session's link.
- **CI.**
  - If CI is red, delegate the fix to a new isolated agent (Agent tool, `isolation: "worktree"`) with the failing check's log. The agent reproduces the failure, fixes it, re-runs the checks and pushes. Then you re-check.
  - Never skip, disable or quarantine a test, and never push an empty commit.
  - A failure that is also red on `staging` is not this PR's. Port an existing fix if there is one, or note it.
  - Merge only on green CI.
- **Ledger.** After each merge, append a line to `docs/agents/promotion-ledger.jsonl`, in the same format as the existing lines.
- **Deploys.** Then confirm the staging deploys: the frontend (servwave-demo.vercel.app) built, the backend is live, and any migration was applied.
- **Live check on staging.** This happens on staging only; never submit anything on production.
  - Delegate it to a verifier agent using Playwright (Chromium is preinstalled).
  - **Test admin login.** Ran authorizes signing in to staging as the test admin with STAGING_TEST_EMAIL / STAGING_TEST_PASSWORD for this QA.
    - That sign-in may fail, because an earlier test may have left the account on a temporary password.
    - If it fails, record that and continue without the checks that need it. Do not reset the account.
  - **Email round trip, via the Gmail connector** (Ran's inbox, ranroffe@servwave.com):
    1. Invite a test user in the test org at a plus-address, `ranroffe+pwreset-<random>@servwave.com`.
    2. Accept the invite from Gmail with a random password.
    3. Run forgot password for that address and complete the reset from the email.
    4. Check the email's sender, subject and copy, that it contains no vendor names, and that its link works only once.
    In Gmail, search for and open only these test emails, by plus-address and subject. Read nothing else.
  - **Also check:**
    - the breached-password wording, and the retry without a new email;
    - with two browsers, a change in one signs out the other;
    - the 4th request in 15 min sends no email;
    - the admin "Send password reset";
    - the eye toggle by keyboard.
    Type any breached password in the browser only; never commit it.
  - **Clean-up:** deactivate the test user(s) you created.
  - **Defects:** a real defect found here goes to an isolated fix agent, then through the same review, PR and CI loop.

## 6. Production
**Ran's go-ahead, for this promotion only:** promote to `main` once all 7 slices are merged on staging, CI is green and the staging check has passed. Follow the "Promotion to main" section of `docs/agents/issue-tracker.md`.
- Cherry-pick the merged staging commits with `-x`, in order, onto a fresh `promote/password-reset` branch based on `main`.
- Check that every dependency of those commits is already on `main`.
- Open the PR into `main` and wait for green CI. Red CI goes to an isolated fix agent, as above. Merge with admin permissions.
- **Check the production deploy.** Confirm production is live, then run a read-only smoke check on app.servwave.com:
  - `/login` shows "Forgot password?";
  - `/forgot-password` and `/reset-password` load;
  - the eye toggle works.
  Submit nothing on production.
- If production breaks, revert the promotion PR at once and report.

## 7. Stop points (the only times you stop for Ran)
1. **A serious database migration, before the production merge only.** Staging merges never stop for migrations.
   - "Serious" means anything beyond purely additive changes: dropping or renaming a table or column, changing a type, adding NOT NULL or a constraint to an existing table, backfilling or rewriting data, or a blocking index on a large table.
   - When it applies, stop before the merge to main and explain to Ran in plain language: what the migration changes, what it touches, the risk, and the rollback.
   - A purely additive migration doesn't stop; list it in the final report.
2. **A merge that only a person can unblock**, such as a required human approval that admin rights can't bypass. Never weaken branch protection. Say exactly what is needed.
3. **Anything destructive or irreversible** outside this plan.

## 8. Final report (your last message, for Ran)
- Update the spec's Status line, §2.2 and §8, and each slice file's status. That goes in with the last PR, or a small docs PR through the same flow.
- Post one summary comment on #2866, ending with the Claude Code attribution footer.
- Write your final message with the main point first, in plain language, in these numbered sections:
  1. **What is built, and what is live on staging and on production**, with PR links.
  2. **What was verified and how:** tests, reviews, the security review and the live checks.
  3. **Anything that failed, was skipped or was not verified**, said plainly, with evidence.
  4. **Review findings left open**, each with its reason.
  5. **Any migration.**
  6. **What Ran still has to do (slice 08):**
     - restore the staging test account;
     - set the email OTP expiry to 3600 s on both auth projects;
     - add `/reset-password` to the redirect allow-list;
     - turn on leaked-password protection in production.
- Keep "built", "tested on staging" and "released to production" distinct. Never claim anything you did not do.
