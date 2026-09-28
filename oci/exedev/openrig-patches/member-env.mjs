// S2.2 — the pinned-tree patch applier for per-seat env delivery.
//
// WHY A PATCH AT ALL (evidence, research doc §5.2/§5.5): OpenRig 0.5.14 has
// no per-seat env surface for non-pi runtimes. The daemon's launchSessionEnv
// (startup.js) hard-codes ONE shared HOME and CODEX_HOME for every seat;
// the daemon Node type carries no env field (types.d.ts); the claude adapter
// hard-codes its launch command (claude-code-adapter.js `claude ${flags}` via
// sendText — nothing to prefix); and codex resolves provider keys through
// `env_key` from the process env, which is the same shared session env. The
// single merge point is NodeLauncher.launchNode's openRigEnv — the env dict
// handed to tmuxAdapter.createSession — so a ~10-line insert there, applied
// to the pinned /opt/openrig tree at build time, is the whole patch. We do
// not fork OpenRig: the tree-hash gate (OPENRIG_TREE_SHA256) measures the
// tree AFTER this applier runs, so the patched bytes ARE the pinned
// identity, and any upstream drift re-refuses the build.
//
// WHAT IT DOES: teaches launchNode to merge a per-node env map for THIS
// seat, read lazily from `$OPENRIG_HOME/member-env.json` (keyed by the
// daemon's node logicalId `<pod.id>.<member.id>`), written by the QDS
// phase body before import and removed by its teardown. Lazy read, not
// constructor read, because a probe-first adopted daemon may have been
// started by an earlier run and must still see THIS run's map. An absent
// file is the no-op it is.
//
// CONTRACT: argv[1] = the @openrig/cli package root. Idempotence is a
// REFUSAL (the marker already present = double-apply = build error). Every
// failure exits non-zero with the reason on stderr; the Dockerfile RUN
// fails closed on any of them.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const fail = (msg) => {
  process.stderr.write(`member-env patch: ${msg}\n`);
  process.exit(1);
};

const pkgRoot = process.argv[2];
if (!pkgRoot) fail("usage: node member-env.mjs <@openrig/cli package root>");
const target = join(pkgRoot, "daemon", "dist", "domain", "node-launcher.js");

const MARKER = "QDS member-env patch";
const IMPORT_ANCHOR = 'import { SeatIdentityStore } from "./seat-identity-store.js";';
const IMPORTS = `${IMPORT_ANCHOR}
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";`;
const ANCHOR = `        const openRigEnv = compactEnv({
            OPENRIG_NODE_ID: node.id,
            OPENRIG_SESSION_NAME: sessionName,
            OPENRIG_RUNTIME: node.runtime ?? undefined,
            ...this.sessionEnv,
            OPENRIG_OCCUPANT_GENERATION: occupantGeneration ?? undefined,
        });`;

// The patched merge. qdsSafeMemberEnv is built AFTER sessionEnv is spread
// into the literal's argument object, so per-seat values (e.g. CODEX_HOME)
// override the shared ones; OPENRIG_* keys are stripped in the filter so the
// identity vars in the literal below can never be overridden; non-strings
// are dropped so a malformed map degrades to fewer keys, never a crash.
const PATCHED = `        // ${MARKER} (S2.2, oci/exedev/openrig-patches): merge the per-seat env
        // map for THIS node (keyed logicalId) from $OPENRIG_HOME/member-env.json —
        // written by the QDS phase body before import, removed by its teardown.
        // Read lazily per launch so an adopted (already-running) daemon still
        // sees THIS run's map; an absent file is the no-op it is. Values are
        // phase-authored (never seat/peer input); OPENRIG_* keys and
        // non-strings are dropped so the identity vars below can never be
        // overridden and a malformed map loses keys instead of crashing.
        let qdsMemberEnv;
        try {
            // Resolve the home the same getOpenRigHome() does (env, then the
            // $HOME/.openrig default) — the daemon process itself may run on
            // the default rather than an explicit OPENRIG_HOME.
            const qdsHome = process.env.OPENRIG_HOME || process.env.RIGGED_HOME || nodePath.join(process.env.HOME ?? "", ".openrig");
            const parsed = JSON.parse(nodeFs.readFileSync(nodePath.join(qdsHome, "member-env.json"), "utf8"));
            qdsMemberEnv = parsed && typeof parsed === "object" ? parsed[logicalId] : undefined;
        }
        catch {
            qdsMemberEnv = undefined;
        }
        const qdsSafeMemberEnv = {};
        if (qdsMemberEnv && typeof qdsMemberEnv === "object") {
            for (const [qdsKey, qdsValue] of Object.entries(qdsMemberEnv)) {
                if (typeof qdsValue === "string" && !qdsKey.startsWith("OPENRIG_"))
                    qdsSafeMemberEnv[qdsKey] = qdsValue;
            }
        }
        const openRigEnv = compactEnv({
            OPENRIG_NODE_ID: node.id,
            OPENRIG_SESSION_NAME: sessionName,
            OPENRIG_RUNTIME: node.runtime ?? undefined,
            ...this.sessionEnv,
            ...qdsSafeMemberEnv,
            OPENRIG_OCCUPANT_GENERATION: occupantGeneration ?? undefined,
        });`;

let src;
try {
  src = readFileSync(target, "utf8");
} catch (e) {
  fail(`cannot read ${target} (${e?.code ?? e}) — the @openrig/cli layout differs from the pinned 0.5.14 tree`);
}

const count = (haystack, needle) => haystack.split(needle).length - 1;
if (count(src, MARKER) !== 0) fail(`marker already present in ${target} — refusing a double apply`);
if (count(src, IMPORT_ANCHOR) !== 1) {
  fail(`expected exactly one import anchor in ${target}, found ${count(src, IMPORT_ANCHOR)} — the pinned tree moved; re-derive against the actual bytes`);
}
if (count(src, ANCHOR) !== 1) {
  fail(`expected exactly one openRigEnv anchor block in ${target}, found ${count(src, ANCHOR)} — the pinned tree moved; re-derive the anchor against the actual @openrig/cli@${process.env.OPENRIG_VERSION ?? "?"} bytes, do not guess`);
}

writeFileSync(target, src.replace(IMPORT_ANCHOR, IMPORTS).replace(ANCHOR, PATCHED));

// Post-apply verification: the marker rides, exactly one merge exists, the
// imports landed, and the module still parses AND loads (dynamic import
// executes only its module-level class definitions — no side effects).
const patched = readFileSync(target, "utf8");
if (count(patched, MARKER) !== 1) fail("post-apply: marker count is not 1");
if (count(patched, "...qdsSafeMemberEnv,") !== 1) fail("post-apply: merge spread missing");
if (!/import \* as nodeFs from "node:fs";/.test(patched) || !/import \* as nodePath from "node:path";/.test(patched)) {
  fail("post-apply: node:fs/node:path imports missing");
}
try {
  await import(target);
} catch (e) {
  fail(`post-apply: patched module does not load (${e?.message ?? e})`);
}
process.stdout.write(`member-env patch: applied to ${target}\n`);
