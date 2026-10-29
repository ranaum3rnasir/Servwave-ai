# Slack Communication Guide — #scheduler-ui-audit

**Channel ID:** `C0AM9NSHN3X`
**Purpose:** Single source of truth for the Scheduler UI/UX QA Sprint
**Rule:** If it's not in this channel, it didn't happen.

---

## General Rules (Everyone)

1. **No side DMs about bugs, findings, or fixes.** Everything goes in `#scheduler-ui-audit`. DMs are only for personal/HR matters.
2. **Use threads.** Every finding starts as a top-level message. All discussion about that finding happens in its thread. Don't pollute the main channel with back-and-forth.
3. **React to acknowledge.** When you see a message that needs your attention, react with :eyes: ("I saw it") immediately. Then reply in thread when you've acted.
4. **One message per finding.** Don't split a finding across multiple messages. One finding = one message with all details.
5. **Tag who needs to act.** Don't post into the void. Every message should make it clear who needs to do something next.
6. **No "hello, are you there?" messages.** Just post your question or finding. Async communication means people respond when they can.

---

## Role-Specific Communication

### The Eyes (Manual QA Tester)

**When you post:** Every time you find something — immediately, not batched.

**Finding message format:**
```
:bug: *[P0/P1/P2] [Test ID] — [Short Title]*

*View:* Week / Day / Month / Grid Day / Grid Week
*Viewport:* 1920x1080 / 1440x900 / 1366x768

*Steps:*
1. Navigate to /schedule
2. [exact sequence]
3. [what happened]

*Expected:* [what should happen — reference Google Calendar if applicable]
*Actual:* [what actually happened]

*Video:* [attach MP4/GIF — REQUIRED for DnD findings]

@fixer — needs fix by [today/tomorrow]
```

**When to post:**
- P0 finding → post immediately, don't wait for anything
- P1 finding → post as you go, within 1 hour of discovery
- P2 finding → can batch 2-3 together at end of testing session

**Thread behavior:**
- When Fixer replies "Fix pushed" → you reply with verification result: `:white_check_mark: Verified fixed` or `:x: Still broken — [details]`
- When Product Lead asks "is this intentional?" → reply with your observation + Google Calendar comparison

**End of day:** Post a summary message:
```
:clipboard: *Eyes — Day [N] Summary*
Scenarios tested: [IDs]
Findings: [N] P0, [N] P1, [N] P2
Verified fixes: [N]
Blocked on: [anything]
```

---

### The Robot (QA Automation Engineer)

**When you post:** After every spec run that has new failures or notable results.

**Spec run result format:**
```
:robot_face: *Spec Run — [spec file name]*

:white_check_mark: Pass: [N]
:x: Fail: [N]
:fast_forward: Skip: [N]

*New failures:*
- [test name] — [reason: locator broken / real bug / flaky]
- [test name] — [reason]

*Action needed:* @fixer — [test X] fails because [DOM changed / real bug detected]
```

**When to post:**
- After stabilizing a spec file (initial run + fixes)
- When a previously-passing test starts failing (potential regression from Fixer's changes)
- When you add new automated tests based on Eyes' findings

**Thread behavior:**
- When Fixer changes UI → you reply in your thread: "Locator updated, spec passing now"
- When Eyes reports something you can automate → reply "Adding automated case for this"

**End of day:** Post run summary:
```
:bar_chart: *Robot — Day [N] Summary*
Specs run: [list]
Total: [N] pass / [N] fail / [N] skip
New tests added: [N]
Flakes fixed: [N]
```

---

### The Fixer (Frontend Developer)

**When you post:** Every time you push a fix.

**Fix notification format:**
```
:wrench: *Fix pushed — [Test ID] [Short Title]*

*What changed:* [1-2 sentence description]
*Files:* [file names]
*Commit:* [hash or message]

@eyes — ready for re-verification
@robot — check if locators still work
```

**Always post fix notifications in the finding's thread** — not as a new top-level message. This keeps the finding → fix → verification chain in one place.

**When you need clarification:**
```
:question: *[Test ID] — Need clarification*

[Your question — "Is dragging IN_PROGRESS jobs intentional?"]

@lead — please decide
```

**Thread behavior:**
- When Eyes files a finding → react with :eyes: immediately
- When you start working on a fix → react with :hammer_and_wrench:
- When fix is pushed → reply in thread with the fix notification format above
- When Product Lead makes a decision → react with :thumbsup:

**End of day:** Post fix summary:
```
:package: *Fixer — Day [N] Summary*
Fixes pushed: [N]
- [Test ID]: [what was fixed]
- [Test ID]: [what was fixed]
P0 remaining: [N]
P1 remaining: [N]
Working on next: [Test ID]
```

---

### The Judge (UI/UX Designer)

**When you post:** Only during and after your 3 scheduled sessions. You are NOT in this channel daily.

**After Session 1 (Calibration):**
```
:art: *Design Calibration — Complete*

Calibration checklist posted. Key decisions:
- [Color: walkthrough amber is distinct enough / needs change to #XXXX]
- [Font: 11px floor is acceptable / needs 12px minimum]
- [Spacing: sidebar card padding p-2.5 is correct / too tight]

@eyes — use this checklist as your quality bar
```

**After Session 2 (Finding Review):**
```
:art: *Finding Review — Decisions*

Reviewed [N] findings. Decisions:
- [Test ID]: FIX — [specific instruction]
- [Test ID]: ACCEPT — [reason]
- [Test ID]: DEFER — [reason]

@fixer — fix list for this week attached
@lead — approve/adjust this priority list
```

**After Session 3 (Final Sign-Off):**
```
:art: *Final Sign-Off*

Verdict: [APPROVED / APPROVED WITH CAVEATS / BLOCKED]

[If caveats/blocked: list specific items]

[Overall impression in 2-3 sentences]
```

---

### The Product Lead (Me)

**How I use Slack:**

**Morning (reading the channel):**
- I read all messages posted since my last check
- I react with :eyes: on every finding I've read
- I reply in threads with severity confirmations or questions

**Triage format (reply in finding thread):**
```
:white_check_mark: Confirmed [P0/P1/P2]
Assigned: @fixer
SLA: [today / end of day tomorrow]
```

**Severity override (reply in finding thread):**
```
:scales: Severity override: [P1 → P2]
Reason: [explanation]
Decision is final.
```

**"Is this intentional?" resolution:**
```
:mag: Reviewed [Test ID]:
Decision: [Fix / Accept / Defer]
Reason: [Google Calendar does X / dispatcher workflow requires Y]
@fixer — [act on this / no action needed]
```

**Phase transition (top-level):**
```
:checkered_flag: *Phase [N] Complete — Moving to Phase [N+1]*

*Results:*
- Scenarios covered: [N]/187
- P0 open: [N] → fixed: [N]
- P1 open: [N]

*Phase [N+1] focus:*
- Eyes: [categories]
- Robot: [specs]
- Fixer: [fix queue]

Everyone: check your assignments above. Questions in thread.
```

**End of day summary (top-level):**
```
:bar_chart: *Day [N] — Product Lead Summary*

*Progress:* [N]/187 scenarios complete
*Quality:* P0=[N] P1=[N] P2=[N]
*Fixes today:* [N] pushed, [N] verified
*Team health:* [any blockers, praise, concerns]

*Tomorrow:* [what we're doing]
```

---

## Response Time Expectations

| Situation | Who Responds | Expected Response Time |
|-----------|-------------|----------------------|
| P0 finding posted | Fixer reacts :eyes: | Within 30 minutes |
| P0 finding posted | Lead confirms severity | Within 1 hour |
| P1 finding posted | Fixer reacts :eyes: | Within 2 hours |
| "Is this intentional?" question | Lead responds | Within 2 hours |
| "Fix pushed" notification | Eyes starts re-verification | Next testing session |
| Spec failure from UI change | Robot investigates | Same day |
| Severity dispute | Lead decides | Within 4 hours |
| Designer session follow-up | Lead converts to fix queue | Same day |

---

## Emoji Convention (Reactions)

| Emoji | Meaning | Used By |
|-------|---------|---------|
| :eyes: | "I saw this, I'll act on it" | Everyone |
| :hammer_and_wrench: | "I'm working on the fix now" | Fixer |
| :white_check_mark: | "Verified fixed" or "Approved" | Eyes, Lead |
| :x: | "Still broken" or "Rejected" | Eyes, Lead |
| :rotating_light: | "This is P0 — drop everything" | Lead |
| :thumbsup: | "Acknowledged, no action needed from me" | Everyone |
| :question: | "I have a question about this" | Everyone |
| :tada: | "Great catch" or "Nice fix" | Lead (recognition) |

---

## What NOT to Post in This Channel

- Personal messages, jokes, off-topic conversation → use `#social`
- Detailed code discussions → create a PR, link it in the thread
- Long debugging sessions → work locally, post the result/conclusion only
- Questions you can answer by reading the test plan or role docs → read first, ask second
- "Good morning" / "logging off" → just do your work, no ceremony needed

---

## Thread Lifecycle of a Finding

```
1. Eyes posts finding (top-level)         ← :bug: P1 D-06 — drag from center...
2. Lead confirms severity (thread)        ← :white_check_mark: Confirmed P1, @fixer SLA: today
3. Fixer reacts :eyes: (reaction)         ← acknowledges
4. Fixer reacts :hammer_and_wrench:       ← working on it
5. Fixer posts fix (thread)               ← :wrench: Fix pushed — ...
6. Robot verifies locators (thread)       ← Spec still passing
7. Eyes re-verifies (thread)              ← :white_check_mark: Verified fixed
8. Lead reacts :tada: (reaction)          ← done, moving on
```

This is the canonical flow. Every finding should follow this lifecycle. If a thread stalls at any step, the Lead pings the responsible person.
