/**
 * Non-fatal warnings collected during a harness run and surfaced in its
 * summary (version drift, ambiguous installs, cleanup failures, a stalled
 * child that had to be force-killed).
 *
 * Deliberately its own module with NO dependencies. The MCP stdio transport
 * and the pi-lens domain helpers both need a place to record a warning, and
 * routing that through the pi-lens module would point the transport layer at
 * the domain layer — the wrong dependency direction, and one that would make a
 * plain MCP client drag pi-lens along with it.
 */
export const harnessNotes: string[] = [];
