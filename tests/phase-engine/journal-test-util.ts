/**
 * Shared test helper (Story DF1.1). Both `phase-lifecycle.test.ts` and
 * `pipeline-run.test.ts` read a journal file off disk and parse it as
 * `JournalFile`; kept in one place so the two suites cannot drift.
 */
import * as fs from "node:fs";

import type { JournalFile } from "../../src/phase-engine/index.ts";

export function readJournal(p: string): JournalFile {
  return JSON.parse(fs.readFileSync(p, "utf8")) as JournalFile;
}
