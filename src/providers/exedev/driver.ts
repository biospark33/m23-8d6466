/**
 * exe.dev provider driver (DF2.2) — the first substrate-backed ProviderDriver.
 *
 * DF2.1 measured inkwell's entire exe.dev surface at SIX control-plane command
 * shapes (`new`, `ls`, `rm`, `share port`, `share set-public`, `whoami`) plus
 * generic `ssh <vm>.exe.xyz` / `scp` (R4 §3.5, exhaustive grep). Everything the
 * driver does routes through one injected command seam so tests swap the
 * substrate, never the driver: `ExeDevDriver` production-constructs with the
 * real `sshCommand()` runner; tests pass the fake substrate's `run`.
 *
 * Response-shape honesty (AC5): only `ls --json`'s `{"vms":[{vm_name,
 * https_url, ssh_dest, …}]}` shape is MEASURED. `new --json`'s key names are
 * UNVERIFIED, so `create` accepts a recognized shape, falls back to re-reading
 * the verified `ls` shape, then derives `https://<name>.exe.xyz` (itself
 * Measured) — and fails CLOSED when both are unusable, after the name has
 * reached the substrate, so the VM stays findable by `ls` and is never
 * orphaned invisibly. Each resolution is logged with its `verified` provenance.
 *
 * INV-2: every box name is a public hostname (`<name>.exe.xyz`), so the run-id
 * grammar (`assertValidRunId`, regex + 63-char limit) is asserted before ANY
 * command is built — an invalid name never reaches the wire.
 *
 * INV-3: nothing here trusts an exit status where content is the question —
 * `whoami` requires non-empty output, `destroy` re-reads `ls` when `rm` fails,
 * and the setup gate (setup-gate.ts) asserts on content throughout.
 */

import { readFileSync } from "node:fs";
import { log, newRequestId } from "../../swarmclaw/log.ts";
import { assertValidRunId } from "../run-record.ts";
import type { ExecResult, ProviderDriver, ProviderVm } from "../driver.ts";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  ExeDevDriverError,
  shQuote,
  sshCommand,
  type ExeCommand,
} from "./transport.ts";
import { fillExeDev, type FillOptions } from "./fill.ts";
import { setupGate, type SetupGateOptions, type SetupGateResult } from "./setup-gate.ts";

// ─── shared transport (re-export) ───────────────────────────────────────────

// The error shape, command seam, and serializer live in transport.ts — the LOW
// module fill.ts and setup-gate.ts also import one-way (layering rationale:
// transport.ts header). Re-exported so this module's public surface — and
// src/providers/index.ts's — is unchanged.
export {
  DEFAULT_EXEC_TIMEOUT_MS,
  ExeDevDriverError,
  shQuote,
  sshCommand,
  type ExeCommand,
} from "./transport.ts";

// ─── response shapes ────────────────────────────────────────────────────────

/** The one MEASURED shape: `ls --json` → `{"vms":[{vm_name, https_url, …}]}`. */
interface LsShape {
  vms?: Array<{ vm_name?: unknown; https_url?: unknown; ssh_dest?: unknown }>;
}

/** How `create` learned the VM's URL — logged per call (Observability Contract). */
export type CreateProvenance = "new-shape" | "ls-shape" | "derived";

/** Options for {@link ExeDevDriver}. Every field is injectable; none is env-magic. */
export interface ExeDevDriverOptions {
  /** Command seam. Defaults to the production `sshCommand()` runner. */
  run?: ExeCommand;
  /** Path to the `vm-sharing: admins-only` operator attestation (INV-1). */
  postureFile?: string;
  /** Per-exec default ceiling (ms). */
  execTimeoutMs?: number;
  /** Propagated from the dispatch that created the run record (§5.2). */
  requestId?: string;
  /** The box's public hostname suffix. exe.dev derives `<name>.exe.xyz`. */
  hostSuffix?: string;
}

// ─── the driver ─────────────────────────────────────────────────────────────

export class ExeDevDriver implements ProviderDriver {
  readonly name = "exedev";

  private readonly run: ExeCommand;
  private readonly postureFile: string;
  private readonly execTimeoutMs: number;
  /** Propagation id (§5.2) — an id, never a credential. */
  readonly requestId: string;
  private readonly hostSuffix: string;

  constructor(opts: ExeDevDriverOptions = {}) {
    // round 6: constructor is the injection point — validate at the trust boundary
    if (opts.execTimeoutMs !== undefined && (!Number.isFinite(opts.execTimeoutMs) || opts.execTimeoutMs < 1)) {
      throw new ExeDevDriverError("exec-timeout-invalid", `execTimeoutMs ${opts.execTimeoutMs} must be a finite number >= 1 ms`, "pass a positive millisecond ceiling");
    }
    if (opts.hostSuffix !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(opts.hostSuffix)) {
      throw new ExeDevDriverError("host-suffix-invalid", `hostSuffix ${JSON.stringify(opts.hostSuffix)} is not a plain suffix (charset [A-Za-z0-9.-], no leading dot/dash)`, "pass a suffix like exe.xyz");
    }
    this.run = opts.run ?? sshCommand();
    this.postureFile = opts.postureFile ?? ".sandbox/exedev-posture.json";
    this.execTimeoutMs = opts.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    this.requestId = opts.requestId ?? newRequestId();
    this.hostSuffix = opts.hostSuffix ?? "exe.xyz";
  }

  /** `<name>.exe.xyz` — the MEASURED derivation (create.just:121-122). */
  boxHost(vm: string): string {
    // round 6: hostname construction is the trust boundary
    assertValidRunId(vm);
    return `${vm}.${this.hostSuffix}`;
  }

  /** URL derivation used by both `create`'s fallback and `expose`. */
  derivedUrl(vm: string): string {
    return `https://${this.boxHost(vm)}`;
  }

  private control(sub: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<ExecResult> {
    return this.run(["ssh", "exe.dev", ...sub], opts);
  }

  /** Observability line for shape provenance the primitive proxy cannot know. */
  private emit(op: string, fields: Record<string, unknown>, outcome: "ok" | "error" = "ok"): void {
    log({
      requestId: this.requestId,
      operation: `exedev.${op}`,
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: outcome,
      runId: null,
      driver: this.name,
      ...fields,
    });
  }

  // ── primitives: control plane ─────────────────────────────────────────────

  async create(name: string, tag?: string): Promise<ProviderVm> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    // INV-2: the name becomes a public hostname; refuse before any command.
    assertValidRunId(name);
    // INV-2 (same trust boundary): tag interpolates into ssh argv, which ssh
    // concatenates into the remote command line — validate before any command.
    if (tag !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
      throw new ExeDevDriverError(
        "tag-invalid",
        `tag ${JSON.stringify(tag)} is not a plain token (charset [A-Za-z0-9._-], must start alphanumeric)`,
        "pass a plain tag: letters, digits, dot, underscore, dash; must start alphanumeric",
      );
    }
    const res = await this.control([
      "new",
      "--name",
      name,
      ...(tag === undefined ? [] : ["--tag", tag]),
      "--json",
    ]);
    if (res.exitCode !== 0) {
      throw new ExeDevDriverError(
        "create-failed",
        `ssh exe.dev new --name ${name} exited ${res.exitCode}: ${res.stderr.trim()}`,
        "re-run; the VM may not exist — confirm with `ssh exe.dev ls --json`",
      );
    }
    // UNVERIFIED shape: accept vm_name at top level or under data/vm. Anything
    // else is a miss — never a guess (AC5).
    const parsed = parseJson(res.stdout, "new");
    const raw =
      pickObject(parsed) ??
      pickObject(parsed?.data) ??
      pickObject(parsed?.vm);
    if (raw?.vm_name === name) {
      // round 6: the log must state where the URL actually came from
      const rawUrl = typeof raw.https_url === "string" && raw.https_url.length > 0 ? raw.https_url : null;
      const httpsUrl = rawUrl ?? this.derivedUrl(name);
      this.emit("create_shape", { vm: name, verified: rawUrl ? "new-shape" : "derived" });
      return { name, httpsUrl };
    }
    // Fallback 1: re-read the one VERIFIED shape.
    const ls = await this.list(name);
    const hit = ls.find((v) => v.name === name);
    if (hit) {
      const httpsUrl = hit.httpsUrl ?? this.derivedUrl(name);
      this.emit("create_shape", { vm: name, verified: hit.httpsUrl ? "ls-shape" : "derived" });
      return { name, httpsUrl };
    }
    // Fallback 2 exhausted: fail CLOSED. The `new` already ran at the
    // substrate, so the VM may exist — name it in the error so an operator
    // (and DF2.6's reaper) can still find it. Never destroy it here (INV-5).
    this.emit("create_shape", { vm: name, verified: "unresolved" }, "error");
    throw new ExeDevDriverError(
      "create-shape-unresolved",
      `exe.dev 'new --name ${name}' succeeded but no recognized response shape named the VM, and 'ls ${name} --json' does not list it — refusing to guess; the VM may be live and unrecorded`,
      "ssh exe.dev ls --json  # find the VM by name; rm it via the DF2.5 teardown path if orphaned",
    );
  }

  async list(name?: string): Promise<ProviderVm[]> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    const res = await this.control(["ls", ...(name === undefined ? [] : [name]), "--json"]);
    if (res.exitCode !== 0) {
      throw new ExeDevDriverError(
        "ls-failed",
        `ssh exe.dev ls exited ${res.exitCode}: ${res.stderr.trim()}`,
        "re-run; exe.dev may be unreachable",
      );
    }
    const shape = parseJson(res.stdout, "ls") as LsShape | null;
    if (shape === null || !Array.isArray(shape.vms)) {
      throw new ExeDevDriverError(
        "ls-unparseable",
        "ssh exe.dev ls --json returned a body without a vms array",
        "re-run `ssh exe.dev ls --json` by hand and compare the shape",
      );
    }
    return shape.vms.flatMap((v) => {
      const vmName = typeof v.vm_name === "string" ? v.vm_name : null;
      if (vmName === null) return [];
      return [
        {
          name: vmName,
          ...(typeof v.https_url === "string" && v.https_url.length > 0 ? { httpsUrl: v.https_url } : {}),
        },
      ];
    });
  }

  /** Idempotent by contract (teardownRun/reapRuns both retry): a `rm` failure is
   *  confirmed against `ls` content — "not found" is the goal state, not an error. */
  async destroy(vm: string): Promise<void> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    assertValidRunId(vm);
    const res = await this.control(["rm", vm]);
    if (res.exitCode === 0) return;
    const remaining = await this.list(vm);
    if (remaining.length === 0) return; // already gone — idempotent success
    throw new ExeDevDriverError(
      "rm-failed",
      `ssh exe.dev rm ${vm} exited ${res.exitCode} and the VM is still listed: ${res.stderr.trim()}`,
      `ssh exe.dev rm ${vm}  # then confirm with: ssh exe.dev ls ${vm} --json`,
    );
  }

  async expose(vm: string, port: number): Promise<string> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    assertValidRunId(vm);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ExeDevDriverError("invalid-port", `invalid port: ${port}`, "pass an integer 1-65535");
    }
    const res = await this.control(["share", "port", vm, String(port)]);
    if (res.exitCode !== 0) {
      throw new ExeDevDriverError(
        "share-port-failed",
        `ssh exe.dev share port ${vm} ${port} exited ${res.exitCode}: ${res.stderr.trim()}`,
        `retry, or inspect the port with: ssh exe.dev ls ${vm} --json`,
      );
    }
    // The command's own output shape is [VERIFY]; the <name>.exe.xyz derivation
    // is the MEASURED one, so the URL is derived and recorded as such.
    this.emit("expose", { vm, port, verified: "derived" });
    return this.derivedUrl(vm);
  }

  /**
   * INV-1: refuses without the recorded `vm-sharing: admins-only` operator
   * attestation (spec §3.5 — team sharing defaults OPEN and must be flipped
   * day one). The refusal fires BEFORE any share command is issued.
   */
  async setPublic(vm: string): Promise<void> {
    assertValidRunId(vm);
    let posture: unknown;
    try {
      posture = JSON.parse(readFileSync(this.postureFile, "utf8")) as unknown;
    } catch (e) {
      throw new ExeDevDriverError(
        "posture-attestation-missing",
        `cannot read the vm-sharing posture attestation at ${this.postureFile} (${(e as Error).message}) — setPublic refuses: team sharing defaults open and a public box breaks one-run-per-box isolation`,
        `flip 'vm-sharing admins-only' in the exe.dev team settings, record it once: {"vmSharing":"admins-only","attestedAt":"<iso>"} at ${this.postureFile}, then re-run`,
      );
    }
    const vmSharing = (posture as { vmSharing?: unknown })?.vmSharing;
    if (vmSharing !== "admins-only") {
      throw new ExeDevDriverError(
        "posture-attestation-missing",
        `posture file ${this.postureFile} records vmSharing=${JSON.stringify(vmSharing)}, not "admins-only" — setPublic refuses`,
        `flip 'vm-sharing admins-only' in the exe.dev team settings, then update ${this.postureFile}`,
      );
    }
    const res = await this.control(["share", "set-public", vm]);
    if (res.exitCode !== 0) {
      throw new ExeDevDriverError(
        "share-set-public-failed",
        `ssh exe.dev share set-public ${vm} exited ${res.exitCode}: ${res.stderr.trim()}`,
        `retry, or check the org setting: ssh exe.dev share set-public ${vm}`,
      );
    }
  }

  /** Preflight (Infra Prerequisites): names the account BEFORE any record exists. */
  async whoami(): Promise<string> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    const res = await this.control(["whoami"]);
    const account = res.stdout.trim();
    // INV-3: exit 0 with empty output is "no answer", not "verified identity".
    if (res.exitCode !== 0 || account.length === 0) {
      throw new ExeDevDriverError(
        "whoami-failed",
        `ssh exe.dev whoami did not identify the account (exit ${res.exitCode}, output ${JSON.stringify(account)})`,
        "fix local exe.dev SSH access (ssh exe.dev whoami must print the account) before any run is created",
      );
    }
    return account;
  }

  // ── primitives: box access ────────────────────────────────────────────────

  /**
   * `exec` is every fill/setup/execute path: one `ssh <vm>.exe.xyz <command>`
   * where `<command>` is the argv POSIX-quoted and joined — ssh semantics
   * concat trailing args into one remote command line, so quoting once here is
   * quoting once, period. argv elements are never interpolated into a local
   * shell: Bun.spawn takes the array verbatim.
   */
  async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    assertValidRunId(vm);
    // round 6: an empty element ships a no-op ssh command
    // round 7: reject whitespace-only elements (no-op substrings)
    if (argv.length === 0 || argv.some((a) => a.length === 0 || a.trim().length === 0))
      throw new ExeDevDriverError("empty-argv", "exec requires a non-empty argv with no empty or whitespace-only elements", "pass the command argv");
    const command = argv.map(shQuote).join(" ");
    return this.run(["ssh", this.boxHost(vm), command], {
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: this.execTimeoutMs,
    });
  }

  /** Same as {@link exec} with a per-call timeout — the gate's per-assertion budget. */
  async execTimed(vm: string, argv: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> {
    assertValidRunId(vm);
    // round 6: an empty element ships a no-op ssh command
    // round 7: reject whitespace-only elements (no-op substrings)
    if (argv.length === 0 || argv.some((a) => a.length === 0 || a.trim().length === 0))
      throw new ExeDevDriverError("empty-argv", "exec requires a non-empty argv with no empty or whitespace-only elements", "pass the command argv");
    const command = argv.map(shQuote).join(" ");
    return this.run(["ssh", this.boxHost(vm), command], {
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs,
    });
  }

  // ── lifecycle: the exedev-specific verbs composed over the primitives ─────
  // DF2.1's seam stays eight primitives; `fill`/`setup` are extra methods on
  // this class (structural typing — the interface is untouched), so the
  // E2E chain is driver.create() → driver.fill() → driver.setup().

  /** Clone + pin + `sbx/<run-id>` branch (see fill.ts). */
  fill(vm: string, opts: FillOptions): Promise<void> {
    return fillExeDev(this, vm, opts);
  }

  /** The five-assertion setup gate (see setup-gate.ts) — a method, not a
   *  process: failure RETURNS a payload and leaves the VM alive (AC1, INV-5). */
  setup(vm: string, opts: SetupGateOptions): Promise<SetupGateResult> {
    return setupGate(this, vm, opts);
  }

  /** Box → host only (the seam's rule). The remote path is grammar-checked
   *  before it is ever placed in a `vm.exe.xyz:` scp argument. */
  async copyFile(vm: string, remotePath: string, localPath: string): Promise<void> { /* dp:ok a rejection IS the error contract: non-zero exits are content-checked below, spawn errors propagate through the registry proxy's error log */
    assertValidRunId(vm);
    assertBoxPathSafe(remotePath);
    const res = await this.run(["scp", "-q", `${this.boxHost(vm)}:${remotePath}`, localPath], {
      timeoutMs: this.execTimeoutMs,
    });
    if (res.exitCode !== 0) {
      throw new ExeDevDriverError(
        "copy-file-failed",
        `scp ${vm}:${remotePath} → ${localPath} exited ${res.exitCode}: ${res.stderr.trim()}`,
        `confirm the artifact exists: ssh ${this.boxHost(vm)} "ls -l '${remotePath}'"`,
      );
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Parse or fail with the command named — never pass a guess upstream. */
function parseJson(text: string, what: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    throw new ExeDevDriverError(
      `${what}-unparseable`,
      `exe.dev ${what} returned a body that is not a JSON object`,
      `run 'ssh exe.dev ${what} --json' by hand and compare the shape`,
    );
  }
}

/** A candidate `new --json` body is recognized only if it carries `vm_name`. */
function pickObject(v: unknown): { vm_name?: unknown; https_url?: unknown } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as { vm_name?: unknown; https_url?: unknown };
  return typeof o.vm_name === "string" ? o : null;
}

/**
 * A box path is grammar-checked (charset allow-list, relative, no `..`)
 * BEFORE it is interpolated into a scp remote spec — the same defence
 * DF2.3's `assertEnvFileSafe` gives the delivery path.
 */
function assertBoxPathSafe(p: string): void {
  const wellFormed = /^[A-Za-z0-9._/-]+$/.test(p) && p.length > 0 && !p.startsWith("/");
  const noTraversal = p.split("/").every((segment) => segment !== ".." && segment !== "");
  if (!wellFormed || !noTraversal) {
    throw new ExeDevDriverError(
      "remote-path-invalid",
      `remote path ${JSON.stringify(p)} is not a plain box-relative path (charset [A-Za-z0-9._/-], no leading /, no ".." segments)`,
      "pass a box-relative path like out/report.txt",
    );
  }
}
