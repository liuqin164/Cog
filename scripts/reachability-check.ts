import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const API_ENTRY = 'src/public.ts';
const BIN_ENTRIES = [
  'src/bin/backup.ts',
  'src/bin/cog.ts',
  'src/bin/cogmem.ts',
  'src/bin/daily.ts',
  'src/bin/doctor.ts',
  'src/bin/dream.ts',
  'src/bin/episode.ts',
  'src/bin/import.ts',
  'src/bin/install.ts',
  'src/bin/memory.ts',
  'src/bin/normalize-transcript.ts',
  'src/bin/observatory.ts',
  'src/bin/prospective.ts',
  'src/bin/repair.ts',
  'src/bin/snapshot.ts',
  'src/bin/version-check-refresh.ts',
];
const SHELL_ENTRIES = [
  'shell/bin/install',
  'shell/src/cog.ts',
  'shell/src/cli.ts',
  'shell/src/embedding/remote-worker.ts',
  'shell/src/embedding/worker.ts',
  'shell/src/install/doctor-cli.ts',
  'shell/src/plugins/web.ts',
  'shell/src/upgrade/supervisor.ts',
];

interface ImportUse {
  module: string;
  names: string[] | null;
  typeOnly: boolean;
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test') continue;
      files.push(...walk(path));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function parseOptions(): ts.CompilerOptions {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('reachability: tsconfig.json not found');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)).options;
}

const productFiles = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'shell/src')),
].filter((file) => !file.includes(join(ROOT, 'src', 'observatory', 'web')))
  .map((file) => resolve(file));
const options = parseOptions();
const program = ts.createProgram(productFiles, options);
const checker = program.getTypeChecker();

function targetFile(symbol: ts.Symbol, valuesOnly = true): string | undefined {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  if (valuesOnly && !(target.flags & ts.SymbolFlags.Value)) return undefined;
  const declaration = target.declarations?.find((node) => !node.getSourceFile().fileName.endsWith('.d.ts'));
  return declaration ? resolve(declaration.getSourceFile().fileName) : undefined;
}

function moduleSymbol(file: string): ts.Symbol | undefined {
  const source = program.getSourceFile(file);
  return source ? checker.getSymbolAtLocation(source) : undefined;
}

function exportFiles(file: string, valuesOnly = true): string[] {
  const symbol = moduleSymbol(file);
  if (!symbol) return [];
  return checker.getExportsOfModule(symbol).flatMap((exported) => {
    const target = targetFile(exported, valuesOnly);
    return target ? [target] : [];
  });
}

function resolveSpecifier(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const resolved = ts.resolveModuleName(specifier, from, options, ts.sys).resolvedModule?.resolvedFileName;
  return resolved ? resolve(resolved) : undefined;
}

function targetsFor(moduleFile: string, names: string[] | null, valuesOnly = true): string[] {
  if (names === null) return [moduleFile, ...exportFiles(moduleFile, valuesOnly)];
  if (names.length === 0) return [moduleFile];
  const symbol = moduleSymbol(moduleFile);
  if (!symbol) return [];
  const files = names.flatMap((name) => {
    const exported = checker.getExportsOfModule(symbol).find((candidate) => candidate.name === name);
    const target = exported ? targetFile(exported, valuesOnly) : undefined;
    return target ? [target] : [];
  });
  return files.length === 0 ? [] : [moduleFile, ...files];
}

function sourceOf(file: string): ts.SourceFile {
  return program.getSourceFile(file)
    ?? ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function literalModules(node: ts.Node): string[] {
  if (ts.isStringLiteral(node)) return [node.text];
  const modules: string[] = [];
  ts.forEachChild(node, (child) => {
    modules.push(...literalModules(child));
  });
  return modules;
}

function exportModules(file: string, valuesOnly = true): string[] {
  const modules: string[] = [];
  for (const statement of sourceOf(file).statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    if (valuesOnly && statement.isTypeOnly) continue;
    if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      modules.push(statement.moduleSpecifier.text);
    }
  }
  return modules;
}

export function usesIn(file: string): ImportUse[] {
  const source = sourceOf(file);
  const uses: ImportUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (!clause) uses.push({ module: node.moduleSpecifier.text, names: [], typeOnly: false });
      else {
        const specifier = node.moduleSpecifier.text;
        if (clause.name) uses.push({ module: specifier, names: ['default'], typeOnly: clause.isTypeOnly });
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          uses.push({ module: specifier, names: null, typeOnly: clause.isTypeOnly });
        } else if (bindings && ts.isNamedImports(bindings)) {
          const split = (typeOnly: boolean): ImportUse | undefined => {
            const names = bindings.elements
              .filter((element) => element.isTypeOnly === typeOnly)
              .map((element) => (element.propertyName ?? element.name).text);
            return names.length > 0 ? { module: specifier, names, typeOnly: typeOnly || clause.isTypeOnly } : undefined;
          };
          for (const use of [split(false), split(true)]) if (use) uses.push(use);
        }
      }
    } else if (ts.isCallExpression(node) && node.arguments[0]) {
      const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (dynamic || required) {
        for (const module of literalModules(node.arguments[0])) uses.push({ module, names: null, typeOnly: false });
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const argument = node.arguments?.[0];
      if (argument) for (const module of literalModules(argument)) uses.push({ module, names: [], typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

function reach(entries: string[], valuesOnly = true): Set<string> {
  const entrySet = new Set(entries.map((entry) => resolve(entry)));
  const reachable = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = resolve(queue.pop()!);
    if (reachable.has(file)) continue;
    reachable.add(file);
    if (entrySet.has(file)) {
      queue.push(...exportFiles(file, valuesOnly));
      for (const specifier of exportModules(file, valuesOnly)) {
        const moduleFile = resolveSpecifier(file, specifier);
        if (moduleFile) queue.push(moduleFile, ...exportFiles(moduleFile, valuesOnly));
      }
    }
    for (const use of usesIn(file)) {
      if (valuesOnly && use.typeOnly) continue;
      const moduleFile = resolveSpecifier(file, use.module);
      if (moduleFile) queue.push(...targetsFor(moduleFile, use.names, valuesOnly));
    }
  }
  return reachable;
}

export interface ReachabilityResult {
  product: Set<string>;
  apiOnly: string[];
  typeOnly: string[];
  unregistered: string[];
  stale: string[];
  entries: string[];
}

export function evaluateReachability(options: { apiOnly?: string[] } = {}): ReachabilityResult {
  const entries = [...BIN_ENTRIES, ...SHELL_ENTRIES];
  const product = reach(entries);
  const api = reach([API_ENTRY]);
  const type = reach([...entries, API_ENTRY], false);
  const apiOnly = [...api]
    .filter((file) => !product.has(file))
    .map((file) => relative(ROOT, file).split('\\').join('/'))
    .sort();
  const typeOnly = [...type]
    .filter((file) => !product.has(file) && !api.has(file))
    .map((file) => relative(ROOT, file).split('\\').join('/'))
    .sort();
  const registered = options.apiOnly ?? (
    JSON.parse(readFileSync(join(ROOT, 'freeze-budget.json'), 'utf8')) as { apiOnly?: string[] }
  ).apiOnly ?? [];
  return {
    product,
    apiOnly,
    typeOnly,
    unregistered: apiOnly.filter((file) => !registered.includes(file)),
    stale: registered.filter((file) => !apiOnly.includes(file)),
    entries,
  };
}

function main(): void {
  const result = evaluateReachability();
  const reachable = new Set([...result.product].map((file) => relative(ROOT, file).split('\\').join('/')));
  const unreachable = productFiles
    .map((file) => relative(ROOT, file).split('\\').join('/'))
    .filter((file) => !reachable.has(file) && !result.apiOnly.includes(file) && !result.typeOnly.includes(file));
  const problems = [
    ...result.unregistered.map((file) => `unregistered api-only: ${file}`),
    ...result.stale.map((file) => `stale api-only registration: ${file}`),
    ...unreachable.map((file) => `unreachable: ${file}`),
  ];
  if (problems.length > 0) {
    console.error('reachability: FAILED');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(
    `reachability: OK — ${productFiles.length} files reachable from `
    + `${result.entries.length} product entries, ${result.apiOnly.length} api-only`,
  );
}

if (import.meta.main) main();
