/**
 * The four basic tools, as a plugin with no more privilege than a third-party one.
 *
 * Every tool validates its input at the trust boundary (path inside the workspace, output capped,
 * command timeout) and every output is returned as text for the capture path to redact and mark.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { MemoryEvent, MemoryKernel } from 'cogmem';
import type { TraceLog } from '../trace.ts';
import type { NativePlugin, ToolDefinition, ToolOutcome } from './host.ts';

const MAX_READ_BYTES = 256 * 1024;
/** Pi's bash output cap: 2000 lines or 50 KiB, whichever is hit first (`truncate.js:13-14`). */
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
/** The shell keeps a default timeout where Pi has none, so a hung command cannot wedge a run. */
const BASH_TIMEOUT_MS = 30_000;
const MAX_BASH_TIMEOUT_MS = 2_147_483_647;
const BASH_OUTPUT_DIR = '.cogmem-shell/bash-output';

export interface BuiltinToolsConfig {
  workspaceRoot: string;
  /**
   * The shell's own state directory (#233). `bash` runs with it read-only; `write`/`edit` refuse it
   * too, because the default data dir lives under the workspace and a path check alone would let the
   * model rewrite the budgets it is caged by.
   */
  dataDir?: string;
  /** The companion's own `cogmem` config; exported as `COGMEM_CONFIG` to every bash child (#277). */
  cliConfigPath?: string;
  trace?: TraceLog;
  /** The kernel's read face: `mem:<eventId>` resolves through it, never through the SQLite file. */
  kernel?: MemoryKernel;
  /** One successful `mem:` read; the shell counts it for the context trace's drill metric (#268). */
  onMemoryRead?: (eventId: string) => void;
}

function inside(root: string, candidate: string): string {
  const resolved = resolve(root, candidate);
  const rootResolved = resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    throw new Error(`path_outside_workspace: ${candidate}`);
  }
  return resolved;
}

function writableInside(root: string, candidate: string, dataDir?: string): string {
  const resolved = inside(root, candidate);
  if (dataDir) {
    const data = resolve(dataDir);
    if (resolved === data || resolved.startsWith(data + sep)) throw new Error(`path_in_data_dir: ${candidate}`);
  }
  return resolved;
}

/** `mem:<eventId>` is the ledger's read key; it is a separate namespace from workspace paths. */
const MEMORY_PATH_PREFIX = 'mem:';

function memoryEventId(path: string): string | undefined {
  if (!path.startsWith(MEMORY_PATH_PREFIX)) return undefined;
  const eventId = path.slice(MEMORY_PATH_PREFIX.length);
  if (eventId === '') throw new Error('invalid_memory_path: expected mem:<eventId>');
  return eventId;
}

/** The same rule the CLI's drill-down uses for "the event's own text". */
function memoryEventText(event: MemoryEvent): string {
  const payload = event.payload as { text?: unknown; output?: unknown; title?: unknown };
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.output === 'string') return payload.output;
  if (typeof payload.title === 'string') return payload.title;
  return JSON.stringify(event.payload);
}

/** A refusal is evidence: the model should learn the path is read-only, not retry it. */
function refuseMemoryWrite(path: string, tool: 'write' | 'edit', trace?: TraceLog): void {
  if (!path.startsWith(MEMORY_PATH_PREFIX)) return;
  trace?.append('memory_path_write_refused', { tool, path });
  throw new Error(`read_only_memory_path: ${path} is a ledger event; read it with read mem:<eventId>`);
}

/**
 * bwrap is probed once per process with a real mount, not `--version`: a binary can exist while
 * unprivileged user namespaces are refused, and that is the case the probe has to catch.
 */
let bwrapProbe: boolean | undefined;

export function bwrapUsable(): boolean {
  if (bwrapProbe !== undefined) return bwrapProbe;
  const probe = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', '--', '/bin/true'], {
    timeout: 2_000,
    stdio: 'ignore',
  });
  bwrapProbe = probe.status === 0;
  return bwrapProbe;
}

/** System directories a command needs; everything else is invisible (#288). */
const SANDBOX_SYSTEM_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];
/** Only these variables reach a bash child; API keys, tokens and the rest are absent by construction. */
const BASH_ENV_ALLOWLIST = [
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_NUMERIC',
  'LC_TIME',
  'LC_COLLATE',
  'LC_MONETARY',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
];
const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

function isWithin(root: string, candidate: string): boolean {
  const resolved = resolve(root);
  const child = resolve(candidate);
  return child === resolved || child.startsWith(resolved + sep);
}

/**
 * The bin directory of the runtime running this shell, when it is not already on the sandbox's
 * fixed PATH (setup-bun's `/home/runner/.bun/bin`, a per-user `~/.bun/bin`). Binding the directory
 * into the sandbox is not enough: `bun tamper.ts` looks it up by name, so PATH must name it too.
 */
function runtimeBin(): string | undefined {
  const dir = dirname(realpathSync(process.execPath));
  return SANDBOX_SYSTEM_DIRS.some((system) => isWithin(system, dir)) ? undefined : dir;
}

function bashEnv(sandboxed: boolean, cliConfigPath?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASH_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const ownBin = sandboxed ? runtimeBin() : undefined;
  env.PATH = sandboxed ? (ownBin ? `${ownBin}:${SANDBOX_PATH}` : SANDBOX_PATH) : process.env.PATH ?? SANDBOX_PATH;
  env.HOME = sandboxed ? '/tmp' : process.env.HOME ?? '/tmp';
  env.TMPDIR = sandboxed ? '/tmp' : process.env.TMPDIR ?? '/tmp';
  env.SHELL = '/bin/bash';
  if (cliConfigPath) env.COGMEM_CONFIG = cliConfigPath;
  return env;
}

/**
 * A minimal read-only system root plus the workspace. The data dir is masked by an empty read-only
 * mount, so memory, budgets and the CLI config are not readable from bash (#288) whether it sits
 * under the workspace (the default `<workspace>/.cogmem-shell`) or elsewhere. Network is unshared:
 * a fetched page cannot ask bash to send a secret out. The runtime's own bin directory is bound
 * and named on PATH when bun/node lives outside `/usr` (a per-user install); only that directory,
 * never `$HOME`.
 */
function sandboxArgs(workspaceRoot: string, dataDir: string, command: string): string[] {
  const workspace = realpathSync(workspaceRoot);
  const data = realpathSync(dataDir);
  const args = ['--die-with-parent', '--unshare-net'];
  for (const dir of SANDBOX_SYSTEM_DIRS) {
    if (existsSync(dir)) args.push('--ro-bind', dir, dir);
  }
  args.push('--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp');
  // An empty read-only mount at the data path: the real memory, budgets and CLI config stay
  // invisible, while a write still fails as `read-only file system` and leaves the denial trace.
  // Order matters when one path contains the other: the workspace mount must win where it should.
  // `data === workspace` is a configuration where the two cannot be separated; leave it visible.
  if (data !== workspace && isWithin(workspace, data)) {
    args.push('--bind', workspace, workspace, '--tmpfs', data, '--remount-ro', data);
  } else if (data !== workspace) {
    // The workspace may itself be under the data dir; mount it while the tmpfs is still writable,
    // then remount the parent read-only. Submounts keep their own flags.
    args.push('--tmpfs', data, '--bind', workspace, workspace, '--remount-ro', data);
  } else {
    args.push('--bind', workspace, workspace);
  }
  // Bound after the data mask: a per-user bun/node install inside a masked home stays runnable.
  const ownBin = runtimeBin();
  if (ownBin) args.push('--ro-bind', ownBin, ownBin);
  args.push('--chdir', workspace, '--', '/bin/bash', '-lc', command);
  return args;
}

/** A denied write is evidence, not just a non-zero exit the model might retry. */
const SANDBOX_DENIAL = /read-only file system|attempt to write a readonly database|sqlite_readonly|unable to open database file/i;

function asString(args: unknown, key: string, required = true): string {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string' || (required && value.length === 0)) throw new Error(`invalid_arguments: "${key}" must be a non-empty string`);
  return value;
}

/** Pi's bash `timeout` is optional seconds with no default (`resolveTimeoutMs`, bash.js:16-27); the
 * shell keeps its own 30s default so an unasked-for hang cannot wedge a resident run. */
function resolveBashTimeoutMs(args: unknown): number {
  const raw = (args as Record<string, unknown> | undefined)?.['timeout'];
  if (raw === undefined) return BASH_TIMEOUT_MS;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) throw new Error('invalid_arguments: "timeout" must be a finite number of seconds');
  const timeoutMs = raw * 1000;
  if (timeoutMs > MAX_BASH_TIMEOUT_MS) throw new Error(`invalid_arguments: "timeout" maximum is ${MAX_BASH_TIMEOUT_MS / 1000} seconds`);
  return timeoutMs;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** The first `maxBytes` bytes of `text`, cut back to the previous character boundary. */
function headBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/** The last `maxBytes` bytes of `text`, moved forward to the next character boundary. */
function tailBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

/**
 * A ledger event's text by `mem:<eventId>`. The read is idempotent and the same 256 KiB cap as a
 * file read; an event past it is cut and the cut is traced rather than retried through bash.
 */
function readMemoryEvent(
  eventId: string,
  kernel: MemoryKernel | undefined,
  trace?: TraceLog,
  onRead?: (eventId: string) => void,
): string {
  if (!kernel) throw new Error('memory_unavailable: this shell has no kernel attached');
  const event = kernel.getEventContext(eventId, { before: 0, after: 0 })?.event;
  if (!event) {
    throw new Error(`memory_event_not_found: no ledger event ${eventId}; use a mem:<eventId> key from a recall anchor or session digest`);
  }
  onRead?.(eventId);
  const text = memoryEventText(event);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_READ_BYTES) return text;
  trace?.append('memory_read_truncated', { eventId, bytes, cap: MAX_READ_BYTES });
  return `${headBytes(text, MAX_READ_BYTES)}\n\n[memory event truncated: showing ${formatSize(MAX_READ_BYTES)} of ${formatSize(bytes)}]`;
}

/**
 * Keep the tail of a command's output for the model: Pi's `truncateTail`, 2000 lines or 50 KiB
 * whichever is hit first (`truncate.js:118-181`). Bash keeps the tail because that is where errors
 * and final results are. The complete text goes to a workspace file and the pointer says which
 * lines are showing, so nothing is lost silently. The cut never lands inside a line or a multi-byte
 * character, except the one documented case Pi also allows: a single line longer than the byte cap,
 * where the last bytes of that line are shown.
 */
function capBashOutput(fullText: string, workspaceRoot: string): string {
  const lines = (fullText.endsWith('\n') ? fullText.slice(0, -1) : fullText).split('\n');
  const totalLines = lines.length;
  if (totalLines <= MAX_OUTPUT_LINES && Buffer.byteLength(fullText, 'utf8') <= MAX_OUTPUT_BYTES) return fullText;

  const visible: string[] = [];
  let bytes = 0;
  let partial = false;
  let truncatedByBytes = false;
  for (let index = lines.length - 1; index >= 0 && visible.length < MAX_OUTPUT_LINES; index -= 1) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, 'utf8') + (visible.length > 0 ? 1 : 0);
    if (bytes + lineBytes > MAX_OUTPUT_BYTES) {
      truncatedByBytes = true;
      if (visible.length === 0) {
        visible.unshift(tailBytes(line, MAX_OUTPUT_BYTES));
        bytes = Buffer.byteLength(visible[0], 'utf8');
        partial = true;
      }
      break;
    }
    visible.unshift(line);
    bytes += lineBytes;
  }
  const shown = visible.join('\n');
  const limit = truncatedByBytes ? ` (${formatSize(MAX_OUTPUT_BYTES)} limit)` : '';
  const full = join(workspaceRoot, BASH_OUTPUT_DIR, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.log`);
  let pointer: string;
  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, fullText, 'utf8');
    pointer = relative(workspaceRoot, full);
  } catch (error) {
    return `${shown}\n\n[output truncated${limit}; full output could not be written: ${error instanceof Error ? error.message : String(error)}]`;
  }
  if (partial) return `${shown}\n\n[showing the last ${formatSize(bytes)} of line ${totalLines}; full output: ${pointer}]`;
  const startLine = totalLines - visible.length + 1;
  return `${shown}\n\n[showing lines ${startLine}-${totalLines} of ${totalLines}${limit}; full output: ${pointer}]`;
}

function definitions(
  workspaceRoot: string,
  dataDir: string | undefined,
  sandboxed: boolean,
  ledger: { kernel?: MemoryKernel; trace?: TraceLog; onMemoryRead?: (eventId: string) => void },
  cliConfigPath?: string,
): ToolDefinition[] {
  const sandbox = sandboxed && dataDir !== undefined ? { dataDir, trace: ledger.trace } : undefined;
  // The shell always has a data dir, so a bare test host without one is not a degradation to
  // announce; a shell with one and no bwrap is, on every result (#281).
  const offNote = dataDir !== undefined && !sandboxed
    ? '[sandbox: off] bwrap is unavailable: this command ran without isolation (filesystem and network are shared)'
    : undefined;
  return [
    {
      name: 'read',
      description: 'Read a UTF-8 text file inside the workspace, or a ledger event by mem:<eventId>. Output is capped at 256 KiB.',
      replay: 'safe',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      rehearse({ args }) {
        const requested = asString(args, 'path');
        const eventId = memoryEventId(requested);
        if (eventId !== undefined) {
          if (!ledger.kernel) throw new Error('memory_unavailable: this shell has no kernel attached');
          return `would read memory event ${eventId}`;
        }
        const path = inside(workspaceRoot, requested);
        return `would read ${path}`;
      },
      execute({ args }) {
        const requested = asString(args, 'path');
        const eventId = memoryEventId(requested);
        if (eventId !== undefined) return readMemoryEvent(eventId, ledger.kernel, ledger.trace, ledger.onMemoryRead);
        const path = inside(workspaceRoot, requested);
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
      rehearse({ args }) {
        const requested = asString(args, 'path');
        refuseMemoryWrite(requested, 'write', ledger.trace);
        const path = writableInside(workspaceRoot, requested, dataDir);
        const content = asString(args, 'content', false);
        return `would write ${Buffer.byteLength(content)} bytes to ${path}`;
      },
      execute({ args }) {
        const requested = asString(args, 'path');
        refuseMemoryWrite(requested, 'write', ledger.trace);
        const path = writableInside(workspaceRoot, requested, dataDir);
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
      rehearse({ args }) {
        const requested = asString(args, 'path');
        refuseMemoryWrite(requested, 'edit', ledger.trace);
        const path = writableInside(workspaceRoot, requested, dataDir);
        asString(args, 'old_string');
        asString(args, 'new_string', false);
        return `would edit ${path}`;
      },
      execute({ args }) {
        const requested = asString(args, 'path');
        refuseMemoryWrite(requested, 'edit', ledger.trace);
        const path = writableInside(workspaceRoot, requested, dataDir);
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
      description: 'Run a bash command in the workspace, 30s timeout by default. It runs with no network access and sees only system directories and the workspace: the shell data directory and the operator home are not mounted, and only a small variable allowlist reaches the child. stdout/stderr are combined; the last 2000 lines or 50 KiB (whichever is hit first) are returned, and the full text is written under .cogmem-shell/bash-output/ and named in the result. A non-zero exit is an error. The optional `timeout` is in seconds.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] },
      rehearse({ args }) {
        const command = asString(args, 'command');
        resolveBashTimeoutMs(args);
        return `would run: ${command}`;
      },
      execute({ args, signal }) {
        const command = asString(args, 'command');
        const timeoutMs = resolveBashTimeoutMs(args);
        const env = bashEnv(sandbox !== undefined, cliConfigPath);
        return new Promise<ToolOutcome>((resolvePromise, rejectPromise) => {
          const child = sandbox
            ? spawn('bwrap', sandboxArgs(workspaceRoot, sandbox.dataDir, command), { cwd: workspaceRoot, signal, stdio: ['ignore', 'pipe', 'pipe'], env })
            : spawn('/bin/bash', ['-lc', command], { cwd: workspaceRoot, signal, stdio: ['ignore', 'pipe', 'pipe'], env });
          let output = '';
          let settled = false;
          let timer: ReturnType<typeof setTimeout>;
          // Pi appends the status after truncating (`formatOutput`, bash.js:233-253) so the tail that
          // matters is not itself pushed out of the cap, and the command's output is kept even when it
          // timed out — the process ran, and losing what it printed is not a reason to lose the result.
          const settle = (note: string | undefined, isError: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (sandbox && SANDBOX_DENIAL.test(output)) {
              sandbox.trace?.append('bash_sandbox_denied', {
                command: command.length > 240 ? `${command.slice(0, 240)}…` : command,
                dataDir: sandbox.dataDir,
              });
            }
            const capped = capBashOutput(output, workspaceRoot);
            const parts = [capped];
            if (note) parts.push(note);
            if (offNote) parts.push(offNote);
            resolvePromise({ output: parts.join('\n\n'), isError });
          };
          timer = setTimeout(() => {
            child.kill('SIGKILL');
            settle(`Command timed out after ${timeoutMs / 1000} seconds`, true);
          }, timeoutMs);
          // A pipe hands over arbitrary byte boundaries, so a multi-byte character can be cut in two
          // between `data` events; decoding each chunk alone leaves U+FFFD on both halves. One decoder
          // per stream carries the unfinished bytes over to the next chunk, and `end()` flushes a
          // genuinely truncated tail as the replacement character rather than dropping it silently.
          const stdoutDecoder = new StringDecoder('utf8');
          const stderrDecoder = new StringDecoder('utf8');
          child.stdout.on('data', (chunk: Buffer) => {
            output += stdoutDecoder.write(chunk);
          });
          child.stderr.on('data', (chunk: Buffer) => {
            output += stderrDecoder.write(chunk);
          });
          child.stdout.on('end', () => {
            output += stdoutDecoder.end();
          });
          child.stderr.on('end', () => {
            output += stderrDecoder.end();
          });
          child.on('error', (error) => {
            // An abort (`signal`) arrives here: the run is unwinding, so reject and let the pipeline
            // record `tool_call_failed` rather than dressing the kill up as the command's verdict.
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sandbox?.trace?.append('bash_sandbox_failed', { message: error.message });
            rejectPromise(error);
          });
          child.on('close', (code) => {
            if (code === null) settle('Command terminated without an exit code', true);
            else if (code === 0) settle(undefined, false);
            else settle(`Command exited with code ${code}`, true);
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
      const { workspaceRoot, dataDir, cliConfigPath, trace, kernel, onMemoryRead } = config as BuiltinToolsConfig;
      const sandboxed = dataDir !== undefined && bwrapUsable();
      if (dataDir !== undefined && !sandboxed) trace?.append('bash_sandbox_unavailable', { dataDir, reason: 'bwrap_not_usable' });
      if (sandboxed) trace?.append('bash_sandbox_network', { network: 'unshared' });
      for (const definition of definitions(workspaceRoot, dataDir, sandboxed, { kernel, trace, onMemoryRead }, cliConfigPath)) {
        ctx.registerTool(definition, { builtin: true });
      }
      ctx.provide('builtinTools', { names: ['read', 'write', 'edit', 'bash'] });
    },
  };
}
