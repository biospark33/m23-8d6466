# qds-alpha tenant box — access instructions

**Verified:** 2026-10-04 ~16:10 UTC, from MJC's workstation (public IP 50.32.71.62).<br />
**Scope:** how to get a root shell on the `qds-alpha` tenant box, and what that box does and does not run today.<br />
**No secrets in this file.** Every credential is referenced by its Proton Pass item or key filename, never by value.

## 1. Topology

| Hop | Host | Address | User | Key (local file) | Key fingerprint |
| --- | --- | --- | --- | --- | --- |
| Bastion | `solstice-control-plane` (DigitalOcean) | `68.183.152.138` | `root` | `~/.ssh/solstice_control_plane` | `SHA256:u8RjF8JPLvXOgvLD/YJpZia+HNn1zH7ibKFHGoYsedU` (`solstice-deploy@control-plane`) |
| Tenant | `qds-alpha` (Vultr, hostname `vultr`) | `207.148.6.90` | `root` | `~/.ssh/solstice_fleet` | `SHA256:2iXrYfEvQYCxxpzti4FR04M3C9ALY4Zh9GOmG/4/q1s` (`solstice-fleet-operator`) |

Why the bastion is mandatory: the tenant's Vultr firewall group `c478b16c-dc6d-4067-b035-8793bcd856b5` allows TCP 22 **only** from `68.183.152.138/32`. A direct SSH from anywhere else times out (it does not get refused).<br />
The bastion holds **no** key for the tenant. The tenant key stays on your workstation and is used through `ProxyJump`. Do not copy `solstice_fleet` onto the bastion.

Expected host keys (check these on first connect):

- Bastion ED25519: `SHA256:+ZGzjitjnSuprvSr3geCRUqW9DzEmDO0XZ5ZU2nOgHs`
- Tenant ED25519: `SHA256:Mi6otoaTO3DYDgy7JFa/9QveLPRw6p6L3V/FZNjjctg`

## 2. Prerequisites on your workstation

1. **Both private keys present, mode 0600:** `~/.ssh/solstice_control_plane` and `~/.ssh/solstice_fleet`.<br />
   If either is missing, both are stored as **SSH-key items** in Proton Pass vault **Operating**. The item titles are the fingerprints listed in §1. Restore them from there, or serve them with `pass-cli ssh-agent`.
   If you serve them with `pass-cli ssh-agent` instead of restoring the private-key files, the matching **public** key must exist as `~/.ssh/solstice_control_plane.pub` and `~/.ssh/solstice_fleet.pub` (public keys are not secret). With `IdentitiesOnly yes`, ssh offers an agent key only when it matches a configured identity. When the private-key file is absent, ssh reads that identity from the `.pub` file beside it. If neither file is present, the agent key is never offered and authentication fails.
2. **`ssh` with ProxyJump support:** OpenSSH ≥ 7.3 (stock macOS is fine).
3. **Vultr API access (optional; only for instance and firewall inspection):** Proton Pass → Operating → **"Vultr — API Keys"** → field `VULTR_API_KEY`.<br />
   The other field, `VULTR_API_KEY_QDS`, is IP-allowlisted and returns `401 Unauthorized IP address` from this workstation.<br />
   Inject the key so it never prints. For example:<br />
   `export VULTR_API_KEY="$(pass-cli item view --vault-name Operating --item-title 'Vultr — API Keys' --field VULTR_API_KEY)"`
4. **Proton Pass CLI logged in:** `pass-cli info` shows a session.

## 3. SSH config (add to `~/.ssh/config`)

```sshconfig
Host qds-bastion
    HostName 68.183.152.138
    User root
    IdentityFile ~/.ssh/solstice_control_plane
    IdentitiesOnly yes

Host qds-alpha
    HostName 207.148.6.90
    User root
    IdentityFile ~/.ssh/solstice_fleet
    IdentitiesOnly yes
    ProxyJump qds-bastion
```

Then run `ssh qds-alpha`.

Equivalent one-liner, without editing the config:

```bash
ssh -o "ProxyCommand=ssh -i ~/.ssh/solstice_control_plane -o IdentitiesOnly=yes -W %h:%p root@68.183.152.138" \
    -i ~/.ssh/solstice_fleet -o IdentitiesOnly=yes root@207.148.6.90
```

## 4. Verify access (read-only, zero spend)

```bash
ssh qds-alpha 'hostname; docker compose ls; docker ps --format "{{.Names}}\t{{.Status}}\t{{.Ports}}"'
```

Expected output: hostname `vultr`, and compose project `solstice` (`/etc/solstice/docker-compose.yml`) running 5 containers:<br />
`solstice-swarmclaw-1`, `solstice-nginx-1`, `solstice-hindsight-1`, `solstice-llm-egress-fence-1`, `solstice-presidio-1`.

## 5. What is on the box (as found 2026-10-04)

- **Compose root:** `/etc/solstice/`. It holds `docker-compose.yml`, `compose.env` (0600), `fence.env` (0600), `clevis-policy.json` (0600), `certbot.env`, `system-meta.env`, `secrets/`, `nginx/` and `units/`. Treat every `*.env` file and `secrets/` as secret material. Never `cat` them into a shared transcript.
- **Tenant Hindsight:** `ghcr.io/vectorize-io/hindsight:0.10.0`, published on **`127.0.0.1:8888`**, not on 18889 as runbook §0/§5 assumes. No `HINDSIGHT_API_TENANT_*` variable is set in that container, so the instance is unauthenticated on box loopback.
- **Front door:** nginx on 80/443. It is not Caddy, so the Z4 `Caddyfile.factory.allowlist` splice has nothing to splice into on this box.
- **swarmclaw:** published on `0.0.0.0:3456`. The Vultr firewall still blocks it from outside (only 22-from-bastion, 80 and 443 are open). Keep that in mind if the firewall group ever changes.
- **Not present:** the factory `hindsight-qds` service, any listener on 18890, a QDS-Factory checkout, `bun`, and `hindsight-qds.env`.
- **Other users:** `/home/linuxuser` (the Vultr default) exists. No `deploy` user is set up.

## 6. Additional access required for issue #408 (factory deploy + legs)

These items are needed **beyond a shell** before the M1.1 legs can fire on this box. Each one is operator-gated (runbook §9).

| # | Requirement | Source | Runbook gate |
| --- | --- | --- | --- |
| 1 | Explicit GO to deploy a **new** stack (`hindsight-qds`) onto this production tenant box. The legs GO does not cover it. | Operator | G6/G7 + Z4 compose up |
| 2 | `HINDSIGHT_API_TENANT_API_KEY` for the dedicated instance (a new value, generated by the operator) | Operator → `hindsight-qds.env` (0600) | G3 |
| 3 | `HINDSIGHT_API_LLM_API_KEY` (OpenRouter; spends on first-boot model init and on every retain) | Proton Pass → Operating → **"OpenRouter — API Keys"** | G3 |
| 4 | Read access from the box to `Quantum-Digital-Solutions/QDS-Factory` for the clone: a deploy key or a short-lived token over stdin, never env or argv | GitHub (account with repo read access) | G7 |
| 5 | `bun` installed system-wide (`/usr/local/bin`), not only under `/root` (see the runbook Z4 "bun PATH" note) | Box setup | §2 |
| 6 | Decision on the front door: nginx location rows instead of the Caddy splice, or `caddyRoute: "deferred-to-M2.3"` in evidence | Operator | Z4 AC8 |
| 7 | Worst-case spend acknowledged: box already running (no new hours), plus OpenRouter tokens for model init and the 8 KB Mulch corpus × 3 banks | Operator | handoff hard gate 3 |

## 7. Hygiene rules

- Connect **only** through the bastion. Never add your own IP to the firewall group. A firewall change is a G2 decision.
- Never put a key or token on a command line or in `env` on the box. Use `pass-cli run`/`inject` locally and stdin piping remotely.
- Never `source` a `/etc/solstice/*.env` file or `hindsight-qds.env` into an interactive shell.
- Log out of the bastion after use. It is shared control-plane infrastructure.
