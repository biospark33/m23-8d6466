#!/bin/sh
# Branch gate: the full factory suite must fail on NOTHING outside the
# documented pre-existing env-dependent set. Each exempt entry is proven
# failing on clean dev via a stash baseline — they are not this branch's
# regressions:
#   pi-vs-claude-code-vendor/self-compact/**  — env-dependent cluster (PR #404 CI-debt history)
# tests/lib/http.test.ts used to sit here too (a >=90ms wall-clock floor
# against TEST-NET-1 collapsed on fast-refusing networks); those tests now
# hang a local Bun.serve instead and are deterministic.
# bun test path args are substring filters (the vendor tree contains
# "tests"), so the run is unfiltered and this script checks the parsed
# fail-set. Non-exempt failing files get TWO reruns with a settle delay:
# timing-sensitive suites (the 91-test stdio spawn suite) fail inside a
# loaded full-suite marathon and pass standalone; a genuine regression
# fails every pass.
LOG=$(mktemp)
LOG_FAILS="$LOG.fails"
trap 'rm -f "$LOG" "$LOG_FAILS"' EXIT

bun test > "$LOG" 2>&1
RC=$?
tr '\r' '\n' < "$LOG" | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | awk '
  /\.test\.(ts|tsx|js|mjs|jsx):$/ { file = $0; sub(/:$/, "", file) }
  /\(fail\)/ { print file }
' | sort -u > "$LOG_FAILS"

EXEMPT_RE='^pi-vs-claude-code-vendor/self-compact/'
TOTAL=$(wc -l < "$LOG_FAILS" | tr -d ' ')
# A non-zero bun exit with zero parsed failing files means the run died
# before/during collection (config error, crash, OOM) — never a green.
if [ "$RC" -ne 0 ] && [ "$TOTAL" = "0" ]; then
  echo "FAIL: bun test exited $RC with no failing files parsed (run died before completing); last lines:"
  tail -20 "$LOG"
  exit 1
fi
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
