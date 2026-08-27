/**
 * Fleet barrel (Story DF3.1; DF3.2 adds fanout/fanout-primitive/rank). C5:
 * brief-schema, dispatch, status, verbs — harvest/teardown are thin front
 * doors inside scripts/fleet.ts over DF2.5's own harvestRun/teardownSandbox,
 * not separate modules here. fleet-lock.ts stays OFF the barrel on purpose:
 * its consumers (fanout-primitive, tests) import it directly.
 */
export * from "./brief-schema.ts";
export * from "./dispatch.ts";
export * from "./status.ts";
export * from "./verbs.ts";
// DF3.2. fanout-primitive is a separate line, never re-exported through
// fanout.ts — it imports the store, so routing it back would cycle.
export * from "./fanout.ts";
export * from "./fanout-primitive.ts";
export * from "./rank.ts";
