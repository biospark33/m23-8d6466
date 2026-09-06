/**
 * #210 — the static mirror for the live-gated tree.
 *
 * Every test under this directory is guarded by `liveGate(...)`, so a plain
 * `bun test` skips it: correct (real boxes, real spend), but it also means a
 * live test can hold an assertion that contradicts the current code and NO
 * static gate we own will say so. Two such were found in one DF1.10 wave —
 * a manifest path the story had just moved, and a status literal pinning the
 * defect the story existed to fix — both by an agent tracing blast radius,
 * nothing forced (#210's two defect examples).
 *
 * This is the forced version: a STATIC sweep over the live tree that runs in
 * the ordinary check job. It greps the two coupling classes that produced
 * those defects — box-side absolute paths and status/state string literals —
 * and requires every EXECUTABLE hit to carry a `live-mirror:` comment naming
 * the constant/import it mirrors. An unannotated hit is exactly the stale
 * coupling #210 describes: someone touched the owning constant, the live
 * assertion quietly kept the old spelling, and the failure surfaced on a
 * paid box mid-round.
 *
 * Deliberately NOT option 2 ("import the constants everywhere"): imports are
 * strictly better where they fit and several sites use them, but `tsc` cannot
 * be the whole gate because half these couplings live inside shell-command
 * template strings. The marker is the minimum that survives every shape.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const E2E_DIR = import.meta.dir;

/** Comment-only lines cannot break a run; the sweep reads executable text. */
const isCommentLine = (line: string): boolean =>
  /^\s*(\/\/|\/\*|\*)/.test(line);

/**
 * Box-side path literals whose owning constant lives in src/. Each pattern's
 * key names the mirror the annotation must point at.
 */
const PATH_PATTERNS: Array<{ re: RegExp; mirrors: string }> = [
  { re: /pipeline\.yaml/, mirrors: "DEFAULT_FILL_WORKDIR/QDS_IN_BOX_DIR (fill.ts) — the delivered manifest pair" },
  { re: /\/run\/steering/, mirrors: "steeringRoot()/inboxPath()/acksPath() (attach.ts) — DF1.11's channel" },
  { re: /\/run\/qds-run|qds-run\//, mirrors: "boxRunRoot/boxMarkerPath/BOX_MARKER_PATH_RE (fanout-primitive.ts, harvest.ts) — F-D1's per-run root" },
  { re: /\$HOME/, mirrors: "the box login user's home — box-home-relative contract (credentials.ts/fill.ts)" },
];

/**
 * Status/state vocabulary asserted as string literals. These mirror exported
 * unions (fleet status vocabulary, approval state) — `toBe("…")` against a
 * literal is fine ONLY when a human has said which union member and why.
 */
const STATUS_VOCAB = new Set([
  "running",
  "ok",
  "not-ok",
  "unknown",
  "live",
  "engine-failed",
  "not-running",
  "awaiting-approval",
]);

const STATUS_ASSERT_RE =
  /\.(?:toBe|toEqual|toContain|toMatchObject)\(\s*"([^"]+)"/;

describe("#210 static mirror — every live-tree coupling is annotated or import-derived", () => {
  const liveFiles = readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".live.test.ts"))
    .map((f) => ({ name: f, lines: readFileSync(join(E2E_DIR, f), "utf8").split("\n") }));

  test("the sweep reads a non-empty live tree — a glob break is a vacuous pass", () => {
    expect(liveFiles.length, "no *.live.test.ts found next to this sweep").toBeGreaterThan(10);
  });

  for (const { name, lines } of liveFiles) {
    test(`${name}: every box-path and status-literal hit carries a live-mirror note`, () => {
      const violations: string[] = [];
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        const hits: string[] = [];
        for (const { re } of PATH_PATTERNS) {
          if (re.test(line)) hits.push(String(re));
        }
        const statusMatch = STATUS_ASSERT_RE.exec(line);
        const statusLiteral = statusMatch?.[1];
        if (statusLiteral !== undefined && STATUS_VOCAB.has(statusLiteral)) {
          hits.push(`status literal "${statusLiteral}"`);
        }
        if (hits.length === 0) return;
        // The marker may sit on the hit line or the line above it.
        const annotated =
          line.includes("live-mirror:") ||
          (lines[i - 1] ?? "").includes("live-mirror:");
        if (!annotated) {
          violations.push(
            `  ${name}:${i + 1} ${hits.join(", ")}\n    ${line.trim().slice(0, 100)}`,
          );
        }
      });
      expect(
        violations.length,
        "unannotated live-tree couplings — each needs a 'live-mirror: <owner>' comment on the line or the line above, naming the src/ constant it mirrors (#210):\n" +
          violations.join("\n"),
      ).toBe(0);
    });
  }
});
