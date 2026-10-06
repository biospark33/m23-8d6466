# Input-Handling (Upload / Deserialization / File-Handling) Invariants Checklist

> **Triggered by:** `upload`, `uploads`, `deserialization`,
> `file handling` in story or epic text.
> **Loaded by:** Phase 3 wrap-up step (`steps/phase-3-wrap-up.md` §3.0).
> **Used as:** `also_consider` input to the Phase 3 adversarial review.

When a story accepts user-supplied input (file uploads, untrusted
deserialization, multipart bodies, archive expansion), every one of
the items below must be addressable from the story spec alone. If the
spec cannot answer "yes, the story covers this," it is a HIGH finding.

## Deserialization-safety invariants

- [ ] **No unsafe Python object deserializers on untrusted bytes.**
      The story explicitly forbids using arbitrary-object
      deserializers (e.g. `pickle` / `cPickle` / `dill` /
      `marshal`) on user-supplied bytes. If serializing arbitrary
      Python objects is genuinely required, the story specifies a
      safe alternative (`json`, `msgpack` constrained to a typed
      schema, Pydantic `model_validate_json`).
- [ ] **No unsafe YAML loaders.** YAML parsing of user input uses
      `yaml.safe_load` or `yaml.load(..., Loader=SafeLoader)`.
      Plain `yaml.load` on untrusted input is a HIGH finding
      (arbitrary-object construction risk).
- [ ] **No DTD-enabled XML parsers on untrusted XML.** XML from
      users is parsed with `defusedxml` or an equivalent
      DTD-disabled / external-entity-blocked parser. Plain
      `ElementTree.parse` on user input is a HIGH finding (XXE
      risk).
- [ ] **No `eval` / `exec` / `compile` on user input.** Trivially
      true, but worth checking — code that builds a string from
      user input and passes it to `eval` / `exec` / `compile` is
      always a HIGH finding.

## File-type-allowlist invariants

- [ ] **MIME / magic-byte allowlist enforced server-side.** The
      story names the allowed file types (e.g. `pdf`, `docx`,
      `xlsx`) AND specifies that the check is by magic bytes
      (`python-magic` / `filetype`) — not by Content-Type header,
      not by file extension. Header- or extension-based checks
      alone are a HIGH finding.
- [ ] **Allowlist is explicit, not denylist.** The story enumerates
      the accepted MIME types. "Anything except .exe" is a HIGH
      finding — adversaries find unlisted extensions.
- [ ] **Polyglot defense for archives.** If the story accepts
      archives (zip, tar, gz), the story specifies that each
      contained file is independently re-validated against the
      same allowlist after extraction (a `.docx.zip` may contain
      a binary executable).

## Size-limit invariants

- [ ] **Per-request size cap.** The story specifies a hard
      `Content-Length` cap enforced at the proxy/web-server layer
      AND re-enforced in application code. The cap is sized for
      the worst-case legitimate upload, not "infinity."
- [ ] **Per-file size cap (inside multipart).** For multipart
      uploads, each part has its own cap — not just the aggregate
      body size. A 100 MB body cap with no per-part cap allows a
      single 100 MB malicious part.
- [ ] **Per-uploaded-archive expanded-size cap.** Archive expansion
      (zip slip / zip bomb defense) caps the **uncompressed** total
      size, not just the compressed size. Compression ratios > 100x
      are a known zip-bomb signature.
- [ ] **Per-tenant / per-principal rate & quota.** Story specifies
      a rate limit (uploads per minute) AND a storage quota
      (total bytes per tenant) so a single tenant cannot exhaust
      shared storage.

## Path-handling invariants

- [ ] **No path traversal.** Filenames from user input are
      sanitized to a single basename (no `/`, no `..`, no NUL byte)
      before being joined to a server-side directory. The story
      shows the sanitization code path or names the helper used.
- [ ] **Server-generated storage key.** Persisted filenames use a
      server-generated UUID (or content hash) — not the user-
      supplied name. The user name is stored as a separate display
      attribute.
- [ ] **Symlink safety on extraction.** Archive extraction refuses
      symlinks that point outside the destination directory.

## Pipeline-safety invariants

- [ ] **Untrusted input parsed in isolation.** Heavy / unsafe
      parsers (PDF, DOCX, image-thumbnail generation) run in a
      sandboxed worker process (separate container, separate
      runtime, separate user) — not in the request handler.
- [ ] **Parser timeouts.** Every parse step has a wall-clock
      timeout. A pathological PDF that takes 30 minutes to render
      must not block a request thread.
- [ ] **Memory caps on parser processes.** Worker containers that
      run untrusted-input parsing have OS-level memory limits so a
      malicious input cannot OOM the host.

## Test invariants

- [ ] **Malicious-input fixture.** The story DOD includes at least
      one test with a known malicious fixture: oversized file
      (>cap), wrong magic bytes for the declared extension, path-
      traversal filename, zip bomb (high compression ratio),
      polyglot file (e.g. `.pdf.docx`).
- [ ] **Allowlist enforcement test.** A test asserts that a file
      with a denied MIME type is rejected with the expected error
      code (400, not 500).
- [ ] **Quota / rate-limit test.** A test asserts that the
      Nth+1 upload within the rate window is rejected.

## Served-content security invariants

Apply when the story also serves uploaded content back to users
(profile pictures, document downloads, attachment previews, exported
artifacts). OWASP File Upload guidance treats the serving path as a
distinct attack surface — input validation alone is insufficient if
malicious HTML/JS reaches a browser under the app's origin.

- [ ] **Origin isolation.** Untrusted uploads are served from a
      separate domain/subdomain (e.g. `user-content.example.com`,
      object-store CDN host) — not the same origin as the
      authenticated app. This prevents stored-HTML/JS uploads from
      executing as same-origin code.
- [ ] **`X-Content-Type-Options: nosniff`.** All served-upload
      responses set this header so browsers do not MIME-sniff a
      `.png` into `text/html`.
- [ ] **Content-Security-Policy on served paths.** Served-upload
      responses set a CSP that, at minimum, disables inline scripts
      and restricts framing for the user-content origin (or an
      equivalent per-route policy if origin isolation is not
      feasible — document why).
- [ ] **`Content-Disposition: attachment` for untrusted types.**
      Any served file whose content-type is not on a small inline-
      safe allowlist (e.g. `image/png`, `image/jpeg`, `application/pdf`
      with a sandboxed viewer) is returned with
      `Content-Disposition: attachment; filename="…"` to force
      download instead of inline render.
- [ ] **Served-content header tests.** The story DOD includes
      tests asserting (a) the isolation origin in the response URL,
      (b) `X-Content-Type-Options: nosniff`, (c) the CSP header
      shape, and (d) `Content-Disposition: attachment` for an
      uploaded HTML fixture.

## Cross-story invariants

- [ ] **Single sanitization helper.** All stories in the batch use
      the same filename-sanitization function — no per-story
      re-implementation.
- [ ] **Consistent error model.** All stories return the same
      error shape for input-validation failures (same status code,
      same body schema) so the frontend can handle them
      uniformly.
- [ ] **Single served-content policy.** If multiple stories serve
      uploaded content, they all use the same origin-isolation host
      and header-emission helper — no per-story divergence.
