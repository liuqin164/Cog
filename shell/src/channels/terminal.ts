/**
 * The terminal channel: the simplest self-owned way to talk to the shell. No external platform, no
 * OpenMaus, no bot token — a line in, a turn out, and `/name args` reaching the plugin command table.
 *
 * It is a channel plugin like any future platform channel: it injects the shell control surface and
 * the command registry, and it knows nothing about the state machine's internals.
 */
import { createInterface, type Interface } from 'node:readline';
import type { NativePlugin } from '../plugins/host.ts';
import type { TraceLog } from '../trace.ts';

export interface ShellControl {
  submit(text: string): Promise<unknown>;
  readonly state: string;
}

export interface TerminalChannelOptions {
  shell: ShellControl;
  commands: { has(name: string): boolean; run(name: string, args: string, ctx: unknown): Promise<string | undefined>; list(): Array<{ name: string; description?: string }> };
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  trace?: TraceLog;
  captureTerminalRecord?: (text: string) => Promise<void>;
}

export class TerminalChannel {
  private reader?: Interface;

  constructor(private readonly options: TerminalChannelOptions) {}

  start(): void {
    const input = this.options.input ?? process.stdin;
    const output = this.options.output ?? process.stdout;
    this.options.trace?.append('terminal_channel_started', {});
    this.reader = createInterface({ input, output, terminal: false });
    this.reader.on('line', (line: string) => {
      void this.handleLine(line.trim()).catch((error) => {
        this.options.trace?.append('terminal_line_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
        this.print(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    });
  }

  async handleLine(line: string): Promise<void> {
    if (line.length === 0) return;
    if (line.startsWith('/')) {
      const [rawName, ...rest] = line.slice(1).split(/\s+/u);
      const args = rest.join(' ');
      if (!this.options.commands.has(rawName)) {
        this.print(`unknown command: /${rawName}\n`);
        return;
      }
      const result = await this.options.commands.run(rawName, args, this.options.shell);
      this.print(`${result ?? ''}\n`);
      await this.options.captureTerminalRecord?.(`/${rawName} ${args}`);
      return;
    }
    await this.options.shell.submit(line);
  }

  print(text: string): void {
    (this.options.output ?? process.stdout).write(text);
  }

  stop(): void {
    this.reader?.close();
    this.reader = undefined;
  }
}

export function terminalPlugin(options: TerminalChannelOptions): NativePlugin {
  return {
    name: 'terminal-channel',
    provide: ['terminal'],
    inject: ['shell', 'commands'],
    apply(ctx) {
      const channel = new TerminalChannel({
        shell: ctx.getService<ShellControl>('shell'),
        commands: ctx.getService<TerminalChannelOptions['commands']>('commands'),
        input: options.input,
        output: options.output,
        trace: options.trace,
        captureTerminalRecord: options.captureTerminalRecord,
      });
      ctx.on('terminal_print', (event: { text?: string }) => {
        if (typeof event.text === 'string') channel.print(event.text);
      });
      ctx.dispose(() => channel.stop());
      ctx.provide('terminal', channel);
    },
  };
}
