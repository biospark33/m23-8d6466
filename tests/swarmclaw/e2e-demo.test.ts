/**
 * E2E demo (MANDATORY, AC2 + DoD): register agent → register MCP server → test
 * → invoke retain → invoke recall → assert recalled content matches retained.
 *
 * Runs against a live SwarmClaw server (Bun.serve) over real HTTP. The MCP
 * subprocess is the fake stdio server (the real hindsight-local-mcp in this
 * environment is HTTP-only and needs Postgres + an LLM key — see report). The
 * command allowlist is widened to `bun` so the full real spawn/handshake path
 * is exercised; only the target binary is substituted.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createServer, type SwarmClawServer } from "../../src/swarmclaw/index.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-mcp-server.ts");
let srv: SwarmClawServer;
let base: string;

beforeAll(() => {
  process.env.SWARMCLAW_COMMAND_ALLOWLIST = "bun";
  // PATH must be allowlisted for the subprocess to resolve a PATH-based command
  // (the same is true for the real hindsight-local-mcp binary).
  process.env.SWARMCLAW_ENV_ALLOWLIST = "PATH";
  srv = createServer(0);
  base = `http://localhost:${srv.port}`;
});

afterAll(async () => {
  await srv.stop();
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_COMMAND_ALLOWLIST;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.SWARMCLAW_ENV_ALLOWLIST;
});

async function post(
  path: string,
  body: unknown,
  requestId?: string,
): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json(), headers: res.headers };
}

test("e2e: agent → mcp-server → test → retain → recall roundtrip over HTTP", async () => {
  // 1. Register agent
  const agent = await post("/api/agents", { agentId: "e2e-agent", capabilities: ["memory"] });
  expect(agent.status).toBe(201);

  // 2. Register MCP server (command=bun, args=fixture → real spawn + handshake)
  const reg = await post("/api/mcp-servers", {
    name: "e2e-hindsight",
    transport: "stdio",
    command: "bun",
    args: [FAKE],
  });
  expect(reg.status).toBe(201);
  const id = reg.json.id as string;
  expect(reg.json.tools).toEqual(expect.arrayContaining(["retain", "recall", "reflect", "consolidate"]));

  // 3. Test endpoint
  const test = await post(`/api/mcp-servers/${id}/test`, {});
  expect(test.status).toBe(200);
  expect(test.json.ok).toBe(true);
  expect(test.json.tools).toEqual(expect.arrayContaining(["retain", "recall", "reflect", "consolidate"]));

  // 4. Invoke retain — CC-9: a client-supplied x-request-id must be echoed in
  // the response header AND used as the JSON-RPC body id.
  const secret = `memory-${crypto.randomUUID()}`;
  const retainReqId = crypto.randomUUID();
  const retain = await post(
    `/api/mcp-servers/${id}/invoke`,
    { tool: "retain", arguments: { bank_id: "e2e-bank", content: secret } },
    retainReqId,
  );
  expect(retain.status).toBe(200);
  expect(retain.headers.get("x-request-id")).toBe(retainReqId);
  expect(retain.json.id).toBe(retainReqId);

  // 5. Invoke recall — content must match what was retained
  const recallReqId = crypto.randomUUID();
  const recall = await post(
    `/api/mcp-servers/${id}/invoke`,
    { tool: "recall", arguments: { bank_id: "e2e-bank" } },
    recallReqId,
  );
  expect(recall.status).toBe(200);
  expect(recall.headers.get("x-request-id")).toBe(recallReqId);
  expect(recall.json.id).toBe(recallReqId);
  const payload = JSON.parse(recall.json.result.content[0].text);
  expect(payload.memories).toContain(secret);
}, 20000);
