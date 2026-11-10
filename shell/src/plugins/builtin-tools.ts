/**
 * The four basic tools, as a plugin with no more privilege than a third-party one.
 *
 * Every tool validates its input at the trust boundary (path inside the workspace, output capped,
 * command timeout) and every output is returned as text for the capture path to redact and mark.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { NativePlugin, ToolDefinition } from './host.ts';

const MAX_READ_BYTES = 256 * 1024;
const MAX_OUTPUT_CHARS = 32 * 1024;
const BASH_TIMEOUT_MS = 30_000;
const BASH_OUTPUT_DIR = '.cogmem-shell/bash-output';

export interface BuiltinToolsConfig {
  workspaceRoot: string;
}

function inside(root: string, candidate: string): string {
  const resolved = resolve(root, candidate);
  const rootResolved = resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    throw new Error(`path_outside_workspace: ${candidate}`);
  }
  return resolved;
}

function asString(args: unknown, key: string, required = true): string {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string' || (required && value.length === 0)) throw new Error(`invalid_arguments: "${key}" must be a non-empty string`);
  return value;
}

/**
 * Cap the text for the model; when it was cut, keep the whole thing inside the workspace and say
 * where (Pi's bash `truncated` + `fullOutputPath`). The path is workspace-relative so the model can
 * hand it straight to `read`. A failed write still returns the capped text and says so — the command
 * did run, and losing the tail is not a reason to lose the result.
 */
function capWithPointer(text: string, workspaceRoot: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = `${text.slice(0, MAX_OUTPUT_CHARS)}\n`;
  const full = join(workspaceRoot, BASH_OUTPUT_DIR, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.log`);
  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `${head}[truncated ${text.length - MAX_OUTPUT_CHARS} chars; full output could not be written: ${message}]`;
  }
  return `${head}[truncated ${text.length - MAX_OUTPUT_CHARS} chars; full output: ${relative(workspaceRoot, full)}]`;
}

function definitions(workspaceRoot: string): ToolDefinition[] {
  return [
    {
      name: 'read',
      description: 'Read a UTF-8 text file inside the workspace. Output is capped at 256 KiB.',
      replay: 'safe',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute({ args }) {
        const path = inside(workspaceRoot, asString(args, 'path'));
        const size = statSync(path).size;
        if (size > MAX_READ_BYTES) throw new Error(`file_too_large: ${size} bytes (cap ${MAX_READ_BYTES})`);
        return readFileSync(path, 'utf8');
      },
    },
    {
      name: 'write',
      description: 'Write a UTF-8 text file inside the workspace, creating parent directories.',
      replay: 'never',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      execute({ args }) {
        const path = inside(workspaceRoot, asString(args, 'path'));
        const content = asString(args, 'content', false);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, 'utf8');
        return `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
      },
    },
    {
      name: 'edit',
      description: 'Replace exactly one occurrence of old_string with new_string in a workspace file. Fails loud when it does not match exactly once.',
      replay: 'never',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
        required: ['path', 'old_string', 'new_string'],
      },
      execute({ args }) {
        const path = inside(workspaceRoot, asString(args, 'path'));
        const oldString = asString(args, 'old_string');
        const newString = asString(args, 'new_string', false);
        const original = readFileSync(path, 'utf8');
        const matches = original.split(oldString).length - 1;
        if (matches !== 1) throw new Error(`edit_not_unique: old_string occurs ${matches} times in ${path}`);
        writeFileSync(path, original.replace(oldString, newString), 'utf8');
        return `edited ${path}`;
      },
    },
    {
      name: 'bash',
      replay: 'never',
      description: 'Run a bash command in the workspace with a 30s timeout. stdout/stderr are combined; output over 32 KiB is capped, and the full text is written under .cogmem-shell/bash-output/ and named in the result.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute({ args, signal }) {
        const command = asString(args, 'command');
        return new Promise<string>((resolvePromise, rejectPromise) => {
          const child = spawn('/bin/bash', ['-lc', command], { cwd: workspaceRoot, signal, stdio: ['ignore', 'pipe', 'pipe'] });
          let output = '';
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            rejectPromise(new Error(`bash_timeout: command exceeded ${BASH_TIMEOUT_MS}ms`));
          }, BASH_TIMEOUT_MS);
          child.stdout.on('data', (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.stderr.on('data', (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.on('error', (error) => {
            clearTimeout(timer);
            rejectPromise(error);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolvePromise(capWithPointer(`exit ${code}\n${output}`, workspaceRoot));
          });
        });
      },
    },
  ];
}

/** Registers all four; the host refuses any later plugin that tries to reuse a name. */
export function builtinToolsPlugin(): NativePlugin {
  return {
    name: 'builtin-tools',
    provide: ['builtinTools'],
    apply(ctx, config) {
      const { workspaceRoot } = config as BuiltinToolsConfig;
      for (const definition of definitions(workspaceRoot)) {
        ctx.registerTool(definition, { builtin: true });
      }
      ctx.provide('builtinTools', { names: ['read', 'write', 'edit', 'bash'] });
    },
  };
}
