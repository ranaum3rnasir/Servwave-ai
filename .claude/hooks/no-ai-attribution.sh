#!/usr/bin/env bash
# CLAUDE.md rule 8: no AI attribution in git artifacts.
# PreToolUse(Bash) guard. Reads hook JSON on stdin; denies a git commit / gh pr
# command that carries a Co-Authored-By / "Generated with ... Claude" trailer.
# Backstop only - the `attribution` setting already suppresses the auto-added trailer.
cmd=$(jq -r '.tool_input.command // ""')

case "$cmd" in
  *"git commit"*|*"gh pr create"*|*"gh pr edit"*|*"gh pr comment"*) ;;
  *) exit 0 ;;  # not a commit/PR command - allow
esac

if printf '%s' "$cmd" | grep -qiE 'co-authored-by:.*claude|generated with.*claude|claude\.com/claude-code'; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"CLAUDE.md rule 8: no AI attribution in git artifacts. Remove the Co-Authored-By / Generated-with line, then retry."}}'
fi
exit 0
