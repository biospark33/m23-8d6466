/**
 * PRD §13 Phase-0 clause 7 (Story P0.11).
 *
 * Clause 7: "Hindsight retain->recall->reflect round-trips on the chosen bank
 * (cloud or self-host)."
 *
 * Uses P0.9's shipped `verifyRoundTrip`, which drives the Hindsight REST client
 * directly. That is the right surface for THIS clause — clause 7 is about
 * Hindsight round-tripping, not about the SwarmClaw bridge (clause 6 covers the
 * bridge). (It formerly also sidestepped a defect in the provisioning script's
 * bridge probe, which issued GETs against POST-only SwarmClaw routes on the
 * wrong port; F008 fixed the probe, so the clause-scope argument above is now
 * the only reason this check avoids the bridge.)
 *
 * MUTATION NOTE: a round-trip necessarily retains a memory. The probe content
 * is clearly labelled so the write is identifiable in the bank, and no
 * credentials are written. See the evidence report for the read-only tension.
 */
import type { GateAssertion, GateCheckOutcome } from "../gate-runner.ts";
import { HindsightClient, HindsightHttpError, resolveBankId } from "../../hindsight/index.ts";
// Not re-exported from the module index, whose header asks callers not to
// re-shape the public contract — so it is imported from its source module.
import {
  verifyRoundTrip,
  type RoundTripResult,
} from "../../hindsight/round-trip-verifier.ts";

/**
 * Budget for the listBanks probe plus verifyRoundTrip's five calls
 * (retain -> recall -> reflect -> consolidate -> post-consolidation recall).
 * The client bounds each individually (retain 30 s, consolidate 60 s), so the
 * runner's 30 s default would cut a slow-but-healthy Hindsight short and
 * replace the step-named failure this check produces with a bare timeout.
 */
const ASSERTION_TIMEOUT_MS = 150_000;

/**
 * Renders a failed reachability probe.
 *
 * Exported for the same reason as p0-2's `auditOqDecisions`: the interesting
 * behaviour (naming the WRONG service that answered on the shared port, instead
 * of dumping its HTML error page) is otherwise only reachable by standing up a
 * hostile server.
 */
export function describeListBanksFailure(err: unknown, baseUrl: string): string {
  let detail: string;
  if (err instanceof HindsightHttpError) {
    // Collapse the body to one line and, when an unrelated service
    // answered with an HTML error page, name it from its <title>
    // instead of dumping markup into the failure list.
    const raw = err.message.replace(/\s+/g, " ").trim();
    const title = raw.match(/<title>([^<]+)<\/title>/i)?.[1];
    const body = title ? `served by "${title}" — not Hindsight` : raw.slice(0, 200);
    detail = `no reachable Hindsight API at ${baseUrl} (listBanks -> HTTP ${err.status}); ${body}`;
  } else {
    detail = `Hindsight unreachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`;
  }
  return `${detail}. OQ-4 records the local stack as BLOCKED-on-env (arm64 libpq/openssl@3 mismatch).`;
}

/**
 * Turns a round-trip result into the clause-7 verdict.
 *
 * `recallMatches` and `insightCount` are asserted, not merely printed. Today
 * `verifyRoundTrip`'s union makes them redundant — but this gate is the artifact
 * that certifies clause 7, and it previously reported both values in its green
 * detail while deciding on `result.ok` alone. Reporting a number is not checking
 * it: if the verifier ever returned `ok:true` with a zero recall or no insights,
 * the gate would have certified "retain -> recall -> reflect round-trips" off a
 * round trip that recalled nothing.
 */
export function evaluateRoundTrip(result: RoundTripResult, bankId: string): GateCheckOutcome {
  if (!result.ok) {
    return {
      pass: false,
      detail: `round-trip failed at step "${result.step}": ${result.error?.code ?? ""} ${result.error?.message ?? ""}`.trim(),
    };
  }
  const shortfalls: string[] = [];
  if (result.recallMatches !== true) shortfalls.push(`recallMatches=${String(result.recallMatches)}`);
  if (!(result.insightCount >= 1)) shortfalls.push(`insightCount=${String(result.insightCount)}`);
  if (shortfalls.length > 0) {
    return {
      pass: false,
      detail: `round-trip reported ok but proved no round trip: ${shortfalls.join(", ")}`,
    };
  }
  return {
    pass: true,
    detail: `round-trip green on bank "${bankId}" (recallMatches=${result.recallMatches}, insightCount=${result.insightCount})`,
  };
}

export function memoryAssertions(): GateAssertion[] {
  return [
    {
      id: "P0.9-hindsight-round-trip",
      story: "P0.9",
      prd_clause: "§13 P0 clause 7",
      description: "retain -> recall -> reflect round-trips on the chosen Hindsight bank",
      group: "main",
      timeout_ms: ASSERTION_TIMEOUT_MS,
      check: async () => {
        const baseUrl = process.env.HINDSIGHT_BASE_URL ?? "http://127.0.0.1:8888";
        const bankId =
          process.env.QDS_GATE_BANK ?? resolveBankId(process.env.QDS_REPO_SLUG ?? "qds-factory");

        const client = new HindsightClient({ baseUrl });

        // Probe THROUGH the client, not a raw fetch. The client strips trailing
        // slashes and injects HINDSIGHT_BEARER_TOKEN / HINDSIGHT_API_KEY; a raw
        // fetch would send no auth (an authenticated instance answers 401/403 →
        // we would false-red a healthy service) and would double-slash a
        // base URL that ends in "/".
        //
        // The probe is still worth doing: the default port is shared with other
        // local tooling (a Jupyter server occupies :8888 on at least one dev
        // host), so this distinguishes "wrong service" from a confusing 502
        // surfacing later out of the round-trip.
        try {
          await client.listBanks();
        } catch (err) {
          return { pass: false, detail: describeListBanksFailure(err, baseUrl) };
        }

        // Wrapped: a throw here would still be caught by the gate runner and
        // recorded as a red assertion, but a bare "check threw:" message is far
        // less diagnosable than naming the step that failed.
        try {
          const result = await verifyRoundTrip({
            client,
            bankId,
            content: "QDS Phase-0 exit-gate probe — retain/recall/reflect round-trip check.",
          });

          return evaluateRoundTrip(result, bankId);
        } catch (err) {
          return {
            pass: false,
            detail: `round-trip threw against ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
  ];
}
