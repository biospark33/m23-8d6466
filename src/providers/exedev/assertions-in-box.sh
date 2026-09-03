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
#         — the EXECUTED ones only, and NOT necessarily in letter order. D-pre
#         (below) is hoisted above C's paid pings, so a refusal there emits a
#         lone `D` line with no `C` line at all: C did not fail, it never ran.
#         A consumer must not read a missing letter as a failure or infer the
#         letters arrive in sequence. The host records the complement
#         explicitly (`notRun` in SetupGateResult) rather than inferring it.
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
# ssh environment must not perturb word splitting or string matching below.
#
# F11 (2026-08-25): that hardening shipped as `IFS=' \t\n'` — SINGLE quotes,
# so IFS became the LITERAL characters {space, backslash, t, n} and C's
# `for m in $Models` shredded every slug containing n/t ("anthropic/…" →
# a, "", hropic/…; measured live three gates failed while n/t-less deepseek
# passed). Build the REAL three characters instead: printf emits space+tab+
# newline+x, command substitution keeps them (nothing trailing to strip), and
# the sentinel-x is removed so IFS is exactly {space, tab, newline}.
IFS="$(printf ' \t\nx')"
IFS="${IFS%x}"
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

# ── D-pre: the version-conditional half of D, hoisted BEFORE any spend ───────
# DF2.10 AC2 — the F14 arm is RE-AIMED, not re-tightened.
#
# F14 weakened D to tolerate an absent ~/.pi/agent/models.json because the box
# image had DRIFTED under us and pi 0.84.x never writes that file. Asserting
# presence would fail every factory box on day one, so the tolerance stays.
#
# What changes is that the tolerance is no longer UNCONDITIONAL. DF2.10 owns
# the pi version (ARG PI_VERSION in oci/exedev/Dockerfile), so "absence is
# production-legal" is a claim about a SPECIFIC pi series that somebody
# actually verified — not a property of pi forever. This constant records the
# series that claim was verified against. Bump PI_VERSION without revisiting
# it and the mismatch below IS the refusal, which is the point: an unreviewed
# runtime must not inherit a tolerance nobody re-checked for it.
#
# It runs HERE, ahead of C, because it is pure string comparison over values
# already on the box: nothing about it needs the paid chat/completions pings C
# makes or D's own provider call. A forgotten constant used to cost real spend
# on every box in the fleet before refusing (INV-2: no spend past budget).
#
# PI_REVIEWED_SERIES MUST MOVE WITH PI_VERSION. Two hand-written copies of the
# pinned version exist besides this constant's series — oci/exedev/Dockerfile
# (ARG PI_VERSION) and scripts/build-exedev-image.ts (export const PI_VERSION);
# the test fake IMPORTS the TS constant and is not a copy. A shell script
# cannot import it, so the binding is a test's job, not this file's — and that
# test EXISTS: tests/providers/exedev/setup-gate.test.ts, "DF2.10 AC2:
# assertions-in-box.sh's PI_REVIEWED_SERIES tracks the pinned PI_VERSION" greps
# this constant out of this file and compares it to the TS pin's series. Rename
# the constant or bump PI_VERSION alone and that test is the alarm.
PI_REVIEWED_SERIES="0.84"
# One definition of where the registry lives — the same expanduser the scan below uses.
models_json="$(python3 -c 'import os; print(os.path.expanduser("~/.pi/agent/models.json"))')"
# FAIL CLOSED on a failed path derivation: if that substitution died (python3
# passed the dep check but this invocation faulted), models_json is empty, and
# `[ ! -f "" ]` is true — so BOTH the D-pre arms and D's scan would read a
# PRESENT registry as tolerated absence. That is the one fail-OPEN shape in a
# gate whose every other arm refuses; refuse instead.
if [ -z "$models_json" ]; then
  emit D 0 "could not derive the models.json path (python3 expanduser printed nothing) — refusing rather than reading a possibly-present registry as absent"
  exit 3
fi
# ...and fail closed on a path that is not ABSOLUTE, which is the same hole one
# step along: os.path.expanduser is documented to return its argument UNCHANGED
# when expansion fails (HOME unset AND the uid has no /etc/passwd entry — a
# systemd exec context, a broken passwd mapping). It then prints the literal
# "~/.pi/agent/models.json", which is non-empty, so the emptiness guard above
# passes and `[ ! -f "~/.pi/agent/models.json" ]` tests a literal-tilde RELATIVE
# path that never exists — reading a PRESENT, possibly-unpriced registry as the
# tolerated absence. That is the one fail-OPEN shape in a gate whose every other
# arm refuses.
case "$models_json" in
  /*) : ;;
  *)
    emit D 0 "the models.json path did not expand to an absolute path ($models_json) — expanduser returns its argument unchanged when HOME is unset and the uid has no passwd entry, and a relative path would read a present registry as tolerated absence"
    exit 3
    ;;
esac
# Fail-closed on an unreadable version: empty never equals the reviewed series.
# (`set -u` only, no `set -e`/`pipefail` — see the prologue — so a `pi` that
# exits non-zero or a grep that matches nothing leaves this empty and the arms
# below decide, rather than aborting the script before they can.)
#
# Exact-LINE match first (grep -x): the real factory pi prints the bare version
# on a line of its own (measured, linux/amd64 image). A first-token grep binds
# to whatever semver-shaped string appears first — an update banner ("A new
# version 0.99.0 is available") would report the ADVERTISED version and refuse
# every box on a phantom pin bump. The fallback stays for "pi X.Y.Z" prefix
# forms, where no exact line exists to prefer — and it is ANCHORED to the
# version line itself, because an unanchored token scan re-opens the very
# banner failure the exact-line match was added to close: it is reached exactly
# when there is no bare-version line, which is the prefix form, and on
# "A new version 0.99.0 is available\npi 0.84.4" it yields 0.99 and the arms
# below then refuse EVERY box in the fleet.
#
# BOUNDED, and asked ONCE. This block exists to refuse cheaply before C's
# spend, and an unbounded `pi --version` defeats that on its own terms: D
# abandoned `pi -p` because pi's node client stalls nondeterministically on
# these boxes (see D below), and a stall here would burn the whole host-side
# gate budget and surface as a generic gate timeout rather than the D-pre
# refusal. The bound rides python3 — already a hard dependency asserted above —
# rather than coreutils `timeout`: a `command -v timeout` fallback to the bare
# call reintroduces the unbounded stall on exactly the boxes that lack it, so
# the one code path here is always bounded. A stall, a crash or a missing
# binary all leave the output empty, which the fail-closed arms below refuse.
#
# stdout goes to a temp FILE, never a pipe: on timeout `subprocess.run` kills
# the direct child, but a stalled pi that forked leaves a grandchild holding
# the write end of a captured PIPE, and the drain that follows the kill then
# blocks for the grandchild's whole lifetime — the bound would be no bound at
# all. A file has no such holder, so the kill is the end of it.
pi_version_out="$(python3 -c '
import subprocess, sys, tempfile
with tempfile.TemporaryFile("w+") as f:
    try:
        subprocess.run(["pi", "--version"], stdout=f, stderr=subprocess.DEVNULL, timeout=10)
    except Exception:
        pass
    f.seek(0)
    sys.stdout.write(f.read())
' 2>/dev/null)"
pi_full="$(printf '%s\n' "$pi_version_out" | grep -xE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
if [ -z "$pi_full" ]; then
  pi_full="$(printf '%s\n' "$pi_version_out" \
    | sed -n 's/^pi[[:space:]]\{1,\}\([0-9]\{1,\}\.[0-9]\{1,\}\.[0-9]\{1,\}\).*$/\1/p' | head -1)"
fi
pi_series="${pi_full%.*}"
# Recorded for D's re-check below: the absence tolerance is granted only to a
# registry that was ALSO absent here, before C's real network calls ran — a
# registry that disappears mid-gate is not "never there", it is a box mutating
# under the gate.
models_json_at_dpre="present"
if [ ! -f "$models_json" ]; then
  models_json_at_dpre="absent"
  if [ -z "$pi_full" ]; then
    # DISTINCT from the arm below: blaming a PI_VERSION bump here would state a
    # cause the evidence contradicts — the box could not report a version at
    # all. Gate B's `command -v pi` passing does not imply `pi --version` works.
    emit D 0 "the box could not report a pi version (pi --version printed nothing parseable) — the missing-registry tolerance is verified for pi series $PI_REVIEWED_SERIES only and cannot be granted to a runtime that will not identify itself"
    exit 3
  fi
  if [ "$pi_series" != "$PI_REVIEWED_SERIES" ]; then
    # This note never flows through the `case "$d_scan"` pass-matcher (this arm
    # emits and exits before it), but it must still not READ as the tolerated
    # absence: the host-side test pins that an UNREVIEWED refusal does not
    # contain the "custom registry absent" pass phrase, so a human or a
    # dashboard grepping notes cannot mistake a refusal for the tolerance.
    emit D 0 "pi series $pi_series is UNREVIEWED for a missing models.json (verified against $PI_REVIEWED_SERIES; box reports $pi_full) — PI_VERSION moved without re-checking whether absence is still production-legal"
    exit 3
  fi
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
# F14 (2026-08-25, gate qds-20260825-0250b0): the box image drifted — pi 0.84.2
# never writes models.json (its registry lives in pi's own store;
# models-store.json ships `{}`), and production readCustomRegistry treats a
# MISSING file as an EMPTY custom registry priced by the bundled catalog
# (validate.ts AC5). So absence is production-legal: D then rests on the
# provider usage.cost proof above and says so.
#
# DF2.10: legal FOR THE REVIEWED SERIES ONLY — that half is decided in D-pre,
# above C, because it is free and the refusal must not cost a fleet's spend.
# Reaching here with the file absent means the series WAS reviewed — PROVIDED
# it was already absent at D-pre. A file present there and absent now was
# removed mid-gate (C's network calls ran in between), and the tolerance is
# for a registry that was never written, not one that vanished under the gate.
if [ ! -f "$models_json" ]; then
  if [ "$models_json_at_dpre" = "present" ]; then
    emit D 0 "models.json was present at D-pre and is absent now — the registry disappeared mid-gate; the absence tolerance is not granted to a box mutating under the gate"
    exit 3
  fi
  d_scan="custom registry absent — production-legal (empty registry per AC5); rates proven by provider usage.cost"
else
# Unindented inside the `else` on purpose: the python body below is
# column-sensitive and lives inside this single-quoted string verbatim.
d_scan="$(python3 -c '
import json, sys
p = sys.argv[1]
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
' "$models_json")"
fi
# Two passing shapes (F14): the full-pricing scan result, or the AC5 absence
# note. Anything ELSE is a real cost-table failure.
case "$d_scan" in
  *"custom registry absent"*|*" models priced") : ;;
  *)
    emit D 0 "cost table not loadable: $d_scan"
    exit 3
    ;;
esac
if ! printf '%s' "$d_total" | python3 -c '
import sys, math
v = float(sys.stdin.read().strip() or 0)
sys.exit(0 if math.isfinite(v) and v > 0 else 1)
'; then
  emit D 0 "a real provider chat call reported usage cost.total = $d_total (must be > 0) — rates default to zero when models.json carries no cost block; the factory would report \$0.0000 while spending"
  exit 3
fi
emit D 1 "D: provider cost.total $d_total > 0; $d_scan"

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
