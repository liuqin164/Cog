import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

// #296: tests here spawn `bun` by name. A suite started from an absolute bun path
// without bun on PATH would make those children fail for an environment reason, so
// the running binary is put first once, for the whole shell suite.
process.env.PATH = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);

// A worker killed with SIGKILL cannot run its exit hook; sweep its leftovers before this run starts.
// The prefix list has to cover every prefix `makeTempDir` is called with, or that family accumulates
// one directory per run (the `companion-probe-` family did, one per probe test invocation).
const ROOTS = ['companion-shell-test-', 'companion-shell-baseline-', 'companion-kill-', 'companion-probe-', 'companion-soak-', 'pi-channel-', 'pi-detach-'];
const root = tmpdir();
if (existsSync(root)) {
  for (const entry of readdirSync(root)) {
    if (ROOTS.some((prefix) => entry.startsWith(prefix))) rmSync(join(root, entry), { recursive: true, force: true });
  }
}
