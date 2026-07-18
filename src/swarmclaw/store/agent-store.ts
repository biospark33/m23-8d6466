/**
 * In-memory agent registry (INV-SC1 agentId + SSRF-safe endpointUrl).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";

export const RegisterAgentSchema = z.object({
  agentId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$/),
  capabilities: z.array(z.string().max(256)).min(1).max(64),
  agentType: z.enum(["department-manager", "worker", "observer", "service"]).optional(),
  endpointUrl: z.string().url().optional(),
  metadata: z
    .record(z.unknown())
    .optional()
    .refine(
      (v) => {
        if (!v) return true;
        try {
          return JSON.stringify(v).length <= 10240;
        } catch {
          return false;
        }
      },
      { message: "metadata exceeds 10KB or contains circular references" },
    ),
});

export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;

export interface AgentRecord extends RegisterAgentInput {
  id: string;
  createdAt: string;
}

export const MAX_AGENTS = 64;

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

/** DNS resolver seam (mirrors setLogSink): overridable so tests can drive the
 * multi-result `.every()` branch deterministically without real DNS. */
type LookupAll = (host: string) => Promise<Array<{ address: string }>>;
let dnsLookup: LookupAll = (host) => lookup(host, { all: true });

export function setDnsLookup(fn: LookupAll): () => void {
  const prev = dnsLookup;
  dnsLookup = fn;
  return () => {
    dnsLookup = prev;
  };
}

/**
 * SSRF guard: endpointUrl hostname must resolve to loopback. Returns true if
 * loopback, false otherwise. Non-resolving hosts are treated as non-loopback.
 */
export async function isLoopbackEndpoint(endpointUrl: string): Promise<boolean> {
  let host: string;
  try {
    host = new URL(endpointUrl).hostname;
  } catch {
    return false;
  }
  if (host === "localhost") return true;
  // Strip IPv6 brackets if present.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare)) return LOOPBACK_IPS.has(bare);
  try {
    const results = await dnsLookup(host);
    return results.length > 0 && results.every((r) => LOOPBACK_IPS.has(r.address));
  } catch {
    return false;
  }
}

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

export class DuplicateAgentError extends Error {
  constructor(agentId: string) {
    super(`agentId '${agentId}' already registered`);
    this.name = "DuplicateAgentError";
  }
}

export class AgentStore {
  private readonly agents = new Map<string, AgentRecord>();

  /** Atomic agentId-uniqueness + capacity check + insert. `agents` is keyed by
   * the generated uuid, so agentId uniqueness is derived by scanning values —
   * bounded by MAX_AGENTS (64), so no separate mirror index is warranted. */
  create(input: RegisterAgentInput): AgentRecord {
    for (const rec of this.agents.values()) {
      if (rec.agentId === input.agentId) {
        throw new DuplicateAgentError(input.agentId);
      }
    }
    if (this.agents.size >= MAX_AGENTS) {
      throw new CapacityError(`maximum of ${MAX_AGENTS} agents reached`);
    }
    const record: AgentRecord = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.agents.set(record.id, record);
    return record;
  }

  get(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  list(): AgentRecord[] {
    return [...this.agents.values()];
  }

  get size(): number {
    return this.agents.size;
  }

  clear(): void {
    this.agents.clear();
  }
}
