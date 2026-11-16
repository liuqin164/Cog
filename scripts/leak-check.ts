/**
 * Fail when a test run left an observatory server or a systemd transient unit
 * behind (#244).
 *
 * Run after the suites, not inside one: a test file cannot assert about the whole
 * run, and a leak that is cleaned by the next file's preload would still be a leak.
 *
 *     bun run leak:check
 *
 * A server whose `cogmem-run-<pid>` root is still alive belongs to another suite
 * that is running right now, so it is not a leak. `COGMEM_LEAK_BASELINE` takes a
 * comma-separated pid list to ignore stock that predates this run.
 */
import { leakedServers, leakedUnits, parseTestUnits, readProcessTable, readUserUnits } from './leak-scan.js';

const baseline = new Set(
  (process.env.COGMEM_LEAK_BASELINE ?? '')
    .split(/[\s,]+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0),
);

const servers = leakedServers(readProcessTable()).filter((server) => !baseline.has(server.pid));
const units = leakedUnits(parseTestUnits(readUserUnits())).filter((unit) => !baseline.has(unit.pid));

if (servers.length === 0 && units.length === 0) {
  console.log('leak:check — no test server or transient unit left behind');
  process.exit(0);
}

for (const server of servers) console.error(`leak:check — server pid ${server.pid}: ${server.args}`);
for (const unit of units) console.error(`leak:check — transient unit ${unit.unit} (test pid ${unit.pid}) is still active`);
console.error(`leak:check — ${servers.length} server(s) and ${units.length} unit(s) leaked`);
process.exit(1);
