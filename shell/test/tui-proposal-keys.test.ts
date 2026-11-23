/**
 * The TuiApp's key-level half of the proposal answer (spec §7, #165 round 23). Round 22 covered the
 * socket route (`command-confirm` / `command-discard` in `attach/server.ts`) and the view element,
 * but not the two lines in `TuiApp.handleKey` that decide which one a keystroke sends. Remove either
 * `client.send` there and one of these goes red.
 *
 * No socket and no terminal: the attached client and the TTY streams are fakes, so this is the key
 * mapping and nothing else.
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ReadStream, WriteStream } from 'node:tty';
import { AttachClient } from '../src/attach/client.ts';
import type { AttachSnapshot } from '../src/attach/server.ts';
import type { CommandProposal } from '../src/proposals.ts';
import { TuiApp } from '../src/tui/app.ts';
import { LineEditor } from '../src/tui/editor.ts';
import { defaultRenderEnv } from '../src/tui/frame.ts';
import { renderTui } from '../src/tui/layout.ts';
import { TuiView } from '../src/tui/view.ts';

class FakeInput extends EventEmitter {
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
}

class FakeOutput extends EventEmitter {
  columns = 120;
  rows = 40;
  write(): boolean {
    return true;
  }
}

const pending: CommandProposal = { id: 'proposal-key-1', command: 'pause', args: '', reason: '你刚说今天很累', status: 'pending', createdAt: 1 };
const credential: CommandProposal = {
  id: 'credential-key-1',
  kind: 'credential',
  command: '',
  args: 'demo-api',
  reason: '演示',
  credential: {
    service: 'demo-api',
    purpose: '演示',
    fields: [{ name: 'account', label: '账号' }, { name: 'password', label: '密码', secret: true }],
  },
  status: 'pending',
  createdAt: 1,
};

/** A started app whose attach snapshot already carries one pending proposal, with every send recorded. */
async function started(sent: unknown[], proposal: CommandProposal = pending): Promise<{ app: TuiApp; input: FakeInput }> {
  const input = new FakeInput();
  const client = {
    send: (message: unknown) => void sent.push(message),
    close: () => {},
  } as unknown as AttachClient;
  const snapshot = {
    status: { lifecycle: 'IDLE' },
    entries: [{ kind: 'proposal', id: `proposal-${proposal.id}`, proposal }],
    queued: [],
    work: {},
    commands: [],
  } as unknown as AttachSnapshot;
  const app = new TuiApp({
    socketPath: '/nonexistent/attach.sock',
    input: input as unknown as ReadStream,
    output: new FakeOutput() as unknown as WriteStream,
    env: { TERM: 'dumb', LANG: 'C' } as NodeJS.ProcessEnv,
    connect: async () => ({ client, snapshot }),
  });
  await app.start();
  return { app, input };
}

describe('the TUI key that answers a proposal (round 23)', () => {
  test('Enter sends a confirm for the pending proposal', async () => {
    const sent: unknown[] = [];
    const { app, input } = await started(sent);
    try {
      input.emit('data', '\r');
      expect(sent).toEqual([{ t: 'command-confirm', id: pending.id }]);
    } finally {
      app.stop('test');
    }
  });

  test('a lone Esc sends a discard once the sequence window closes', async () => {
    const sent: unknown[] = [];
    const { app, input } = await started(sent);
    try {
      input.emit('data', '\u001b');
      expect(sent).toEqual([]); // a lone Esc waits to see whether an arrow key follows
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      expect(sent).toEqual([{ t: 'command-discard', id: pending.id }]);
    } finally {
      app.stop('test');
    }
  });
});

describe('the terminal credential wizard (#383)', () => {
  test('a credential request collects each field and sends one submission', async () => {
    const sent: unknown[] = [];
    const { app, input } = await started(sent, credential);
    try {
      input.emit('data', 'alice');
      input.emit('data', '\r');
      expect(sent).toEqual([]);
      input.emit('data', 's3cret');
      input.emit('data', '\r');
      expect(sent).toEqual([]);
      input.emit('data', 'https://api.example.com');
      input.emit('data', '\r');
      expect(sent).toEqual([{
        t: 'credential-submit',
        id: 'credential-key-1',
        values: { account: 'alice', password: 's3cret' },
        allowedOrigins: ['https://api.example.com'],
      }]);
      expect((app as unknown as { view: TuiView }).view.credential).toBeUndefined();
    } finally {
      app.stop('test');
    }
  });

  test('Esc cancels the whole wizard without sending a partial submission', async () => {
    const sent: unknown[] = [];
    const { app, input } = await started(sent, credential);
    try {
      input.emit('data', 'alice');
      input.emit('data', '\u001b');
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 80));
      expect(sent).toEqual([{ t: 'credential-cancel', id: 'credential-key-1' }]);
    } finally {
      app.stop('test');
    }
  });

  test('the secret field is never rendered while the account field is', () => {
    const view = new TuiView();
    const env = defaultRenderEnv({ TERM: 'dumb', LANG: 'C' } as NodeJS.ProcessEnv);
    view.credential = {
      id: 'credential-key-1',
      service: 'demo-api',
      purpose: '演示',
      prompt: '请输入账号',
      index: 0,
      total: 2,
      value: 'alice',
      secret: false,
    };
    const account = renderTui(view, new LineEditor([]), { width: 80, height: 24 }, env).rows.flat().map((segment) => segment.text).join('\n');
    expect(account).toContain('接下来的输入不会进入对话与账本');
    expect(account).toContain('alice');
    view.credential = { ...view.credential, prompt: '请输入密码', value: 's3cret', secret: true, index: 1 };
    const password = renderTui(view, new LineEditor([]), { width: 80, height: 24 }, env).rows.flat().map((segment) => segment.text).join('\n');
    expect(password).not.toContain('s3cret');
  });
});
