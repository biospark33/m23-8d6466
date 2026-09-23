// Repo tsc gate only (QDS-Factory `bun run typecheck`). NOT part of upstream.
//
// At runtime Pi's jiti loader aliases @earendil-works/* and typebox to Pi's own
// copies (see tsconfig.json's header comment), and this vendored package has no
// node_modules by design. Upstream typechecks for real via scripts/typecheck.sh
// against the globally installed Pi (paths-mapped in the gitignored
// tsconfig.tsc.json) — its include is only extensions/** and tests/**, so this
// file is invisible to it. The repo-wide tsc has no such mapping, so without
// these ambient declarations the imports fail to resolve (TS2307) and every
// callback parameter under them collapses into implicit-any (TS7006). Each name
// below is one the vendored code actually imports, typed `any`: the repo gate
// then checks the vendored code's own cross-file types while treating the
// Pi-injected surface as opaque. No runtime effect (.d.ts is never loaded) and
// no vendored source depends on this file.
declare module "@earendil-works/pi-coding-agent" {
	export type ExtensionAPI = any;
	export type ExtensionCommandContext = any;
	export type ExtensionContext = any;
	export type CompactionEntry = any;
	export type SessionEntry = any;
	export type SessionBeforeCompactEvent = any;
	export const compact: any;
	export const convertToLlm: any;
	export const findCutPoint: any;
	export const serializeConversation: any;
	export const sessionEntryToContextMessages: any;
	export const SettingsManager: any;
}
declare module "@earendil-works/pi-ai" {
	export type AssistantMessage = any;
	export type Context = any;
	export type Model<T = any> = any;
	export type SimpleStreamOptions = any;
	export const createAssistantMessageEventStream: any;
}
declare module "@earendil-works/pi-tui" {
	export const Text: any;
	export const truncateToWidth: any;
	export const visibleWidth: any;
}
declare module "typebox" {
	export const Type: any;
}
