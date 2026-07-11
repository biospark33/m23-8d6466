/**
 * In-memory MCP server registry. Owns the RegisterMCPServerSchema, the atomic
 * 32-server cap (check + insert in one synchronous op — no await between), and
 * duplicate-name detection (409).
 */

import { z } from "zod";
import type { StdioTransport } from "../mcp/stdio-transport.ts";
import type { ToolBridge } from "../mcp/tool-bridge.ts";

export const RegisterMCPServerSchema = z.object({
  name: z.string().min(1).max(128),
  transport: z.enum(["stdio"]),
  command: z.string().optional(),
  args: z.array(z.string().max(4096)).default([]),
  url: z.string().url().optional(),
  env: z.record(z.string().min(1), z.string()).optional(),
});

export type RegisterMCPServerInput = z.infer<typeof RegisterMCPServerSchema>;

export interface MCPServerRecord {
  id: string;
  name: string;
  transport: "stdio";
  command?: string;
  args: string[];
  env?: Record<string, string>;
  createdAt: string;
  stdio: StdioTransport;
  bridge: ToolBridge;
  healthy: boolean;
}

export const MAX_MCP_SERVERS = 32;

export class DuplicateNameError extends Error {
  constructor(name: string) {
    super(`MCP server name '${name}' already registered`);
    this.name = "DuplicateNameError";
  }
}

export class CapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapacityError";
  }
}

export class MCPStore {
  private readonly servers = new Map<string, MCPServerRecord>();
  private readonly namesInUse = new Set<string>();

  /**
   * Atomically reserve a name + capacity slot. This runs synchronously (no
   * await), so two concurrent registrations racing the 32nd slot cannot both
   * pass — the second sees the reservation. The caller must reserve BEFORE the
   * async spawn/handshake, then finalize() or release() the reservation.
   */
  reserve(name: string): string {
    if (this.namesInUse.has(name)) {
      throw new DuplicateNameError(name);
    }
    if (this.servers.size + this.reservations.size >= MAX_MCP_SERVERS) {
      throw new CapacityError(`maximum of ${MAX_MCP_SERVERS} MCP servers reached`);
    }
    const id = crypto.randomUUID();
    this.reservations.set(id, name);
    this.namesInUse.add(name);
    return id;
  }

  private readonly reservations = new Map<string, string>();

  /** Finalize a reserved slot with the fully-built record. */
  finalize(id: string, record: Omit<MCPServerRecord, "id">): MCPServerRecord {
    if (!this.reservations.has(id)) {
      throw new Error(`no reservation for id ${id}`);
    }
    this.reservations.delete(id);
    const full: MCPServerRecord = { ...record, id };
    this.servers.set(id, full);
    return full;
  }

  /** Release a reservation (spawn/handshake failed). */
  release(id: string): void {
    const name = this.reservations.get(id);
    if (name !== undefined) {
      this.reservations.delete(id);
      this.namesInUse.delete(name);
    }
  }

  get(id: string): MCPServerRecord | undefined {
    return this.servers.get(id);
  }

  list(): MCPServerRecord[] {
    return [...this.servers.values()];
  }

  get size(): number {
    return this.servers.size;
  }

  async remove(id: string): Promise<void> {
    const rec = this.servers.get(id);
    if (!rec) return;
    this.servers.delete(id);
    this.namesInUse.delete(rec.name);
    await rec.stdio.shutdown();
  }

  async shutdownAll(): Promise<void> {
    await Promise.all([...this.servers.values()].map((r) => r.stdio.shutdown()));
    this.servers.clear();
    this.namesInUse.clear();
    this.reservations.clear();
  }
}
