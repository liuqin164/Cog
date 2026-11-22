import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_COMPANION_NAME = 'Cog';

export function normalizeCompanionName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  return name === '' ? DEFAULT_COMPANION_NAME : name;
}

export function companionAvatar(name: string): string {
  const trimmed = normalizeCompanionName(name);
  if (/^[\x00-\x7F]+$/u.test(trimmed)) return trimmed.slice(0, 1).toUpperCase();
  return [...trimmed].slice(0, 2).join('');
}

export function readCompanionName(dataDir: string): string | undefined {
  try {
    const state = JSON.parse(readFileSync(join(dataDir, 'install.json'), 'utf8')) as { choices?: { companionName?: unknown } };
    return state.choices?.companionName === undefined ? undefined : normalizeCompanionName(state.choices.companionName);
  } catch {
    return undefined;
  }
}
