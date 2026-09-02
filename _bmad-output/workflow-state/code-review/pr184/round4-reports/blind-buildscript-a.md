# blind-buildscript-a

## [MEDIUM] `judgeCandidateDir` follows symlinks HOST-side, reopening the exact hole `-L` was added to close
- **File:line:** `scripts/build-exedev-image.ts:1029` (diff line 1035; also the `isDirectory()` branch at `:1022` / diff 1028)
- **Trigger:** a credential-candidate path that resolves to a DIRECTORY (`/etc/foo/credentials/`) containing a symlink, e.g. `credentials/key -> /etc/passwd` or `credentials/key -> /root/.ssh/id_rsa`. `docker cp -L` follows only the top-level source link; entries *inside* the copied tree are written to the host as symlinks whose targets are absolute **in-container** paths. `fs.readFileSync` then resolves them against the **host** filesystem. So the bytes judged by `configLooksLikeCredential` are the host's file, not the image's — a real in-image credential reached through an inner symlink reads as whatever the build host happens to have at that path (commonly a benign file, or nothing). The `inspectConfigs` docblock argues at length that `-L` "CLOSES a hole rather than opening one … a config symlinked to `/etc/passwd` would have had the HOST's file read and judged in its place"; that hole is still open for every entry below a candidate directory. Secondary, opposite-direction defect on the same lines: `Dirent.isDirectory()` is false for a symlink-to-directory (readdirSync does not stat through links), so such an entry falls into `readFileSync` → `EISDIR` → an unconditional "could not read" finding that fails an otherwise clean build.
- **Evidence:**
```ts
      if (e.isDirectory()) {
        walk(path.join(d, e.name), childRel);
        continue;
      }
      // Everything else — files, symlinks (followed; dangling ones throw and
      // fail closed), oddities — is judged by content or reported.
      try {
        const text = fs.readFileSync(path.join(d, e.name), "utf8");
```

## [MEDIUM] `nodeModulesRoot` gives up on the first non-boundary hit and misses a real `node_modules` deeper in the path
- **File:line:** `scripts/build-exedev-image.ts:1045` (diff lines 1047–1052)
- **Trigger:** any tar entry whose path contains a decoy segment ending in `node_modules` before the real one, e.g. `usr/lib/my_node_modules/foo/node_modules/pkg/index.js`. `indexOf` finds only the FIRST occurrence, sees it is not on a `/` boundary, and returns `null` — so the genuine `…/node_modules/` root further right is never reported. On this image the gate is "expected count 0, a NON-ZERO count is itself the finding", so the failure direction is a silent green on precisely the condition (an npm tree crept in) the sweep exists to catch. The fix is to keep scanning from `idx + 1`, not to return.
- **Evidence:**
```ts
  const idx = entry.indexOf("node_modules/");
  if (idx < 0) return null;
  // Must sit on a path boundary: `my_node_modules/x` is not an npm tree.
  if (idx > 0 && entry[idx - 1] !== "/") return null;
```

## [MEDIUM] `parseBaseRefs` registers a stage alias before testing the ref of the SAME instruction, so `FROM alpine AS alpine` drops the image
- **File:line:** `scripts/build-exedev-image.ts:541`–`:543` (diff 547–549), with the fatal consequence at `:863` (diff 869)
- **Trigger:** the self-hop shape `FROM alpine AS alpine`, which `resolveRuntimeBaseRef`'s docblock explicitly claims is handled "with no special case at all". Within one iteration the stage name is added to `stages` first, then `stages.has(ref.toLowerCase())` is tested — for a self-named stage the ref matches the alias it just declared and is `continue`d. Result: that base image never lands in `baseRefs`, so (a) its digest is never folded into the buildId — an identity that omits a real base — and (b) `resolveRuntimeBaseRef` correctly returns `alpine` while `baseRefs.includes(runtimeBaseRef)` is false, so a valid Dockerfile dies with "cannot determine which image the FINAL stage … derives from", a message that names nothing about the real cause. Checking the ref against `stages` *before* adding this instruction's own stage is the ordering Docker actually uses.
- **Evidence:**
```ts
    if (stage) stages.add(stage);
    if (ref.toLowerCase() === "scratch") continue;
    if (stages.has(ref.toLowerCase())) continue;
```
```ts
  if (runtimeBaseRef === null || !baseRefs.includes(runtimeBaseRef)) {
```

## [MEDIUM] `resolveBaseDigest`'s local fallback takes `RepoDigests[0]` without checking it belongs to `ref`'s repository
- **File:line:** `scripts/build-exedev-image.ts:671`–`:673` (diff 677–679)
- **Trigger:** the base image is present locally under more than one repository name — a mirrored/retagged base in CI, or any dev host that did `docker tag` + `docker push` to a second registry. `RepoDigests` then has several entries and `index .RepoDigests 0` returns whichever docker lists first, which need not be the digest of `ref`'s repository. That value is (a) folded into the buildId as this base's identity — a false provenance claim that fails silently, since the shape check `@sha256:[0-9a-f]{64}` passes for any repo's digest — and (b) spliced into `runtimeBasePinned` as `${ref}@${digest}`, a ref/digest pair the registry does not have, which then fails later and opaquely in the negative-control step. The digest must be selected by matching the repository part of `ref`, not by position.
- **Evidence:**
```ts
  const local = tryRun("docker", ["image", "inspect", "--format", "{{index .RepoDigests 0}}", ref]);
  const fromLocal = local?.match(/@(sha256:[0-9a-f]{64})$/);
  if (fromLocal) return fromLocal[1]!;
```

## [MEDIUM] The "not literal" refusal in `resolveBaseDigest` is ordered after the digest match, so a templated ref carrying a digest slips through
- **File:line:** `scripts/build-exedev-image.ts:659`–`:663` (diff 665–669)
- **Trigger:** `FROM ${BASE}@sha256:<64hex>` in the Dockerfile. The `pinned` match succeeds and returns before the `ref.includes("$")` guard whose docblock says "Refuse rather than resolve something else later" ever runs. `parseBaseRefs` keeps the literal ref string `${BASE}@sha256:…`, and `gatherBuildIdInputs` may then hand it on as `runtimeBaseRef` / `runtimeBasePinned` — a `$`-bearing string that goes into docker argv further down (`docker run`/`docker create` on the negative-control base), failing there with an unresolvable-reference error instead of at parse. Moving the `$` check above the `pinned` match costs nothing and preserves the stated intent.
- **Evidence:**
```ts
  const pinned = ref.match(/@(sha256:[0-9a-f]{64})$/);
  if (pinned) return pinned[1]!;
  // A `${VAR}` in a FROM would make the buildId a hash of a template rather
  // than of a substrate. Refuse rather than resolve something else later.
  if (ref.includes("$")) {
```

## [MEDIUM] `fromInstructions`' continuation refusal only sees `FROM …\`, not a non-FROM instruction whose continuation line starts with `FROM`
- **File:line:** `scripts/build-exedev-image.ts:561` (diff 567)
- **Trigger:** any backslash-continued instruction whose *next* physical line begins with `FROM `, e.g.
  ```
  RUN make install \
      FROM=x ./configure
  ```
  The guard's regex is anchored on the line that *starts* with `FROM` and ends with `\`; a continuation *into* a FROM-looking line matches neither arm, so the line is parsed as a real `FROM` and appended to `out`. Because it is appended last, `resolveRuntimeBaseRef` (`froms.at(-1)`) takes the phantom as the runtime base — the negative control for AC5's added-binary diff — and `parseBaseRefs` folds it into the buildId. The docblock claims this whole class is refused ("teach it heredocs (and continued FROM lines)"); half of it is. Most realistic phantoms will die in `resolveBaseDigest`, but the failure names an invented image rather than the misparse, and a phantom that happens to resolve is silently wrong.
- **Evidence:**
```ts
  if (dockerfile.includes("<<") || /^\s*from\s.*\\[ \t]*$/im.test(dockerfile)) {
```

## [MEDIUM] `tarUnescape`'s pass-through loop appears not to skip the trailing surrogate after `codePointAt` — I cannot see the line after my slice ends
- **File:line:** `scripts/build-exedev-image.ts:1108`–`:1114` (diff 1114–1120; my slice ends exactly at the `bytes.push(...)` line, so a compensating `i++` on the very next line would refute this)
- **Trigger:** an escaped entry (`entry.includes("\\")` true, so the fast path is skipped) that also contains an astral character — an emoji or similar in a path. `entry.codePointAt(i)` correctly returns the full code point and pushes its 4 UTF-8 bytes, but the loop advances by one CODE UNIT, so the next iteration lands on the low surrogate: `codePointAt` returns the lone surrogate, `String.fromCodePoint` produces it, and `Buffer.from(…, "utf8")` encodes it as U+FFFD — appending 3 junk bytes after every astral character. That is exactly the mojibake the docblock says this branch exists to prevent, and the resulting name misses in `docker cp`, producing a phantom "could not read" finding. Unverifiable from this slice.
- **Evidence:**
```ts
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i]!;
    if (c !== "\\") {
      const cp = entry.codePointAt(i)!;
      bytes.push(...Buffer.from(String.fromCodePoint(cp), "utf8"));
```

## [LOW] `inspectConfigs` captures `docker cp`'s stderr and then discards it, so the fail-closed finding names no cause
- **File:line:** `scripts/build-exedev-image.ts:963`–`:966` (diff 969–972)
- **Trigger:** any `docker cp` failure other than the two anticipated ones (permission denied inside the container, a truncated export, a daemon hiccup). `stdio` deliberately sets stderr to `"pipe"` — so the reason is captured — but `cp.stderr` is never read anywhere in the function; the only output is the generic `could not read /<p> to check it for credentials`. An operator gets a build-stopping INV-IBOX-1 finding with no way to tell a permissions problem from a missing file. Either read `cp.stderr` into the finding or set stderr to `"ignore"` and stop implying it was kept.
- **Evidence:**
```ts
        const cp = spawnSync("docker", ["cp", "-L", `${cid}:/${variant}`, dest], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        if (cp.status !== 0) continue;
```
