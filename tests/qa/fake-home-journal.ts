/**
 * QA hunter-pack fixture: a fake Home-bot/gateway journal the hunter-pack
 * suite (leaf-1.4.1) drives through the F3 happy path — post-merge trigger
 * wakes the QA manager bot, the bot starts a QA protocol, and each hunter leg
 * is journaled as a `qa-leg-submitted` record carrying a complete
 * `ProtocolExternalJobConfig`-shaped config, with `qa-leg-terminal` closing it.
 * One wake, one protocol (story Technical Notes): a second postMergeTrigger
 * for a commitSha whose protocol already fired is refused and journaled as
 * `protocol-refused`.
 *
 * EXTENDS, never re-declares, `tests/managers/home-seam-fakes.ts`: the
 * principal-refusal vocabulary (`TURN_REFUSALS`), the four `SOLSTICE_*_TOKEN`
 * names, `isHomeBackedAgent`, and the budget/turn seam behavior all live
 * there and are imported here. This module only adds the journal around them.
 * AC5 negative control: no second refusal vocabulary may exist anywhere —
 * `assertSpecSeams()` is the in-code pin (its one expected-value literal is
 * the ONLY permitted second spelling in this file).
 *
 * The external_job config is encoded AS DATA mirroring the fork's
 * `ProtocolExternalJobConfig` (zeropoint
 * src/types/protocol.ts:151 — issueId XOR workId, 40-hex commitSha,
 * pollTimeoutMs default 1h, onFailure 'fail'). Zero fork imports: factory-side
 * fixture (charter §5.4), the shape is transcribed, not imported.
 *
 * Journal lines follow the SC2 wrapper-journal pattern
 * (tests/fleet/e2e/sc2-harness.ts:56): one JSON object per line;
 * `parseJsonlJournal` skips torn lines instead of aborting, so a mid-write
 * crash leaves a readable journal.
 */

import {
  GatewayBudgetError,
  HomeTurnRefusalError,
  isHomeBackedAgent,
  PROFILE_TOKEN_NAMES,
  TURN_REFUSALS,
  type Principal,
  type SeamFakes,
  type TurnRefusal,
  createSeamFakes,
} from "../managers/home-seam-fakes.ts";

/**
 * The seam-pinning expected values. This is the ONLY place the vocabulary is
 * spelled out in this file, and only as the assertSpecSeams() expected side —
 * a second usable refusal list anywhere is the AC5 violation.
 */
const SEAM_PIN = {
  turnRefusals: ["initiator_missing", "initiator_mismatch", "no_owner"],
  profileTokenNames: [
    "SOLSTICE_LLM_GATEWAY_TOKEN",
    "SOLSTICE_KNOWLEDGE_TOKEN",
    "SOLSTICE_MEMORY_GATEWAY_TOKEN",
    "SOLSTICE_WORKSPACE_GATEWAY_TOKEN",
  ],
} as const;

/**
 * `ProtocolExternalJobConfig` shape as data (fork protocol.ts:151). `issueId`
 * is always null here — a fixture synthesizing a numeric issueId is AC1's
 * namespace-conflation negative control and must fail.
 */
export type QaExternalJobConfig = {
  repoSlug: string;
  repoUrl: string;
  commitSha: string;
  manifestPath: string;
  issueId: null;
  workId: string;
  groupCapUsd: number;
  pollTimeoutMs: number;
  onFailure: "fail";
};

/**
 * The one-wake-one-protocol refusal (story Technical Notes): a QA protocol
 * already fired for this merged commitSha, so the re-wake is refused before
 * any turn runs.
 */
export class HomeTriggerRefusedError extends Error {
  constructor(
    readonly code: "protocol-already-fired",
    commitSha: string,
  ) {
    super(
      `postMergeTrigger refused for ${commitSha}: a QA protocol already fired for this merged commitSha — one wake, one protocol`,
    );
    this.name = "HomeTriggerRefusedError";
  }
}

export type QaJournalRecord =
  | { kind: "post-merge-trigger"; commitSha: string; order: number }
  | { kind: "protocol-refused"; commitSha: string; reason: "protocol-already-fired"; order: number }
  | { kind: "turn"; botId: string; initiator: Principal; order: number }
  | { kind: "turn-refused"; botId: string; refusal: TurnRefusal; order: number }
  | {
      kind: "budget-refused";
      botId: string;
      reason: "budget_reservation_missing" | "budget_reservation_exists";
      order: number;
    }
  | { kind: "qa-protocol-start"; commitSha: string; protocolRunId: string; order: number }
  | { kind: "qa-leg-submitted"; workId: string; config: QaExternalJobConfig; order: number }
  | {
      kind: "qa-leg-terminal";
      workId: string;
      status: "completed" | "failed";
      exitCode: number;
      order: number;
    };

export type FakeHomeJournal = SeamFakes & {
  readonly journal: readonly QaJournalRecord[];
  /**
   * The post-merge trigger waking the QA manager bot as a RECORDED turn:
   * the initiator is the home's owner principal itself (the operator, per
   * S02b INV-8) — passed through to the seam fakes, never synthesized here.
   * An unreserved bot is refused (GatewayBudgetError) and journaled as
   * budget-refused before the throw re-raises.
   */
  postMergeTrigger(commitSha: string, botId: string): void;
  startProtocol(args: { commitSha: string; protocolRunId: string }): void;
  /** One hunter leg = one `qa-leg-submitted` journal record; returns the config journaled. */
  submitLeg(args: {
    lens: string;
    repoSlug: string;
    repoUrl: string;
    commitSha: string;
    manifestPath: string;
    groupCapUsd: number;
    pollTimeoutMs?: number;
  }): QaExternalJobConfig;
  /**
   * Close a submitted leg: journals `qa-leg-terminal` (status is the record's
   * terminal lifecycle state — an exit-6 leg closes "completed"; the exit code
   * rides beside it, it is not the verdict). Refuses a workId never submitted.
   */
  legTerminal(args: { workId: string; status: "completed" | "failed"; exitCode: number }): void;
  /** The journal as JSONL — feed through parseJsonlJournal to round-trip. */
  toJsonl(): string;
};

/**
 * Fork protocol.ts:151 semantics, pinned as data: `w:qa-<utcstamp>-<lens>`
 * workId, 40-hex commitSha, pollTimeoutMs default 1h, onFailure 'fail',
 * issueId null (XOR with workId — never both, never synthesized).
 */
function externalJobConfig(args: {
  lens: string;
  repoSlug: string;
  repoUrl: string;
  commitSha: string;
  manifestPath: string;
  groupCapUsd: number;
  pollTimeoutMs?: number;
}): QaExternalJobConfig {
  if (!/^[0-9a-f]{40}$/.test(args.commitSha)) {
    throw new Error(`leg_commit_sha_invalid: commitSha must be 40-hex, got: ${args.commitSha}`);
  }
	// Compact UTC stamp — the fork counterpart builder's exact form
	// (qaUtcStamp: 20261016T120000Z), which the run-record writer grammar pins.
	const utcstamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return {
    repoSlug: args.repoSlug,
    repoUrl: args.repoUrl,
    commitSha: args.commitSha,
    manifestPath: args.manifestPath,
    issueId: null,
    workId: `w:qa-${utcstamp}-${args.lens}`,
    groupCapUsd: args.groupCapUsd,
    pollTimeoutMs: args.pollTimeoutMs ?? 3_600_000,
    onFailure: "fail",
  };
}

export function createFakeHomeJournal(opts: {
  gatewayUrl: string;
  /** Null owner is representable so INV-8's no_owner refusal stays observable. */
  owner: Principal | null;
  homeId?: string;
}): FakeHomeJournal {
  const fakes = createSeamFakes(opts);
  const journal: QaJournalRecord[] = [];
  const firedProtocolCommitShas = new Set<string>();
  const submittedWorkIds = new Set<string>();
  let order = 0;

  const journalRefusal = (botId: string, error: unknown): never => {
    if (error instanceof HomeTurnRefusalError) {
      journal.push({ kind: "turn-refused", botId, refusal: error.refusal, order: order++ });
    } else if (error instanceof GatewayBudgetError) {
      journal.push({ kind: "budget-refused", botId, reason: error.reason, order: order++ });
    }
    throw error;
  };

  return {
    ...fakes,
    journal,

    postMergeTrigger(commitSha, botId) {
      // One wake, one protocol: journal the refusal, then re-raise — before
      // any wake record or turn for the repeat commitSha.
      if (firedProtocolCommitShas.has(commitSha)) {
        const refused = new HomeTriggerRefusedError("protocol-already-fired", commitSha);
        journal.push({ kind: "protocol-refused", commitSha, reason: refused.code, order: order++ });
        throw refused;
      }
      journal.push({ kind: "post-merge-trigger", commitSha, order: order++ });
      try {
        // Recorded, not synthesized: the initiator IS the home's owner object.
        fakes.runBotTurn(botId, { initiator: fakes.home.owner ?? undefined });
        const turn = fakes.turns[fakes.turns.length - 1];
        if (!turn) throw new Error("qa_journal_invariant: recorded turn missing after runBotTurn");
        journal.push({ kind: "turn", botId: turn.botId, initiator: turn.initiator, order: order++ });
        // Marked only on a landed turn: a budget- or principal-refused wake
        // fired no protocol, so the commitSha stays re-triggerable.
        firedProtocolCommitShas.add(commitSha);
      } catch (error) {
        journalRefusal(botId, error);
      }
    },

    startProtocol({ commitSha, protocolRunId }) {
      journal.push({ kind: "qa-protocol-start", commitSha, protocolRunId, order: order++ });
    },

    submitLeg(args) {
      const config = externalJobConfig(args);
      // One wake, one protocol extends to leg identity: a same-millisecond
      // duplicate submit would make legTerminal ambiguous — refuse, don't dedup.
      if (submittedWorkIds.has(config.workId)) {
        throw new Error(`qa_journal_invariant: duplicate workId ${JSON.stringify(config.workId)} (same-millisecond submit)`);
      }
      submittedWorkIds.add(config.workId);
      journal.push({ kind: "qa-leg-submitted", workId: config.workId, config, order: order++ });
      return config;
    },

    legTerminal({ workId, status, exitCode }) {
      if (!submittedWorkIds.has(workId)) {
        throw new Error(`qa_journal_invariant: qa-leg-terminal for unsubmitted workId ${JSON.stringify(workId)}`);
      }
      journal.push({ kind: "qa-leg-terminal", workId, status, exitCode, order: order++ });
    },

    toJsonl() {
      return `${journal.map((r) => JSON.stringify(r)).join("\n")}\n`;
    },
  };
}

/** Torn-line-safe reader (SC2 wrapperJournal pattern, hardened): a line that
 * does not parse — a mid-write torn tail — is skipped, not fatal. */
export function parseJsonlJournal(text: string): QaJournalRecord[] {
  const records: QaJournalRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as QaJournalRecord);
    } catch {
      /* torn tail line: skip */
    }
  }
  return records;
}

/**
 * AC5 seam pin: the vocabularies this fixture rides on are EXACTLY the ones
 * home-seam-fakes owns — three principal refusals, four token names, and
 * `isHomeBackedAgent` by identity and behavior. Throws on any drift.
 */
export function assertSpecSeams(): void {
  if (JSON.stringify(TURN_REFUSALS) !== JSON.stringify(SEAM_PIN.turnRefusals)) {
    throw new Error(
      `spec seam drift: TURN_REFUSALS is ${JSON.stringify(TURN_REFUSALS)}, expected ${JSON.stringify(SEAM_PIN.turnRefusals)}`,
    );
  }
  if (JSON.stringify(PROFILE_TOKEN_NAMES) !== JSON.stringify(SEAM_PIN.profileTokenNames)) {
    throw new Error(
      `spec seam drift: PROFILE_TOKEN_NAMES is ${JSON.stringify(PROFILE_TOKEN_NAMES)}, expected ${JSON.stringify(SEAM_PIN.profileTokenNames)}`,
    );
  }
  // Identity + the pinned behavior (S02b: runtime hermes-sandbox, user owner).
  const operator: Principal = { kind: "user", id: "op" };
  if (
    isHomeBackedAgent({ runtime: "hermes-sandbox", owner: operator }) !== true ||
    isHomeBackedAgent({ runtime: "hermes-sandbox" }) !== false ||
    isHomeBackedAgent({ runtime: "other", owner: operator }) !== false
  ) {
    throw new Error("spec seam drift: isHomeBackedAgent behavior does not match the S02b pin");
  }
}
