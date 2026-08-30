/**
 * The redaction map the shipped CLIs assemble (INV-PR-7, INV-RV-4) — F007.
 *
 * `openPullRequest` and `reverify` both default `deps.redaction` to `{}`, and
 * `redactSecrets(text, {})` returns its input unchanged. Neither shipped entry
 * point passed one, so the redaction boundary was inert on the only path that
 * publishes: the PR body, the refusal issue comment and the sealed report all
 * carry `git push` / `ls-remote` stderr and agent-authored text verbatim.
 *
 * One copy for both CLIs, because both publish the same run's values.
 *
 * What the host still holds when these run:
 *  - the provider key HASH, from the run record (`keyHash`);
 *  - the host GitHub token — but only from the moment the preflight reads it.
 *
 * What it cannot hold: the minted provider key itself. INV-4 keeps the
 * plaintext key in the mint return and nowhere else (`credentials.ts:28`), and
 * the box is destroyed before either CLI runs, so `keyHash` is all there is.
 * `process.env` is never consulted either: INV-PR-2 keeps the token out of the
 * environment and INV-RV-3 strips credentials from the verify process, so an
 * env-derived map would redact nothing at all.
 */
import { RunRecordStore, resolveRunsDir } from "../providers/run-record.ts";
import { assertRedactable, type RedactionMap } from "./report.ts";

/** Key names, chosen so `redactSecrets`' `SECRET_KEY_RE` can see them. */
export const TOKEN_KEY = "QDS_PR_TOKEN";
export const KEY_HASH_KEY = "QDS_PROVIDER_KEY_HASH";

/**
 * The run's own known-sensitive values that are on disk right now.
 *
 * An unreadable or absent record yields `{}`: the entry point refuses on that
 * absence a moment later and reports it properly. A crash from the redaction
 * path would replace a clean refusal with a stack trace.
 */
export function runRedactionMap(runId: string, runsDir?: string): RedactionMap {
  const map: RedactionMap = {};
  try {
    const { keyHash } = new RunRecordStore({ dir: resolveRunsDir(runsDir), create: false }).get(runId);
    if (keyHash !== undefined && keyHash !== "") map[KEY_HASH_KEY] = keyHash;
  } catch {
    // No record to read. Nothing to promise, so promise nothing.
  }
  assertRedactable(map);
  return map;
}

/**
 * Wrap the token reader so the token lands in `map` AT the read.
 *
 * Not read up front: the preflight reads it LAST, after the gate has passed
 * (`push.ts:323`), precisely so an unregistered repo or a red verdict never
 * causes a credential to be touched. A CLI that read it early just to build the
 * map would break that. Every surface the map is applied to — the body
 * (`open-pr.ts:276`) and the refusal comment (`open-pr.ts:435`) — is rendered
 * after this read, so filling the entry in here is in time for all of them.
 */
export function captureHostToken(
  map: RedactionMap,
  read: () => Promise<string | null>,
): () => Promise<string | null> {
  return async () => { // dp:ok wrapper around the injected token read; a rejection is that read's own failure and belongs to the preflight caller — invoked at push.ts:323, handled by open-pr.ts:251-253
    const token = await read();
    if (token !== null && token.length > 0) map[TOKEN_KEY] = token;
    return token;
  };
}
