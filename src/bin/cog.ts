#!/usr/bin/env bun
/**
 * The product's own entry point: `cog`.
 *
 * `cog` is the companion itself: it attaches to the resident shell (or starts it) and opens the
 * terminal interface. The management surface — doctor, update, observatory, … — stays on `cogmem`.
 * This file is only the handoff; the shell entry ships at `dist/shell/cog.js` in the same package.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KNOWN_FLAGS = new Set(['headless', 'help', 'workspace', 'data', 'db', 'project', 'agent', 'http-port', 'no-http']);
for (const token of process.argv.slice(2)) {
  if (!token.startsWith('--')) continue;
  const name = token.slice(2).split('=')[0]!;
  if (!KNOWN_FLAGS.has(name)) {
    process.stderr.write(`cog: unknown flag --${name}\n`);
    process.exit(1);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const built = join(here, '..', 'shell', 'cog.js');
const source = join(here, '..', '..', 'shell', 'src', 'cog.ts');
const entry = existsSync(built) ? built : source;

if (!existsSync(entry)) {
  process.stderr.write(`cog: companion shell not found (looked for ${built} and ${source}); run \`bun run build\`\n`);
  process.exit(1);
}

const child = spawn(process.execPath, ['run', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('error', (error) => {
  process.stderr.write(`cog: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
