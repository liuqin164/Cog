import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installPathSteps,
  isOnPath,
  pathWarningSteps,
  resolveCliBinDir,
  type InstallStep,
} from '../src/install/InstallSteps.js';
import { makeTempDir } from './helpers/tmp.js';

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const doctorBin = join(coreRoot, 'src/bin/doctor.ts');

// The CLI under test must be reachable even when a case narrows PATH, so the
// directory holding this Bun binary is always kept on it.
const BUN_DIR = dirname(process.execPath);

function run(cmd: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const env = { ...process.env, NO_COLOR: '1', ...options.env };
  env.PATH = [BUN_DIR, env.PATH].filter(Boolean).join(':');
  const proc = Bun.spawn({
    cmd,
    cwd: options.cwd ?? coreRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
}

test('the installed layout is recognised, so the gate cannot report OK off PATH', () => {
  const home = makeTempDir('cogmem-bin-dir-');
  const shimDir = join(home, 'node_modules', '.bin');
  const pkgBin = join(home, 'node_modules', 'cogmem', 'dist', 'bin');
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(pkgBin, { recursive: true });
  writeFileSync(join(shimDir, 'cogmem'), '#!/bin/sh\n');
  writeFileSync(join(pkgBin, 'cogmem.js'), '// dispatcher\n');

  // What Bun actually reports as argv[1] when the launcher resolves the shim.
  // Reporting `ok` here would be a silent success on a machine where `cogmem`
  // does not resolve at all, which is the failure this covers.
  expect(resolveCliBinDir(join(pkgBin, 'cogmem.js'), { PATH: '/usr/bin:/bin' })).toBe(shimDir);
  // A source checkout is still not an installed layout.
  expect(resolveCliBinDir('src/bin/doctor.ts', { PATH: '/usr/bin:/bin' })).toBeUndefined();
  rmSync(home, { recursive: true, force: true });
});
describe('install step shape', () => {
  test('every step names exactly one actor and only agent steps are automation-safe', () => {
    const steps: InstallStep[] = [
      ...installPathSteps('cogmem'),
      ...pathWarningSteps('/opt/bin'),
    ];
    for (const step of steps) {
      expect(['agent', 'operator', 'host']).toContain(step.actor);
      expect(step.id.length).toBeGreaterThan(0);
      expect(step.command.length).toBeGreaterThan(0);
      expect(step.when.length).toBeGreaterThan(0);
      expect(step.purpose.length).toBeGreaterThan(0);
      if (step.actor !== 'agent') expect(step.safeForAutomation).toBe(false);
    }
  });

  test('the companion installer is the one setup step', () => {
    const steps = installPathSteps('/opt/bin/cogmem');
    const operator = steps.find((step) => step.id === 'companion_install');
    expect(operator?.actor).toBe('operator');
    expect(operator?.safeForAutomation).toBe(false);
    expect(operator?.command).toBe('/opt/bin/cogmem install');
    expect(steps.some((step) => step.command.includes('doctor'))).toBe(true);
  });

  test('the bin directory is only inferred from an installed layout', () => {
    expect(resolveCliBinDir('/home/u/.bun/bin/cogmem', {})).toBe('/home/u/.bun/bin');
    expect(resolveCliBinDir('/home/u/proj/node_modules/.bin/cogmem', {})).toBe('/home/u/proj/node_modules/.bin');
    expect(resolveCliBinDir('/home/u/proj/src/bin/doctor.ts', {})).toBeUndefined();
    expect(resolveCliBinDir(undefined, {})).toBeUndefined();
    expect(resolveCliBinDir('/home/u/proj/src/bin/doctor.ts', { COGMEM_BIN_DIR: '/opt/bin' })).toBe('/opt/bin');
  });

  test('finds the installed launcher when argv1 is the symlink target', () => {
    const dir = makeTempDir('cogmem-launcher-path-');
    const binDir = join(dir, 'bin');
    const launcher = join(dir, 'package', 'dist', 'bin', 'cogmem.js');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, '#!/usr/bin/env bun\n');
    symlinkSync(launcher, join(binDir, 'cogmem'));
    expect(resolveCliBinDir(launcher, { PATH: binDir })).toBe(binDir);
  });

  test('PATH membership compares resolved directories', () => {
    expect(isOnPath('/usr/local/bin', { PATH: '/usr/bin:/usr/local/bin' })).toBe(true);
    expect(isOnPath('/opt/bin', { PATH: '/usr/bin:/usr/local/bin' })).toBe(false);
    expect(isOnPath('/opt/bin', { PATH: '' })).toBe(false);
  });
});

describe('the install gate answers four outcomes', () => {
  test('with no companion install it reports not installed and exits 0', async () => {
    const home = makeTempDir('cogmem-gate-missing-');
    const cwd = makeTempDir('cogmem-gate-cwd-');
    const { stdout, stderr, exitCode } = await run([process.execPath, doctorBin, '--json'], {
      cwd,
      env: { HOME: home, COGMEM_BIN_DIR: join(home, 'bin') },
    });
    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.installGate.level).toBe('not_installed');
    expect(parsed.installGate.exitCode).toBe(0);
    expect(parsed.nextSteps.length).toBeGreaterThan(0);
    expect(parsed.nextSteps.some((step: InstallStep) => step.actor === 'operator')).toBe(true);
    expect(parsed.nextSteps.some((step: InstallStep) => step.actor === 'agent')).toBe(true);
    expect(parsed.installGate.diagnostics[0].code).toBe('missing_install');
  });

  test('text mode lists the same commands as JSON, in the same order', async () => {
    const home = makeTempDir('cogmem-gate-text-');
    const cwd = makeTempDir('cogmem-gate-text-cwd-');
    const env = { HOME: home, COGMEM_BIN_DIR: join(home, 'bin') };
    const asJson = await run([process.execPath, doctorBin, '--json'], { cwd, env });
    const asText = await run([process.execPath, doctorBin], { cwd, env });
    const steps = JSON.parse(asJson.stdout).nextSteps as InstallStep[];
    let cursor = -1;
    for (const step of steps) {
      const at = asText.stdout.indexOf(step.command, cursor + 1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(asText.exitCode).toBe(asJson.exitCode);
  });

  test('a CLI directory outside PATH is a WARN with the exact export line', async () => {
    const dir = makeTempDir('cogmem-gate-path-');
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'cogmem'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const { stdout, exitCode } = await run([process.execPath, doctorBin, '--json'], {
      env: { COGMEM_BIN_DIR: binDir, PATH: '/usr/bin:/bin', HOME: dir },
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.installGate.level).toBe('not_installed');
    expect(parsed.installGate.diagnostics.some((d: { code: string }) => d.code === 'cli_not_on_path')).toBe(true);
    const fixPath = parsed.nextSteps.find((step: InstallStep) => step.id === 'fix_path');
    expect(fixPath.actor).toBe('operator');
    expect(fixPath.command).toBe('export PATH="' + binDir + ':$PATH"');
    const absolute = parsed.nextSteps.find((step: InstallStep) => step.id === 'use_absolute_bin');
    expect(absolute.actor).toBe('agent');
    expect(absolute.command).toContain(binDir);
  });
});
