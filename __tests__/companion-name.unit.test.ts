import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_COMPANION_NAME, companionAvatar, normalizeCompanionName, readCompanionName } from '../shell/src/companion-name.ts';
import { parseInstallFlags } from '../shell/src/install/installer.ts';
import { makeTempDir } from './helpers/tmp.ts';

describe('the companion name and its avatar label come from one config value', () => {
  test('the fallback is the configured default, never an unrelated word', () => {
    expect(normalizeCompanionName('')).toBe(DEFAULT_COMPANION_NAME);
    expect(normalizeCompanionName('   ')).toBe(DEFAULT_COMPANION_NAME);
    expect(companionAvatar(DEFAULT_COMPANION_NAME)).toBe('C');
  });

  test('Chinese names show one or two characters, longer names the first two', () => {
    expect(companionAvatar('小海')).toBe('小海');
    expect(companionAvatar('小')).toBe('小');
    expect(companionAvatar('小海豚')).toBe('小海');
  });

  test('English names show the first letter, uppercased', () => {
    expect(companionAvatar('Nova')).toBe('N');
    expect(companionAvatar('cog')).toBe('C');
  });

  test('the installer accepts the name at first install and for a rename', () => {
    expect(parseInstallFlags(['--name', '小海']).name).toBe('小海');
    expect(parseInstallFlags(['--name', 'Nova']).name).toBe('Nova');
  });

  test('a rename is read from install.json on the next request, not cached', () => {
    const dir = makeTempDir('cogmem-name-');
    expect(readCompanionName(dir)).toBeUndefined();
    writeFileSync(join(dir, 'install.json'), JSON.stringify({ choices: { companionName: '小海' } }));
    expect(readCompanionName(dir)).toBe('小海');
    writeFileSync(join(dir, 'install.json'), JSON.stringify({ choices: { companionName: 'Nova' } }));
    expect(readCompanionName(dir)).toBe('Nova');
  });
});
