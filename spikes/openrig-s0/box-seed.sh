#!/usr/bin/env bash
# Spike S0 — runs ON the box as the default user. Reads the keys JSON on stdin
# (never echoed). Seeds: test repo, rig dir, per-seat pi agent dirs (auth.json
# with the seat's OWN key + settings.json loading self-compact), then boots the
# daemon (loopback) and imports the rig. NOT production.
set -euo pipefail
RIG=spike
export OPENRIG_HOME=$HOME/.openrig
KEYS_JSON=$(cat)

# 1. Tiny test repo on branch sbx/spike
rm -rf /work/repo && sudo install -d -o "$USER" /work && mkdir -p /work/repo && cd /work/repo
git init -q -b sbx/spike && git config user.email spike@qds.local && git config user.name spike
printf '# spike repo\n' > README.md && git add . && git commit -qm init

# 2. Rig definition: two Pi seats (lead + worker) in pod "dev"
mkdir -p /work/rig/agents/lead /work/rig/agents/worker && cd /work/rig
for a in lead worker; do
  printf 'name: %s\nversion: "1.0.0"\nresources: {skills: []}\nprofiles: {default: {uses: {skills: []}}}\n' $a > agents/$a/agent.yaml
done
cat > rig.yaml <<EOF
version: "0.2"
name: $RIG
pods:
  - id: dev
    label: Dev
    members:
      - {id: lead,   agent_ref: "local:agents/lead",   profile: default, runtime: pi, model: "openrouter/anthropic/claude-haiku-4.5", cwd: /work/repo}
      - {id: worker, agent_ref: "local:agents/worker", profile: default, runtime: pi, model: "openrouter/deepseek/deepseek-v3.2", cwd: /work/repo}
    edges:
      - {kind: delegates_to, from: lead, to: worker}
EOF

# 3. Pre-seed per-seat pi agent dirs BEFORE launch (adapter only mkdirp's)
for seat in lead worker; do
  d=$OPENRIG_HOME/state/pi/dev-$seat@$RIG/agent
  mkdir -p "$d" && chmod 700 "$d"
  key=$(printf '%s' "$KEYS_JSON" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const k=JSON.parse(s).find(x=>x.seat===process.argv[1]);if(!k)process.exit(3);process.stdout.write(k.key)})' "$seat")
  umask 077; printf '{"openrouter":{"type":"api_key","key":"%s"}}' "$key" > "$d/auth.json"; unset key
  printf '{"extensions":["/opt/qds/pi-ext/self-compact/self-compact.ts"]}' > "$d/settings.json"
done

# 4. Daemon (loopback, no kernel) + import rig
rig daemon status >/dev/null 2>&1 || rig daemon start --no-kernel
for i in $(seq 1 30); do curl -fsS 127.0.0.1:7433/healthz >/dev/null 2>&1 && break; sleep 1; done
T0=$(date +%s)
curl -sS -X POST 127.0.0.1:7433/api/rigs/import -H "X-Rig-Root: /work/rig" -H 'Content-Type: text/yaml' --data-binary @/work/rig/rig.yaml
echo; echo "import returned after $(( $(date +%s)-T0 ))s"
