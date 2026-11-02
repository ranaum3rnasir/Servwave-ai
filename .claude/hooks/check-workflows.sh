#!/usr/bin/env bash
# PostToolUse guard: lint GitHub workflow files the moment an agent changes them.
#
# A workflow file that does not parse never runs, so GitHub reports nothing and
# the break is only found a review round later. This hook runs after every tool
# call that can change files (Edit/Write/MultiEdit/NotebookEdit and Bash, since
# agents also edit with sed and heredocs).
#
# Cheap by design: it does nothing unless a *.yml/*.yaml file under
# .github/workflows/ differs from HEAD (modified, staged or untracked), and then
# runs actionlint on just those files.
#
# Contract (Claude Code PostToolUse): exit 0 = fine, silent. Exit 2 = the
# message on stderr is fed back to the agent. Missing actionlint also exits 2.
#
# Repos checked: $CLAUDE_PROJECT_DIR, plus the repo of the hook input's cwd and
# of tool_input.file_path, so an agent whose session sits in the main checkout
# but edits a worktree is still covered.

set -u

input=$(cat 2>/dev/null || true)

candidates=()
[ -n "${CLAUDE_PROJECT_DIR:-}" ] && candidates+=("$CLAUDE_PROJECT_DIR")
if command -v jq >/dev/null 2>&1 && [ -n "$input" ]; then
  cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
  fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
  [ -n "$cwd" ] && candidates+=("$cwd")
  [ -n "$fp" ] && candidates+=("$(dirname "$fp")")
fi
[ ${#candidates[@]} -eq 0 ] && candidates+=("$PWD")

roots=()
for c in "${candidates[@]}"; do
  [ -d "$c" ] || continue
  r=$(git -C "$c" rev-parse --show-toplevel 2>/dev/null) || continue
  case " ${roots[*]-} " in *" $r "*) ;; *) roots+=("$r") ;; esac
done

status=0
for root in "${roots[@]-}"; do
  [ -n "$root" ] || continue
  [ -d "$root/.github/workflows" ] || continue

  changed=$(
    {
      git -C "$root" diff --name-only HEAD -- .github/workflows 2>/dev/null
      git -C "$root" ls-files --others --exclude-standard -- .github/workflows 2>/dev/null
    } | sort -u
  )
  [ -n "$changed" ] || continue

  files=()
  while IFS= read -r f; do
    case "$f" in *.yml|*.yaml) ;; *) continue ;; esac
    [ -f "$root/$f" ] && files+=("$f")   # deleted files have nothing to lint
  done <<< "$changed"
  [ ${#files[@]} -gt 0 ] || continue

  # actionlint checks `run:` scripts only through shellcheck, and skips them
  # silently when shellcheck is absent, so both are required.
  missing=()
  command -v actionlint >/dev/null 2>&1 || missing+=(actionlint)
  command -v shellcheck >/dev/null 2>&1 || missing+=(shellcheck)
  if [ ${#missing[@]} -gt 0 ]; then
    {
      echo "check-workflows: ${missing[*]} not installed, so these changed workflow files were NOT checked:"
      printf '  %s\n' "${files[@]}"
      echo "Install with: brew install ${missing[*]}   (then retry)"
    } >&2
    exit 2
  fi

  # Run from the repo root so .github/actionlint.yaml (if any) is picked up.
  if ! out=$(cd "$root" && actionlint -no-color -oneline "${files[@]}" 2>&1); then
    {
      echo "check-workflows: actionlint found problems in changed workflow files under $root."
      echo "A workflow that does not parse never runs on GitHub, so fix these now:"
      echo "$out"
    } >&2
    status=2
  fi
done

exit "$status"
