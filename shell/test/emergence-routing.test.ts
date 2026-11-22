import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writePluginRegistry } from '../src/plugins/registry.ts';
import { ScriptedProvider, makeShell, makeTempDir } from './helpers.ts';

const BASE = Date.UTC(2026, 10, 15, 12, 0, 0);
const NO_DREAM = { windowStartHour: 0, windowEndHour: 1, runKernelNight: false, maxEpisodes: 5 };
describe('one emergence reaches one channel (#420)', () => {
  test('an open web stream wins; without it the connected telegram channel pushes once', async () => {
    const dir = makeTempDir('emergence-routing-');
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir, { recursive: true });
    writePluginRegistry(dataDir, ['builtin:web-channel']);

    let now = BASE;
    const provider = new ScriptedProvider([
      { text: '第一件事。', toolCalls: [] },
      { text: '第二件事。', toolCalls: [] },
    ]);
    const shell = makeShell(dir, provider, {
      dataDir,
      dbPath: join(dataDir, 'memory.sqlite'),
      plugins: ['builtin:web-channel'],
      dream: NO_DREAM,
    }, { now: () => now });
    await shell.start();
    const contract = (shell as any).channelContract;
    const telegram = contract.register({
      channelId: 'telegram:1',
      occasion: 'private',
      accounts: [{ accountId: 'owner', role: 'owner' }],
      reachability: 'online',
      interruptibility: 'normal',
    });
    contract.presence(telegram, { reachability: 'online', ownerActivity: 'idle', at: now });
    const web = (shell.host as any).getService('webChannel');
    const cards: string[] = [];
    web.broadcast = (event: string) => { cards.push(event); };
    const pushes: any[] = [];
    const emerged: any[] = [];
    shell.host.bus.on('companion_emergence', (payload: any) => {
      emerged.push(payload);
      if (payload.channelId === telegram.channelId && payload.strength === 'proactive') pushes.push(payload);
    });
    const stream = (await web.handle(new Request('http://127.0.0.1/channel/web/events'), '127.0.0.1')).body!.getReader();
    try {
      await shell.runCommand('wake', '1 first');
      now = BASE + 60_000;
      await shell.tick(now);
      expect(cards.filter((event) => event === 'emergence')).toHaveLength(1);
      expect(pushes).toHaveLength(0);
      expect(emerged.at(-1)).toMatchObject({ channelId: 'web', strength: 'proactive' });

      await stream.cancel();
      contract.presence(telegram, { reachability: 'online', ownerActivity: 'idle', at: now });
      expect(contract.currentChannel()).toBe('telegram:1');
      await shell.runCommand('wake', '1 second');
      now += 60_000;
      await shell.tick(now);
      expect(cards.filter((event) => event === 'emergence')).toHaveLength(1);
      expect(pushes).toHaveLength(1);
      expect(emerged.at(-1)).toMatchObject({ channelId: 'telegram:1', strength: 'proactive' });
    } finally {
      await stream.cancel().catch(() => undefined);
      await shell.stop();
    }
  }, 30_000);
});
