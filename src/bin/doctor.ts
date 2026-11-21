#!/usr/bin/env bun
/**
 * `cogmem doctor`: the shell's install gate.
 *
 * The shell doctor owns the checks; this file only hands the process over so the
 * management dispatcher does not take a source-tree dependency on the shell.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, '..', 'shell', 'install', 'doctor-cli.js');
const source = join(here, '..', '..', 'shell', 'src', 'install', 'doctor-cli.ts');
const entry = existsSync(built) ? built : source;

if (!existsSync(entry)) {
  process.stderr.write(`cogmem doctor: shell doctor not found (looked for ${built} and ${source}); run \`bun run build\`\n`);
  process.exit(1);
}

const child = spawn(process.execPath, ['run', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', (error) => {
  process.stderr.write(`cogmem doctor: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
