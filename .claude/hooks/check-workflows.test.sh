#!/usr/bin/env bash
# Self-test for check-workflows.sh. Builds a throwaway git repo, then checks:
#   clean tree -> exit 0, silent
#   unrelated edit -> exit 0, silent
#   valid new workflow -> exit 0, silent
#   unclosed quote in a workflow -> exit 2, actionlint message on stderr
#   same broken file, actionlint missing from PATH -> exit 2, install hint
#   same broken file, shellcheck missing from PATH -> exit 2, install hint
# Run: bash .claude/hooks/check-workflows.test.sh
set -u
hook="$(cd "$(dirname "$0")" && pwd)/check-workflows.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fail=0

repo="$tmp/repo"
mkdir -p "$repo/.github/workflows"
git -C "$repo" init -q
cat > "$repo/.github/workflows/ok.yml" <<'YML'
name: ok
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
YML
echo readme > "$repo/README.md"
git -C "$repo" add -A
git -C "$repo" -c user.email=t@t -c user.name=t commit -qm init

run() { # $1 = PATH override (optional)
  if [ -n "${1:-}" ]; then
    printf '{"tool_name":"Bash","cwd":"%s"}' "$repo" | PATH="$1" CLAUDE_PROJECT_DIR="$repo" bash "$hook" 2>"$tmp/err" >"$tmp/out"
  else
    printf '{"tool_name":"Bash","cwd":"%s"}' "$repo" | CLAUDE_PROJECT_DIR="$repo" bash "$hook" 2>"$tmp/err" >"$tmp/out"
  fi
  echo $?
}
expect() { # name code want_code [stderr_grep]
  local name=$1 code=$2 want=$3 pat=${4:-}
  if [ "$code" != "$want" ]; then echo "FAIL $name: exit $code, want $want"; cat "$tmp/err"; fail=1; return; fi
  if [ -z "$pat" ] && [ -s "$tmp/err" ]; then echo "FAIL $name: expected silence, got:"; cat "$tmp/err"; fail=1; return; fi
  if [ -n "$pat" ] && ! grep -q "$pat" "$tmp/err"; then echo "FAIL $name: stderr lacks /$pat/:"; cat "$tmp/err"; fail=1; return; fi
  echo "ok   $name"
}

expect "clean tree" "$(run)" 0
echo more >> "$repo/README.md"
expect "unrelated edit" "$(run)" 0
cp "$repo/.github/workflows/ok.yml" "$repo/.github/workflows/new.yml"
expect "valid new workflow" "$(run)" 0
cat > "$repo/.github/workflows/broken.yml" <<'YML'
name: broken
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "unclosed
        name: "oops
YML
expect "unclosed quote" "$(run)" 2 "broken.yml"
# PATH without actionlint (keep git, jq, coreutils)
nopath="$tmp/bin"; mkdir -p "$nopath"
for t in git jq bash cat sort dirname mktemp grep; do
  p=$(command -v "$t") && ln -s "$p" "$nopath/$t"
done
expect "actionlint missing" "$(run "$nopath:/usr/bin:/bin")" 2 "brew install actionlint"
# actionlint present but shellcheck missing: run: scripts would go unchecked
ln -s "$(command -v actionlint)" "$nopath/actionlint"
expect "shellcheck missing" "$(run "$nopath:/usr/bin:/bin")" 2 "brew install shellcheck"

if [ $fail -eq 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; exit 1; fi
