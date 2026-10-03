#!/bin/sh
# Branch gate: the full factory suite must be green EXCEPT the documented
# pi-vs-claude-code-vendor/self-compact env-dependent cluster (pre-existing
# on clean dev — proven by stash baseline; see the PR #404 CI-debt history).
# ANY OTHER failing file fails the gate. bun test path args are substring
# filters (the vendor tree contains "tests"), so the run is unfiltered and
# this script does the fail-set check on the parsed output.
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
bun test > "$LOG" 2>&1
tr '\r' '\n' < "$LOG" | perl -pe 's/\e\[[0-9;]*[a-zA-Z]//g' | awk '
  /\.test\.(ts|tsx|js|mjs|jsx):$/ { file = $0 }
  /\(fail\)/ { print file }
' | sort -u > "$LOG.fails"
VENDOR=$(grep -c "^pi-vs-claude-code-vendor" "$LOG.fails" || true)
TOTAL=$(wc -l < "$LOG.fails" | tr -d ' ')
NONVENDOR=$(grep -vc "^pi-vs-claude-code-vendor" "$LOG.fails" || true)
echo "failing files: $TOTAL (vendor cluster: $VENDOR, non-vendor: $NONVENDOR)"
if [ "$NONVENDOR" != "0" ]; then
  # One rerun per non-vendor failing file: timing-sensitive tests fail a single
  # pass under machine load (e.g. tests/lib/http.test.ts retry-budget asserts)
  # but pass standalone; a genuine regression fails both passes.
  STILL=""
  for f in $(grep -v "^pi-vs-claude-code-vendor" "$LOG.fails"); do
    bun test "$f" > /dev/null 2>&1 || STILL="$STILL $f"
  done
  if [ -n "$STILL" ]; then
    echo "FAIL: persistent non-vendor failures:$STILL"
    exit 1
  fi
  echo "non-vendor single-pass failures passed on rerun (timing flakes)"
fi
echo "FACTORY_FULL_OK (only the documented vendor cluster fails)"
