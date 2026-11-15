/**
 * The registry's fixture: a native plugin that registers one tool and one command. The
 * register→restart→loaded tests point `<dataDir>/plugins.json` at this file.
 */
import type { NativePlugin } from '../../src/plugins/host.ts';

export default {
  name: 'fixture-native',
  apply(ctx) {
    ctx.registerTool({
      name: 'fixture-native-echo',
      description: 'return a fixed string',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
    });
    ctx.registerCommand({
      name: 'fixture-native',
      description: 'the fixture command',
      handler: () => 'fixture ok',
    });
  },
} satisfies NativePlugin;
