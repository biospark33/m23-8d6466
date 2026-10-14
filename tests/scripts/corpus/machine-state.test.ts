/**
 * J4 — the `MachineStateRecordSchema` arm of the corpus union and
 * `appendMachineStateRecord` (appendRecord stays triage-only). Triage behavior must be unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CorpusRecordSchema,
  DEFAULT_MACHINE_STATE_CORPUS_DIR,
  MACHINE_STATE_DISPOSITIONS,
  MachineStateRecordSchema,
  TriageRecordSchema,
  appendMachineStateRecord,
  appendRecord,
  readCorpusRecords,
} from "../../../scripts/corpus/index.ts";
import { corpusFilePath, readRecords } from "../../../scripts/corpus/merge.ts";
import { recordKey } from "../../../scripts/corpus/schema.ts";

const machine = {
  finding_id: "run1@t1",
  state_ref: "observe:run1",
  label: "noul=0.9",
  disposition: "compact",
  labeler: "jev-1.13.0-l7",
  answer_mode: "mock",
  pr: null,
  round: null,
  created_at: "2026-10-14T00:00:00.000Z",
  latency_ms: 3,
};

const triage = {
  finding_id: "f1",
  finding_text: "unchecked null",
  diff_context_ref: "src/a.ts:1",
  label: "real",
  disposition: "PATCH",
  labeler: "frontier-lead",
  pr: 5,
  round: 1,
  created_at: "2026-10-14",
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join("/tmp", "corpus-ms-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("MachineStateRecordSchema", () => {
  test("valid record parses; disposition set is exactly compact|no-compact", () => {
    expect(MachineStateRecordSchema.safeParse(machine).success).toBe(true);
    expect(MACHINE_STATE_DISPOSITIONS).toEqual(["compact", "no-compact"]);
    expect(DEFAULT_MACHINE_STATE_CORPUS_DIR).toBe("_bmad-output/judgment/corpus/machine-state");
  });

  test("arms never blend: extra keys refused", () => {
    expect(MachineStateRecordSchema.safeParse({ ...machine, finding_text: "x" }).success).toBe(false);
    expect(CorpusRecordSchema.safeParse({ ...machine, diff_context_ref: "x" }).success).toBe(false);
    expect(CorpusRecordSchema.safeParse({ ...triage, state_ref: "x" }).success).toBe(false);
  });

  test("disposition outside the closed set refused; triage enum unaffected", () => {
    expect(MachineStateRecordSchema.safeParse({ ...machine, disposition: "PATCH" }).success).toBe(false);
    expect(TriageRecordSchema.safeParse({ ...triage, disposition: "compact" }).success).toBe(false);
    expect(() => appendRecord(dir, { ...triage, disposition: "compact" })).toThrow(/record failed schema validation: disposition/);
  });

  test("pr/round must be null, answer_mode required", () => {
    expect(MachineStateRecordSchema.safeParse({ ...machine, pr: 1 }).success).toBe(false);
    expect(MachineStateRecordSchema.safeParse({ ...machine, round: 1 }).success).toBe(false);
    const { answer_mode: _a, ...noMode } = machine;
    expect(MachineStateRecordSchema.safeParse(noMode).success).toBe(false);
    expect(MachineStateRecordSchema.safeParse({ ...machine, answer_mode: "other" }).success).toBe(false);
  });

  test("created_at / latency_ms follow the triage rules", () => {
    expect(MachineStateRecordSchema.safeParse({ ...machine, created_at: "2026-02-30" }).success).toBe(false);
    expect(MachineStateRecordSchema.safeParse({ ...machine, created_at: "yesterday" }).success).toBe(false);
    expect(MachineStateRecordSchema.safeParse({ ...machine, latency_ms: -1 }).success).toBe(false);
    expect(MachineStateRecordSchema.parse({ ...machine, latency_ms: undefined }).latency_ms).toBeNull();
  });

  test("recordKey accepts both arms with the unchanged grammar", () => {
    expect(recordKey(MachineStateRecordSchema.parse(machine))).toBe("x|x|run1@t1|jev-1.13.0-l7");
    expect(recordKey(TriageRecordSchema.parse(triage))).toBe("5|1|f1|frontier-lead");
  });
});

describe("appendMachineStateRecord", () => {
  test("writes then detects duplicate", () => {
    expect(appendMachineStateRecord(dir, machine)).toBe("written");
    expect(appendMachineStateRecord(dir, machine)).toBe("duplicate");
    const lines = readFileSync(corpusFilePath(dir, null, null), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(MachineStateRecordSchema.safeParse(JSON.parse(lines[0]!)).success).toBe(true);
    expect(appendMachineStateRecord(dir, { ...machine, finding_id: "run2@t1" })).toBe("written");
    expect(readCorpusRecords(corpusFilePath(dir, null, null))).toHaveLength(2);
  });

  test("invalid record names its fields", () => {
    expect(() => appendMachineStateRecord(dir, { ...machine, finding_text: "x" })).toThrow(/record failed schema validation: /);
    expect(() => appendMachineStateRecord(dir, { ...machine, disposition: "PATCH" })).toThrow(/record failed schema validation: disposition/);
    expect(() => appendMachineStateRecord(dir, triage)).toThrow(/record failed schema validation: /);
    expect(() => appendMachineStateRecord(dir, 42)).toThrow(/record failed schema validation/);
  });
});

describe("appendRecord stays triage-only", () => {
  test("refuses a machine-state record exactly as on dev", () => {
    expect(() => appendRecord(dir, machine)).toThrow(/record failed schema validation: /);
    expect(existsSync(corpusFilePath(dir, null, null))).toBe(false);
  });

  test("mixed files: each writer and readRecords fail loudly on the foreign arm", () => {
    const f = corpusFilePath(dir, null, null);
    writeFileSync(f, `${JSON.stringify(TriageRecordSchema.parse({ ...triage, pr: null, round: null }))}\n`);
    expect(() => appendMachineStateRecord(dir, machine)).toThrow(/failed schema validation/);
    rmSync(f);
    expect(appendMachineStateRecord(dir, machine)).toBe("written");
    expect(() => appendRecord(dir, { ...triage, pr: null, round: null })).toThrow(/failed schema validation/);
    expect(() => readRecords(f)).toThrow(/failed schema validation/);
  });

  test("triage behavior unchanged", () => {
    expect(appendRecord(dir, triage)).toBe("written");
    expect(appendRecord(dir, triage)).toBe("duplicate");
    expect(readRecords(corpusFilePath(dir, 5, 1))).toHaveLength(1);
    expect(() => appendRecord(dir, { ...triage, finding_text: "" })).toThrow(/record failed schema validation: finding_text/);
    expect(() => appendRecord(dir, 42)).toThrow(/record failed schema validation/);
  });
});
