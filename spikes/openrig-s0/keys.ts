// Spike S0 key helper — NOT production. Mints/revokes/reads per-seat capped
// OpenRouter keys via the provisioning API. Key VALUES are written only to a
// 0600 state file and never printed. Run from repo root so bun loads .env.
//
//   bun spikes/openrig-s0/keys.ts mint <limitUsd> <seat>...   → state file
//   bun spikes/openrig-s0/keys.ts usage                         → per-key usage
//   bun spikes/openrig-s0/keys.ts revoke                        → DELETE all
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const STATE = process.env.SPIKE_KEYS_FILE ?? "/tmp/spike-openrig-keys.json";
const API = "https://openrouter.ai/api/v1/keys";
const prov = process.env.OPENROUTER_PROVISIONING_KEY;
if (!prov) throw new Error("OPENROUTER_PROVISIONING_KEY missing (run from repo root)");
const auth = { Authorization: `Bearer ${prov}`, "Content-Type": "application/json" };

type Seat = { seat: string; hash: string; key: string; limit: number };
const load = (): Seat[] => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : []);
const save = (s: Seat[]) => {
  writeFileSync(STATE, JSON.stringify(s), { mode: 0o600 });
  chmodSync(STATE, 0o600);
};

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "mint") {
  const limit = Number(args[0]);
  if (!(limit > 0 && limit <= 1)) throw new Error("limitUsd must be in (0, 1] for the spike");
  const seats = load();
  for (const seat of args.slice(1)) {
    const res = await fetch(API, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: `sbx-spike-openrig-${seat}-${Date.now()}`, limit }),
    });
    if (!res.ok) throw new Error(`mint ${seat}: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { key: string; data: { hash: string } };
    seats.push({ seat, hash: body.data.hash, key: body.key, limit });
    save(seats); // persist after EACH mint so a crash mid-loop still leaves hashes to revoke
    console.log(`minted ${seat} hash=${body.data.hash} limit=$${limit}`);
  }
} else if (cmd === "usage") {
  for (const s of load()) {
    const res = await fetch(`${API}/${s.hash}`, { headers: auth });
    const d = res.ok ? ((await res.json()) as { data: { usage: number; limit: number; disabled?: boolean } }).data : null;
    console.log(`${s.seat} hash=${s.hash} ${d ? `usage=$${d.usage} limit=$${d.limit}` : `HTTP ${res.status}`}`);
  }
} else if (cmd === "revoke") {
  let failed = 0;
  for (const s of load()) {
    const res = await fetch(`${API}/${s.hash}`, { method: "DELETE", headers: auth });
    const ok = res.ok || res.status === 404;
    if (!ok) failed++;
    console.log(`revoke ${s.seat} hash=${s.hash} → ${res.status}`);
  }
  if (failed) process.exit(1);
} else {
  console.error("usage: keys.ts mint <limitUsd> <seat>... | usage | revoke");
  process.exit(2);
}
