#!/usr/bin/env bash
# check-defensive-programming.sh — pre-PR advisory gate (qds-dev Phase 5).
#
# Scans ADDED lines of changed .ts files for the defensive-programming gaps
# that historically dominated bot-review cycles (qds-dev learnings D016-D020;
# this repo's own record: DF1.5's dead `??` fallbacks):
#
#   D016  `as any` / `as unknown as` casts — erases the type the compiler
#         would have caught the bug with
#   D017  an ADDED async function whose body awaits but has no try/catch
#         anywhere in that function — a rejection escapes as an unstructured
#         crash. Function-scoped (review round 6): a try in a sibling
#         function no longer suppresses the finding.
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
#   scripts/dev/check-defensive-programming.sh --code-only <file>
#       (emits the blanked code-only view of one file; shared with
#       tests/phase-engine/usage.test.ts so scanner and invariant test use
#       ONE blanker)

set -euo pipefail

# Byte-wise, locale-independent text processing. macOS awk in a UTF-8 locale
# raises "towc: multibyte conversion failure" on any line carrying a non-ASCII
# byte and SKIPS that record — the blanker, the D020 depth walk and the D017
# frame walk all silently lost coverage of every file containing an em dash
# (which is most of them here). Under C the same bytes pass through untouched.
# Every pattern in this file is ASCII, so nothing else changes.
export LC_ALL=C

BASE="origin/main"
WARN=0
CODE_ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --code-only) CODE_ONLY="$2"; shift 2 ;;
    --warn) WARN=1; shift ;;
    *) echo "unknown flag: $1" >&2; echo "usage: $0 [--base <ref>] [--warn] [--code-only <file>]" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

FINDINGS=0

# Held in variables: an unquoted '' inside [[ =~ ]] collapses to the empty
# string and the pattern degrades to "any ?? at all" (found the hard way).
# D016 is word-boundaried on both ends (round 8): a bare substring pattern
# also matched "has any idea" / "as anything" in comments and prose. POSIX
# ERE has no \b, so the boundaries are spelled out.
D016_RE='(^|[^A-Za-z0-9_])as[[:space:]]+any([^A-Za-z0-9_]|$)|(^|[^A-Za-z0-9_])as[[:space:]]+unknown[[:space:]]+as([^A-Za-z0-9_]|$)'
D018_RE='(\?\?|\|\|)[[:space:]]*(""|'"''"')'
D019_RE='catch[[:space:]]*(\(.*\))?[[:space:]]*\{[[:space:]]*\}[[:space:]]*$'
D020_RE='JSON\.parse\('

# Code-only view of a file: blanks string/char/template literals and
# line/block comments (state carries across lines), so braces and keywords
# inside them cannot skew the walkers below. ${...} interpolation expressions
# are executable code and stay VISIBLE, with braces inside them blanked so
# the frame/depth walkers stay true (review round 7). Known ceilings: regex
# literals; nested templates and string literals inside an interpolation are
# emitted verbatim.
blank_code() { # file
  awk '
    BEGIN { in_bc = in_str = in_chr = in_tpl = in_itp = d_itp = esc = 0 }
    {
      out = ""
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (in_lc) break
        if (in_bc) {
          out = out " "
          if (substr($0, i, 2) == "*/") { in_bc = 0; i++ }
          continue
        }
        if (in_itp) {
          # Inside a template ${...} interpolation: executable code. Emit it
          # verbatim so D017/D020 and the usage invariant scan see it, but
          # blank braces so the frame and depth walkers stay true (round 7).
          if (c == "{") { d_itp++; out = out " " }
          else if (c == "}") {
            if (d_itp > 0) { d_itp--; out = out " " }
            else { in_itp = 0; out = out " " }
          }
          else out = out c
          continue
        }
        if (in_str || in_chr || in_tpl) {
          out = out " "
          if (esc) esc = 0
          else if (c == "\\") esc = 1
          else if (in_str && c == "\"") in_str = 0
          else if (in_chr && c == "\47") in_chr = 0
          else if (in_tpl && c == "`") in_tpl = 0
          # ${ opens an interpolation (an escaped \${ stays literal); the "$"
          # was blanked above and the "{" is consumed here (review round 7).
          else if (in_tpl && substr($0, i, 2) == "${") { in_itp = 1; d_itp = 0; i++ }
          continue
        }
        if (substr($0, i, 2) == "//") { in_lc = 1; out = out "  "; i++ }
        else if (substr($0, i, 2) == "/*") { in_bc = 1; out = out "  "; i++ }
        else if (c == "\"") { in_str = 1; out = out " " }
        else if (c == "\47") { in_chr = 1; out = out " " }
        else if (c == "`") { in_tpl = 1; out = out " " }
        else out = out c
      }
      in_lc = 0
      print out
    }
  ' "$1"
}

# D020 — exit 0 iff every JSON.parse on the target line sits inside an open
# try block, evaluated at each call's source position. Depth-stack model: `d`
# is the absolute brace depth walked over the code-only view; a `try {`
# token pushes the depth of its body, and any `}` pops try blocks it closes.
# try tokens are pushed when the walk REACHES them, not pre-registered at
# line start (review round 6) — so a parse earlier on the line than a
# same-line try is correctly reported as unguarded. The dp:ok annotation is
# the escape hatch for the lexer ceilings above.
dp020_guarded() { # file lineno
  blank_code "$1" | awk -v target="$2" '
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
    # Walk up to the next try-open or JSON.parse token, whichever comes
    # first. Returns "try" (pushed at its source position), "parse" (guard
    # state to evaluate NOW), or "" at end of line. Word-boundary prefixes
    # keep `retry` and `myJSON.parse` from matching.
    function step() {
      if (!match(rest, /(^|[^A-Za-z0-9_])try[[:space:]]*[{]|(^|[^A-Za-z0-9_.])JSON\.parse/)) {
        walk(rest)
        rest = ""
        return ""
      }
      pre = substr(rest, 1, RSTART - 1)
      tok = substr(rest, RSTART, RLENGTH)
      rest = substr(rest, RSTART + RLENGTH)
      walk(pre)
      if (tok ~ /try/) {
        walk(tok) # consumes the opening brace: d is now the try body depth
        stack[++sp] = d
        return "try"
      }
      return "parse"
    }
    NR == target {
      rest = $0
      do {
        t = step()
        if (t == "parse" && sp <= 0) exit 1
      } while (t != "")
      exit 0
    }
    { rest = $0; while (step() != "") {} }
  '
}

# D017 — prints the start line of each ADDED async function whose body
# awaits but contains no try/catch anywhere in that function (review round
# 6). Frame model over the code-only view: a `{` at paren depth 0 opens a
# frame (braces inside parens are destructuring, not a body); `async` arms
# the next such frame; `await` marks the current frame and its nearest async
# ancestor; `try` marks the current frame. A frame that closes async +
# awaiting + try-less is a finding. Ceilings: braces at paren depth > 0
# (inline callbacks) and brace-less arrow bodies are not tracked; an
# identifier merely NAMED async arms the next brace — dp:ok is the hatch.
d017_scan() { # file added_line_csv
  blank_code "$1" | awk -v added_csv="$2" '
    BEGIN {
      k = split(added_csv, a, ",")
      for (i = 1; i <= k; i++) if (a[i] != "") added[a[i]] = 1
      sp = pd = pend_async = bad = 0
    }
    function openFrame(isAsync) {
      sp++
      as[sp] = isAsync; aw[sp] = 0; tr[sp] = 0; ln[sp] = NR
    }
    function closeFrame() {
      if (sp > 0) {
        if (as[sp] && aw[sp] && !tr[sp] && (ln[sp] in added)) { print ln[sp]; bad = 1 }
        sp--
      }
    }
    function onAwait() {
      if (sp <= 0) return
      aw[sp] = 1
      for (j = sp; j >= 1; j--) if (as[j]) { aw[j] = 1; break }
    }
    {
      n = length($0)
      w = ""
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (c ~ /[A-Za-z0-9_$]/) { w = w c; continue }
        if (w == "async") pend_async = 1
        else if (w == "try" && sp > 0) tr[sp] = 1
        else if (w == "await") onAwait()
        w = ""
        if (c == "(") pd++
        else if (c == ")") { if (pd > 0) pd-- }
        # pend_async survives braces at paren depth > 0 (round 8): the {} of a
        # default parameter like async function f(opts = {}) { must not disarm
        # the async that the function body brace should consume.
        else if (c == "{") { openFrame(pd == 0 && pend_async); if (pd == 0) pend_async = 0 }
        else if (c == "}") closeFrame()
      }
      # A keyword ending the line is still only in the w buffer — flush it
      # or the last word of every line is silently dropped (round 7): async
      # at end-of-line armed nothing, so the frame opened by the next line
      # escaped D017 even while awaiting with no try/catch.
      if (w == "async") pend_async = 1
      else if (w == "try" && sp > 0) tr[sp] = 1
      else if (w == "await") onAwait()
    }
    END { exit bad ? 1 : 0 }
  '
}

report() { # file line rule text
  if grep -q "dp:ok" <(sed -n "$2p" "$1") 2>/dev/null; then return 0; fi
  echo "FINDING [$3] $1:$2 — $4"
  FINDINGS=$((FINDINGS + 1))
}

# Emit the code-only view of one file and exit — consumed by
# tests/phase-engine/usage.test.ts so the invariant scan and this gate share
# ONE blanker implementation; a lexer fix lands in both at once (round 7).
if [[ -n "${CODE_ONLY:-}" ]]; then
  [[ -f "$CODE_ONLY" ]] || { echo "not a file: $CODE_ONLY" >&2; exit 2; }
  blank_code "$CODE_ONLY"
  exit 0
fi

# Tool failures propagate (review round 6): a failed git diff must stop the
# gate, not silently scan an empty file set and print OK.
# Diff from the merge-base, not BASE's tip (round 8): once BASE advances past
# the fork point, its own edits appear reversed in a tip diff — lines main
# DELETED would surface as "added" hunks and get scanned as if this branch
# wrote them. The merge-base is also the per-file diff base below.
MB="$(git merge-base "${BASE}" HEAD)"
CHANGED="$(git diff --name-only --diff-filter=ACMR "${MB}" -- '*.ts' | sort -u)"
if [[ -n "$CHANGED" ]]; then
  # bash-3.2 portable mapfile -t (macOS ships 3.2). The here-string appends
  # the trailing newline that command substitution strips, so every element
  # is read normally; the `|| [[ -n $line ]]` arm is dead here but kept
  # uniform with the blank_code instance below, where command output may
  # lack a final newline and the arm is what captures the last element.
  FILES=()
  while IFS= read -r line || [[ -n $line ]]; do FILES+=("$line"); done <<< "$CHANGED"
else
  FILES=()
fi

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue

  # Code-only view, line-indexed: blank_code preserves line count 1:1, so
  # BLANKED[n-1] is the code-only text of added line n. D016 matches cast
  # keywords against this view (round 9) — a mention of `as any` in a
  # comment or string literal is not a cast. Real casts keep their keywords;
  # ${...} interpolation code stays visible. Regex literals remain a lexer
  # ceiling — dp:ok is the hatch.
  BLANKED=()
  while IFS= read -r line || [[ -n $line ]]; do BLANKED+=("$line"); done < <(blank_code "$f")

  # Walk added hunks with their line numbers.
  while IFS=$'\t' read -r lineno text; do
    [[ -z "$lineno" ]] && continue
    # dp:ok is written in a comment, so this check must see the RAW line.
    [[ "$text" =~ dp:ok ]] && continue

    if [[ "${BLANKED[$((lineno - 1))]}" =~ $D016_RE ]]; then
      report "$f" "$lineno" "D016" "type-erasing cast on an added line"
    fi
    # Empty-string literal ONLY (`?? ""` / `|| ''`); a fallback to a real
    # default value is normal code. D018/D019 deliberately match the RAW
    # line: the "" / '' IS a string literal (blanking would erase the very
    # thing D018 detects), and D019 on a blanked line would newly flag
    # `catch (e) { /* ... */ }` as an empty block.
    if [[ "$text" =~ $D018_RE ]]; then
      report "$f" "$lineno" "D018" "silent empty-string fallback — validate instead of blanking"
    fi
    if [[ "$text" =~ $D019_RE ]]; then
      report "$f" "$lineno" "D019" "empty catch block swallows the failure"
    fi
    if [[ "$text" =~ $D020_RE ]] && ! dp020_guarded "$f" "$lineno"; then
      report "$f" "$lineno" "D020" "unguarded JSON.parse on non-literal input"
    fi
  done < <(git diff "${MB}" -- "$f" | awk '
    /^@@ / { match($0, /\+[0-9]+/); n = substr($0, RSTART + 1, RLENGTH - 1) - 1; next }
    /^ / { n++ }
    /^\+/ && !/^\+\+\+/ { n++; print n "\t" substr($0, 2) }
  ')

  # D017 needs whole-function context: report each ADDED async function that
  # awaits with no try/catch anywhere in its own body.
  ADDED_CSV="$(git diff "${MB}" -- "$f" | awk '
    /^@@ / { match($0, /\+[0-9]+/); n = substr($0, RSTART + 1, RLENGTH - 1) - 1; next }
    /^ / { n++ }
    /^\+/ && !/^\+\+\+/ { n++; printf "%s,", n }
  ')"
  while IFS= read -r lineno; do
    [[ -z "${lineno:-}" ]] && continue
    report "$f" "$lineno" "D017" "async function awaits but has no try/catch in its body"
  done < <(d017_scan "$f" "$ADDED_CSV")
done

if [[ $FINDINGS -gt 0 ]]; then
  echo "FAIL: ${FINDINGS} defensive-programming finding(s). Fix, or annotate with '// dp:ok <reason>' (or /* dp:ok ... */)."
  [[ $WARN -eq 1 ]] && { echo "(--warn: advisory only)"; exit 0; }
  exit 1
fi
echo "OK: no defensive-programming findings in ${#FILES[@]} changed .ts file(s)."
