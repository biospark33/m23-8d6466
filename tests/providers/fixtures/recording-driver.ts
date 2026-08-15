/**
 * Driver wrapper that records every exec's argv (DF2.3).
 *
 * FakeDriver's contract passes argv verbatim to Bun.spawn, so the recorded
 * array is what the remote side's `ps` sees — the hygiene scan asserts no
 * secret substring appears in it. (What this CANNOT catch is a driver that
 * rewrites argv between the call and the spawn; detecting that would need the
 * inner driver to record its own spawn argv. FakeDriver does not rewrite —
 * that is the documented contract being relied on here.)
 *
 * stdin presence is recorded as a boolean — the content is deliberately never
 * kept, so the fixture itself cannot leak a secret into a test artifact.
 */

import type { ExecResult, ProviderDriver, ProviderVm } from "../../../src/providers/driver.ts";

export interface RecordedExec {
  vm: string;
  argv: readonly string[];
  hadStdin: boolean;
}

export class RecordingDriver implements ProviderDriver {
  readonly execCalls: RecordedExec[] = [];

  constructor(private readonly inner: ProviderDriver) {}

  get name(): string {
    return this.inner.name;
  }

  create(name: string, tag?: string): Promise<ProviderVm> {
    return this.inner.create(name, tag);
  }

  list(name?: string): Promise<ProviderVm[]> {
    return this.inner.list(name);
  }

  destroy(vm: string): Promise<void> {
    return this.inner.destroy(vm);
  }

  expose(vm: string, port: number): Promise<string> {
    return this.inner.expose(vm, port);
  }

  setPublic(vm: string): Promise<void> {
    return this.inner.setPublic(vm);
  }

  whoami(): Promise<string> {
    return this.inner.whoami();
  }

  exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    this.execCalls.push({ vm, argv: [...argv], hadStdin: stdin !== undefined });
    return this.inner.exec(vm, argv, stdin);
  }

  copyFile(vm: string, remotePath: string, localPath: string): Promise<void> {
    return this.inner.copyFile(vm, remotePath, localPath);
  }
}
