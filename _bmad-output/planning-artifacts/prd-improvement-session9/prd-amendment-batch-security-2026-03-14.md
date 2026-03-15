> **Amendment Batch: Security — STRIDE Threat Model Response**
> **Source Analysis:** `prd-analysis-stride-threat-model-2026-03-14.md`
> **Applies To:** `prd-v2.md` v2.0 (2026-03-10)
> **Date:** 2026-03-14
> **Author:** Security Amendment (Claude Sonnet 4.6 via BMAD)
> **Classification:** Internal — Development Team Use

This batch contains all PRD changes required to address the gaps identified in the STRIDE threat model analysis. Amendments are ordered: existing NFR modifications first (NFR9 through NFR13, NFR33), then new NFRs (SEC-01 through SEC-13), then FR modifications (FR51, FR127).

Each amendment is self-contained: it quotes the exact original text from `prd-v2.md` and provides the complete replacement text that supersedes it.

---

## AMENDMENT: Strengthen NFR11 — Path Traversal Enforcement Mechanism

**Type:** MODIFY_NFR
**Target:** NFR11
**Reason:** NFR11 specifies the desired outcome (access denied error) without specifying the enforcement mechanism, leaving path traversal via symlinks or relative paths possible if enforcement is application-level only (STRIDE gap: E-01, addresses M-01).

**Original text:**
> **NFR11:** Agent filesystem access must be restricted to the assigned worktree and explicit scope at the process level — an agent attempting to read or write outside its scope receives an access denied error, not a warning

**Replacement text:**
> **NFR11:** Agent filesystem access must be restricted to the assigned worktree and explicit scope, enforced at the OS level — not solely at the application level. For MVP on macOS, enforcement must use `sandbox-exec` (macOS Sandbox) profiles or Bun's `--allow-read`/`--allow-write` permission flags with explicit scope allowlists; on Linux, `seccomp` profiles or equivalent OS-level restrictions apply. Whichever mechanism is used must be specified in the architecture document and verified by an integration test that attempts path traversal (`../../`) from a sandboxed agent process and confirms the attempt is blocked with an access denied error. Application-level path canonicalization (resolving symlinks before scope check) must be applied in addition to, not instead of, the OS-level enforcement. Post-MVP for B2B deployment: evaluate full container isolation (Docker/Podman) per agent.

---

## AMENDMENT: Strengthen NFR9 — Add Prompt Injection as a Credential Access Vector

**Type:** MODIFY_NFR
**Target:** NFR9
**Reason:** NFR9 covers the legitimate access path (Pi SDK mediation) but does not address the case where a compromised or prompt-injected agent uses Pi SDK's own tool-call mechanism to read `factory.yaml` directly — an agent operating within Pi could still request a file read of `factory.yaml` if filesystem scope enforcement (NFR11) fails (STRIDE gap: T-07, E-02).

**Original text:**
> **NFR9:** API credentials stored in `factory.yaml` must never be readable by any agent process — Pi SDK mediates all model API access, agents interact with Pi, never with providers directly

**Replacement text:**
> **NFR9:** API credentials stored in `factory.yaml` must never be readable by any agent process via any access path — including direct filesystem reads, Pi SDK tool calls, environment variable inspection, or process memory access. Pi SDK mediates all model API access; agents interact with Pi, never with providers directly. Factory Core must provide credentials to Pi SDK via in-process configuration struct at startup, never via environment variable or command-line argument, so that credentials are not present in the subprocess environment inherited by agents and hook scripts. This requirement is the first line of a defense-in-depth chain: NFR11 (filesystem scope) and NFR-SEC-12 (environment sanitization) provide additional enforcement layers.

---

## AMENDMENT: Strengthen NFR10 — Specify Credential Scanning Coverage

**Type:** MODIFY_NFR
**Target:** NFR10
**Reason:** NFR10 states credentials must be verifiable by "automated credential scanning on all output paths" without specifying what patterns that scanning must cover, leaving gaps for partial credential fragments and high-entropy strings (STRIDE gap: I-01, C-05).

**Original text:**
> **NFR10:** No API key, secret, or credential may appear in any factory output: agent stdout/stderr, Overstory logs, learning records, PR evidence body, dashboard rendered content, committed files, or `.qds/meta/` journals — as verifiable by automated credential scanning on all output paths

**Replacement text:**
> **NFR10:** No API key, secret, or credential may appear in any factory output: agent stdout/stderr, Overstory logs, learning records, PR evidence body, dashboard rendered content, committed files, `.qds/meta/` journals, or Telegram outbound messages — as verifiable by automated credential scanning on all output paths. Credential scanning must cover: (a) known API key patterns by provider (Anthropic `sk-ant-*`, Telegram bot token format `\d+:[A-Za-z0-9_-]{35}`, GitHub token formats `ghp_*` / `gho_*` / `github_pat_*`); (b) generic high-entropy string detection (Shannon entropy > 4.5 bits/character for strings longer than 20 characters); and (c) fragments of known credentials (prefix or suffix matches). Scanning must run as part of the factory's startup health check and as a pre-commit hook on all factory-initiated commits, not only in CI.

---

## AMENDMENT: Strengthen NFR12 — Add File Permission Requirement

**Type:** MODIFY_NFR
**Target:** NFR12
**Reason:** NFR12 prevents git tracking of `factory.yaml` but does not require file permissions that prevent any co-resident local process running as the same user from reading the file (STRIDE gap: I-05, C-01).

**Original text:**
> **NFR12:** `factory.yaml` must be excluded from version control via `.gitignore` — the setup script must verify this on every startup and halt with an error if `factory.yaml` is tracked by git

**Replacement text:**
> **NFR12:** `factory.yaml` must be excluded from version control via `.gitignore` and must have file permissions `600` (owner read/write only, no group or world access). The setup script must: (a) create `factory.yaml` with `600` permissions, (b) verify `.gitignore` exclusion and halt with an error if `factory.yaml` is tracked by git, and (c) verify file permissions on every startup and emit a warning (non-halting) if permissions are broader than `600`. The setup documentation must warn developers that backup software (Time Machine, iCloud Drive, Dropbox) may copy `factory.yaml` to cloud storage and recommend excluding the factory config directory from backup sync.

---

## AMENDMENT: Strengthen NFR13 — Add GitHub Branch Protection Requirement

**Type:** MODIFY_NFR
**Target:** NFR13
**Reason:** NFR13 enforces the `qds/` branch namespace at the Factory Core software level, but the underlying GitHub token may have write access to all branches on the account, meaning the restriction is software-enforced only and the token itself constitutes an unmitigated escalation path (STRIDE gap: E-07, T-08, M-06).

**Original text:**
> **NFR13:** Factory branch operations must be restricted to the `qds/` namespace — any factory attempt to create, modify, or delete a branch outside `qds/<dev>/` must be blocked at the Factory Core level before the git command executes

**Replacement text:**
> **NFR13:** Factory branch operations must be restricted to the `qds/` namespace — any factory attempt to create, modify, or delete a branch outside `qds/<dev>/` must be blocked at the Factory Core level before the git command executes. Additionally: (a) the setup script must verify that the authenticated GitHub token has only the minimum required scopes (`contents:write` and `pull_requests:write` on the target repository); where possible, a fine-grained Personal Access Token (PAT) scoped to the specific target repository is strongly preferred over a classic OAuth token with broad `repo` scope; (b) the setup documentation must require that the target repository have GitHub branch protection rules configured — no force push to any branch, require pull requests for merges to the default branch, and require status checks — as an independent enforcement layer the factory cannot bypass; and (c) the setup script must check for branch protection rules via `gh api` and warn the developer if they are not configured.

---

## AMENDMENT: Update NFR33 — Add Brute-Force Rate Limiting, Registration Code Expiry, and Content Security Policy

**Type:** MODIFY_NFR
**Target:** NFR33
**Reason:** NFR33 addresses outbound credential sanitization but does not cover: inbound command flood protection, registration code brute-force via the `/register` endpoint, code expiry, or the broader outbound content security policy needed to prevent operational intelligence disclosure in Telegram messages (STRIDE gaps: S-01, S-02, D-01, I-04, M-02, M-08).

**Original text:**
> **NFR33:** No credentials, API keys, file paths, or system-level details may appear in any Telegram message — all outbound messages must pass through the credential sanitizer (extending NFR9-NFR10 to the Telegram output channel), as verifiable by automated scanning of all formatted messages in test suite

**Replacement text:**
> **NFR33:** Telegram integration must satisfy three security requirements:
>
> **(a) Outbound content security policy.** No credentials, API keys, file paths, raw stack traces, code snippets from the target codebase, learning record content, agent internal state dumps, or detailed architectural descriptions from stall diagnostics may appear in any Telegram message. All outbound messages must pass through the credential sanitizer (extending NFR9-NFR10 to the Telegram output channel). Permitted outbound content is limited to: story IDs, pipeline phase summaries, aggregate cost totals, completion counts, and generic escalation descriptions (e.g., "Agent stalled — probable cause: missing dependency"). Verifiable by automated scanning of all formatted messages in the test suite.
>
> **(b) Registration code security.** Telegram registration codes (FR127) must use at least 48 bits of cryptographic randomness (minimum 8 alphanumeric characters from a mixed-case charset). Codes must expire after 10 minutes from generation. The code must be displayed only in the CLI terminal output and must never be written to any log file, database record, or file that could be committed or transmitted. The bot must apply silent drop (no response) to unregistered senders attempting to register with invalid or expired codes, rather than returning an error response, to prevent confirmation of bot activity. Verifiable by unit tests covering entropy measurement, expiry enforcement, and response-suppression behavior.
>
> **(c) Per-sender rate limiting.** The Telegram bot must rate-limit inbound messages per Telegram user ID: a maximum of 5 failed authentication attempts per user ID per hour (with silent drop thereafter), and a maximum of 30 messages per registered sender per minute (with a 5-minute backoff on violation). Rate limiting applies independently of the NL daily budget ceiling (NFR34). Verifiable by integration tests simulating rapid message sequences from a single sender.

---

## AMENDMENT: Update FR51 — Add /nudge Command Authentication Requirement

**Type:** MODIFY_FR
**Target:** FR51
**Reason:** The `/nudge` Telegram command injects arbitrary instructions into a running agent's context, which the STRIDE analysis identifies as effectively remote code execution in the agent's reasoning — the highest-impact command if spoofed — requiring a confirmation step distinct from single-message authorization (STRIDE threat: S-01, Section 7.4 impact assessment).

**Original text:**
> **FR51:** Factory can enforce git safety iron laws: never force-push, never commit to protected branches, factory-namespaced branch naming (`qds/<dev>/<story-id>`), structured commit attribution (`[QDS:<story-id>:<phase>]`)

**Replacement text:**
> **FR51:** Factory can enforce git safety iron laws: never force-push, never commit to protected branches, factory-namespaced branch naming (`qds/<dev>/<story-id>`), structured commit attribution (`[QDS:<story-id>:<phase>]`). Additionally, the `/nudge` Telegram command — which injects instructions directly into a running agent's context — must require a two-step confirmation before execution: the developer sends `/nudge {story_id} {message}`, the bot responds with a preview of the nudge content and the target agent, and the developer must send a confirmation reply (`/nudge {story_id} confirm`) within 60 seconds for the nudge to execute. Nudge requests that expire without confirmation are silently discarded and logged. The `/approve` command for BMAD dismissals and circuit breaker overrides must use the same two-step confirmation pattern (`/approve {id}` → preview → `/approve {id} confirm`). This two-step requirement applies to both Telegram commands and to Act-mode copilot nudge/approve actions (FR108, FR109) which already require explicit confirmation via FR109.

---

## AMENDMENT: New NFR — Agent Worktree OS-Level Sandboxing

**Type:** NEW_NFR
**Target:** Security section (after NFR13)
**Reason:** The existing NFR11 addresses scope restriction but the enforcement mechanism is not specified at an architectural level; this new NFR establishes the OS-level sandboxing requirement as a named, testable constraint independent of NFR11's outcome-specification (STRIDE gap: E-01, E-02, M-01).

**Original text:** N/A — new item

**Replacement text:**
> **NFR-SEC-01:** Agent subprocess filesystem access must be enforced at the OS level using platform-appropriate sandboxing — macOS `sandbox-exec` profiles or Bun `--allow-read`/`--allow-write` permission flags with canonicalized path allowlists on macOS; Linux `seccomp` or equivalent on Linux. The sandboxing mechanism must be: (a) specified by name in the architecture document, (b) applied uniformly to all agent subprocesses and hook scripts spawned by Factory Core, and (c) verified by an automated integration test that spawns a sandboxed subprocess, attempts to read a file outside the permitted scope using both absolute paths and relative path traversal (`../../`), and asserts that both attempts are blocked at the OS level with an access denied error. Application-level path canonicalization is required in addition to OS-level enforcement to defend against symlink traversal. Post-MVP for B2B deployment: evaluate container-based isolation (Docker/Podman) per agent process as the enforcement mechanism.

---

## AMENDMENT: New NFR — factory.yaml File Permission Enforcement

**Type:** NEW_NFR
**Target:** Security section (after NFR-SEC-01)
**Reason:** `factory.yaml` holds all factory credentials in plaintext and has no file permission requirement in the current PRD, meaning any process running as the same OS user can read all credentials from a single file (STRIDE gap: I-05, C-01).

**Original text:** N/A — new item

**Replacement text:**
> **NFR-SEC-02:** `factory.yaml` must have file permissions `600` (owner read/write only) at all times. The setup script must create the file with `600` permissions. Factory startup must verify permissions before reading credentials and must: halt with an error message if `factory.yaml` is world-readable (`o+r`) or group-readable (`g+r`) — a broadly readable credentials file is a hard stop condition, not a warning. The startup verification check must be present even if the `chmod` was applied correctly at setup time, to guard against external tools that may reset permissions. This requirement is in addition to the `.gitignore` exclusion requirement in NFR12.

---

## AMENDMENT: New NFR — Dashboard Session Token Authentication and Localhost Binding

**Type:** NEW_NFR
**Target:** Security section (after NFR-SEC-02)
**Reason:** No authentication mechanism is described for the dashboard SSE and WebSocket endpoints; any process on localhost (or on the local network if the developer changes the bind address) can connect, subscribe to agent output, and issue control commands including nudge and stop (STRIDE gaps: I-03, S-06, D-08, M-03).

**Original text:** N/A — new item

**Replacement text:**
> **NFR-SEC-03:** Dashboard SSE and WebSocket endpoints must require a session authentication token for all connections. Factory Core must generate a cryptographically random UUID v4 session token at startup, display it once in CLI output, and require it as either a query parameter (`?token=...`) or an `Authorization: Bearer` header on all dashboard SSE and WebSocket connection requests. Connections without a valid token must be rejected with HTTP 401. The token is rotated on factory restart; previous tokens are immediately invalidated. The dashboard server must bind exclusively to `127.0.0.1` (localhost) — binding to `0.0.0.0` or any externally routable interface is prohibited unless an explicit `--remote-dashboard` flag is passed at startup, which must emit a prominently visible security warning. WebSocket connection count from a single source address must be limited to 5 concurrent connections to prevent connection-flood degradation. Verifiable by integration tests confirming rejected unauthenticated connections and localhost-only binding.

---

## AMENDMENT: New NFR — Codebase Content Framing and Prompt Injection Sanitization

**Type:** NEW_NFR
**Target:** Security section (after NFR-SEC-03)
**Reason:** No input sanitization or content framing is applied to codebase files, Mulch expertise, or learning records before they enter agent context, leaving agents vulnerable to prompt injection via specially crafted file contents in the target codebase (STRIDE gaps: T-07, S-05, E-02, M-04).

**Original text:** N/A — new item

**Replacement text:**
> **NFR-SEC-04:** All external content incorporated into agent context — codebase files read for context, Mulch expertise loaded from `.mulch/`, learning records loaded from `pipeline.db`, and phase boundary transfer manifests — must be explicitly framed as untrusted data using structural delimiter tags in the overlay assembly. The overlay system prompt must instruct agents that content within `<codebase_file>`, `<mulch_content>`, and `<learning_record>` tags is external data to be treated as code or documentation, not as instructions, regardless of what that content contains. Learning records must additionally pass an instruction-syntax sanitization pass before synthesis that detects and rejects records containing text resembling model instruction syntax (e.g., patterns matching `<instruction>`, `SYSTEM:`, `Human:`, `Assistant:`, `\[INST\]`). Records flagged by sanitization must be quarantined in `pipeline.db` with a `sanitization_hold` status and generate a dashboard alert for developer review before injection. The Superpowers gate validation (FR60) must be extended to enforce this sanitization check as a required synthesis gate. Verifiable by unit tests that confirm sanitization detection of known injection patterns and integration tests that verify delimiter framing in assembled overlays.

---

## AMENDMENT: New NFR — Credential Sanitization in All Output Paths

**Type:** NEW_NFR
**Target:** Security section (after NFR-SEC-04)
**Reason:** Pi SDK error messages and `gh` CLI subprocess output may include credential fragments; hook scripts spawned as subprocesses inherit the parent environment and could expose credentials via environment variable access (STRIDE gaps: I-01, C-02, C-03).

**Original text:** N/A — new item

**Replacement text:**
> **NFR-SEC-05:** All agent subprocess and hook script environments must be sanitized before spawn to remove all credential-bearing variables. Factory Core must construct an explicit environment allowlist for each subprocess — containing only `PATH`, runtime binary paths (node, bun), and explicitly non-sensitive project configuration — and pass this allowlist as the complete environment for the spawned process. No Pi SDK keys, GitHub tokens, Telegram tokens, or other credential values present in the Factory Core process environment may be inherited by agent subprocesses, hook scripts, or any spawned child process. API credentials must be provided to Pi SDK via in-process configuration struct at Factory Core startup, never via environment variable or command-line argument, so credentials are not present in the process environment to begin with. Pi SDK's startup behavior regarding credential persistence to disk must be documented in the architecture document; if Pi SDK writes credentials to a local config file for session persistence, that file must be governed by NFR-SEC-02's `600` permission requirement and added to the NFR12 `.gitignore` exclusion list. Verifiable by integration tests that spawn a hook subprocess and assert that credential environment variables are absent from the subprocess's environment.

---

## AMENDMENT: New NFR — Learning Record Integrity Checksums

**Type:** NEW_NFR
**Target:** Security section (after NFR-SEC-05)
**Reason:** Raw learning records are plain YAML files in `.qds/learnings/` with no integrity protection; post-write modification is undetected by the synthesis pipeline, and a co-resident attacker could inject false conventions that propagate into all future agent overlays (STRIDE gaps: T-02, T-03, S-05, M-05).

**Original text:** N/A — new item

**Replacement text:**
> **NFR-SEC-06:** Raw learning records must have SHA-256 checksums recorded in `pipeline.db` at write time. The synthesis pipeline (FR59, FR60) must verify each source record's checksum before processing. Any checksum mismatch must quarantine the affected record with a `checksum_fail` status in `pipeline.db`, exclude it from the current synthesis run, and generate a dashboard alert for developer review — the synthesis run must continue with the remaining valid records rather than halting. Mulch expertise files loaded from `.mulch/` must be verified against a checksum registry in `pipeline.db` (populated at factory startup file scan) before inclusion in any agent overlay; files not present in the registry are loaded with a warning, not silently, to detect newly added files that have not been reviewed. Note: checksums prevent undetected accidental corruption and significantly raise the bar for deliberate file-level tampering; they do not protect against an attacker who can also modify `pipeline.db`, which requires OS-level process isolation (NFR-SEC-01) as the primary defense against co-resident malicious processes.

---

## AMENDMENT: New NFR — Meta-Optimizer Change Independent Validation and Append-Only Journals

**Type:** NEW_NFR
**Target:** Security section (after NFR-SEC-06)
**Reason:** FR86 defines what the weekly optimizer cannot change, but that restriction is enforced within the optimizer's own logic — there is no independent validation pass that cannot be influenced by the optimizer's output before the change is applied (STRIDE gaps: E-03, R-03, M-07).

**Original text:** N/A — new item

**Replacement text:**
> **NFR-SEC-07:** Weekly optimizer proposed changes must pass independent schema validation before application. The validation pass must: (a) be implemented as a separate Factory Core component with no shared code path with the optimizer agent itself, (b) validate the proposed change against a static, hardcoded allowlist of modifiable parameters (overlay efficiency settings, injection level thresholds, phase timeout multipliers), and (c) reject any change that references a parameter not on the allowlist — including any change to iron laws, git safety rules, budget ceilings, hook layer definitions, or agent scope restrictions — with an immediate halt and dashboard alert. Optimizer outputs must use a schema-validated structured format (not freeform YAML) parseable by the validator before the optimizer's output is even read by Factory Core for application. Weekly optimization journal files (`YYYY-WNN.yaml`) must be written once in append-only mode; reverts generate a new journal entry documenting the revert and the revert reason — the original entry is never overwritten or deleted. Verifiable by unit tests that present a change targeting a prohibited parameter to the validator and assert rejection, and by an append-only write test that confirms journal file monotonic growth.

---

## AMENDMENT: New NFR — Phase Boundary Manifest Integrity and Post-Parse Deletion

**Type:** NEW_NFR
**Target:** Security section (after NFR-SEC-07)
**Reason:** Transfer manifests written to the filesystem between phases have no integrity protection; a co-resident process could modify a manifest in the window between write and read, injecting false learnings or altering acceptance criteria, and retained manifests become an unnecessary information asset (STRIDE gaps: T-09, I-06, M-09).

**Original text:** N/A — new item

**Replacement text:**
> **NFR-SEC-08:** Phase boundary transfer manifests written to the filesystem between pipeline phases must include an HMAC (HMAC-SHA256) computed using a factory-instance-local key generated at startup and held only in Factory Core process memory. The receiving agent must verify the HMAC before parsing any manifest content; a verification failure must cause the receiving agent to reject the manifest, halt the phase transition, and escalate to the developer via dashboard alert rather than proceeding with potentially tampered transfer data. Manifests must be deleted from the filesystem immediately after the receiving agent has successfully verified and parsed them — no manifest file may be retained after the phase transition it served. Manifest deletion is a required step in the phase transition handshake, not an optional cleanup. Verifiable by integration tests confirming HMAC verification failure on a tampered manifest and file deletion confirmation after successful parse.

---

## AMENDMENT: New NFR — GitHub Token Least-Privilege and Branch Protection Verification

**Type:** NEW_NFR
**Target:** Security section (after NFR-SEC-08)
**Reason:** The `gh` CLI token may have write access to all repositories under the developer's account, not just the factory's target repository; a leaked token or factory misconfiguration has a blast radius that extends far beyond the intended scope (STRIDE gaps: E-07, T-08, M-06).

**Original text:** N/A — new item

**Replacement text:**
> **NFR-SEC-09:** Factory setup script must verify GitHub token scope and target repository protection state before first use: (a) verify that the authenticated token is scoped to the minimum required permissions — if the token has broad `repo` scope (all repositories), the setup script must emit a warning recommending creation of a fine-grained PAT scoped to the specific target repository only; (b) verify via `gh api /repos/{owner}/{repo}/branches/{branch}/protection` that the target repository's default branch has branch protection rules enabled — specifically: no force push to any branch, require pull request reviews before merging to default branch, and require status checks; (c) if branch protection rules are absent, the setup script must emit a prominent warning (not a hard stop, as the developer may not have admin rights on all repos) explaining the security implication and providing the GitHub UI path to configure protection. These checks must also run as part of factory startup health verification. Verifiable by setup script tests that simulate both compliant and non-compliant token scopes and protection configurations and assert the correct warning or pass behavior.

---

## AMENDMENT: New NFR — Telegram Command Audit Log

**Type:** NEW_NFR
**Target:** Security section (after NFR-SEC-09)
**Reason:** Telegram commands including destructive operations (/stop, /approve, /nudge) are not persisted in a command-level audit trail; without a tamper-evident log of received commands with Telegram message IDs, command repudiation cannot be investigated (STRIDE gap: R-02, M-12).

**Original text:** N/A — new item

**Replacement text:**
> **NFR-SEC-10:** Every Telegram message received by the factory bot — authenticated or not — must be logged to an append-only table in `pipeline.db` (`telegram_command_log`) containing: Telegram message ID, sender Telegram user ID, UTC timestamp, raw message text, parsed command intent (or `UNRECOGNIZED`), authentication result (`AUTHORIZED` / `UNAUTHORIZED` / `RATE_LIMITED`), and execution result. Log entries must never be deleted or updated — subsequent state changes are recorded as additional entries. This log is the authoritative record for command repudiation investigations. Verifiable by integration tests confirming log entry creation for all inbound message paths including rejected, rate-limited, and unauthenticated messages.

---

## AMENDMENT: Update FR127 — Strengthen Registration Code Security Requirements

**Type:** MODIFY_FR
**Target:** FR127
**Reason:** The 6-character one-time code is vulnerable to brute-force at scale (especially if numeric-only), has no specified expiry, and lacks silent-drop behavior for unregistered senders — the STRIDE analysis documents a feasible brute-force path against the `/register` endpoint with no rate limiting (STRIDE threats: S-01, S-02, Section 7 detailed analysis).

**Original text:**
> **FR127:** Telegram user authentication uses a one-time registration code flow — developer runs `qds telegram register` from CLI, receives a 6-character code, sends `/register {code}` to the bot, and the bot maps the Telegram user ID to the factory developer ID

**Replacement text:**
> **FR127:** Telegram user authentication uses a one-time registration code flow — developer runs `qds telegram register` from CLI, receives a cryptographically random 8-character alphanumeric code (minimum 47 bits of entropy, generated via OS CSPRNG), sends `/register {code}` to the bot, and the bot maps the Telegram user ID to the factory developer ID. The registration code must: (a) expire after 10 minutes from generation, after which the developer must re-run `qds telegram register` to obtain a fresh code; (b) be displayed only in CLI terminal output and must never be written to log files, `pipeline.db`, or any file that could be committed or transmitted; (c) be consumed and invalidated immediately upon first successful use. The bot must apply silent drop (no response of any kind) to all `/register` attempts from a sender that has exhausted the per-sender rate limit (5 failed attempts per user ID per hour, per NFR33c); for non-rate-limited invalid or expired codes, the bot responds with a generic "registration failed" message that does not distinguish between wrong code, expired code, or unrecognized sender. All unregistered senders receive no response to commands other than `/register`, preventing bot discovery confirmation.

---

*End of Security Amendment Batch*
*Amendment count: 16 (5 modified NFRs, 9 new NFRs, 2 modified FRs)*
*Source: prd-analysis-stride-threat-model-2026-03-14.md — mitigations M-01 through M-12 and C-01 through C-05*
*All Critical and High severity gaps from the STRIDE analysis are addressed. Medium severity gaps (M-10 GitHub rate limit awareness, M-11 Mulch git access controls) are documented in the threat model as Growth-phase items.*
