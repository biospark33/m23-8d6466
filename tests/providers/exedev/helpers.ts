/**
 * Host-side process runner shared by the exedev test suites (git plumbing for
 * the origin repos, rev-parse for the pinned SHAs). One copy so driver.test.ts
 * and setup-gate.test.ts cannot diverge (review round 1, duplication warning).
 */

export async function runLocal(argv: string[]): Promise<string> { /* dp:ok a rejection here is the test failing — there is nothing to recover */
  const proc = Bun.spawn({ cmd: argv, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`runLocal ${argv.join(" ")} exited ${code}: ${stderr}${stdout ? ` (stdout: ${stdout})` : ""}`);
  return stdout;
}
