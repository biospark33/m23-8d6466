#!/bin/sh
# Branch gate: the full factory suite must fail on NOTHING outside the
# documented pre-existing env-dependent set. Each exempt entry is proven
# failing on clean dev via a stash baseline — they are not this branch's
# regressions:
#   pi-vs-claude-code-vendor/self-compact/**  — env-dependent cluster (PR #404 CI-debt history)
#   tests/lib/http.test.ts                    — retry-budget wall-clock assert assumes 192.0.2.1:9
#                                               times out at 50ms/attempt; this network refuses fast,
#                                               so the >=90ms assert fails intermittently (1-in-2..3 runs)
# bun test path args are substring filters (the vendor tree contains
# "tests"), so the run is unfiltered and this script checks the parsed
# fail-set. Non-exempt failing files get TWO reruns with a settle delay:
# timing-sensitive suites (the 91-test stdio spawn suite, the http asserts)
# fail inside a loaded full-suite marathon and pass standalone; a genuine
# regression fails every pass.
LOG=$(mktemp)
LOG_FAILS="$LOG.fails"
trap 'rm -f "$LOG" "$LOG_FAILS"' EXIT

bun test > "$LOG" 2>&1
tr '\r' '\n' < "$LOG" | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | awk '
  /\.test\.(ts|tsx|js|mjs|jsx):$/ { file = $0 }
  /\(fail\)/ { print file }
' | sort -u > "$LOG_FAILS"

EXEMPT_RE='^(pi-vs-claude-code-vendor/|tests/lib/http\.test\.ts)'
TOTAL=$(wc -l < "$LOG_FAILS" | tr -d ' ')
UNDOCUMENTED=$(grep -vc "$EXEMPT_RE" "$LOG_FAILS" || true)
echo "failing files: $TOTAL (documented-exempt: $((TOTAL - UNDOCUMENTED)), undocumented: $UNDOCUMENTED)"
if [ "$UNDOCUMENTED" = "0" ]; then
  echo "FACTORY_FULL_OK (only the documented pre-existing set fails)"
  exit 0
fi

STILL=""
for f in $(grep -v "$EXEMPT_RE" "$LOG_FAILS"); do
  ok=""
  for attempt in 1 2; do
    sleep 5
    if bun test "$f" > /dev/null 2>&1; then ok=1; break; fi
  done
  [ -n "$ok" ] || STILL="$STILL $f"
done
if [ -n "$STILL" ]; then
  echo "FAIL: persistent undocumented failures:$STILL"
  exit 1
fi
echo "non-exempt single-pass failures passed on rerun (load flakes)"
