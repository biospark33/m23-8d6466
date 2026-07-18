/**
 * In-memory MCP server registry. Owns the RegisterMCPServerSchema, the atomic
 * 32-server cap (check + insert in one synchronous op — no await between), and
 * duplicate-name detection (409).
 */

import { z } from "zod";
import { log, newRequestId, type StdioTransport } from "../mcp/stdio-transport.ts";
import type { ToolBridge } from "../mcp/tool-bridge.ts";
import { CapacityError } from "./agent-store.ts";

export { CapacityError };

export const RegisterMCPServerSchema = z.object({
  name: z.string().min(1).max(128),
  transport: z.enum(["stdio"]),
  command: z.string().optional(),
  args: z.array(z.string().max(4096)).max(256).default([]),
  url: z.string().url().optional(),
  env: z
    .record(z.string().min(1), z.string())
    .optional()
    .refine((v) => !v || Object.keys(v).length <= 64, { message: "env exceeds 64 keys" }),
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

export class MCPStore {
  private readonly servers = new Map<string, MCPServerRecord>();
  private readonly namesInUse = new Set<string>();
  private readonly reservations = new Map<string, string>();
  /** Transports of in-flight registrations, keyed by reservation id. */
  private readonly pendingTransports = new Map<string, StdioTransport>();
  /** Set synchronously at the start of shutdownAll — closes reserve/finalize. */
  private closed = false;

  /**
   * Atomically reserve a name + capacity slot. This runs synchronously (no
   * await), so two concurrent registrations racing the 32nd slot cannot both
   * pass — the second sees the reservation. The caller must reserve BEFORE the
   * async spawn/handshake, then finalize() or release() the reservation.
   */
  reserve(name: string): string {
    if (this.closed) {
      throw new Error("store is shutting down");
    }
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

  /**
   * Track a freshly-constructed transport against its reservation so
   * shutdownAll() can SIGTERM it even while spawn/handshake is still in
   * flight. No-op unless the reservation exists.
   */
  attachTransport(id: string, stdio: StdioTransport): void {
    if (this.reservations.has(id)) {
      this.pendingTransports.set(id, stdio);
    }
  }

  /** Finalize a reserved slot with the fully-built record. */
  finalize(id: string, record: Omit<MCPServerRecord, "id">): MCPServerRecord {
    if (this.closed) {
      throw new Error("store is shutting down");
    }
    const reserved = this.reservations.get(id);
    if (reserved === undefined) {
      throw new Error(`no reservation for id ${id}`);
    }
    if (record.name !== reserved) {
      // Throw before deleting so the reservation stays intact for release().
      throw new Error("finalize name does not match reservation");
    }
    this.reservations.delete(id);
    this.pendingTransports.delete(id);
    const full: MCPServerRecord = { ...record, id };
    this.servers.set(id, full);
    return full;
  }

  /** Release a reservation (spawn/handshake failed). */
  release(id: string): void {
    this.pendingTransports.delete(id);
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
    // First synchronous statement: close the store so no new records or
    // reservations can appear while the drain below is in flight.
    this.closed = true;
    const targets = [...[...this.servers.values()].map((r) => r.stdio), ...this.pendingTransports.values()];
    // Per-transport errors are isolated: one stuck/throwing shutdown must not
    // skip the remaining transports or the map cleanup.
    const results = await Promise.allSettled(targets.map((t) => t.shutdown()));
    for (const r of results) {
      if (r.status === "rejected") {
        const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
        log({
          requestId: newRequestId(),
          operation: "mcp.shutdown",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: 0,
          status: "error",
          error: { code: "shutdown", message: err.message, stack: err.stack },
        });
      }
    }
    this.servers.clear();
    this.namesInUse.clear();
    this.reservations.clear();
    this.pendingTransports.clear();
  }
}
