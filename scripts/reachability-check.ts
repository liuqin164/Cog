import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\s*\(([\s\S]{0,500}?)\);/g;
const MODULE_URL_RE = /new URL\(\s*['"]([^'"]+)['"]/g;

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && SOURCE_EXTENSIONS.includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(from), specifier.split('?')[0]!);
  const candidates = [base, base.replace(/\.js$/u, '.ts'), base.replace(/\.js$/u, '.tsx'), join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

const binEntries = readdirSync(join(ROOT, 'src/bin'))
  .filter((file) => SOURCE_EXTENSIONS.includes(extname(file)))
  .map((file) => join(ROOT, 'src/bin', file));
const entries = [
  join(ROOT, 'src/public.ts'),
  join(ROOT, 'src/internal.ts'),
  ...binEntries,
  join(ROOT, 'shell/src/cog.ts'),
  join(ROOT, 'shell/src/cli.ts'),
  join(ROOT, 'shell/src/embedding/worker.ts'),
  join(ROOT, 'shell/src/embedding/remote-worker.ts'),
  join(ROOT, 'shell/src/install/doctor-cli.ts'),
  join(ROOT, 'shell/src/plugins/web.ts'),
  join(ROOT, 'shell/src/upgrade/supervisor.ts'),
  join(ROOT, 'shell/bin/install'),
].filter((file) => existsSync(file));

const reachable = new Set<string>();
const queue = [...entries];
while (queue.length > 0) {
  const file = queue.pop()!;
  if (reachable.has(file)) continue;
  reachable.add(file);
  const source = readFileSync(file, 'utf8');
  const specifiers = [...source.matchAll(IMPORT_RE)].map((match) => match[1]!);
  for (const call of source.matchAll(DYNAMIC_RE)) {
    for (const quoted of call[1]!.matchAll(/['"](\.[^'"]+)['"]/g)) specifiers.push(quoted[1]!);
  }
  for (const match of source.matchAll(MODULE_URL_RE)) specifiers.push(match[1]!);
  for (const specifier of specifiers) {
    const resolved = resolveImport(file, specifier);
    if (resolved && !reachable.has(resolved)) queue.push(resolved);
  }
}

const productFiles = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'shell/src')),
].filter((file) => !file.includes(`${join(ROOT, 'src', 'observatory', 'web')}`));

const unreachable = productFiles
  .filter((file) => !reachable.has(file))
  .map((file) => relative(ROOT, file).split('\\').join('/'))
  .sort();

if (unreachable.length > 0) {
  console.error('reachability: FAILED');
  for (const file of unreachable) console.error(`  unreachable: ${file}`);
  process.exit(1);
}

console.log(`reachability: OK — ${productFiles.length} files reachable from ${entries.length} entries`);
