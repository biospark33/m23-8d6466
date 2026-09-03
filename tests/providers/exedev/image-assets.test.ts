/**
 * DF2.10 AC6 — the systemd assets the image bakes, asserted as POLICY.
 *
 * The two files under `oci/exedev/systemd/` ship the only supervision policy
 * the factory box has, and until this suite existed NOTHING asserted their
 * contents: `grep -rn "qds-run@" tests/ scripts/ src/` returned nothing. The
 * Dockerfile's build-time `systemd-analyze verify` proves the unit LOADS and is
 * silent — `Restart=on-failure`, `%h/app/.env` and `User=root` all pass it
 * cleanly. The AC6 scan greps only for `QDS_`. The unit's bytes feed
 * `deriveBuildId`, but a policy edit is inert until someone rebuilds and
 * republishes, and the pin gate compares against whatever the operator pasted
 * in — it is not a policy check. So the one directive whose wrong value causes
 * double-spend and double-commit was guarded by review alone.
 *
 * The AC names its own negative control: `Restart=on-failure` "passes a naive
 * 'the engine comes back' test, re-walks phases whose commits and spend already
 * happened, and MUST fail this one." Every assertion below is therefore written
 * as a `Policy` with a `violations()` function, and the mutation table at the
 * bottom PROVES each one can fail — including the mutation a
 * `content.includes("Restart=no")` test would sail straight past: a file that
 * says `Restart=no` and then says `Restart=on-failure`, where systemd's
 * last-wins semantics mean the second one is what runs.
 *
 * No docker, no box, no network: this reads the real repo assets and the real
 * host-side constants they must agree with.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_ENV_FILE } from "../../../src/providers/credentials.ts";
import { steeringRoot } from "../../../src/fleet/attach.ts";
import {
  DEFAULT_IMAGE_BUILD_ID,
  ExeDevDriver,
  IMAGE_MARKER_PATH,
  imageMarkerFailure,
} from "../../../src/providers/exedev/driver.ts";
import { readBoxFile } from "../../../src/providers/exedev/transport.ts";
import { DEFAULT_IMAGE_MARKER, fakeExeDev } from "./fixtures/fake-exedev.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SYSTEMD_DIR = join(REPO_ROOT, "oci", "exedev", "systemd");
const UNIT_PATH = join(SYSTEMD_DIR, "qds-run@.service");
const TMPFILES_PATH = join(SYSTEMD_DIR, "qds-steering.conf");
const DOCKERFILE_PATH = join(REPO_ROOT, "oci", "exedev", "Dockerfile");
const DRIVER_PATH = join(REPO_ROOT, "src", "providers", "exedev", "driver.ts");
const ATTACH_PATH = join(REPO_ROOT, "src", "fleet", "attach.ts");

/** The box's login/exec user — `User=` in the unit and the tmpfiles owner. */
const BOX_USER = "exedev";
/**
 * The LITERAL path the unit must carry. Built from `KEY_ENV_FILE` (the
 * box-home-relative delivery contract DF2.3 writes and the setup gate reads) so
 * a change to EITHER side breaks this test: the unit hard-codes an absolute
 * path precisely because a system unit cannot express "the User='s home".
 */
const EXPECTED_ENV_FILE = `/home/${BOX_USER}/${KEY_ENV_FILE}`;
/** The steering channel the tmpfiles drop-in creates. */
const EXPECTED_STEERING_ROOT = "/run/steering";
/** tmpfiles mode field, normalised (`0700`) and as `stat -c %a` reports it. */
const EXPECTED_STEERING_MODE = "700";

// ─── a systemd unit parser that a comment cannot fool ───────────────────────

interface Directive {
  section: string;
  key: string;
  value: string;
  /** 1-based line of the directive's FIRST physical line. */
  line: number;
}

/**
 * Fold `\`-continuations, then drop comments — in that order and not the other
 * way round, so a comment that ends in a backslash cannot swallow the directive
 * beneath it. A logical line's comment-ness is decided by where it STARTED.
 */
function logicalLines(text: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const raw = text.split("\n");
  let buf: string | null = null;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const physical = raw[i] ?? "";
    const continued = physical.endsWith("\\");
    const body = continued ? physical.slice(0, -1) : physical;
    if (buf === null) {
      buf = body;
      start = i + 1;
    } else {
      buf += ` ${body.trim()}`;
    }
    if (!continued) {
      out.push({ text: buf, line: start });
      buf = null;
    }
  }
  if (buf !== null) out.push({ text: buf, line: start });
  return out;
}

/**
 * Parse to an ORDERED directive list, section-qualified. Order is load-bearing:
 * systemd's last-wins semantics for scalar directives are only expressible if
 * the parse keeps duplicates instead of collapsing them into a map.
 */
function parseUnit(text: string): Directive[] {
  const directives: Directive[] = [];
  let section = "";
  for (const { text: line, line: lineNo } of logicalLines(text)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    // systemd accepts both `#` and `;` as comment introducers.
    if (trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(trimmed);
    if (header) {
      section = header[1] ?? "";
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      // Not a directive and not a header — record it so the "well-formed"
      // test below fails loudly rather than silently ignoring garbage.
      directives.push({ section, key: `<unparseable:${trimmed}>`, value: "", line: lineNo });
      continue;
    }
    directives.push({
      section,
      key: trimmed.slice(0, eq).trim(),
      value: trimmed.slice(eq + 1).trim(),
      line: lineNo,
    });
  }
  return directives;
}

/** Every value assigned to `key` in `section`, in file order. */
function valuesOf(unit: Directive[], section: string, key: string): string[] {
  return unit.filter((d) => d.section === section && d.key === key).map((d) => d.value);
}

/**
 * The value systemd would ACT on for a scalar directive: the last assignment
 * wins. `undefined` when the directive is absent (or was reset to empty).
 */
function effectiveScalar(unit: Directive[], section: string, key: string): string | undefined {
  const values = valuesOf(unit, section, key);
  const last = values.at(-1);
  return last === "" ? undefined : last;
}

/**
 * A space-separated list directive (`After=`), accumulated across repetitions.
 * An EMPTY assignment resets the list — an `After=` line with no value after
 * the real one silently drops the ordering, and a test that only concatenated
 * would not see it.
 */
function effectiveList(unit: Directive[], section: string, key: string): string[] {
  let acc: string[] = [];
  for (const value of valuesOf(unit, section, key)) {
    if (value === "") acc = [];
    else acc.push(...value.split(/\s+/).filter((v) => v !== ""));
  }
  return acc;
}

// ─── the policies ───────────────────────────────────────────────────────────

interface Policy {
  id: string;
  /** Why the wrong value is a defect, in the AC's terms. */
  why: string;
  /** Empty ⇒ the unit satisfies this policy. */
  violations(unit: Directive[]): string[];
}

const POLICIES: Policy[] = [
  {
    id: "restart-no",
    why: "a restarted engine re-walks phases whose git commits and LLM spend already happened; restart is double-spend, not recovery",
    violations(unit) {
      const bad: string[] = [];
      const effective = effectiveScalar(unit, "Service", "Restart");
      if (effective !== "no") bad.push(`effective Restart is ${effective ?? "<absent>"}, not "no"`);
      // Belt and braces: not merely "the last one is no". ANY `Restart=` that
      // is not `no`, in any section, is the finding — a stray one in [Unit] is
      // a directive an editor plainly meant to be supervision policy.
      for (const d of unit) {
        if (d.key === "Restart" && d.value !== "no") {
          bad.push(`line ${d.line}: [${d.section}] Restart=${d.value}`);
        }
      }
      return bad;
    },
  },
  {
    id: "user-exedev",
    why: "the engine runs as the box's login user; as root it would write run artefacts the exec user cannot read",
    violations(unit) {
      const user = effectiveScalar(unit, "Service", "User");
      return user === BOX_USER ? [] : [`effective User is ${user ?? "<absent>"}, not ${BOX_USER}`];
    },
  },
  {
    id: "after-tmpfiles",
    why: "/run is tmpfs, so the steering channel is re-created every boot; without this ordering the engine races the channel it writes into",
    violations(unit) {
      const after = effectiveList(unit, "Unit", "After");
      return after.includes("systemd-tmpfiles-setup.service")
        ? []
        : [`After= is [${after.join(", ")}] — missing systemd-tmpfiles-setup.service`];
    },
  },
  {
    id: "envfile-literal",
    why: "the per-run capped LLM key is delivered to the literal path; a wrong path starts the engine with no credential",
    violations(unit) {
      const files = valuesOf(unit, "Service", "EnvironmentFile");
      // Exactly one, and exactly that. A SECOND EnvironmentFile is a second
      // credential source the story never sanctioned, so a "contains" check is
      // not the check.
      if (files.length !== 1 || files[0] !== EXPECTED_ENV_FILE) {
        return [`EnvironmentFile= is [${files.join(", ")}], expected exactly [${EXPECTED_ENV_FILE}]`];
      }
      return [];
    },
  },
  {
    id: "no-home-specifier",
    why: "in a SYSTEM unit %h is the service MANAGER's home (/root), not User='s — %h/app/.env silently reads a file that is not there",
    violations(unit) {
      // Directives only. The shipped unit's COMMENTS say `%h/app/.env` while
      // explaining why it must not appear as a directive; judging the raw file
      // text would fail on the very comment that documents the rule.
      return unit
        .filter((d) => d.value.includes("%h") || d.key.includes("%h"))
        .map((d) => `line ${d.line}: [${d.section}] ${d.key}=${d.value}`);
    },
  },
  {
    id: "no-qds-var",
    why: "DF1.11's INV-IBOX-13 and DF3.7's AC4 both rest on the engine resolving its own run/steering roots rather than inheriting them from the image",
    violations(unit) {
      const bad: string[] = [];
      for (const d of unit) {
        if (/QDS_[A-Za-z0-9_]*/.test(`${d.key}=${d.value}`)) {
          bad.push(`line ${d.line}: [${d.section}] ${d.key}=${d.value}`);
        }
        // `Environment=` is how a unit sets a variable at all, and the unit
        // ships none. The OTHER injection channel — a second `EnvironmentFile=`
        // pointing at a file this repo does not control — is closed by
        // `envfile-literal` pinning the directive to exactly one exact value,
        // so it is not restated here; keeping the two policies disjoint is what
        // lets the mutation table below name a single owner per defect.
        if (d.key === "Environment") bad.push(`line ${d.line}: Environment= is not shipped by DF2.10`);
      }
      return bad;
    },
  },
  {
    id: "directive-set",
    why: "DF1.10 adds exactly one line (ExecStart=/usr/local/bin/qds-engine run %i); pinning the set makes that addition a deliberate, visible change",
    violations(unit) {
      // NO `Install` key: the section is GONE by design. An enabled per-run
      // instance is pulled in by multi-user.target on every subsequent boot,
      // re-walking phases whose commits and spend already happened — the same
      // double-spend `Restart=no` refuses, arriving through a different door.
      // Its absence is the policy, so pinning the set is what keeps it absent.
      const expected: Record<string, string[]> = {
        Unit: ["Description", "After", "Requires", "AssertPathExists"],
        Service: ["Type", "User", "Restart", "TimeoutStopSec", "TimeoutStartSec", "EnvironmentFile"],
      };
      const bad: string[] = [];
      const sections = [...new Set(unit.map((d) => d.section))];
      for (const section of sections) {
        const keys = unit.filter((d) => d.section === section).map((d) => d.key);
        const want = expected[section];
        if (want === undefined) {
          bad.push(`unexpected section [${section}]`);
          continue;
        }
        if (JSON.stringify(keys) !== JSON.stringify(want)) {
          bad.push(`[${section}] directives are [${keys.join(", ")}], expected [${want.join(", ")}]`);
        }
      }
      for (const section of Object.keys(expected)) {
        if (!sections.includes(section)) bad.push(`section [${section}] is missing`);
      }
      return bad;
    },
  },
];

const UNIT_TEXT = readFileSync(UNIT_PATH, "utf8");
const UNIT = parseUnit(UNIT_TEXT);

/** The directive keys the shipped unit carries in `section`, in file order. */
function unitKeys(section: string): string[] {
  return UNIT.filter((d) => d.section === section).map((d) => d.key);
}

// ─── AC6: the shipped unit ──────────────────────────────────────────────────

describe("DF2.10 AC6 — qds-run@.service ships the policy the AC states", () => {
  test("the parse is clean: every non-comment line is a header or a directive", () => {
    expect(UNIT.filter((d) => d.key.startsWith("<unparseable:"))).toEqual([]);
    // Nothing before the first section header — a directive at section "" is a
    // line systemd would refuse, and it would also silently escape every
    // section-qualified assertion below.
    expect(UNIT.filter((d) => d.section === "")).toEqual([]);
  });

  test("every AC6 policy holds on the file as shipped", () => {
    for (const policy of POLICIES) {
      expect(policy.violations(UNIT), `${policy.id}: ${policy.why}`).toEqual([]);
    }
  });

  test("Restart is the string `no` — the AC's named negative control", () => {
    // Stated flatly, on its own, because this is the directive the whole
    // finding is about: `Restart=on-failure` here would pass the Dockerfile's
    // `systemd-analyze verify`, pass the QDS_* scan, and re-run a phase whose
    // commits and spend already happened.
    expect(effectiveScalar(UNIT, "Service", "Restart")).toBe("no");
  });

  test("User, After and the literal EnvironmentFile", () => {
    expect(effectiveScalar(UNIT, "Service", "User")).toBe(BOX_USER);
    expect(effectiveScalar(UNIT, "Service", "Type")).toBe("simple");
    expect(effectiveList(UNIT, "Unit", "After")).toContain("systemd-tmpfiles-setup.service");
    // The unit↔host tie is the line above: EXPECTED_ENV_FILE is built from
    // BOX_USER + KEY_ENV_FILE, so drift in either side breaks that equality.
    // (A rebuilt "/home/<User>/<KEY_ENV_FILE>" comparison here would be the
    // same construction compared with itself — asserted once, honestly.)
    expect(valuesOf(UNIT, "Service", "EnvironmentFile")).toEqual([EXPECTED_ENV_FILE]);
    expect(KEY_ENV_FILE).toBe("app/.env");
  });

  test("no %h specifier in any DIRECTIVE (the comments may name it; they explain the rule)", () => {
    expect(UNIT.filter((d) => `${d.key}=${d.value}`.includes("%h"))).toEqual([]);
    // Proof the scope is the right one: the file DOES contain `%h`, in the
    // comment that documents the prohibition. A raw-text check would fail here
    // for the wrong reason and would then be "fixed" by deleting the comment.
    expect(UNIT_TEXT).toContain("%h");
  });

  test("no ExecStart — DF1.10 owns it, and its arrival must be a visible change", () => {
    expect(UNIT.filter((d) => d.key.startsWith("ExecStart"))).toEqual([]);
    expect(unitKeys("Service")).toEqual([
      "Type",
      "User",
      "Restart",
      "TimeoutStopSec",
      "TimeoutStartSec",
      "EnvironmentFile",
    ]);
    // The contract DF1.10 is told to satisfy is documented IN the unit; if that
    // sentence is deleted the next author has nothing to implement against.
    expect(UNIT_TEXT).toContain("ExecStart=/usr/local/bin/qds-engine run %i");
  });
});

// ─── AC6: the tmpfiles drop-in, and the five copies of its tuple ────────────

const TMPFILES_TEXT = readFileSync(TMPFILES_PATH, "utf8");

/** Non-comment, non-blank lines, split into tmpfiles fields. */
function tmpfilesEntries(text: string): string[][] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => l.split(/\s+/));
}

/**
 * The Dockerfile with `#` lines removed. `toContain` over the raw text is
 * satisfied by the same bytes inside a comment — and this file's own AC6
 * comment block quotes every path and every assert it later runs, so an
 * uncommented check would pass against a RUN that had been commented out or
 * deleted outright. Read-only: these bytes are a `deriveBuildId` input.
 */
const DOCKERFILE_DIRECTIVES = readFileSync(DOCKERFILE_PATH, "utf8")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"))
  .join("\n");

/** `0700` → `700`, the unit `install -m` and `stat -c %a` speak. */
function normaliseMode(mode: string): string {
  return mode.replace(/^0+(?=\d)/, "");
}

/**
 * The tmpfiles assertions AS A `violations()`, the shape {@link POLICIES} uses.
 *
 * This exists so the mutation table at the bottom can run the REAL checks
 * against a mutated entry. It used to run `tmpfilesEntries` — a pure
 * split/trim/filter with no policy in it — and assert the result merely
 * differed from the good tuple, which holds for any implementation that does
 * not return the good tuple for every input. Neither real assertion (the exact
 * shape, the cross-copy tie to the Dockerfile) was ever exercised by a mutation.
 */
function tmpfilesViolations(text: string): string[] {
  const entries = tmpfilesEntries(text);
  if (entries.length !== 1) return [`entry-count: ${entries.length} entries, expected exactly 1`];
  const entry = entries[0] ?? [];
  if (entry.length !== 5) return [`entry-shape: ${entry.length} fields, expected 5`];
  const [type = "", path = "", mode = "", owner = "", group = ""] = entry;
  const bad: string[] = [];
  if (type !== "d") bad.push(`entry-shape: type is ${type}, expected d`);
  if (path !== EXPECTED_STEERING_ROOT) bad.push(`path: ${path} != ${EXPECTED_STEERING_ROOT}`);
  if (normaliseMode(mode) !== EXPECTED_STEERING_MODE) bad.push(`mode: ${mode} != 0${EXPECTED_STEERING_MODE}`);
  if (owner !== BOX_USER || group !== owner) bad.push(`ownership: ${owner}:${group} != ${BOX_USER}:${BOX_USER}`);
  // The Dockerfile's build-time assert is written in terms of THIS tuple, so a
  // drifted tuple is one the image never verifies at build time — the copy that
  // is checked against reality rather than against another copy.
  if (
    !DOCKERFILE_DIRECTIVES.includes(
      `[ "$(stat -c '%a %U %G' ${path})" = "${normaliseMode(mode)} ${owner} ${group}" ]`,
    )
  ) {
    bad.push(`dockerfile-assert: nothing verifies ${path} ${mode} ${owner}:${group} at build time`);
  }
  return bad;
}

describe("DF2.10 AC6 — qds-steering.conf is one line, and the five copies agree", () => {
  test("exactly `d /run/steering 0700 exedev exedev`", () => {
    const entries = tmpfilesEntries(TMPFILES_TEXT);
    expect(entries).toEqual([["d", EXPECTED_STEERING_ROOT, "0700", BOX_USER, BOX_USER]]);
  });

  test("the drop-in and the driver's provision script cannot silently diverge", () => {
    // `STEERING_PROVISION_SCRIPT` is module-private, so this reads the source
    // text — but ONLY the script constant's own slice of it, cut between its
    // declaration and its closing join. First-match regexes over the whole
    // file were comment-blind: a documentation example (`install -d -m 700`)
    // earlier in driver.ts would satisfy them while the real script drifted,
    // and the divergence this test exists to catch would pass green. The
    // markers are asserted to exist first, so a rewritten declaration fails
    // loudly rather than quietly checking nothing.
    const driverSrc = readFileSync(DRIVER_PATH, "utf8");
    const scriptStart = driverSrc.indexOf("const STEERING_PROVISION_SCRIPT");
    const scriptEnd = driverSrc.indexOf('].join(" && ")', scriptStart);
    expect(scriptStart, "driver.ts no longer declares STEERING_PROVISION_SCRIPT").toBeGreaterThan(-1);
    expect(scriptEnd, "STEERING_PROVISION_SCRIPT is no longer a joined array literal").toBeGreaterThan(scriptStart);
    const scriptSrc = driverSrc.slice(scriptStart, scriptEnd);
    const root = /QDS_STEERING_ROOT:-([^"}]+)/.exec(scriptSrc);
    const mode = /install -d -m (\d+)/.exec(scriptSrc);
    const modeAssert = /stat -c %a[^)]*\)" = (\d+)/.exec(scriptSrc);
    expect(root, "the script no longer names a steering-root default").not.toBeNull();
    expect(mode, "the script no longer provisions with `install -d -m <mode>`").not.toBeNull();
    expect(modeAssert, "the script no longer verifies the mode after provisioning").not.toBeNull();

    // The single entry, asserted to have all five fields before any of them is
    // read — an entry short a field would otherwise compare `undefined` against
    // `undefined` somewhere below and pass.
    const entry = tmpfilesEntries(TMPFILES_TEXT)[0] ?? [];
    expect(entry).toHaveLength(5);
    const [, path = "", tmpfilesMode = "", owner = "", group = ""] = entry;
    expect(root?.[1]).toBe(path);
    // tmpfiles writes `0700`; `install -m` and `stat -c %a` speak `700`.
    expect(normaliseMode(tmpfilesMode)).toBe(EXPECTED_STEERING_MODE);
    expect(mode?.[1]).toBe(EXPECTED_STEERING_MODE);
    expect(modeAssert?.[1]).toBe(EXPECTED_STEERING_MODE);

    // Third copy: attach.ts's host leg resolves the same default. Cleared and
    // restored so a stray env var from another suite cannot decide this.
    const before = process.env.QDS_STEERING_ROOT;
    try {
      Reflect.deleteProperty(process.env, "QDS_STEERING_ROOT");
      expect(steeringRoot()).toBe(path);
    } finally {
      if (before !== undefined) process.env.QDS_STEERING_ROOT = before;
    }

    // Fourth copy: attach.ts's BOX leg, which this suite used to miss entirely
    // while calling the set "four copies". `steeringRoot()` above resolves the
    // root on the HOST; `BOX_STEERING_ROOT_SH` is the `sh` expansion the
    // append and ack-read scripts actually RUN inside the box — the leg that
    // writes inbox.ndjson into the very channel this tmpfiles entry
    // provisions. Drift there splits the two legs onto different files with
    // every assertion in this suite still green, and its only other pin is a
    // hard-coded literal in an unrelated suite (tests/fleet/gate-verbs.test.ts).
    // Module-private, so this reads source text the same way the driver script
    // above does, asserting the marker exists before reading through it.
    const attachSrc = readFileSync(ATTACH_PATH, "utf8");
    const boxRootDecl = /^const BOX_STEERING_ROOT_SH = (.+);$/m.exec(attachSrc);
    expect(boxRootDecl, "attach.ts no longer declares BOX_STEERING_ROOT_SH").not.toBeNull();
    const boxRoot = /QDS_STEERING_ROOT:-([^"}]+)/.exec(boxRootDecl?.[1] ?? "");
    expect(boxRoot, "BOX_STEERING_ROOT_SH no longer names a steering-root default").not.toBeNull();
    expect(boxRoot?.[1]).toBe(path);
    // …and it is the constant the box-side scripts RUN, not a pinned orphan: a
    // script that inlined its own `${QDS_STEERING_ROOT:-…}` would leave the
    // assertion above pinning a value nothing executes.
    for (const script of ["APPEND_SCRIPT", "ACK_READ_SCRIPT"]) {
      expect(attachSrc, `${script} no longer resolves its root through BOX_STEERING_ROOT_SH`).toMatch(
        new RegExp(`const ${script} = \\[[^\\]]*BOX_STEERING_ROOT_SH`),
      );
    }

    // Fifth copy: the Dockerfile's build-time assert on what the entry
    // actually produced — the one copy checked against reality rather than
    // against another copy. Comment-stripped (see DOCKERFILE_DIRECTIVES).
    expect(DOCKERFILE_DIRECTIVES).toContain(
      `[ "$(stat -c '%a %U %G' ${path})" = "${EXPECTED_STEERING_MODE} ${owner} ${group}" ]`,
    );
    // The owner is the unit's `User=`: the engine writes into this channel, so
    // the drop-in's owner and the unit's user are the same fact stated twice.
    expect(effectiveScalar(UNIT, "Service", "User")).toBe(BOX_USER);
    expect(owner).toBe(BOX_USER);
    expect(group).toBe(owner);
  });

  test("no QDS_* variable in the drop-in", () => {
    expect(TMPFILES_TEXT).not.toMatch(/QDS_[A-Za-z0-9_]*/);
  });
});

// ─── AC6: the QDS_* invariant across BOTH assets ────────────────────────────

describe("DF2.10 AC6 — neither systemd asset introduces a QDS_* variable", () => {
  test("no Environment=, no QDS_* directive, and the only EnvironmentFile is the credential path", () => {
    expect(valuesOf(UNIT, "Service", "Environment")).toEqual([]);
    expect(UNIT.filter((d) => /QDS_/.test(`${d.key}=${d.value}`))).toEqual([]);
    expect(valuesOf(UNIT, "Service", "EnvironmentFile")).toEqual([EXPECTED_ENV_FILE]);
    expect(EXPECTED_ENV_FILE).not.toMatch(/QDS_/);
    expect(tmpfilesEntries(TMPFILES_TEXT).flat().join(" ")).not.toMatch(/QDS_/);
  });

  /**
   * The deferral this test used to record is DISCHARGED — and the test that
   * recorded it had to go with it.
   *
   * The finding was that the AC6 scan missed the two surfaces that actually
   * reach a booted `qds-run@` instance: a manager-wide `DefaultEnvironment=`
   * (/etc/systemd/system.conf and its drop-in dir), which PID 1 hands to EVERY
   * unit, and per-unit drop-in directories (…/qds-run@.service.d/*.conf), which
   * systemd merges into the unit at load time. The Dockerfile now covers both
   * with ONE recursive `/etc/systemd/` pass, anchored on the Environment-family
   * DIRECTIVE so the shipped unit's own comments are not findings.
   *
   * The old test guarded the HOLE — three `not.toMatch` assertions looking for
   * the literals `DefaultEnvironment=`, `system.conf(.d)` and `.service.d` in
   * the Dockerfile. It still PASSED after the widening, but only by luck: the
   * new grep uses the regex `(Default)?Environment=` and one recursive pass
   * that needs no path literals, so none of the three literals it forbade ever
   * appears. A test that is green because the thing it looks for was spelled
   * differently is not evidence, so it is replaced by its positive dual, below.
   *
   * This one fails if someone NARROWS the scan back: drop the recursion, point
   * it at the unit file instead of the directory, or delete a login/session
   * path, and the assertion goes red naming what was lost.
   */
  test("the AC6 scan is WIDE: /etc/systemd/ recursively, plus the login/session files", () => {
    // Comment-stripped (see DOCKERFILE_DIRECTIVES): the Dockerfile's own AC6
    // comment block quotes every path the RUN greps, so a raw-text check would
    // pass against a RUN that had been commented out or deleted outright.
    const ac6 = DOCKERFILE_DIRECTIVES;

    // (a) ONE RECURSIVE pass over the DIRECTORY — this is what covers
    // system.conf, system.conf.d/ and every per-unit *.service.d/ at once,
    // without the Dockerfile enumerating paths that would then drift. The
    // trailing `\s` is load-bearing: `/etc/systemd/system/qds-run@.service`
    // also starts with `/etc/systemd/`, and re-narrowing the target to a single
    // file is exactly the regression this asserts against.
    expect(ac6, "the AC6 RUN no longer greps /etc/systemd/ RECURSIVELY for an Environment-family QDS_ directive").toMatch(
      /grep -[A-Za-z]*r[A-Za-z]* '[^']*Environment=[^']*QDS_[^']*' \/etc\/systemd\/\s/,
    );
    // …and the `(Default)?` alternation SPECIFICALLY. The pattern above cannot
    // see it: its leading `[^']*` happily absorbs the deleted group, so
    // narrowing the Dockerfile scan to `'^[[:space:]]*Environment=.*QDS_'`
    // — which cannot match `DefaultEnvironment=` in system.conf, re-opening the
    // manager-wide hole this whole test replaced a deferral for — kept the
    // assertion GREEN. Verified by executing both variants against it.
    expect(ac6, "the AC6 grep no longer matches DefaultEnvironment= — the manager-wide surface is unscanned again").toMatch(
      /\(Default\)\?Environment=/,
    );

    // (b) the login/session leg — ssh's path, not systemd's: bash sources these
    // for a NON-INTERACTIVE `ssh box cmd`, which is how the setup gate and the
    // fleet driver invoke everything. Each path named, so deleting any one of
    // them is a named failure rather than a silently smaller scan.
    for (const path of [
      "/etc/environment",
      "/etc/environment.d/",
      "/etc/profile",
      "/etc/profile.d/",
      "/etc/bash.bashrc",
      `/home/${BOX_USER}/.profile`,
      `/home/${BOX_USER}/.bashrc`,
      `/home/${BOX_USER}/.bash_profile`,
      `/home/${BOX_USER}/.bash_login`,
    ]) {
      // Word-boundaried, NOT `toContain`. A bare substring test cannot tell
      // `/etc/environment` from the `/etc/environment.d/` sitting beside it on
      // the same grep argument list — delete the former and the latter still
      // satisfies it, so two of these nine paths were unguarded. Requiring the
      // path to end at whitespace or end-of-string makes it its own argument.
      const asOwnArgument = new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "m");
      expect(ac6, `the AC6 login/session scan no longer covers ${path} as its own argument`).toMatch(asOwnArgument);
    }

    // (c) the unit FILE is still scanned in its own right — stricter than (a),
    // which is anchored on the Environment family: ANY QDS_ token in a
    // directive of the shipped unit is a finding.
    expect(ac6, "the AC6 scan no longer checks the shipped unit file for a bare QDS_ token").toContain(
      "/etc/systemd/system/qds-run@.service",
    );

  });

  // Its OWN test, not the tail of the one above. As the last statement of the
  // AC6-scan test it was unreachable whenever any of that test's eleven earlier
  // assertions threw — so a new, unasserted asset dropped into
  // oci/exedev/systemd/ on the same commit that narrowed the AC6 grep reported
  // only "the AC6 RUN no longer greps …". The named failure this check exists
  // to produce is precisely the one you would not get.
  test("oci/exedev/systemd holds exactly the two asserted assets", () => {
    const assets = new Bun.Glob("**/*").scanSync({ cwd: SYSTEMD_DIR, onlyFiles: true });
    expect([...assets].sort()).toEqual(["qds-run@.service", "qds-steering.conf"]);
  });
});

// ─── negative controls: every assertion above can fail ──────────────────────

/**
 * Each row mutates a COPY of the unit text and names the policies that MUST
 * reject the result. Rows with an empty `rejectedBy` are the false-positive
 * controls: edits that change comments or add unrelated-but-legal content and
 * must be ACCEPTED, which is what proves the checks parse rather than grep.
 */
interface Mutation {
  why: string;
  mutate(text: string): string;
  rejectedBy: string[];
}

const MUTATIONS: Mutation[] = [
  {
    why: "AC6's named negative control: Restart=on-failure",
    mutate: (t) => t.replace("Restart=no", "Restart=on-failure"),
    rejectedBy: ["restart-no"],
  },
  {
    why: "the one a `content.includes(\"Restart=no\")` test passes: a LATER Restart=on-failure, which systemd's last-wins semantics make the live value",
    // Anchored on the EnvironmentFile DIRECTIVE, not on `[Install]`. The unit
    // no longer HAS an [Install] header — the literal survives only inside the
    // comment explaining why the section was deleted — so the old anchor
    // spliced `Restart=on-failure` into a comment body, where the parser
    // rightly ignores it: the row would then fail as "rejected by nobody",
    // which reads as a broken policy rather than a stale mutation. The intent
    // is unchanged and is the only thing that matters here: a SECOND `Restart=`
    // later in [Service] than the real one, which last-wins semantics make live.
    mutate: (t) =>
      t.replace(`EnvironmentFile=${EXPECTED_ENV_FILE}`, `Restart=on-failure\nEnvironmentFile=${EXPECTED_ENV_FILE}`),
    rejectedBy: ["restart-no", "directive-set"],
  },
  {
    why: "Restart=always with a line continuation, so a line-oriented grep sees `Restart=` and a value on the next line",
    mutate: (t) => t.replace("Restart=no", "Restart=\\\n  always"),
    rejectedBy: ["restart-no"],
  },
  {
    why: "the directive commented out — the policy is gone, and the bytes still say `Restart=no`",
    mutate: (t) => t.replace("Restart=no", "# Restart=no"),
    rejectedBy: ["restart-no", "directive-set"],
  },
  {
    why: "Restart=no demoted to [Unit], where it is not supervision policy at all",
    mutate: (t) => t.replace("Restart=no", "").replace("[Unit]", "[Unit]\nRestart=no"),
    rejectedBy: ["restart-no", "directive-set"],
  },
  {
    why: "User=root — the engine writing artefacts the exec user cannot read",
    mutate: (t) => t.replace("User=exedev", "User=root"),
    rejectedBy: ["user-exedev"],
  },
  {
    why: "the %h trap the AC names: %h in a SYSTEM unit is /root, so the credential is silently absent",
    mutate: (t) => t.replace(`EnvironmentFile=${EXPECTED_ENV_FILE}`, "EnvironmentFile=%h/app/.env"),
    rejectedBy: ["envfile-literal", "no-home-specifier"],
  },
  {
    why: "path drift from KEY_ENV_FILE (app/.env → app/env)",
    mutate: (t) => t.replace(`EnvironmentFile=${EXPECTED_ENV_FILE}`, `EnvironmentFile=/home/${BOX_USER}/app/env`),
    rejectedBy: ["envfile-literal"],
  },
  {
    why: "a SECOND EnvironmentFile — an unsanctioned credential source the AC never granted",
    mutate: (t) => t.replace(`EnvironmentFile=${EXPECTED_ENV_FILE}`, `EnvironmentFile=${EXPECTED_ENV_FILE}\nEnvironmentFile=-/etc/qds/extra.env`),
    rejectedBy: ["envfile-literal", "directive-set"],
  },
  {
    why: "the tmpfiles ordering swapped for a generic one: the engine then races /run/steering on every boot",
    mutate: (t) => t.replace("After=systemd-tmpfiles-setup.service", "After=network-online.target"),
    rejectedBy: ["after-tmpfiles"],
  },
  {
    why: "an empty After= after the real one — systemd RESETS the list, so the ordering is silently dropped",
    mutate: (t) => t.replace("After=systemd-tmpfiles-setup.service", "After=systemd-tmpfiles-setup.service\nAfter="),
    rejectedBy: ["after-tmpfiles", "directive-set"],
  },
  {
    why: "Environment=QDS_RUN_ROOT — exactly what INV-IBOX-13 and DF3.7 AC4 forbid",
    mutate: (t) => t.replace("Restart=no", "Restart=no\nEnvironment=QDS_RUN_ROOT=/srv/qds/runs"),
    rejectedBy: ["no-qds-var", "directive-set"],
  },
  {
    why: "an ExecStart appearing before DF1.10 ships one",
    mutate: (t) => t.replace("Type=simple", "Type=simple\nExecStart=/usr/local/bin/qds-engine run %i"),
    rejectedBy: ["directive-set"],
  },
  {
    why: "ACCEPTED: a comment that names Restart=on-failure while explaining why it is refused (this is the file as shipped)",
    mutate: (t) => `${t}\n# A restart here would be Restart=on-failure, and %h/app/.env with it.\n`,
    rejectedBy: [],
  },
  {
    why: "ACCEPTED: `;`-introduced comments and blank lines",
    mutate: (t) => t.replace("[Service]", "\n; Restart=always\n[Service]\n"),
    rejectedBy: [],
  },
];

describe("DF2.10 AC6 — negative controls: each assertion rejects the wrong file", () => {
  test("every mutation is rejected by exactly the policies named, and by no others", () => {
    for (const m of MUTATIONS) {
      const mutated = parseUnit(m.mutate(UNIT_TEXT));
      const failing = POLICIES.filter((p) => p.violations(mutated).length > 0).map((p) => p.id);
      expect(failing.sort(), m.why).toEqual([...m.rejectedBy].sort());
    }
  });

  test("the mutations are real: each one actually changed the file", () => {
    for (const m of MUTATIONS) {
      expect(m.mutate(UNIT_TEXT), m.why).not.toBe(UNIT_TEXT);
    }
  });

  test("a mutated tmpfiles entry is rejected by the REAL assertions, and by the named one", () => {
    // Each row names the check that MUST reject it — the same discipline the
    // unit mutation table above uses. The previous version ran `tmpfilesEntries`
    // (a pure splitter) and asserted the result was merely `not.toEqual(good)`,
    // which no tmpfiles assertion in this file was ever run against.
    const wrong: Array<[why: string, text: string, check: string]> = [
      ["mode widened to 0755 — the channel becomes world-readable", "d /run/steering 0755 exedev exedev", "mode"],
      ["owned by root — the engine's User= cannot write its own channel", "d /run/steering 0700 root root", "ownership"],
      ["a different path — the drop-in provisions a channel nothing addresses", "d /run/qds-steering 0700 exedev exedev", "path"],
      [
        "a second entry — a channel the story never sanctioned, alongside the real one",
        "d /run/steering 0700 exedev exedev\nd /run/other 0700 exedev exedev",
        "entry-count",
      ],
      ["a field dropped — five fields is the shape, and a short entry must not compare undefined to undefined", "d /run/steering 0700 exedev", "entry-shape"],
    ];
    for (const [why, text, check] of wrong) {
      const violations = tmpfilesViolations(text);
      expect(violations, why).not.toEqual([]);
      expect(
        violations.map((v) => v.split(":")[0]),
        why,
      ).toContain(check);
    }
    // ACCEPTED: comments and blank lines are not entries — proof the checks
    // parse rather than grep, and the false-positive control for the rows above.
    expect(tmpfilesViolations("# comment\n\nd /run/steering 0700 exedev exedev\n")).toEqual([]);
    // …and the file as shipped passes the very checks the mutations fail.
    expect(tmpfilesViolations(TMPFILES_TEXT)).toEqual([]);
  });
});

// ─── fixture contract: the box bakes the marker of the image it booted ──────

/**
 * PARKED HERE, and it should move.
 *
 * This is a FIXTURE-contract test, not a systemd-asset one: its home is
 * `image-contract.test.ts`, beside the rest of gate B. It sits here because
 * that file was being edited in parallel when the fixture knob it exercises
 * landed, and a knob with no check is how a fake grows a hole.
 *
 * The hole it closes: `fake-exedev.ts` RECORDS the create's `--image` into
 * `creates` and then serves `DEFAULT_IMAGE_MARKER` regardless — whose
 * `buildId` is the very constant gate B compares against. So a driver
 * threading the WRONG image ref produced a box gate B passed green, while a
 * real box booted from another image bakes THAT image's buildId and gate B
 * refuses it. `markersByImage` makes the fake behave the way the substrate
 * does; it is OFF by default, and the second half of this test is the proof
 * that leaving it off changes nothing.
 *
 * No gate cycle is run: gate B IS these two calls (`setup-gate.ts` — read the
 * marker with `readBoxFile`, judge it with `imageMarkerFailure(read,
 * driver.imageBuildId)`), so calling them directly asserts the same logic in
 * milliseconds instead of a 20 s create→fill→gate round.
 */
describe("DF2.10 — the fake serves the marker of the image the box was created FROM", () => {
  const FOREIGN_REF = `ghcr.io/not-this-repo/exedev@sha256:${"a".repeat(64)}`;
  const FOREIGN_BUILD_ID = "0123456789abcdef";

  test("markersByImage ON: a wrong --image ref is refused by gate B — and OFF changes nothing", async () => {
    const foreignMarker = JSON.stringify({
      ...(JSON.parse(DEFAULT_IMAGE_MARKER) as Record<string, unknown>),
      imageRef: FOREIGN_REF,
      buildId: FOREIGN_BUILD_ID,
    });
    const fake = fakeExeDev({ markersByImage: { [FOREIGN_REF]: foreignMarker } });
    try {
      // The DOCUMENTED-LEGAL seam and the reason this matters: `image` is
      // overridden while `imageBuildId` is not, so the driver still demands the
      // repo pin from a box booting somebody else's image. Nothing refuses that
      // pair at construction — gate B is the only thing that can.
      const foreign = new ExeDevDriver({ run: fake.run, image: FOREIGN_REF });
      expect(foreign.imageBuildId).toBe(DEFAULT_IMAGE_BUILD_ID);
      const vm = "df210-foreign-image";
      await foreign.create(vm);
      expect(fake.creates.map((c) => c.image)).toEqual([FOREIGN_REF]);

      const read = await readBoxFile(foreign, vm, IMAGE_MARKER_PATH, 10_000);
      const failure = imageMarkerFailure(read, foreign.imageBuildId);
      expect(failure?.code, "gate B passed a box booted from an unpinned image").toBe("image-marker-mismatch");
      expect(failure?.message).toContain(FOREIGN_BUILD_ID);
      expect(failure?.message).toContain(DEFAULT_IMAGE_BUILD_ID);
      // The ref is REPORTED, never compared (a tenant mirror keeps the digest
      // and the buildId but not the ref) — so it must be in the note.
      expect(failure?.message).toContain(FOREIGN_REF);

      // DEFAULT PATH UNCHANGED: same fake, same map — a box created from the
      // repo pin has no entry, keeps DEFAULT_IMAGE_MARKER, and passes.
      const pinned = new ExeDevDriver({ run: fake.run });
      const okVm = "df210-pinned-image";
      await pinned.create(okVm);
      const okRead = await readBoxFile(pinned, okVm, IMAGE_MARKER_PATH, 10_000);
      expect(imageMarkerFailure(okRead, pinned.imageBuildId)).toBeNull();
    } finally {
      fake.cleanup();
    }
  }, 60_000);
});
