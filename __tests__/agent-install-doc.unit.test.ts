import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/**
 * The install guide is written for an agent that cannot check it. Every `cogmem <subcommand>` in it
 * must exist, and the list of commands comes from the CLI's own help — the single source — rather than
 * from a table copied into this file, which would drift the day a command is renamed.
 */
test('every cogmem subcommand the agent install guide names really exists', () => {
  const doc = readFileSync(join(root, 'docs', 'agent-install.md'), 'utf8');
  const help = spawnSync('bun', [join(root, 'src', 'bin', 'cogmem.ts'), '--help'], { encoding: 'utf8' }).stdout;
  const commands = new Set([...help.matchAll(/^ {2}([a-z][a-z-]+)/gm)].map((match) => match[1]));
  expect(commands.size).toBeGreaterThan(10);
  // Commands live in code: fenced blocks and inline spans. Prose is allowed to say "cogmem with …
  // another host", so scanning the whole file would report English as a missing subcommand.
  const code = [...doc.matchAll(/```[\s\S]*?```/g), ...doc.matchAll(/`[^`\n]+`/g)].map((match) => match[0]).join('\n');
  const offenders: string[] = [];
  for (const match of code.matchAll(/cogmem ([a-z][a-z-]+)/g)) {
    if (!commands.has(match[1])) offenders.push(`${match[1]} in "${match[0]}"`);
  }
  expect(offenders).toEqual([]);
});

test('the README points an agent at this document, and the package ships it', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  expect(readme).toContain('https://github.com/liuqin164/Cog/blob/main/docs/agent-install.md');
  expect(readme).toContain('docs/agent-install.md');
  expect(existsSync(join(root, 'docs', 'agent-install.md'))).toBe(true);
  const files = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] }).files;
  expect(files).toContain('docs/agent-install.md');
  // The README stayed a landing page: no version wording crept in with the pointer.
  expect(readme).not.toMatch(/\b4\.0\.0\b|\bversion 4\b/i);
});

/**
 * `cogmem install` is a shim over the shell installer, so `src/bin/install.ts` has no usage text of
 * its own. The installer's `INSTALL_USAGE` is the exact text `cogmem install --help` prints; reading
 * it here keeps the guard offline and on the same source the command uses.
 */
function installUsage(): string {
  const source = readFileSync(join(root, 'shell', 'src', 'install', 'installer.ts'), 'utf8');
  return /export const INSTALL_USAGE = \[([\s\S]*?)\]\.join\('\\n'\)/.exec(source)?.[1] ?? '';
}

function installFlags(text: string): Set<string> {
  return new Set([...text.matchAll(/--([a-z][a-z0-9-]*)/g)].map((match) => match[1]!));
}

/**
 * Flags on a `cogmem install` command and its `\` continuations. Scanning a whole block would catch
 * `npm install --save` beside the command and report a flag the installer never takes.
 */
function installCommandFlags(text: string): Set<string> {
  const flags = new Set<string>();
  for (const block of text.matchAll(/```[\s\S]*?```/g)) {
    const lines = block[0].split('\n');
    const start = lines.findIndex((line) => /^\s*(?:\.\/node_modules\/\.bin\/)?cogmem install\b/.test(line));
    if (start === -1) continue;
    for (let index = start; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (index > start && !/^\s+--/.test(line)) break;
      for (const match of line.matchAll(/--([a-z][a-z0-9-]*)/g)) flags.add(match[1]!);
      if (!line.trimEnd().endsWith('\\')) break;
    }
  }
  return flags;
}

test('the agent install guide runs the companion installer, not the kernel init wizard', () => {
  const doc = readFileSync(join(root, 'docs', 'agent-install.md'), 'utf8');
  expect(doc).toContain('cogmem install');
  expect(doc).not.toContain('cogmem init --yes');

  const blocks = [...doc.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]).filter((block) => /\bcogmem install\b/.test(block));
  expect(blocks.length).toBeGreaterThan(0);
  // The installer is the only install step: the kernel wizard must not appear in a command block.
  expect(blocks.join('\n')).not.toMatch(/\bcogmem init\b/);

  const allowed = installFlags(installUsage());
  expect(allowed.size).toBeGreaterThan(5);
  const shown = installCommandFlags(doc);
  expect(shown.size).toBeGreaterThan(3);
  expect([...shown].filter((flag) => !allowed.has(flag))).toEqual([]);
});

test('the agent guide and the README show the same unattended installer flags', () => {
  const doc = readFileSync(join(root, 'docs', 'agent-install.md'), 'utf8');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const allowed = installFlags(installUsage());
  for (const text of [doc, readme]) {
    expect([...installCommandFlags(text)].filter((flag) => !allowed.has(flag))).toEqual([]);
  }
  // The unattended route is one command, not two paraphrases of it.
  for (const text of [doc, readme]) {
    expect(text).toContain('--provider openai_compatible');
    expect(text).toContain('--base-url https://api.example.com/openai');
    expect(text).toContain('--model your-model');
  }
});
