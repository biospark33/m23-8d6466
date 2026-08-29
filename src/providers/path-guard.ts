/**
 * F034 — the ONE grammar for a path that will be interpolated into a box-side
 * `sh -c` script, an argv word, or an scp remote spec. Six private copies had
 * drifted (only `exedev/fill.ts` and `exedev/{setup-gate,driver}.ts` rejected
 * `a//b`); this is the STRICTEST union of all six, plus a leading-`-` refusal
 * none of them had — a path that reads as a flag is not a plain path.
 *
 * A LEAF by design (no imports at all): every caller sits on an exec or
 * credential path, so this module must never be able to pull one in. Callers
 * catch and re-throw their own typed error — the classes and messages callers
 * emit are pinned by their own suites and do not change here.
 */
export function assertPlainBoxPath(label: string, value: string): void {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    !/^[A-Za-z0-9._/-]+$/.test(value) ||
    value.startsWith("-") ||
    segments.includes("..") ||
    // Leading "" is the absolute-path root and is allowed (callers that need a
    // box-RELATIVE path reject the leading "/" themselves); an empty segment
    // anywhere else is "a//b" or a trailing slash.
    segments.slice(1).includes("")
  ) {
    throw new Error(
      `${label} ${JSON.stringify(value)} is not a plain path (charset [A-Za-z0-9._/-], no "..", no empty segments, no leading "-")`,
    );
  }
}
