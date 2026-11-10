import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A worker killed with SIGKILL cannot run its exit hook; sweep its leftovers before this run starts.
const root = tmpdir();
if (existsSync(root)) {
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('companion-shell-test-') || entry.startsWith('companion-kill-') || entry.startsWith('pi-channel-') || entry.startsWith('pi-detach-')) {
      rmSync(join(root, entry), { recursive: true, force: true });
    }
  }
}
