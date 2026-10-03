# Vultr VPS Deploy Runbook — swarmclaw platform + Hindsight sidecar + factory host CLI

**Status:** DRAFT — every step marked `[OPERATOR-GO]` needs an explicit go or a credential only the
operator holds. Nothing in this runbook has been executed; agents prepped it read-only
(2026-09-30 inventory, session qds-factory-1d).
**Closes:** P0.5 / P0.9 (via the companion closure plan), OQ-4, DD-4 update. Handoff Phase 2,
est. ~1–3 days env work.
**Plan of record:** `_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-17-swarmclaw-kg-integration-HANDOFF.md`
(STATUS UPDATE 2026-09-30 section), frozen decision #3: x86_64 Linux dissolves the arm64-mac
libpq/openssl wall and the :8888 Jupyter clash.

## 0. Facts this runbook is built on (verified paths)

| Artifact | Path |
| --- | --- |
| swarmclaw compose | `/Users/steve/swarmclaw/docker-compose.yml` (+ overlay `docker-compose.local.yml`) |
| Hindsight service block | compose `:213–339`; pin source `config/hindsight-version.txt`; validator `scripts/validate-hindsight-pin.mjs` |
| Hindsight secrets | `hindsight.env` (`env_file`, `required: false`, compose `:293–295`) — gitignored, never commit |
| App/fence secrets | `.env.local` (compose `:112–114`, `:427–429`); template `.env.example` (36 vars) |
| Host systemd units | `/Users/steve/swarmclaw/deploy/solstice/units/` (backup svc+timer, 7 certbot units incl. cold-start placeholder) |
| nginx assets | `/Users/steve/swarmclaw/deploy/solstice/nginx/` (conf + cold-start 503 page + tests) |
| Existing runbooks | `/Users/steve/swarmclaw/docs/runbooks/app-startup.md` (canonical: ALWAYS both compose files); `docs/workspace-identity/DEPLOY-RUNBOOK.md` (OAuth consoles) |
| Factory CLI | QDS-Factory: `bun scripts/fleet.ts <verb>` — no global bin, no host daemons |
| Factory token path | `src/pr/github.ts:252–284` `readHostToken()`: macOS keychain (absent on Linux, guarded) → **piped stdin**; never env/argv |
| Factory env surface | QDS-Factory `.env.example` (55 vars incl. `HINDSIGHT_BASE_URL`, `HINDSIGHT_BEARER_TOKEN`/`HINDSIGHT_API_KEY`, `SWARMCLAW_*` allowlists) |
| Bank provisioner | `scripts/provision-hindsight-banks.ts` (three qds- banks; `HINDSIGHT_BASE_URL` default `http://127.0.0.1:8888` on-box) |

Hard constraints carried from prior incidents:
- Hindsight digest must be the **multi-arch INDEX digest** (QEMU-on-Apple-Silicon incident, compose `:216–223`).
- Hindsight host port is **127.0.0.1:18889**, never 8888-public (foreign-bank collision 2026-08-11, `:229–234`); `/mcp` has **no auth** — 18889 must never face the internet.
- Committed `environment:` wins over `env_file` — do not "fix" provider/reranker pins in hindsight.env.
- Always bring the stack up with **both** compose files (`app-startup.md` rule).

## 1. Provision the Vultr box

1. `[OPERATOR-GO — SPEND]` Create Vultr instance: **x86_64** (amd64), Ubuntu LTS (24.04), size ≥ the
   Hindsight model-init footprint (shm 2g is committed; give the box ≥ 8 GB RAM + ≥ 80 GB NVMe —
   Hindsight downloads models into `hindsight_hf_cache` on first boot). Worst-case printed first:
   this is the one real-money step; typical ~$20–40/mo tier suffices. Region near the operator.
2. `[OPERATOR]` SSH key, hostname, firewall: allow 22 + 80 + 443 ONLY. **Never 18889.**
3. `[OPERATOR-GO]` Point DNS A record(s) at the box (the domain the nginx/certbot units expect).

## 2. Host prerequisites

```bash
# as root on the VPS
apt update && apt -y upgrade
curl -fsSL https://bun.sh/install | bash            # Bun for the factory CLI
curl https://get.docker.com | sh                     # docker + compose v2
adduser --disabled-password <deploy-user> && usermod -aG docker <deploy-user>
apt -y install git rsync
systemctl enable --now docker
```

## 3. Place the swarmclaw stack

1. `[OPERATOR-GO]` Clone swarmclaw on the box (`git clone` the platform repo; branch = the
   integration lineage the factory adapter lives on — sc2 substrate).
2. `[OPERATOR — CREDENTIALS]` Hand-place, mode 600:
   - `hindsight.env`: `HINDSIGHT_API_TENANT_API_KEY`, `HINDSIGHT_API_LLM_API_KEY` (OpenRouter),
     provider/model left to the committed environment block.
   - `.env.local`: `SOLSTICE_PSEUDONYM_KEY`, `SOLSTICE_TENANT_ID` (**required — fence refuses to
     boot without the tenant pin**, compose `:423–426`), `SOLSTICE_ADJUDICATOR_BEARER`, plus the
     Clerk/OAuth vars from `.env.example` that production needs.
3. `[OPERATOR-GO — EXTERNAL]` Clerk + Google + Azure OAuth console config per
   `docs/workspace-identity/DEPLOY-RUNBOOK.md` (CASA gate) — not automatable from the repo.
4. Bring up: `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d` — review
   whether the LOCAL overlay belongs in prod (it repoints `SOLSTICE_HINDSIGHT_BASE_URL`; in prod the
   in-network default `http://hindsight:8888` is correct). `app-startup.md` triage applies on wedges.

## 4. TLS

1. `[OPERATOR-GO — DNS/HTTP-01]` Run the certbot bootstrap unit (placeholder cert → issue → renew
   timer; units already exist under `deploy/solstice/units/certbot/`). Requires the DNS record from §1
   and ports 80/443 open. nginx mounts `/var/www/certbot` + `/etc/letsencrypt:ro` (compose `:177–187`).

## 5. Hindsight first boot (this is the OQ-4 step)

1. `docker compose logs -f hindsight` — model init can take up to the committed 1320 s healthcheck
   start_period; `HINDSIGHT_API_MODEL_INIT_TIMEOUT=1200`.
2. Assert: `curl -s http://127.0.0.1:18889/` answers; `docker compose ps` shows healthy.
3. `[CONFIRMS OQ-4]` The arm64-mac libpq/openssl wall does not exist on x86_64 Linux — record the
   boot evidence (timestamped JSON into `_bmad-output/evidence/p0-9-closure/`, see the closure plan).

## 6. Factory host CLI

1. `[OPERATOR-GO]` On the box, clone QDS-Factory (the factory adapter substrate — ADR-1 shape) and
   `bun install`.
2. Front door: `bun scripts/fleet.ts <verb>` (registry `src/fleet/verbs.ts:73–431`, exits 0–6).
   No global bin, no daemons — it is a verb CLI by design (DD-1: the operator is the channel).
3. `[OPERATOR — CREDENTIALS]` GitHub token for PR verbs goes via **piped stdin** on Linux
   (`… | bun scripts/fleet.ts approve …` / open-pr paths); keychain path is macOS-only by code
   (`src/pr/github.ts:252–284`). Create `.env` for the factory from its `.env.example`: set
   `HINDSIGHT_BASE_URL=http://127.0.0.1:8888` (on-box compose network) or the host-gateway
   equivalent, `HINDSIGHT_BEARER_TOKEN`/`HINDSIGHT_API_KEY` as applicable, `SWARMCLAW_*` allowlists,
   `QDS_RUNS_DIR`.
4. Provision the qds- banks once Hindsight is healthy:
   `bun scripts/provision-hindsight-banks.ts` — bank IDs carry the **qds-** prefix (the shared
   platform Hindsight is unauthenticated; discipline per the 2026-08-11 incident).

## 7. Post-deploy verification (smoke)

- `docker compose ps` — all 7 services healthy (backup profile excluded unless enabling the timer).
- nginx serves TLS on 443; 18889 refuses from outside (`curl -m 3 http://<box-ip>:18889` fails).
- swarmclaw health + one MCP `/invoke` probe against a qds- bank.
- Factory: one read-only `bun scripts/fleet.ts status` + a `fleet approve` dry path (stdin token).
- Enable the backup timer (`systemctl enable --now solstice-backup.timer`) `[OPERATOR-GO]`.

## 8. Closure handoff

Hand off to `_bmad-output/plans/2026-09-30-p0-5-p0-9-closure-plan.md` — the VPS milestones here
(set 5: Hindsight up; 6: CLI + banks; 7: smoke) are exactly the milestones that plan's evidence
legs consume.

## 9. Explicit GO/credential register (all operator)

| # | Gate | Kind |
| --- | --- | --- |
| G1 | Vultr instance creation | spend |
| G2 | DNS + firewall | config |
| G3 | `hindsight.env` + `.env.local` placement | credentials |
| G4 | Clerk/Google/Azure consoles | credentials, external |
| G5 | certbot issuance | DNS/HTTP-01 |
| G6 | swarmclaw clone/branch on box + bring-up | decision (which lineage) |
| G7 | QDS-Factory clone on box + `.env` secrets | credentials |
| G8 | backup timer enable | decision |
| G9 | (deferred) GHCR image publish | owned by E01-S06, not this runbook |

## Z4 annotation — factory stack (2026-10-03, authored; nothing executed)

The Z4 factory deploy profile (`deploy/vps/`) is authored only — nothing below has been executed on
any box. The profile declares itself an extension of THIS runbook + the vultr-deploy template
perimeter: same box, same firewall (§1: 22/80/443 only), same front door; no second proxy, TLS, or
firewall stack (charter §2.2).

**Dedicated-instance origin (R2 trap #7 / DD-register resolution).** The factory stack adds a
DEDICATED Hindsight 0.10.0 instance (`hindsight-qds`), separate from §5's platform tenant sidecar:

| Consumer side | Address | Notes |
| --- | --- | --- |
| compose-side (in compose network) | `http://hindsight-qds:8888` | compose-network service name |
| host-side (on the box) | `http://127.0.0.1:18890` | the SINGLE loopback publish for the factory instance |

- NEVER `http://127.0.0.1:8888` for factory host-side legs. §6.3's `HINDSIGHT_BASE_URL=http://127.0.0.1:8888`
  value is the SHARED-SIDECAR (tenant stack) origin and resolves the WRONG instance for factory work.
- Port 18889 stays the platform tenant stack's host map (§0, §5); the factory dedicated instance is
  **18890, never 18889**. Both binds are loopback-only — the firewall is untouched (a loopback bind
  is not a public port; §1's 22/80/443-only stands).

**G5 disambiguation.** Runbook G5 (§9) is certbot issuance. It is UNRELATED to the DF3.6b "G5
pairing" gate (`.unlazy/df3-6b/GATES.md`) — the two share a label, nothing else.

**Fired-leg gate pin (R5-F5).** The Z4 fired leg consumes G1–G7 EXACTLY. G8 (backup timer) and G9
(GHCR publish) are OUT of the fired leg.

**Ops dependency register — surfaced rows (surfaced, never silently assigned):**

| Row | Ownership | Why |
| --- | --- | --- |
| m2-gateway image publish (GHCR) | UNOWNED | A G9 analog: M2.1 is dev-first/mock-tier per DD-26(1) and ships no GHCR publish; ops register §5 row 5 covers the exedev image only. Until the image is published, the `m2-gateway` compose service shows its documented awaiting-image state and smoke evidence records it `{"status":"awaiting-image"}` — never green-by-default. |
| factory-stack data backup policy | UNOWNED | G8's backup is the zeropoint swarmclaw stack's; no story or register entry covers factory data backup. |
