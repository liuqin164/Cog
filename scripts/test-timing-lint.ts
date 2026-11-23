import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import * as ts from 'typescript';

const ROOT = process.cwd();
const TESTS = join(ROOT, '__tests__');
const LIMIT_MS = 50;

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function inLoop(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isForStatement(parent) || ts.isForOfStatement(parent) || ts.isForInStatement(parent)
      || ts.isWhileStatement(parent) || ts.isDoStatement(parent)
    ) return true;
  }
  return false;
}

function delayOf(node: ts.CallExpression): number | undefined {
  const delay = node.arguments[1];
  if (!delay || !ts.isNumericLiteral(delay)) return undefined;
  return Number(delay.text.replace(/_/g, ''));
}

export function findSlowWaits(root: string): string[] {
  const problems: string[] = [];
  for (const file of walk(root)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'setTimeout'
      ) {
        const delay = delayOf(node);
        if (delay !== undefined && delay <= LIMIT_MS && !inLoop(node)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          problems.push(`${relative(ROOT, file)}:${line + 1}: setTimeout(${delay}) waits on wall-clock`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return problems;
}

if (import.meta.main) {
  const problems = findSlowWaits(TESTS);
  if (problems.length > 0) {
    console.error('test-timing: FAILED');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log('test-timing: OK');
}
