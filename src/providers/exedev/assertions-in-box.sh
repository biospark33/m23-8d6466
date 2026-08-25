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
#         ordering, INV-2) · 125 = a named missing dependency, never a false
#         fail. 125, not 127: /bin/sh's own command-not-found IS 127, and the
#         host must keep a bare 127 meaning "the gate did not run" (fail-closed).
#
# Content over exit status (INV-3): every check inspects WHAT came back.
# pi --list-models exits 0 while printing "No models available" — that trap is
# assertion B's (host-side); here, D inspects the cost table's CONTENT and E
# computes credit rather than trusting any single field name.

set -u
# round 7: hermetic parsing — a polluted IFS or non-C locale inherited from the
# ssh environment must not perturb word splitting or string matching below
IFS=' \t\n'
export LC_ALL=C

Roster="${1:?usage: assertions-in-box.sh <rosterPath> <envFile> <model>...}"
EnvFile="${2:?missing envFile argument}"
shift 2
Models="$*"

# ── dependencies: named, up front (Infra Prerequisites row 5) ───────────────
# round 6: name every missing dep in one pass — sequential discovery wasted operator cycles
missing=""
for dep in curl python3 pi; do
  command -v "$dep" >/dev/null 2>&1 || missing="$missing $dep"
done
if [ -n "$missing" ]; then
  echo "missing dependency:$missing" >&2
  exit 125
fi

# ── the runtime key: box-local only — never printed, never in a note, never
# in a curl argv (it rides stdin via `curl -K -`, invisible to `ps`) ─────────
if [ ! -r "$EnvFile" ]; then
  echo "missing dependency: env file $EnvFile (DF2.3 key delivery)" >&2
  exit 125
fi
# round 7: DF2.3 delivers mode 0600 — drift to 0644 before sourcing is a contract violation
env_mode="$(python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode)[-3:])' "$EnvFile" 2>/dev/null)" || {
  echo "missing dependency: python3 (0600 mode check)" >&2
  exit 125
}
if [ "$env_mode" != "600" ]; then
  echo "missing dependency: env file $EnvFile mode is $env_mode not 0600 (DF2.3 contract violation)" >&2
  exit 125
fi
# shellcheck disable=SC1090
. "$EnvFile"
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "missing dependency: OPENROUTER_API_KEY in $EnvFile" >&2
  exit 125
fi

emit() {
  # $1=item $2=1|0 $3=note — python3 builds the JSON so notes need no escaping.
  python3 -c 'import json,sys; print(json.dumps({"item": sys.argv[1], "ok": sys.argv[2] == "1", "note": sys.argv[3]}))' \
    "$1" "$2" "$3"
}

# ── empty roster is a wiring bug: the host-side parser guarantees ≥1 model, so
# an empty list here means C would "pass" vacuously (0/0 answered). Fail C —
# nothing was proven (placed after emit's definition for obvious reasons).
if [ -z "$Models" ]; then
  emit C 0 "no models in the roster — nothing was proven; the host-side parser guarantees at least one model, so an empty list here is a wiring bug"
  exit 2
fi

# ── C: live model ping per roster model (setup.just:169-201) ────────────────
# A real chat/completions POST per model, ZDR + no data collection on the
# route, accepting `content` OR `reasoning` — reasoning models answer with
# content=null and the text under .reasoning; accepting only .content here
# produces false failures.
#
# max_tokens is EXPLICIT (8, D's own figure) because the provider DEFAULT is
# the model's max output — for high-ceiling slugs that worst case exceeds a
# capped run key's whole limit and OpenRouter refuses the ping outright:
# MEASURED live 2026-08-25, anthropic/claude-haiku-4.5 against a 50,000 µ$ key
# → 402 "You requested up to 64000 tokens, but can only afford 50000" — the
# gate then fails C on a healthy model + healthy key. Bounding the request
# keeps the ping inside any cap the fleet can mint (F10).
c_fail=""
c_count=0
for m in $Models; do
  c_count=$((c_count + 1))
  resp="$(printf 'header = "Authorization: Bearer %s"\n' "$OPENROUTER_API_KEY" \
    | curl -s --max-time 30 -K - https://openrouter.ai/api/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$m\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"reply with the single word: ready\"}],\"provider\":{\"zdr\":true,\"data_collection\":\"deny\"}}")"
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
# D's instrument is the provider's own usage.cost from a real curl chat call
# (same seam as C), NOT `pi -p`: pi's node streaming client stalls
# nondeterministically on exe.dev boxes (measured 2026-08-19, runs 9-17: gate
# D hung or returned cost.total = 0 on cold/stalled calls while curl-based C
# passed every run), and the provider-computed cost is the stronger proof
# that rates flow — it is the number the key is actually billed on.
d_body='{"model":"'"$(printf '%s' "$Models" | awk '{print $1}')"'","messages":[{"role":"user","content":"reply with the single word: ready"}],"max_tokens":8}'
# Body and HTTP status captured from ONE call: status via -w, body via -o. A
# transport-level curl failure leaves d_code empty/000 — distinct below from a
# genuine (200) zero-cost answer.
d_tmp="${TMPDIR:-/tmp}/df24-d-resp.$$"
d_code="$(printf 'header = "Authorization: Bearer %s"\n' "$OPENROUTER_API_KEY" \
  | curl -sS --max-time 60 -K - -H "Content-Type: application/json" -d "$d_body" \
    -o "$d_tmp" -w '%{http_code}' https://openrouter.ai/api/v1/chat/completions)" || true
d_resp="$(cat "$d_tmp" 2>/dev/null || printf '')"
rm -f "$d_tmp"
case "$d_code" in
  2*) : ;;
  *)
    emit D 0 "provider chat call failed (HTTP ${d_code:-none}) — the cost flow is unproven; this is a provider/transport error, NOT a genuine zero-cost response"
    exit 3
    ;;
esac
d_total="$(printf '%s' "$d_resp" | python3 -c '
import json, sys
# usage.cost shape is route-dependent: {"total": x} on some upstreams, a bare
# float on others (measured 2026-08-19: GMICloud returns the scalar).
try:
    c = (json.load(sys.stdin).get("usage") or {}).get("cost")
except Exception:
    c = None
if isinstance(c, dict):
    print(c.get("total") or 0)
elif isinstance(c, (int, float)):
    print(c)
else:
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
import sys, math
v = float(sys.stdin.read().strip() or 0)
sys.exit(0 if math.isfinite(v) and v > 0 else 1)
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
key_json="$(printf 'header = "Authorization: Bearer %s"\n' "$OPENROUTER_API_KEY" \
  | curl -s --max-time 30 -K - https://openrouter.ai/api/v1/key)"  # round 6: a hung key endpoint burned the whole gate budget instead of failing fast
e_note="$(printf '%s' "$key_json" | python3 -c '
import json, math, sys
try:
    d = json.load(sys.stdin).get("data", {})
except Exception:
    print("key endpoint body unparseable"); sys.exit(1)
if not isinstance(d, dict):
    print("key endpoint body has no data object"); sys.exit(1)
def finite_number(v):
    # python bool IS an int (True == 1) and json.load accepts bare NaN/Infinity
    # (round-4 review: {"limit": NaN} passed E because NaN <= 0 is false, and
    # NaN - anything is NaN, so remaining <= 0 never fired) — a credit value
    # must be a real, finite number or remaining cannot be computed at all.
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
limit, usage = d.get("limit"), d.get("usage", 0)
# usage: null → treat as 0 (nothing spent). limit: null → UNCAPPED fail (existing behavior).
if usage is None:
    usage = 0
if not finite_number(usage):
    print("usage is not a finite number — credit remaining cannot be computed"); sys.exit(1)
if limit is None:
    print("limit is null — UNCAPPED key; DF2.3 INV-CRED-1 requires a capped key"); sys.exit(1)
if not finite_number(limit):
    print("limit is not a finite number — credit remaining cannot be computed"); sys.exit(1)
# round 6: limit=-5, usage=-10 computed remaining=+5 and passed E
if limit <= 0:
    print(f"limit {limit:g} is not positive — remaining cannot be meaningful"); sys.exit(1)
if usage < 0:
    print(f"usage {usage:g} is negative — credit remaining cannot be computed"); sys.exit(1)
remaining = limit - usage
if remaining <= 0:
    print(f"no credit remaining: limit {limit} - usage {usage} = {remaining}"); sys.exit(1)
print(f"credit remaining {remaining:g} (limit {limit:g} - usage {usage:g}, computed — never limit_remaining)")
')"
e_status=$?
if [ "$e_status" -ne 0 ]; then
  emit E 0 "$e_note"
  exit 4
fi
emit E 1 "E: $e_note"

exit 0
