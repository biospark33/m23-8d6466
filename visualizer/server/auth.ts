/**
 * Tunneled auth gate for the DF4.1 visualizer (AC1, AC5, INV-1/2/5).
 *
 * SSSF shipped with no authn at all (R4 §2.6); the trace holds full compiled
 * prompts — client source code (F11/R10) — so every route, static included,
 * sits behind this gate on a loopback-bound port reached through an SSH
 * forward. No CORS is ever emitted: a permissive header would let a hostile
 * origin read the trace with the browser's cached Basic credential.
 *
 * Credential forms (same secret, one secret): `Bearer <token>` — primary —
 * and `Basic base64(":"+token)` as the browser-navigation fallback. The
 * compare is constant-time over fixed 32-byte sha256 digests, so timing
 * leaks neither the token nor its length.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
// VizError and assertNeverPublic are owned by the provider seam (INV-2 must
// be enforceable from src/providers/ without importing from visualizer/, see
// src/providers/viz-guard.ts) and re-exported here so existing imports from
// this module are unaffected.
export { VizError, assertNeverPublic } from "../../src/providers/viz-guard.ts";
import { VizError } from "../../src/providers/viz-guard.ts";

export const DEFAULT_VIZ_PORT = 4600;
export const TOKEN_MIN_BYTES = 32;

/**
 * QDS_VIZ_TOKEN, host-side only, minted fresh per server start. An unset or
 * short token prevents the listener from binding at all (INV-1) — the server
 * never starts ungated and never falls back to "open in dev". The token is
 * never logged in any form, so neither is it included in any error message.
 */
export function validateToken(env: Record<string, string | undefined>): string {
  const token = env.QDS_VIZ_TOKEN;
  if (token === undefined || token === "") {
    throw new VizError(
      "VIZ_TOKEN_MISSING",
      "QDS_VIZ_TOKEN is unset — refusing to bind: the visualizer never serves unauthenticated",
      "Set QDS_VIZ_TOKEN to a secret of at least 32 bytes (e.g. openssl rand -hex 32) and restart.",
    );
  }
  // Bytes, not UTF-16 code units: a 20-character token of 2-byte characters
  // is 40 bytes of entropy, and a surrogate pair is 4 bytes in one .length of 2.
  const tokenBytes = Buffer.byteLength(token, "utf8");
  if (tokenBytes < TOKEN_MIN_BYTES) {
    throw new VizError(
      "VIZ_TOKEN_SHORT",
      `QDS_VIZ_TOKEN is ${tokenBytes} bytes, minimum is ${TOKEN_MIN_BYTES} — refusing to bind`,
      "Mint a fresh secret of at least 32 bytes (e.g. openssl rand -hex 32) and restart.",
    );
  }
  return token;
}

/**
 * QDS_VIZ_PORT, default 4600, integer in 1024-65535 or refuse to bind.
 * Bun 1.2.2x does not throw on a bad port — the validation is app-side,
 * BEFORE Bun.serve (INV-5).
 */
export function validatePort(env: Record<string, string | undefined>): number {
  const raw = env.QDS_VIZ_PORT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_VIZ_PORT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new VizError(
      "VIZ_PORT_INVALID",
      `QDS_VIZ_PORT "${raw}" is not a decimal integer — refusing to bind`,
      "Set QDS_VIZ_PORT to an integer in 1024-65535, or unset it for the default 4600.",
    );
  }
  const port = Number(trimmed);
  if (port < 1024 || port > 65535) {
    throw new VizError(
      "VIZ_PORT_INVALID",
      `QDS_VIZ_PORT ${port} is outside 1024-65535 — refusing to bind`,
      "Set QDS_VIZ_PORT to an integer in 1024-65535, or unset it for the default 4600.",
    );
  }
  return port;
}

// ── request gates ────────────────────────────────────────────────────────────

/** sha256 both sides, then compare the fixed 32-byte digests — length never leaks. */
function constantTimeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * DNS-rebinding gate (AC1): the Host header must be exactly one of the two
 * loopback spellings carrying the resolved listen port. A hostile page that
 * resolves its own name to 127.0.0.1 cannot reach a route even to test a
 * credential — this runs BEFORE the credential check.
 */
export function checkHost(req: Request, port: number): boolean {
  const host = req.headers.get("host");
  if (host === null) return false;
  const idx = host.lastIndexOf(":");
  if (idx === -1) return false;
  const hostname = host.slice(0, idx).toLowerCase();
  const portPart = host.slice(idx + 1);
  return (
    (hostname === "127.0.0.1" || hostname === "localhost") && portPart === String(port)
  );
}

/** The credential scheme the request presents, for the CSRF table's rows 5/6. */
function credentialScheme(req: Request): "bearer" | "basic" | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  if (/^bearer /i.test(header)) return "bearer";
  if (/^basic /i.test(header)) return "basic";
  return null;
}

/** Parsed-origin comparison: scheme+host+port via new URL, never exact string match. */
function originAllowed(value: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false; // unparsable is malformed → rejected like foreign
  }
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.port === String(port)
  );
}

/**
 * CSRF gate for the one write route, evaluated top-down per AC1's table:
 * present Origin decides (match → proceed, foreign/unparsable → 403); absent
 * Origin + present Referer decides the same way (a real Referer carries a
 * path, hence the component comparison); both absent → Bearer proceeds, Basic
 * is 403 — the exact shape a cross-site form POST with cached Basic
 * credentials takes. A non-Basic credential with both absent proceeds to the
 * credential check and fails there (401), so an unauthenticated caller cannot
 * distinguish the CSRF gate from the gate it already fails.
 */
export function checkCsrf(req: Request, port: number): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null) return originAllowed(origin, port);
  const referer = req.headers.get("referer");
  if (referer !== null) return originAllowed(referer, port);
  return credentialScheme(req) !== "basic";
}

/** Constant-time credential check. Absent/malformed/wrong → false, never a throw. */
export function checkCredential(req: Request, token: string): boolean {
  const header = req.headers.get("authorization");
  if (header === null) return false;
  if (/^bearer /i.test(header)) {
    return constantTimeEqual(header.slice(7), token);
  }
  if (/^basic /i.test(header)) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    return constantTimeEqual(decoded, `:${token}`);
  }
  return false;
}

/** Mint an id for requests whose route carries no correlation key. */
export function mintRequestId(): string {
  return `req-${randomBytes(6).toString("hex")}`;
}
