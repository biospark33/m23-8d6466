#!/usr/bin/env bash
# check-defensive-programming.sh — pre-PR advisory gate (qds-dev Phase 5).
#
# Scans ADDED lines of changed .ts files for the defensive-programming gaps
# that historically dominated bot-review cycles (qds-dev learnings D016-D020;
# this repo's own record: DF1.5's dead `??` fallbacks):
#
#   D016  `as any` / `as unknown as` casts — erases the type the compiler
#         would have caught the bug with
#   D017  async function with an awaited call but no try/catch anywhere in
#         its body — a rejection escapes as an unstructured crash
#   D018  silent empty-string fallbacks (`?? ""` / `|| ""`) on values that
#         should be validated, not blanked
#   D019  `catch {}` / `catch (e) {}` with an empty block — swallows the
#         failure the future debugger needs
#   D020  unguarded JSON.parse on non-literal input
#
# Findings are reported with file:line; exit is nonzero unless --warn
# downgrades to advisory. False positives are resolved by fixing the code or
# adding a `dp:ok <reason>` trailing comment on the flagged line (`// dp:ok
# ...` or `/* dp:ok ... */` in TypeScript — `#` is not a TS comment).
#
# Usage:
#   scripts/dev/check-defensive-programming.sh [--base <ref>] [--warn]

set -euo pipefail

BASE="origin/main"
WARN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --warn) WARN=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

FINDINGS=0

# Held in variables: an unquoted '' inside [[ =~ ]] collapses to the empty
# string and the pattern degrades to "any ?? at all" (found the hard way).
D018_RE='(\?\?|\|\|)[[:space:]]*(""|'"''"')'
D019_RE='catch[[:space:]]*(\(.*\))?[[:space:]]*\{[[:space:]]*\}[[:space:]]*$'
D020_RE='JSON\.parse\('
# D020 — true if the flagged line sits inside an open try block. Walks the
# file from the top with brace tracking: each `try {` line resets the state,
# and the matching close brace ends it, so a try that already closed does NOT
# guard a later parse. Same-line `try { JSON.parse(x) }` counts as guarded.
# Braces inside string/template literals can miscount — when in doubt the
# answer is "unguarded", and the dp:ok annotation is the escape hatch.
dp020_guarded() { # file lineno
  awk -v target="$2" '
    NR == target {
      if (!inside && $0 ~ /^[[:space:]]*try[[:space:]]*[{]/) inside = 1
      exit inside ? 0 : 1
    }
    /^[[:space:]]*try[[:space:]]*[{]/ { inside = 1; depth = 0 }
    inside {
      n = length($0)
      for (i = 1; i <= n && inside; i++) {
        c = substr($0, i, 1)
        if (c == "{") depth++
        else if (c == "}") { depth--; if (depth <= 0) inside = 0 }
      }
    }
  ' "$1"
}
report() { # file line rule text
  if grep -q "dp:ok" <(sed -n "$2p" "$1") 2>/dev/null; then return 0; fi
  echo "FINDING [$3] $1:$2 — $4"
  FINDINGS=$((FINDINGS + 1))
}

mapfile -t FILES < <(git diff --name-only --diff-filter=ACMR "${BASE}" -- '*.ts' | sort -u || true)

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue

  # Walk added hunks with their line numbers.
  while IFS=$'\t' read -r lineno text; do
    [[ -z "$lineno" ]] && continue
    [[ "$text" =~ dp:ok ]] && continue

    if [[ "$text" =~ as\ any|as\ unknown\ as ]]; then
      report "$f" "$lineno" "D016" "type-erasing cast on an added line"
    fi
    # Empty-string literal ONLY (`?? ""` / `|| ''`); a fallback to a real
    # default value is normal code.
    if [[ "$text" =~ $D018_RE ]]; then
      report "$f" "$lineno" "D018" "silent empty-string fallback — validate instead of blanking"
    fi
    if [[ "$text" =~ $D019_RE ]]; then
      report "$f" "$lineno" "D019" "empty catch block swallows the failure"
    fi
    if [[ "$text" =~ $D020_RE ]] && ! dp020_guarded "$f" "$lineno"; then
      report "$f" "$lineno" "D020" "unguarded JSON.parse on non-literal input"
    fi
  done < <(git diff "${BASE}" -- "$f" | awk '
    /^@@ / { match($0, /\+[0-9]+/); n = substr($0, RSTART + 1, RLENGTH - 1) - 1; next }
    /^ / { n++ }
    /^\+/ && !/^\+\+\+/ { n++; print n "\t" substr($0, 2) }
  ')

  # D017 needs whole-function context: approximate per added async line —
  # flag `async` additions whose file contains no try on a nearby region.
  # Kept cheap on purpose (see ponytail note): the per-line rules above carry
  # the load; this rule flags async functions added with zero try in the file.
  if git diff "${BASE}" -- "$f" | grep -q '^+.*async ' && ! grep -q 'try' "$f"; then
    echo "FINDING [D017] $f — async code added but no try/catch anywhere in the file"
    FINDINGS=$((FINDINGS + 1))
  fi
done

if [[ $FINDINGS -gt 0 ]]; then
  echo "FAIL: ${FINDINGS} defensive-programming finding(s). Fix, or annotate with '// dp:ok <reason>' (or /* dp:ok ... */)."
  [[ $WARN -eq 1 ]] && { echo "(--warn: advisory only)"; exit 0; }
  exit 1
fi
echo "OK: no defensive-programming findings in ${#FILES[@]} changed .ts file(s)."
