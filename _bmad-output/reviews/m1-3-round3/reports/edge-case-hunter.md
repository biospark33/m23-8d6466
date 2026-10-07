[
  {
    "location": "scripts/memory/probe-recall.ts:219-236",
    "trigger_condition": "canary refuses while evidenceDir is uncreatable (exists as file, EACCES, ENOTDIR)",
    "guard_snippet": "let diagnosticWritten = false; try { mkdirSync(env.evidenceDir, { recursive: true }); ... } catch (e) { diagnosticWritten = false; writeSync(2, `canary diagnostic write failed: ${(e as Error).message}\\n`); }",
    "potential_consequence": "F-019 guarded only atomicReplaceFile; the preceding mkdirSync throws past the canary-refusal return, so the run exits 1 (generic failure) instead of the contracted exit-3 canary refusal with diagnosticPath omitted"
  },
  {
    "location": "scripts/memory/priming-report.ts:414-426",
    "trigger_condition": "ledger.close() throws after costTable was successfully assigned",
    "guard_snippet": "let tableWritten = costTable !== undefined; catch (e) { if (!tableWritten) dataNotes.push(`cost ledger unreadable ... costTable omitted`); else dataNotes.push(`cost ledger close failed (${(e as Error).message}) — costTable above is read-complete`); }",
    "potential_consequence": "outer catch pushes \"costTable omitted\" while metrics serialize the assigned costTable — one report simultaneously shows the table and a note claiming it is omitted"
  },
  {
    "location": "scripts/memory/priming-report.ts:526-529",
    "trigger_condition": "md write fails after json write succeeded (or reader runs between the two replaces)",
    "guard_snippet": "const md = renderReportMd(metrics); atomicReplaceFile(jsonPath, ...); try { atomicReplaceFile(mdPath, md); } catch (e) { atomicReplaceFile(jsonPath, previousJson); throw e; }",
    "potential_consequence": "torn pair on disk (new json beside stale md); R2-010's reader-never-sees-mismatched-pair invariant only serializes writers — readers take no lock, so AC5 re-derivability breaks at the torn state"
  },
  {
    "location": "scripts/memory/priming-report.ts:128-145,386-388",
    "trigger_condition": "audit db present but read fails (SQLITE_BUSY under a writer, corruption, wrong schema)",
    "guard_snippet": "catch { dataNotes.push(`audit db unreadable at ${withCwd(path)} (${code}); receiptCoverage reported 0`); return ids; }",
    "potential_consequence": "catch collapses every read failure to an empty set, so receiptCoverage silently prints 0% — a present-but-unreadable source reported as absent data (same class F-010/R2-005 fixed elsewhere)"
  },
  {
    "location": "scripts/memory/priming-report.ts:92-97",
    "trigger_condition": "individual side-channel file exists but is unreadable (EACCES mid-dir)",
    "guard_snippet": "catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadableFiles.push(name); continue; } // + dataNote naming the count",
    "potential_consequence": "a permission-blocked valid row is indistinguishable from malformed JSON — cycles silently undercounted; R2-005's note covers only readdir-level failure"
  },
  {
    "location": "scripts/p0-9/provision-and-import.ts:315-322",
    "trigger_condition": "two same-domain entries both have empty concepts",
    "guard_snippet": "if (entry.concepts.length === 0) { failures.push(`${bankId} ${documentId}: empty-concepts-skipped`); continue; } seen.add(documentId);",
    "potential_consequence": "guard placed after seen.add: the second empty-concepts dup hits the seen.has continue and is dropped silently — the recorded-failure contract undercounts"
  }
]
