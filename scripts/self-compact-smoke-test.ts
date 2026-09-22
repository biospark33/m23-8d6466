#!/usr/bin/env bun
/**
 * self-compact-smoke-test — version gate for the vendored self-compact
 * extension (pi-vs-claude-code-vendor/self-compact/extensions/self-compact).
 *
 * Spawns this host's `pi` with the vendored extension and asserts it loads and
 * registers its four flags (--compact-soft-at, --compact-at, --compact-buffer,
 * --compact-prompt) in `pi --help`. Exit 0 = load OK; nonzero = the pi version
 * on this host rejects the extension — the version gate before the roster
 * wiring. Spawn shape (Bun.spawn, PI_SKIP_VERSION_CHECK=1, bounded capture)
 * follows scripts/coms-smoke-test.ts at smoke-test minimalism.
 */

const EXT = "pi-vs-claude-code-vendor/self-compact/extensions/self-compact/self-compact.ts";
const FLAG_RE = /--compact-(soft-at|at|buffer|prompt)/g;

// Driver runs ONLY as a script — importing this file must not spawn pi.
if (import.meta.main) {
	// import.meta.dir is <repo>/scripts; strip the suffix for the repo root.
	const proc = Bun.spawn(["pi", "--no-extensions", "-e", EXT, "--help"], {
		cwd: import.meta.dir.replace(/\/scripts$/, ""),
		env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	// Drain BOTH pipes before waiting on exit — an undrained stderr can block
	// the child on a full pipe buffer.
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	const distinct = new Set(out.match(FLAG_RE) ?? []);
	if (code !== 0 || distinct.size !== 4) {
		console.error(
			`self-compact smoke FAILED: exit=${code}, distinct flags=${[...distinct].join(",") || "none"}`,
		);
		console.error((out + err).slice(-2000));
		process.exit(1);
	}
	console.log(`self-compact smoke OK: ${distinct.size} compact flags registered`);
}
