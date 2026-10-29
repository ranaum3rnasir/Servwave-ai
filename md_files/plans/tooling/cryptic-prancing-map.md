# Git & GitHub Setup Plan for ALPHA CRM

## Context
The project has 4 local commits on a `master` branch with no remote repository. ~33 files of uncommitted Step 5 work. Before starting Step 6, we need: security cleanup, a clean commit, a private GitHub repo, and a branching strategy for multi-session AI-assisted development.

## Current State

| Item | Status |
|------|--------|
| Local git repo | `master` branch, 4 commits |
| Remote (GitHub) | **None** — no remote configured |
| GitHub CLI (`gh`) | Installed (skip install step) |
| Uncommitted work | ~33 files (Step 5 enhancements, price book, email, skills) |
| Security issue | **Password in `.gitignore` comment** — needs cleanup |

---

## Execution Steps

### 1. Security Cleanup
**Files:** `.gitignore`, new `CREDENTIALS.md`

a. **Create `CREDENTIALS.md`** in project root with the Supabase password (and any other credentials/notes)
b. **Add `CREDENTIALS.md` to `.gitignore`**
c. **Remove the password comment** from `.gitignore` (line: `# ALPHA_CRM Supabase pass: AlphaCRM1001!`)
d. **Untrack `.mcp.json`**: `git rm --cached .mcp.json` (it was tracked before being added to `.gitignore`)
e. **Untrack `.claude/settings.local.json`**: `git rm --cached .claude/settings.local.json`
f. **Add to `.gitignore`** if not already there: `CREDENTIALS.md`, `.claude/settings.local.json`

### 2. Commit All Uncommitted Work
Stage and commit all Step 5 work as one clean commit:
```bash
git add -A
git status                    # Review — no secrets, no .env files
git commit -m "feat: complete Step 5 — price book, email notifications, estimate enhancements"
```

### 3. Authenticate GitHub CLI
```bash
gh auth login
# → GitHub.com → HTTPS → Login with browser
gh auth status               # Verify
```

### 4. Create Private GitHub Repo + Push
```bash
gh repo create ALPHA_CRM --private --source=. --push
```

### 5. Rename Branch to `main`
```bash
git branch -m master main
git push -u origin main
gh repo edit --default-branch main
# Clean up old master ref on remote
git push origin --delete master
```

### 6. Verify
```bash
gh repo view                 # Shows private repo
git remote -v                # Shows GitHub origin
git log --oneline            # Clean 5-commit history
```

---

## Branching Strategy Going Forward

### Trunk-Based with Feature Branches

```
main (always stable, deployable)
  ├── step-6/job-backend       ← backend work
  ├── step-6/job-frontend      ← frontend work
  └── fix/estimate-bug         ← hotfixes
```

### Rules
1. **`main` is always stable.** Merge only after tests pass.
2. **One branch per task.** Create from latest `main`:
   ```bash
   git checkout main && git pull
   git checkout -b step-6/job-backend
   ```
3. **Commit frequently.** Small, atomic commits — don't accumulate giant diffs.
4. **Merge via PR or fast-forward** when work is done and tests pass.
5. **Delete branches after merge.**

### Multi-Session Parallel Work
- **Session A:** `step-6/job-backend` (controller + routes + tests)
- **Session B:** `step-6/job-frontend` (pages + components)
- These touch different files → safe to parallelize
- Merge backend first → rebase frontend onto updated `main` → merge frontend
- **If sessions would touch the same files:** run sequentially on one branch instead

### Commit Message Convention (Conventional Commits)
```
feat: add job CRUD endpoints
fix: estimate tax calculation rounding
test: add job controller unit tests
refactor: extract pagination helper
docs: update CLAUDE.md for Step 6
chore: update dependencies
```

### What NOT to Do
- Don't commit `.env`, `.mcp.json`, or `CREDENTIALS.md`
- Don't force-push to `main`
- Don't use `git add .` blindly — always review `git status` first
- Don't accumulate massive uncommitted diffs across sessions
