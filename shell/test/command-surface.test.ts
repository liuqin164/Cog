/**
 * The command面 closure (20-165): the palette, the resident and the TUI read one table.
 *
 * The discriminator for the table is deletion and rename: drop a row or change a name and the spec
 * list, the per-surface dispatch or the palette check below goes red.
 */
import { describe, expect, test } from 'bun:test';
import { CORE_COMMANDS, coreCommandFor } from '../src/commands.ts';
import { RESERVED_CORE_COMMANDS } from '../src/plugins/host.ts';
import { dispatchTuiCommand, paletteCommands } from '../src/tui/commands.ts';
import { TuiView } from '../src/tui/view.ts';

const SPEC_COMMANDS = ['soul', 'memory', 'commitments', 'status', 'context', 'sleep', 'dream', 'pause', 'resume', 'why', 'model', 'help', 'exit'];

describe('the core command table is the single source of truth (spec §7)', () => {
  test('the spec set is in the table and every name is reserved', () => {
    for (const name of SPEC_COMMANDS) expect(CORE_COMMANDS.some((command) => command.name === name)).toBe(true);
    for (const command of CORE_COMMANDS) expect(RESERVED_CORE_COMMANDS).toContain(command.name);
  });

  test('every command is dispatchable on each surface it declares, through the same table entry', () => {
    const view = new TuiView();
    view.modelRoutes = ['mg/a', 'mg/b']; // `/model`'s palette surface needs a second route
    const palette = paletteCommands(view).map((command) => command.name);
    for (const command of CORE_COMMANDS) {
      expect(command.surfaces.length).toBeGreaterThan(0);
      for (const surface of command.surfaces) {
        // All three faces resolve a name with this function, so the entry — and its handler — is one.
        expect(coreCommandFor(command.name, surface)).toBe(command);
        if (surface === 'palette') expect(palette).toContain(command.name);
        if (surface === 'tui') {
          const dispatch = dispatchTuiCommand(command.name, '', view);
          expect(dispatch.forward || dispatch.exit === true || dispatch.overlay !== undefined).toBe(true);
        }
      }
    }
    // A face never dispatches a name the table did not grant it: `/exit` is the TUI's, not the resident's.
    expect(coreCommandFor('exit', 'resident')).toBeUndefined();
  });
});
