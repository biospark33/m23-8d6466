#!/bin/sh
# DF2.2 — setup-gate assertions C/D/E, run INSIDE the box (INV-4: the runtime
# key never crosses the wire; this script reads the box's own 0600 env file,
# which DF2.3 delivered before setup started).
#
# argv (ARGUMENTS, never environment — `ssh host 'cmd'` carries no env, the
# measured upstream bug where every fan-out arm gated against models it would
# never call):
#   $1 = roster path   (the ACTIVE roster this gate is proving; notes only)
#   $2 = env file      (the box's key file, mode 0600)
#   $3.. = model ids   (bare ids, `openrouter/` prefix already stripped)
#
# stdout: one JSON line {"item","ok","note"} per executed assertion (C, D, E)
# exit:   0 all pass · 2=C · 3=D · 4=E (first failure stops the gate — spend
#         ordering, INV-2) · 127 = a named missing dependency, never a false fail
#
# Content over exit status (INV-3): every check inspects WHAT came back.
# pi --list-models exits 0 while printing "No models available" — that trap is
# assertion B's (host-side); here, D inspects the cost table's CONTENT and E
# computes credit rather than trusting any single field name.

set -u

Roster="${1:?usage: assertions-in-box.sh <rosterPath> <envFile> <model>...}"
EnvFile="${2:?missing envFile argument}"
shift 2
Models="$*"

# ── dependencies: named, up front (Infra Prerequisites row 5) ───────────────
for dep in curl python3 pi; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "missing dependency: $dep" >&2
    exit 127
  fi
done

# ── the runtime key: box-local only, never printed, never in a note ─────────
if [ ! -r "$EnvFile" ]; then
  echo "missing dependency: env file $EnvFile (DF2.3 key delivery)" >&2
  exit 127
fi
# shellcheck disable=SC1090
. "$EnvFile"
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "missing dependency: OPENROUTER_API_KEY in $EnvFile" >&2
  exit 127
fi

emit() {
  # $1=item $2=1|0 $3=note — python3 builds the JSON so notes need no escaping.
  python3 -c 'import json,sys; print(json.dumps({"item": sys.argv[1], "ok": sys.argv[2] == "1", "note": sys.argv[3]}))' \
    "$1" "$2" "$3"
}

# ── C: live model ping per roster model (setup.just:169-201) ────────────────
# A real chat/completions POST per model, ZDR + no data collection on the
# route, accepting `content` OR `reasoning` — reasoning models answer with
# content=null and the text under .reasoning; accepting only .content here
# produces false failures.
c_fail=""
c_count=0
for m in $Models; do
  c_count=$((c_count + 1))
  resp="$(curl -s --max-time 30 https://openrouter.ai/api/v1/chat/completions \
    -H "Authorization: Bearer $OPENROUTER_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word: ready\"}],\"provider\":{\"zdr\":true,\"data_collection\":\"deny\"}}")"
  if ! printf '%s' "$resp" | python3 -c '
import json, sys
try:
    msg = json.load(sys.stdin)["choices"][0]["message"]
except Exception:
    sys.exit(1)
c, r = msg.get("content"), msg.get("reasoning")
ok = (isinstance(c, str) and c.strip()) or (isinstance(r, str) and r.strip())
sys.exit(0 if ok else 1)
  '; then
    c_fail="$c_fail $m"
  fi
done
if [ -n "$c_fail" ]; then
  emit C 0 "no live answer (content or reasoning) from:$c_fail — roster $Roster; check the box egress and the runtime key"
  exit 2
fi
emit C 1 "C: $c_count/$c_count roster models answered over chat/completions (content or reasoning, zdr + deny)"

# ── D: cost table loaded (setup.just:205-243) ───────────────────────────────
# Two halves. (1) A REAL pi call must report cost.total > 0 — the wrong
# instrument is diffing /api/v1/key usage (it false-failed the first live
# mount). (2) EVERY model in ~/.pi/agent/models.json must be priced with all
# four keys: a partial cost block fails pi validation and drops the WHOLE
# roster; a missing/zero cost.input means the factory reports $0.0000 forever
# while genuinely spending (measured on a 463.6k-token run).
pi_json="$(if command -v timeout >/dev/null 2>&1; then timeout 60 pi -p --mode json "reply with the single word: ready" 2>/dev/null; else pi -p --mode json "reply with the single word: ready" 2>/dev/null; fi)"
d_total="$(printf '%s' "$pi_json" | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get("cost", {}).get("total", 0))
except Exception:
    print(0)
')"
d_scan="$(python3 -c '
import json, os, sys
p = os.path.expanduser("~/.pi/agent/models.json")
try:
    data = json.load(open(p)).get("models", {})
except Exception as e:
    print(f"models.json unreadable: {e}"); sys.exit(1)
if not data:
    print("models.json has no models — pi dropped the WHOLE roster or never loaded it"); sys.exit(1)
bad = []
for slug, entry in data.items():
    cost = entry.get("cost") if isinstance(entry, dict) else None
    if not isinstance(cost, dict) or any(k not in cost for k in ("input", "output", "cacheRead", "cacheWrite")):
        missing = [k for k in ("input", "output", "cacheRead", "cacheWrite") if not isinstance(cost, dict) or k not in cost]
        # chr(47) = "/": a literal "/" inside this python -c is fine (double
        # quotes work), but chr(47) keeps the whole block free of ANY quoting
        # hazard against the single-quoted shell wrapper.
        bad.append(f"{slug}: partial cost block (missing {chr(47).join(missing)}) — pi validation drops the WHOLE roster")
        continue
    if not cost.get("input"):
        bad.append(f"{slug}: cost.input is 0 — the factory reports $0.0000 while genuinely spending")
if bad:
    print("; ".join(bad)); sys.exit(1)
print(f"{len(data)}/{len(data)} models priced")
')"
if ! printf '%s' "$d_scan" | grep -q " models priced$"; then
  emit D 0 "cost table not loadable: $d_scan"
  exit 3
fi
if ! printf '%s' "$d_total" | python3 -c '
import sys
v = float(sys.stdin.read().strip() or 0)
sys.exit(0 if v > 0 else 1)
'; then
  emit D 0 "a real pi -p call reported cost.total = $d_total (must be > 0) — rates default to zero when models.json carries no cost block; the factory would report \$0.0000 while spending"
  exit 3
fi
emit D 1 "D: pi cost.total $d_total > 0; $d_scan"

# ── E: capped credit remaining (setup.just:245-255) ─────────────────────────
# GET /api/v1/key with the RUNTIME key; remaining is COMPUTED as limit - usage
# (never a limit_remaining field we have not verified). A null limit means
# UNCAPPED — DF2.3 INV-CRED-1 requires a capped key, so E fails. This proves
# headroom, never liveness: the endpoint answers 200 for a dead key, which is
# why C above is the liveness proof and runs first.
key_json="$(curl -s --max-time 30 https://openrouter.ai/api/v1/key -H "Authorization: Bearer $OPENROUTER_API_KEY")"
e_note="$(printf '%s' "$key_json" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin).get("data", {})
except Exception:
    print("key endpoint body unparseable"); sys.exit(1)
limit, usage = d.get("limit"), d.get("usage", 0)
if limit is None:
    print("limit is null — UNCAPPED key; DF2.3 INV-CRED-1 requires a capped key"); sys.exit(1)
remaining = limit - usage
if remaining <= 0:
    print(f"no credit remaining: limit {limit} - usage {usage} = {remaining}"); sys.exit(1)
print(f"credit remaining {remaining:g} (limit {limit:g} - usage {usage:g}, computed — never limit_remaining)")
')"
if [ $? -ne 0 ]; then
  emit E 0 "$e_note"
  exit 4
fi
emit E 1 "E: $e_note"

exit 0
