import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const observatory = readFileSync(join(root, 'src/observatory/web/index.html'), 'utf8');
const observatoryApp = readFileSync(join(root, 'src/observatory/web/app.js'), 'utf8');
const channel = readFileSync(join(root, 'shell/web-channel/index.html'), 'utf8');

describe('the approved concept values are the page values', () => {
  test('both surfaces carry the light gold theme, Noto families and 14px radius', () => {
    for (const page of [observatory, channel]) {
      expect(page).toContain('--accent: #e6c26e');
      expect(page).toContain('--radius: 14px');
      expect(page).toContain('Noto Serif SC');
      expect(page).toContain('Noto Sans SC');
      expect(page).toContain('color-scheme: light');
    }
    expect(observatory).toContain('--radius-stage: 18px');
    expect(channel).toContain('.avatar');
    expect(channel).toContain('width: 34px');
    expect(channel).toContain('#send');
    expect(channel).toContain('width: 40px');
  });

  test('the six role hexes and the added read-only views are present', () => {
    for (const color of ['#e0655f', '#e6c26e', '#4fb286', '#6aa8d8', '#8fa3b8', '#b08fd4']) {
      expect(observatoryApp).toContain(`color: '${color}'`);
    }
    expect(observatory).toContain('id="tab-classification"');
    expect(observatory).toContain('id="view-classification"');
    expect(observatory).toContain('id="tab-round"');
    expect(observatory).toContain('id="view-round"');
    expect(observatoryApp).toContain('function renderClassification');
    expect(observatoryApp).toContain('function renderRound');
  });
});
