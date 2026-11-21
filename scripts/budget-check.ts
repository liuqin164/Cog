import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import * as ts from 'typescript';
import { FINAL_AUXILIARY_OBJECTS, FINAL_TABLES } from '../src/migrations/v3_7_4/FinalSchemaDefinition.ts';
import { STATES } from '../shell/src/state/table.ts';
import { assignmentPlugin } from '../shell/src/plugins/assignment.ts';
import { askPlugin } from '../shell/src/plugins/ask.ts';
import { builtinToolsPlugin } from '../shell/src/plugins/builtin-tools.ts';
import { memoryToolPlugin } from '../shell/src/plugins/memory-tool.ts';
import { proposalPlugin } from '../shell/src/plugins/proposal.ts';
import { selfInstallPlugin } from '../shell/src/plugins/self-install.ts';
import { soulEditPlugin } from '../shell/src/plugins/soul-edit.ts';

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.html']);
const EXTRA_FILES = ['install.sh', 'shell/bin/install'];
const BUDGET = JSON.parse(readFileSync(join(ROOT, 'freeze-budget.json'), 'utf8')) as {
  lines: Record<string, number>;
  tools: number;
  commands: number;
  states: number;
  tables: number;
  exportSymbols: number;
};

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test') continue;
      files.push(...sourceFiles(path));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) && entry.name !== 'three.bundle.js') {
      files.push(path);
    }
  }
  return files;
}

function areaFor(path: string): string {
  if (path === 'install.sh') return 'install.sh';
  if (path === 'shell/bin/install') return 'shell/bin';
  const parts = path.split('/');
  if (parts[0] === 'src') return parts.length > 2 ? `src/${parts[1]}` : 'src';
  return parts.length > 3 ? `shell/src/${parts[2]}` : 'shell/src';
}

function lineCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  const files = [
    ...sourceFiles(join(ROOT, 'src')),
    ...sourceFiles(join(ROOT, 'shell/src')),
    ...EXTRA_FILES.map((file) => join(ROOT, file)),
  ];
  for (const file of files) {
    const area = areaFor(relative(ROOT, file).split('\\').join('/'));
    const lines = readFileSync(file, 'utf8').split('\n').length - 1;
    counts[area] = (counts[area] ?? 0) + lines;
  }
  return counts;
}

function toolCount(): number {
  const names = new Set<string>();
  const context = {
    registerTool(definition: { name: string }) {
      names.add(definition.name);
    },
    getService() {
      return {};
    },
    provide() {},
  };
  const plugins = [
    builtinToolsPlugin(),
    proposalPlugin(),
    askPlugin(),
    assignmentPlugin(),
    memoryToolPlugin({ agentId: 'budget', projectId: 'budget', sessionId: 'budget' }),
    soulEditPlugin(),
    selfInstallPlugin({ proposals: undefined as never, admin: undefined as never, trace: undefined as never }),
  ];
  for (const plugin of plugins) plugin.apply(context as never, { workspaceRoot: ROOT });
  return names.size;
}

function commandCount(): number {
  const source = readFileSync(join(ROOT, 'shell/src/commands.ts'), 'utf8');
  const start = source.indexOf('export const CORE_COMMANDS');
  const end = source.indexOf('\n];', start);
  return [...source.slice(start, end).matchAll(/^    name: '([^']+)',$/gm)].length;
}

function tableCount(): number {
  return [...FINAL_TABLES, ...FINAL_AUXILIARY_OBJECTS].filter((object) => object.type === 'table').length;
}

function exportSymbolCount(): number {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('freeze-budget: tsconfig.json not found');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ts.getDirectoryPath(configPath));
  const entry = join(ROOT, 'src/public.ts');
  const program = ts.createProgram([entry], parsed.options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  const symbol = source ? checker.getSymbolAtLocation(source) : undefined;
  if (!symbol) throw new Error('freeze-budget: src/public.ts has no module symbol');
  return checker.getExportsOfModule(symbol).length;
}

const measured = {
  lines: lineCounts(),
  tools: toolCount(),
  commands: commandCount(),
  states: STATES.length,
  tables: tableCount(),
  exportSymbols: exportSymbolCount(),
};

const problems: string[] = [];

for (const [area, cap] of Object.entries(BUDGET.lines)) {
  if (!(area in measured.lines)) problems.push(`stale area: ${area} has cap ${cap} but no source files`);
}

for (const [area, lines] of Object.entries(measured.lines)) {
  const cap = BUDGET.lines[area];
  if (typeof cap !== 'number') problems.push(`missing cap: ${area} has ${lines} lines`);
  else if (lines > cap) problems.push(`over cap: ${area} has ${lines} lines, cap ${cap}`);
}

for (const metric of ['tools', 'commands', 'states', 'tables', 'exportSymbols'] as const) {
  const cap = BUDGET[metric];
  if (typeof cap !== 'number') problems.push(`missing cap: ${metric}`);
  else if (measured[metric] > cap) problems.push(`over cap: ${metric} is ${measured[metric]}, cap ${cap}`);
}

if (problems.length > 0) {
  console.error('freeze-budget: FAILED');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

const totalLines = Object.values(measured.lines).reduce((sum, lines) => sum + lines, 0);
console.log(
  `freeze-budget: OK — ${Object.keys(measured.lines).length} areas / ${totalLines} lines, `
  + `${measured.tools} tools, ${measured.commands} commands, ${measured.states} states, `
  + `${measured.tables} tables, ${measured.exportSymbols} export symbols`,
);
