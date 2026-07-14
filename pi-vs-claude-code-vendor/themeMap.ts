/**
 * themeMap.ts — Per-extension default theme assignments
 *
 * Themes live in .pi/themes/ and are mapped by extension filename (no extension).
 * Each extension calls applyExtensionTheme(import.meta.url, ctx) in its session_start
 * hook to automatically load its designated theme on boot.
 *
 * Available themes (.pi/themes/):
 *   catppuccin-mocha · cyberpunk · dracula · everforest · gruvbox
 *   midnight-ocean   · nord      · ocean-breeze · rose-pine
 *   synthwave        · tokyo-night
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

// ── Theme assignments ──────────────────────────────────────────────────────
//
// Key   = extension filename without extension (matches extensions/<key>.ts)
// Value = theme name from .pi/themes/<value>.json
//
export const THEME_MAP: Record<string, string> = {
	"agent-chain":        "midnight-ocean",   // deep sequential pipeline
	"agent-team":         "dracula",          // rich orchestration palette
	"coms":               "ocean-breeze",     // peer-to-peer messaging, cross-boundary
	"coms-net":           "ocean-breeze",     // peer-to-peer messaging, cross-boundary
	"cross-agent":        "ocean-breeze",     // cross-boundary, connecting
	"damage-control":     "gruvbox",          // grounded, earthy safety
	"minimal":            "synthwave",        // synthwave by default now!
	"pi-pi":              "rose-pine",        // warm creative meta-agent
	"pure-focus":         "everforest",       // calm, distraction-free
	"purpose-gate":       "tokyo-night",      // intentional, sharp focus
	"session-replay":     "catppuccin-mocha", // soft, reflective history
	"subagent-widget":    "cyberpunk",        // multi-agent futuristic
	"system-select":      "catppuccin-mocha", // soft selection UI
	"theme-cycler":       "synthwave",        // neon, it's a theme tool
	"tilldone":           "everforest",       // task-focused calm
	"tool-counter":       "synthwave",        // techy metrics
	"tool-counter-widget":"synthwave",        // same family
};

// ── Helpers ───────────────────────────────────────────────────────────────

/** Derive the extension name (e.g. "minimal") from its import.meta.url. */
function extensionName(fileUrl: string): string {
	const filePath = fileUrl.startsWith("file://") ? fileURLToPath(fileUrl) : fileUrl;
	return basename(filePath).replace(/\.[^.]+$/, "");
}

// ── Theme ──────────────────────────────────────────────────────────────────

/**
 * Apply the mapped theme for an extension on session boot.
 *
 * @param fileUrl   Pass `import.meta.url` from the calling extension file.
 * @param ctx       The ExtensionContext from the session_start handler.
 * @returns         true if the theme was applied successfully, false otherwise.
 */
export function applyExtensionTheme(fileUrl: string, ctx: ExtensionContext): boolean {
	if (!ctx.hasUI) return false;

	const name = extensionName(fileUrl);
	
	// If there are multiple extensions stacked in 'ipi', they each fire session_start
	// and try to apply their own mapped theme. The LAST one to fire wins.
	// Since system-select is last in the ipi alias array, it was setting 'catppuccin-mocha'.
	
	// We want to skip theme application for all secondary extensions if they are stacked,
	// so the primary extension (first in the array) dictates the theme.
	const primaryExt = primaryExtensionName();
	if (primaryExt && primaryExt !== name) {
		return true; // Pretend we succeeded, but don't overwrite the primary theme
	}

	// Own-property only — a file named e.g. `constructor.ts` must not inherit
	// Object.prototype members and skip the synthwave fallback below.
	let themeName = Object.hasOwn(THEME_MAP, name) ? THEME_MAP[name] : undefined;
	
	if (!themeName) {
		themeName = "synthwave";
	}

	const result = ctx.ui.setTheme(themeName);

	if (!result.success && themeName !== "synthwave") {
		warnThemeFailureOnce(themeName);
		return ctx.ui.setTheme("synthwave").success;
	}

	return result.success;
}

// setTheme failures are otherwise invisible — the extension boots with a silent
// fallback theme and the user can't tell their mapped theme never applied.
// Warn once per theme name so stacked extensions don't spam the console.
const warnedThemeFailures = new Set<string>();
function warnThemeFailureOnce(themeName: string): void {
	if (warnedThemeFailures.has(themeName)) return;
	warnedThemeFailures.add(themeName);
	console.warn(`[themeMap] failed to apply theme "${themeName}" — falling back to synthwave`);
}
// ── Title ──────────────────────────────────────────────────────────────────

/**
 * Read process.argv to find the first -e / --extension flag value.
 *
 * When Pi is launched as:
 *   pi -e extensions/subagent-widget.ts -e extensions/pure-focus.ts
 *
 * process.argv contains those paths verbatim. Every stacked extension calls
 * this and gets the same answer ("subagent-widget"), so all setTitle calls
 * are idempotent — no shared state or deduplication needed.
 *
 * Returns null if no -e flag is present (e.g. plain `pi` with no extensions),
 * or if every -e is followed by another flag rather than a path.
 */
function primaryExtensionName(): string | null {
	const argv = process.argv;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		// Equals form: `pi --extension=extensions/foo.ts` or `pi -e=extensions/foo.ts`.
		// Without this, an equals-form launch yields no primary name and the LAST
		// stacked extension's theme wins, contradicting "primary wins".
		if (arg.startsWith("--extension=") || arg.startsWith("-e=")) {
			const value = arg.slice(arg.indexOf("=") + 1);
			if (value && !value.startsWith("-")) {
				return basename(value).replace(/\.[^.]+$/, "");
			}
			continue;
		}
		if (i >= argv.length - 1) continue;
		// The value after -e/--extension must exist and be a path, not another
		// flag — `pi -e --mode json` would otherwise report "--mode" as the
		// extension name. Keep scanning so a later real -e still wins.
		const next = argv[i + 1];
		if ((arg === "-e" || arg === "--extension") && next && !next.startsWith("-")) {
			return basename(next).replace(/\.[^.]+$/, "");
		}
	}
	return null;
}

/**
 * Set the terminal title to "π - <first-extension-name>" on session boot.
 * Reads the title from process.argv so all stacked extensions agree on the
 * same value — no coordination or shared state required.
 *
 * Deferred 150 ms to fire after Pi's own startup title-set.
 *
 * Known race: the 150 ms defer is a heuristic, not a happens-before edge.
 * Under load Pi's startup title-set can land AFTER this timer fires, so Pi's
 * title wins and the extension title is lost (or, with stacked extensions,
 * ordering can invert). The title is cosmetic; accept the race rather than
 * coupling to Pi internals for a deterministic ordering.
 */
function applyExtensionTitle(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const name = primaryExtensionName();
	if (!name) return;
	// Capture ONLY ctx.ui, not the whole ExtensionContext: if the session is
	// torn down inside the 150ms window, the pending timer pins just the UI
	// facade, not the session's full object graph (sessionManager, model
	// registry, model). The pin is bounded either way — the timer always
	// fires and releases it. There is deliberately no clear-on-shutdown:
	// ExtensionContext exposes no lifecycle hook (session_shutdown lives on
	// the extension API object, which this helper never receives), and a
	// 150ms self-releasing, unref'd timer is not a leak worth an API change.
	const ui = ctx.ui;
	const titleTimer = setTimeout(() => {
		// The session can end before this fires (e.g. a fast CLI run or test) —
		// the UI context may already be torn down by then.
		try {
			ui.setTitle(`π - ${name}`);
		} catch {
			/* ignore */
		}
	}, 150);
	// Unref: this fires ~150ms into session start, and a fast CLI run / test may
	// exit before then. A refed timer would hold the event loop alive and delay
	// process exit purely for a cosmetic title-set — never worth blocking exit.
	titleTimer.unref();
}

// ── Combined default ───────────────────────────────────────────────────────

/**
 * Apply both the mapped theme AND the terminal title for an extension.
 * Drop-in replacement for applyExtensionTheme — call this in every session_start.
 *
 * Usage:
 *   import { applyExtensionDefaults } from "./themeMap.ts";
 *
 *   pi.on("session_start", async (_event, ctx) => {
 *     applyExtensionDefaults(import.meta.url, ctx);
 *     // ... rest of handler
 *   });
 */
export function applyExtensionDefaults(fileUrl: string, ctx: ExtensionContext): void {
	applyExtensionTheme(fileUrl, ctx);
	applyExtensionTitle(ctx);
}
