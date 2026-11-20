import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const LEGACY_TEMP_PREFIXES = [
  'assignment-findings-',
  'assignment-findings-long-',
  'auto-expand-assistant-',
  'auto-expand-hit-',
  'auto-expand-miss-',
  'cli-config-',
  'cli-config-read-',
  'companion-context-share-',
  'companion-kill-',
  'companion-probe-',
  'companion-shell-baseline-',
  'companion-shell-test-',
  'companion-soak-',
  'companion-soak-clock-',
  'continuity-a1-',
  'continuity-a1-bound-',
  'continuity-a1-budget-',
  'continuity-a2-',
  'continuity-a2-end-',
  'continuity-a2-start-',
  'continuity-a3-',
  'continuity-b1-',
  'face-csrf-',
  'face-notoken-',
  'face-rebind-',
  'face-token-',
  'lanes-budget-',
  'lanes-faces-',
  'lanes-order-',
  'lanes-ruling-',
  'lanes-stub-keys-',
  'mem-read-',
  'mem-read-big-',
  'mem-read-file-',
  'mem-read-missing-',
  'mem-read-model-',
  'mem-read-write-',
  'memory-lane-prompt-',
  'memory-prompt-',
  'memory-recall-key-',
  'memory-remember-',
  'memory-restart-',
  'native-install-',
  'native-install-again-',
  'native-install-failed-',
  'native-install-invalid-',
  'native-install-restart-',
  'native-install-resume-',
  'pi-channel-',
  'pi-detach-',
  'self-change-broken-apply-',
  'self-change-broken-import-',
  'self-change-full-',
  'self-change-snapshot-',
  'self-change-toxic-',
  'self-change-unapproved-',
  'task-exit-',
  'task-exit-counter-',
  'task-exit-protected-',
  'task-procedure-',
  'task-procedure-empty-',
  'task-procedure-lane-',
  'task-procedure-lane-budget-',
  'task-procedure-replay-',
  'tool-mount-plain-',
  'tool-mount-web-',
] as const;

export function sweepLegacyTempDirs(root: string, startedAt: number): number {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!LEGACY_TEMP_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
    const path = join(root, entry);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.mtimeMs >= startedAt) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return removed;
}
