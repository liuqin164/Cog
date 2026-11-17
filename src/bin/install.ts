#!/usr/bin/env bun
/**
 * `cogmem install`: the six-step companion installer, shipped in this package.
 *
 * It lives in the shell's install module, which is compiled to `dist/shell/install/installer.js` in
 * the published package. This shim only hands the process over, so the management dispatcher does
 * not take a source-tree dependency on the shell.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, '..', 'shell', 'install', 'installer.js');
const source = join(here, '..', '..', 'shell', 'src', 'install', 'installer.ts');
const entry = existsSync(built) ? built : source;

if (!existsSync(entry)) {
  process.stderr.write(`cogmem install: installer not found (looked for ${built} and ${source}); run \`bun run build\`\n`);
  process.exit(1);
}

const child = spawn(process.execPath, ['run', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', (error) => {
  process.stderr.write(`cogmem install: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
