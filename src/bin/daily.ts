#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { assertCliArgs } from './CliArgs.js';
import { buildDailyReport, localDateString, renderDailyReport } from '../daily/DailyReport.js';

function usage(): string {
  return [
    'Usage: cogmem daily [options]',
    '  --data <dir>    companion data dir (default: $COGMEM_DATA_DIR or ~/.cogmem/companion)',
    '  --db <path>     ledger path (default: <data>/memory.sqlite)',
    '  --trace <path>  shell trace (default: <data>/shell-events.jsonl)',
    '  --date <date>   local day YYYY-MM-DD (default: today)',
    '  --project <id>  restrict trace counts to one project',
    '  --out <path>    report path (default: <data>/daily/<date>.md)',
    'The report reads the ledger and trace only; it calls no model.',
  ].join('\n');
}

function parse(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const next = argv[index + 1];
    values.set(item.slice(2), !next || next.startsWith('--') ? 'true' : next);
    if (next && !next.startsWith('--')) index += 1;
  }
  return values;
}

function main(): void {
  assertCliArgs(process.argv.slice(2), { usage: usage() });
  const args = parse(process.argv.slice(2));
  const dataDir = resolve(args.get('data') ?? process.env.COGMEM_DATA_DIR ?? join(homedir(), '.cogmem', 'companion'));
  const dbPath = args.get('db') ?? join(dataDir, 'memory.sqlite');
  const tracePath = args.get('trace') ?? join(dirname(dbPath), 'shell-events.jsonl');
  const date = args.get('date') ?? localDateString();
  const projectId = args.get('project');
  const out = args.get('out') ?? join(dataDir, 'daily', `${date}.md`);
  const report = buildDailyReport({
    dataDir,
    dbPath,
    tracePath,
    date,
    ...(projectId ? { projectId } : {}),
  });
  const text = renderDailyReport(report);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${text}\n`, 'utf8');
  process.stdout.write(`${text}\n`);
  console.error(`daily: wrote ${out}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
