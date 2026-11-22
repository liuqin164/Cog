import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const observatory = readFileSync(join(root, 'src/observatory/web/index.html'), 'utf8');
const observatoryApp = readFileSync(join(root, 'src/observatory/web/app.js'), 'utf8');
const channelCss = readFileSync(join(root, 'shell/web-channel/view.css'), 'utf8');
const channelApp = readFileSync(join(root, 'shell/web-channel/app.js'), 'utf8');

const DARK = {
  '--bg': '#0a0f16',
  '--bg-soft': '#0e151f',
  '--panel': '#121b28',
  '--panel-2': '#16222f',
  '--line': '#223146',
  '--line-soft': '#1a2839',
  '--ink': '#e8e4d8',
  '--ink-2': '#b9c2cd',
  '--ink-3': '#7e8b9a',
  '--gold': '#e6c26e',
  '--teal': '#4fb286',
  '--coral': '#e0655f',
  '--sky': '#6aa8d8',
  '--lav': '#b08fd4',
  '--slate': '#8fa3b8',
  '--user-bubble': '#1d2c3f',
};

const LIGHT = {
  '--bg': '#f2efe7',
  '--bg-soft': '#eae6da',
  '--panel': '#fbf9f3',
  '--panel-2': '#f4f0e4',
  '--line': '#d9d2bf',
  '--line-soft': '#e4ddcb',
  '--ink': '#232a33',
  '--ink-2': '#4c5764',
  '--ink-3': '#85909c',
  '--gold': '#a97e22',
  '--teal': '#22795a',
  '--coral': '#b83a35',
  '--sky': '#2f6ea6',
  '--lav': '#7d5ba6',
  '--slate': '#5d7186',
  '--user-bubble': '#e7dfc9',
};

function blocks(page: string) {
  const dark = page.slice(page.indexOf(':root {'), page.indexOf('@media (prefers-color-scheme: light)'));
  const light = page.slice(page.indexOf('@media (prefers-color-scheme: light)'));
  return { dark, light };
}

describe('the approved concept values are the shell values', () => {
  test('the shell carries every dark and light token', () => {
    const { dark, light } = blocks(observatory);
    for (const [name, value] of Object.entries(DARK)) expect(dark).toContain(`${name}: ${value};`);
    for (const [name, value] of Object.entries(LIGHT)) expect(light).toContain(`${name}: ${value};`);
    expect(observatory).toContain('color-scheme: dark');
    expect(observatory).toContain('prefers-color-scheme: light');
    expect(observatory).toContain('--radius: 14px');
    expect(observatory).toContain('--radius-stage: 18px');
    expect(observatory).toContain('Noto Serif SC');
    expect(observatory).toContain('Noto Sans SC');
  });

  test('the three-column shell and its mobile breakpoints are present', () => {
    expect(observatory).toContain('grid-template-columns: 268px minmax(0, 1fr) 330px');
    expect(observatory).toContain('@media (max-width: 1180px)');
    expect(observatory).toContain('@media (max-width: 760px)');
    expect(observatory).toContain('class="tabbar"');
    expect(observatory).toContain('<!--ui:tabs-->');
    expect(observatory).toContain('<!--ui:views-->');
    expect(observatory).toContain('<!--ui:tabbar-->');
    expect(observatory).toContain('id="view-classification"');
    expect(observatory).toContain('id="view-soul"');
  });

  test('the six role hexes and the added read-only views are present', () => {
    for (const color of ['#e0655f', '#e6c26e', '#4fb286', '#6aa8d8', '#8fa3b8', '#b08fd4']) {
      expect(observatoryApp).toContain(`color: '${color}'`);
    }
    expect(observatoryApp).toContain('function renderClassification');
    expect(observatoryApp).toContain('function renderRound');
  });
});

describe('the star map keeps the concept night sky', () => {
  test('stage, fog, dust, clouds and links carry the concept constants', () => {
    expect(observatory).toContain('radial-gradient(120% 90% at 50% 38%, #0c1830 0%, #071224 46%, #04070f 100%)');
    expect(observatoryApp).toContain('new THREE.FogExp2(0x060b16, 0.0026)');
    expect(observatoryApp).toContain('state.mobile || state.reducedMotion ? 0 : 700');
    expect(observatoryApp).toContain('color: 0x9db8dd, size: 1.5, sizeAttenuation: false, transparent: true, opacity: 0.7');
    expect(observatoryApp).toContain('const colors = [0x31559f, 0x2a6f8f, 0x7a4a86, 0x27655c, 0x6b4a9e]');
    expect(observatoryApp).toContain('opacity: 0.13');
    expect(observatoryApp).toContain('blending: THREE.AdditiveBlending');
    expect(observatoryApp).toContain('vertexColors: true');
    expect(observatoryApp).toContain('color: 0xe6c26e');
    expect(observatory).toContain('rgba(10, 16, 26, .88)');
    expect(observatory).toContain('class="map-tools" id="legend"');
  });
});

describe('the chat view keeps the concept card and bubble shapes', () => {
  test('proposal, surfacing, chips, bubble, avatar and composer', () => {
    expect(channelCss).toContain('#view-chat .proposal');
    expect(channelCss).toContain('border: 1px solid var(--gold)');
    expect(channelCss).toContain('background: var(--gold-soft)');
    expect(channelCss).toContain('grid-template-columns: 74px 1fr');
    expect(channelCss).toContain('.surface-card');
    expect(channelCss).toContain('border: 1px solid var(--teal)');
    expect(channelCss).toContain('background: var(--teal-soft)');
    expect(channelCss).toContain('.chip .dot');
    expect(channelCss).toContain('border-radius: 16px 16px 4px 16px');
    expect(channelCss).toContain('background: var(--user-bubble)');
    expect(channelCss).toContain('width: 40px');
    expect(channelCss).toContain('max-width: 47.5rem');
    expect(channelApp).toContain("'批准安装'");
    expect(channelApp).toContain("'承诺浮现'");
    expect(channelApp).toContain("'插件提案'");
    expect(channelApp).toContain('__COGMEM_COMPANION__');
    expect(channelApp).not.toContain("'伴'");
  });
});
