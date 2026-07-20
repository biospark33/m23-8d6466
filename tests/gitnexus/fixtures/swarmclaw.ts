// GitNexus test fixture: a small, symbol-rich TS module.
// Exists so `gitnexus analyze` has known symbols (registerSwarmClawAgent,
// SwarmClaw routes) to query regardless of what the live repo tree contains —
// the P0.7 SwarmClaw work lands on a different branch and may be absent here.
// ponytail: fixture is the analysis target, not shipped app code.

export interface Agent {
  id: string;
  name: string;
}

const registry = new Map<string, Agent>();

/** Register a SwarmClaw agent in the routing registry. */
export function registerSwarmClawAgent(agent: Agent): void {
  registry.set(agent.id, agent);
}

/** Look up a previously registered agent. */
export function getAgent(id: string): Agent | undefined {
  return registry.get(id);
}

/** Wire the default SwarmClaw routes by registering the built-in agents.
 * ponytail: load-bearing — the AC-1 context test asserts this is an incoming
 * caller of registerSwarmClawAgent; don't remove without updating the test. */
export function registerSwarmClawRoutes(): void {
  registerSwarmClawAgent({ id: "coordinator", name: "Coordinator" });
  registerSwarmClawAgent({ id: "worker", name: "Worker" });
}

/** Dispatch a task to a registered agent; used by the SwarmClaw router. */
export function dispatch(agentId: string, task: string): string {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`no agent: ${agentId}`);
  return `${agent.name} handled ${task}`;
}

/** Route a task to an agent via the SwarmClaw router. */
export function routeTask(agentId: string, task: string): string {
  return dispatch(agentId, task);
}
