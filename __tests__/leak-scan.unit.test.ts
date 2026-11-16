import { describe, expect, test } from 'bun:test';

import {
  isTestServer,
  leakedServers,
  leakedUnits,
  parseObservatoryProcesses,
  parseTestUnits,
  runRootPid,
} from '../scripts/leak-scan.js';

/**
 * #244: the gate is only worth running if it can tell a leaked test server from a
 * developer's real resident and from another suite that is still running.
 */

const ps = [
  '  101 /usr/bin/node /srv/cogmem/dist/bin/observatory.js --port 7337',
  '  202 /home/me/.bun/bin/bun /tmp/cogmem-run-900/cogmem-cycle-a/install/node_modules/cogmem/src/bin/observatory.ts --port 1',
  '  303 bun /repo/.cogmem/tmp/cogmem-run-901/x/install/node_modules/cogmem/src/bin/observatory.ts',
  '  404 bun /tmp/cogmem-run-902/x/src/bin/observatory.ts',
  '  505 bun /repo/src/bin/doctor.ts',
  '  606 /bin/bash -c bun /tmp/cogmem-run-903/x/src/bin/observatory.ts',
].join('\n');

describe('recognising a test server', () => {
  test('only observatory processes are considered', () => {
    expect(parseObservatoryProcesses(ps).map((server) => server.pid)).toEqual([101, 202, 303, 404]);
  });

  test('a real resident and a repo checkout are not test servers', () => {
    expect(isTestServer('/srv/cogmem/dist/bin/observatory.js --port 7337')).toBe(false);
    expect(isTestServer('/tmp/cogmem-run-900/x/src/bin/observatory.ts')).toBe(true);
    expect(isTestServer('/repo/.cogmem/tmp/cogmem-run-901/x/src/bin/observatory.ts')).toBe(true);
    expect(runRootPid('/tmp/cogmem-run-902/x/src/bin/observatory.ts')).toBe(902);
  });
});

describe('what counts as leaked', () => {
  test('a live run root is another suite, a dead one is a leak', () => {
    const alive = (pid: number): boolean => pid === 900;
    expect(leakedServers(ps, alive).map((server) => server.pid)).toEqual([303, 404]);
  });

  test('a server with no run root in its args is still a test server', () => {
    const output = '  707 bun /repo/.cogmem/tmp/x/src/bin/observatory.ts';
    expect(leakedServers(output, () => true).map((server) => server.pid)).toEqual([707]);
  });
});

describe('transient units', () => {
  const units = [
    'cogmem-150-900-123456.service loaded active running Cogmem test unit',
    'cogmem-150-901-123456.service loaded active running Cogmem test unit',
    'cogmem-150-902-123456.service loaded inactive dead Cogmem test unit',
    'cogmem-companion.service loaded active running Cogmem companion',
  ].join('\n');

  test('only this suite\'s unit names are parsed', () => {
    expect(parseTestUnits(units).map((unit) => [unit.unit, unit.pid, unit.active])).toEqual([
      ['cogmem-150-900-123456.service', 900, true],
      ['cogmem-150-901-123456.service', 901, true],
      ['cogmem-150-902-123456.service', 902, false],
    ]);
  });

  test('an active unit whose test process is gone is a leak', () => {
    expect(leakedUnits(parseTestUnits(units), (pid) => pid === 900).map((unit) => unit.pid)).toEqual([901]);
  });
});
