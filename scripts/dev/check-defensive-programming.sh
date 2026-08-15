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
# D020 — true if the flagged line sits inside an open try block. Depth-stack
# model: `d` is the absolute brace depth walked from the top of the file; a
# `try {` line pushes the depth of its body, and any `}` pops try blocks it
# closes. Guarded = at least one try still on the stack. This keeps the outer
# scope when a nested try closes, and does not treat a closed try as a guard
# for a later parse. The target line is walked only up to the JSON.parse
# token before evaluating the stack, so a try/catch that closes earlier on
# that same line no longer counts as a guard. String/char/template literals
# and comments are blanked before counting, so
# braces inside them cannot skew the depth walk. Known ceilings (rare, drift
# in either direction): regex literals (/[{]/) and nested template
# interpolations are not lexed; the dp:ok annotation is the escape hatch.
dp020_guarded() { # file lineno
  awk -v target="$2" '
    function walk(str) { # update brace depth / try stack across a code-only string
      n = length(str)
      for (i = 1; i <= n; i++) {
        c = substr(str, i, 1)
        if (c == "{") d++
        else if (c == "}") {
          d--
          while (sp > 0 && stack[sp] > d) sp--
        }
      }
    }
    {
      # Blank literal/comment contents (→ spaces). State carries across
      # lines for block comments, multi-line templates, and backslash
      # continuations, so `cl` is the code-only view of the line.
      cl = ""
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (in_lc) break
        if (in_bc) {
          cl = cl " "
          if (substr($0, i, 2) == "*/") { in_bc = 0; i++ }
          continue
        }
        if (in_str || in_chr || in_tpl) {
          cl = cl " "
          if (esc) esc = 0
          else if (c == "\\") esc = 1
          else if (in_str && c == "\"") in_str = 0
          else if (in_chr && c == "\47") in_chr = 0
          else if (in_tpl && c == "`") in_tpl = 0
          continue
        }
        if (substr($0, i, 2) == "//") { in_lc = 1; cl = cl "  "; i++ }
        else if (substr($0, i, 2) == "/*") { in_bc = 1; cl = cl "  "; i++ }
        else if (c == "\"") { in_str = 1; cl = cl " " }
        else if (c == "\47") { in_chr = 1; cl = cl " " }
        else if (c == "`") { in_tpl = 1; cl = cl " " }
        else cl = cl c
      }
      in_lc = 0
      if (cl ~ /^[[:space:]]*try[[:space:]]*[{]/) stack[++sp] = d + 1
      if (NR == target) {
        # Evaluate the stack at the parse call, not line start: braces
        # earlier on this line may have closed the try before JSON.parse.
        p = match(cl, /JSON\.parse/)
        if (p == 0) exit 0 # token only inside a blanked literal — not a call
        walk(substr(cl, 1, p - 1))
        exit (sp > 0) ? 0 : 1
      }
      walk(cl)
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
