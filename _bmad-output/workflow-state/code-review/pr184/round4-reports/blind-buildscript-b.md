# blind-buildscript-b

> Scope note: my slice is `/tmp/pr184-r4/chunk-buildscript.diff` lines 1080–2135 only.
> The `+++ b/<path>` header and the hunk headers are **outside** my slice, so I cannot
> compute real source line numbers. Every finding cites the **diff line number in
> `chunk-buildscript.diff`** plus the enclosing function name so it is findable.

## [MEDIUM] The NOTICE is written before the binary-attribution gate, so a failing AC5 gate leaves exactly the artifact the file swears it never leaves
- **File:line:** exedev image build script, `main()` — diff `chunk-buildscript.diff:1967` (write) vs `chunk-buildscript.diff:1985-1991` (gate)
- **Trigger:** Build an image where `exeuntu update pi` (or any vendor installer) lands a binary whose basename has no entry in `oci/exedev/binary-licenses.json`. The credential gate passes, the sweep passes, `NOTICE_PATH` is written to disk, and *then* `uncoveredBinaries` returns non-empty and `die(1)` exits the process — `die` does not unwind the `finally`, and `NOTICE_PATH` is not in `leaked.paths`. `oci/.build/exedev/NOTICE` is left on disk describing an image that failed a gate and was never tagged or pushed. The very next comment three lines above states the opposite intent for the credential gate; the reasoning was applied to that gate and not to the one after it.
- **Evidence:**
```
1954 +    // The credential gate runs BEFORE the NOTICE is written. The header's claim
1955 +    // is that a build which tripped a gate leaves no artifact behind, and
1956 +    // `oci/.build/exedev/NOTICE` is an artifact — freshly written, describing an
1957 +    // image that then failed INV-IBOX-1.
...
1967 +    fs.writeFileSync(NOTICE_PATH, notice);
...
1985 +    if (uncovered.length > 0) {
1986 +      die(1, [
```

## [MEDIUM] `leaked.containers.delete(cid)` runs unconditionally after an unchecked `docker rm -f` — a removal that FAILED is erased from the leak registry that exists to catch it
- **File:line:** `scanImage()` — diff `chunk-buildscript.diff:1222-1223`; `extractNodeModules()` — diff `chunk-buildscript.diff:1258-1259`
- **Trigger:** `docker rm -f <cid>` fails (daemon restarted mid-run, container held by another operation, `ENOSPC` on the daemon's graph driver). `spawnSync` is called with `stdio: "ignore"` and its `status` is never read, so the failure is invisible; the very next statement removes `cid` from `leaked.containers`, so the exit/signal leak handlers will not retry it either. The container — created from a multi-GB image — is now leaked with no record anywhere. This is the one code path `leaked.containers` was built for, and it is the one path that unregisters on failure.
- **Evidence:**
```
1221 +  } finally {
1222 +    spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
1223 +    leaked.containers.delete(cid);
1224 +  }
```
```
1257 +  } finally {
1258 +    spawnSync("docker", ["rm", "-f", cid], { stdio: "ignore" });
1259 +    leaked.containers.delete(cid);
1260 +  }
```

## [MEDIUM] Stale-run sweep: `statSync` on a vanished sibling turns a healthy concurrent run into `die(2)`, and the age gate can delete a *live* run's directory
- **File:line:** `main()` — diff `chunk-buildscript.diff:1743-1757`
- **Trigger (a), the throw:** The comment two blocks up says this design exists for "the matrix case" — two concurrent runs on one host. Run B finishes and `fs.rmSync(runDir)`s its own `run-XXXX` between run A's `fs.readdirSync(BUILD_DIR)` (line 1736) and run A's `fs.statSync(stale)` (line 1747). `statSync` throws `ENOENT`, the `catch` does not distinguish it, and run A dies with `cannot sweep the stale run directory at …` — a fatal exit 2 on a build that had nothing wrong with it. Same outcome for a dangling symlink named `run-foo` (`statSync` follows links). `force`/`recursive` on the `rmSync` guard nothing here because the throw comes from the `stat`, not the `rm`.
- **Trigger (b), the age gate:** the gate reads the *directory's* mtime. `runDir`'s mtime is only bumped when a child entry is created/removed — i.e. at `mkdtemp`, at archive export, and at `fs.rmSync(archive)`. The whole gate phase after `docker load` (`scanImage`'s full-filesystem export + tar listing, `sweepImageTree`, and **two** `find / -exec sha256sum` passes over a multi-GB image) writes nothing into `runDir`. If that phase ever exceeds `staleAfterMs`, a concurrently starting run sees a >1h mtime, concludes "died uncleanly", and `rmSync(recursive)`s the live run's directory. The comment asserts "an hour is several build lengths" but measures build length, not gate length.
- **Evidence:**
```
1743 +  for (const entry of staleEntries) {
1744 +    if (!entry.startsWith("run-")) continue;
1745 +    const stale = path.join(BUILD_DIR, entry);
1746 +    try {
1747 +      const st = fs.statSync(stale);
1748 +      if (!st.isDirectory() || Date.now() - st.mtimeMs < staleAfterMs) continue;
1749 +      fs.rmSync(stale, { recursive: true, force: true });
...
1751 +    } catch (err) {
1752 +      die(2, [
1753 +        `cannot sweep the stale run directory at ${stale}: ${...}`,
```

## [MEDIUM] The `finally` cleanup can clobber the in-flight error, and an unguarded throw there exits 1 — the code this file reserves for a compliance failure
- **File:line:** `main()` — diff `chunk-buildscript.diff:2115-2122`
- **Trigger:** Anything in the `try` block throws a real (non-`die`) exception — `renderNotice` blowing up, `summarize` on a malformed sweep, an OOM in `sweepTree`. Control reaches the `finally`, `fs.rmSync(runDir, { recursive: true, force: true })` hits `EACCES`/`EBUSY`/`ENOTEMPTY` (NFS, a docker mount still holding it, a Windows-style lock), and that throw *replaces* the original exception. The operator is shown a filesystem error for a licence-gate crash. Independently: an uncaught throw from this `finally` exits **1**, which every other error path in this diff goes out of its way to avoid (`writeJson`, `parseArgs`, the artifact pre-clean, the stale sweep all wrap their I/O precisely because "an uncaught throw would exit 1, the code reserved for a compliance failure"). This `finally` is the one place that rule was not applied.
- **Evidence:**
```
2115 +  } finally {
2116 +    fs.rmSync(runDir, { recursive: true, force: true });
2117 +    leaked.paths.delete(runDir);
2118 +    if (!opts.keepTree) {
2119 +      fs.rmSync(treeDir, { recursive: true, force: true });
```

## [MEDIUM] The protected-build-input guard is a case-sensitive string compare on a case-insensitive filesystem — `--evidence OCI/exedev/Dockerfile` walks straight past it and gets deleted
- **File:line:** `main()` — diff `chunk-buildscript.diff:1664-1676` (guard) and `chunk-buildscript.diff:1683-1685` (the delete)
- **Trigger:** On macOS (APFS default is case-insensitive) or a case-insensitive mount, run with `--evidence OCI/exedev/Dockerfile` (or `oci/exedev/SYSTEMD/x.service`, or any protected path with a different case). `path.resolve` normalises separators and `..` but **not case**, so `insideOrEqual` compares `/repo/OCI/exedev/Dockerfile` against `/repo/oci/exedev/Dockerfile`, `startsWith` is false, `clash` is `undefined`, the guard passes — and then `fs.rmSync(stale, { force: true })` on line 1685 resolves case-insensitively and deletes the **real** tracked `Dockerfile`. The guard's own comment names this exact outcome ("naming an input would delete it") as the thing it prevents. Same hole for `--summary` and for a `..`-free path reached through a symlinked parent (`path.resolve` does not call `realpath`).
- **Evidence:**
```
1665 +  const insideOrEqual = (child: string, parent: string): boolean =>
1666 +    child === parent || child.startsWith(parent + path.sep);
1667 +  for (const out of [opts.summary, opts.evidence]) {
1668 +    const clash = protectedInputs.find((input) => insideOrEqual(out, input));
```
```
1683 +  for (const stale of [NOTICE_PATH, opts.summary, opts.evidence]) {
1684 +    try {
1685 +      fs.rmSync(stale, { force: true });
```

## [MEDIUM] `listExecutables` audits the image using the image's own `find` and `sha256sum` — the gate for "a vendor installer replaced a binary in place" can be defeated by replacing exactly those binaries
- **File:line:** `listExecutables()` — diff `chunk-buildscript.diff:1411-1425`, specifically the `-c` payload at `chunk-buildscript.diff:1422`
- **Trigger:** The docblock's whole thesis is that path-difference was insufficient because "`exeuntu update pi --version` overwrites the pi tree the base already ships", so identity now includes content hash. But the content hash is computed **by a program shipped inside the artifact under audit**, run as root inside that artifact, over a listing produced by a `find` also shipped inside that artifact. An installer that lands a modified `sha256sum` (or a `find` that prunes a directory) makes its own additions invisible to the gate — and the base run gets a *different*, honest `sha256sum` from the base image, so the two listings are not even produced by the same measuring instrument. The docblock names two residual false-negative classes (`-type l`, mode-only changes) but not this one, so a reader is left believing the enumeration is trustworthy. It also silently trusts that `/bin/sh` in a *hostile* image is a shell.
- **Evidence:**
```
1418 +      "--entrypoint", "/bin/sh", ref,
...
1422 +      "-c", "exec find / -xdev -type f -perm -u+x -exec sha256sum {} +",
```

## [MEDIUM] `docker cp -L` may only dereference the SRC_PATH itself, not symlinks nested inside the copied tree — if so, the hole this docblock claims to close is still open (UNCERTAIN: I cannot verify docker's semantics from my slice)
- **File:line:** `extractNodeModules()` — diff `chunk-buildscript.diff:1251` and `chunk-buildscript.diff:1255`, justified by the docblock at `chunk-buildscript.diff:1234-1245`
- **Trigger:** The docblock states that without `-L`, `docker cp` writes a *nested* linked package (an npm workspace link, a hoisted/linked dep) into the host scratch dir as a dangling symlink, `walkTree` calls it `unreadable`, `treePackageCount` is 0, and `if (sweep.treePackageCount > 0)` greens an image carrying an unswept tree. My understanding of `docker cp --follow-link, -L` is that it resolves **SRC_PATH** only — the top-level path named on the command line — and copies symlinks *inside* a directory verbatim. If that is right, `-L` does nothing for the case the docblock describes: `${cid}:/${site}` is a directory, its own resolution is irrelevant, and every nested link still lands dangling. **I cannot confirm docker's behaviour from my slice** — but note that even in that case the build is not silently green: `sweep.unreadable` is now separately fatal at the `failClosed` block (diff 1940-1952), which is the actual thing closing this hole. So the risk is a *misplaced* justification: someone later removing the `failClosed` block would trust `-L` to hold the line.
- **Evidence:**
```
1237 +/*
1238 + * linked package (an npm workspace link, a hoisted/linked dep, anything the
1239 + * vendor installer symlinked) into the host scratch dir VERBATIM — a symlink
```
```
1251 +      if (i === 0) run("docker", ["cp", "-L", `${cid}:/${site}`, nm], `docker cp /${site}`);
...
1255 +      else run("docker", ["cp", "-L", `${cid}:/${site}/.`, `${nm}/`], `docker cp /${site}`);
```

## [LOW] Nothing checks that `NOTICE_PATH`, `--summary` and `--evidence` are three distinct paths; two of the three writes silently win
- **File:line:** `main()` — diff `chunk-buildscript.diff:1683` (the set is enumerated), `chunk-buildscript.diff:1967` / `2065` / `2067` (the three writes)
- **Trigger:** `--summary out.json --evidence out.json` → `writeJson(opts.summary, …)` runs, then `writeJson(opts.evidence, …)` overwrites it. Exit 0, "summary: out.json / evidence: out.json" printed, and the summary is gone. Worse: `--summary oci/.build/exedev/NOTICE` passes the protected-input guard (NOTICE is an output, not an input), the pre-clean loop deletes it three times harmlessly, the NOTICE is written at 1967, and then line 2065 overwrites the published NOTICE with the summary JSON — after every gate has passed, so the run reports success. The guard immediately above went to real effort to catch pathological `--summary`/`--evidence` values; this class was not covered.
- **Evidence:**
```
1683 +  for (const stale of [NOTICE_PATH, opts.summary, opts.evidence]) {
```
```
1967 +    fs.writeFileSync(NOTICE_PATH, notice);
...
2065 +    writeJson(opts.summary, summary);
2066 +
2067 +    writeJson(opts.evidence, {
```

## [LOW] `fs.writeFileSync(NOTICE_PATH, …)` is the one artifact write not wrapped — an I/O failure there exits 1, the compliance code
- **File:line:** `main()` — diff `chunk-buildscript.diff:1967`
- **Trigger:** `oci/.build/exedev/` becomes unwritable (disk full, permissions changed, another process took the path as a directory) between the pre-clean writability probe at diff 1693-1695 and this write ~10 minutes of build later. `writeFileSync` throws, nothing catches it inside `main`, the process exits **1** — which `writeJson`'s own comment (diff 1562-1567) documents as "reserv[ed] for a compliance failure". An `ENOSPC` is reported to CI as a licence violation. `writeJson` exists precisely to prevent this and is used for the other two artifacts; this one call skips it.
- **Evidence:**
```
1967 +    fs.writeFileSync(NOTICE_PATH, notice);
```

## [LOW] On a non-push run, the single-digest fallback can adopt the docker-archive exporter's digest and record it as `builtDigest` — the "reproducibility evidence" — with nothing ever validating it
- **File:line:** `main()` — diff `chunk-buildscript.diff:1870`; recorded at `chunk-buildscript.diff:2081`
- **Trigger:** A buildx that namespaces only the docker exporter (writes `docker.containerimage.digest` and no flat key, no `image` scope). `digests.get("image")` is `undefined`, `distinct.size === 1`, so `builtDigest` becomes the **docker archive's** manifest digest — a value no registry resolves. The comment at diff 1863-1867 admits the flat arm is accepted on trust and says the push-time registry read-back "PROVES" it — but that proof only exists on `--push`. On a local run the value is written straight into `build-evidence.json` as `builtDigest`, described at diff 2076-2078 as "the reproducibility evidence … Two runs of this script that report the same `builtDigest` are the proof". Two such runs would agree on a digest that means something other than what the field claims.
- **Evidence:**
```
1870 +  const builtDigest = digests.get("image") ?? (distinct.size === 1 ? [...distinct][0]! : null);
```
```
2081 +      builtDigest,
```
