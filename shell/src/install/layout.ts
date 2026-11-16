/**
 * Where the shell's entry points live.
 *
 * A source checkout keeps them under `shell/src`; the published package keeps emitted JavaScript
 * under `dist/shell` and ships no source at all (#287). Every path that used to be
 * `join(shellDir, 'src', …)` goes through here so the installer, the service unit and the upgrade
 * supervisor speak one layout in both places.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** A source shell home (`<checkout>/shell`) has `src/cli.ts`; an installed one does not. */
export function isSourceShell(home: string): boolean {
  return existsSync(join(home, 'src', 'cli.ts'));
}

/** The compiled shell home inside an installed `cogmem` package. */
export function isInstalledShell(home: string): boolean {
  return existsSync(join(home, 'dist', 'shell', 'cli.js'));
}

export function cliEntry(home: string): string {
  return isSourceShell(home) ? join(home, 'src', 'cli.ts') : join(home, 'dist', 'shell', 'cli.js');
}

export function cogEntry(home: string): string {
  return isSourceShell(home) ? join(home, 'src', 'cog.ts') : join(home, 'dist', 'shell', 'cog.js');
}

export function supervisorEntry(home: string): string {
  return isSourceShell(home) ? join(home, 'src', 'upgrade', 'supervisor.ts') : join(home, 'dist', 'shell', 'upgrade', 'supervisor.js');
}

/** The shell home that contains this module: `<checkout>/shell` or the installed package root. */
export function defaultShellHome(start: string): string {
  let dir = resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    if (isSourceShell(dir) || isInstalledShell(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start, '..', '..');
}
