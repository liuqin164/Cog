/**
 * #225's discriminators, against a local fixture server: extraction, the 30k cap and recall
 * paging, the one-hour cache, both SSRF cases (direct private and a redirect into private), and
 * the missing-backend error shape. The search tests inject fetch so no test reaches the internet.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginHost } from '../../src/plugins/host.ts';
import { fetchPinned, webPlugin, type LookupAddress, type WebPluginOptions } from '../../src/plugins/web.ts';
import { ScriptedProvider, makeShell, makeTempDir } from '../helpers.ts';

const ARTICLE_HTML = `<!doctype html><html><head><title>Fixture Article</title></head><body>
  <nav><a href="/">Navigation link that must not be extracted</a></nav>
  <article>
    <h1>Fixture Article</h1>
    <p>The article body is here, with enough prose to clear the extraction floor and prove the conversion works.</p>
    <p>A second paragraph keeps the readable body from looking like a failure page in Readability's view.</p>
  </article>
  <script>window.__noise = "script-noise";</script>
</body></html>`;

const LONG_PARAGRAPH = `${'alpha beta gamma '.repeat(400)}😀`;
const LONG_HTML = `<!doctype html><html><head><title>Long Page</title></head><body><article><h1>Long Page</h1>${Array.from(
  { length: 18 },
  () => `<p>${LONG_PARAGRAPH}</p>`,
).join('')}</article></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let base = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/article') return new Response(ARTICLE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (path === '/long') return new Response(LONG_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (path === '/pdf') return new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } });
      if (path === '/js-shell') {
        return new Response('<html><head><title>App</title></head><body><div id="app"></div><script>render()</script></body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      if (path === '/redirect-article') return new Response(null, { status: 302, headers: { location: '/article' } });
      if (path === '/redirect-private') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
      if (path === '/host') return new Response(request.headers.get('host') ?? '', { headers: { 'content-type': 'text/plain' } });
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

async function start(options: Partial<WebPluginOptions> & { dataDir: string }): Promise<PluginHost> {
  const host = new PluginHost();
  host.register(webPlugin(options));
  await host.start();
  return host;
}

async function call(host: PluginHost, name: string, input: unknown) {
  return host.tools.invoke(name, { toolCallId: `call-${name}`, input }, { runId: 'run' });
}

function responseId(output: string): string {
  const match = output.match(/responseId: ([0-9a-f]{32})/);
  if (!match) throw new Error(`no responseId in: ${output.slice(0, 200)}`);
  return match[1]!;
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('web_fetch extraction and paging', () => {
  test('extracts the article body as Markdown and drops navigation and scripts', async () => {
    const dir = makeTempDir();
    const host = await start({ dataDir: dir, allowLoopback: true });
    const result = await call(host, 'web_fetch', { url: `${base}/article` });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Title: Fixture Article');
    expect(result.output).toContain('The article body is here');
    expect(result.output).toContain('A second paragraph');
    expect(result.output).not.toContain('Navigation link');
    expect(result.output).not.toContain('script-noise');
    expect(result.output).not.toContain('<script>');
  });

  test('caps at 30k characters, caches the rest, and recall pages without losing or splitting a character', async () => {
    const dir = makeTempDir();
    const host = await start({ dataDir: dir, allowLoopback: true });
    const first = await call(host, 'web_fetch', { url: `${base}/long` });
    expect(first.isError).toBe(false);
    const id = responseId(first.output);
    const total = Number(first.output.match(/of (\d+)\. Use web_recall/)?.[1]);
    expect(total).toBeGreaterThan(30_000);
    const offset = Number(first.output.match(/offset: (\d+)/)?.[1]);
    expect(offset).toBeLessThanOrEqual(30_000);
    expect(hasLoneSurrogate(first.output)).toBe(false);

    const second = await call(host, 'web_recall', { responseId: id, offset, limit: 30_000 });
    expect(second.isError).toBe(false);
    expect(hasLoneSurrogate(second.output)).toBe(false);
    expect(second.output).toContain('alpha beta gamma');

    const tail = await call(host, 'web_recall', { responseId: id, offset: total - 20, limit: 100 });
    expect(tail.isError).toBe(false);
    expect(tail.output.endsWith('😀')).toBe(true);
    expect(tail.output).not.toContain('Use web_recall');
  });

  test('findText returns passages and names a miss', async () => {
    const dir = makeTempDir();
    const host = await start({ dataDir: dir, allowLoopback: true });
    const fetched = await call(host, 'web_fetch', { url: `${base}/long` });
    const id = responseId(fetched.output);
    const found = await call(host, 'web_recall', { responseId: id, findText: 'alpha beta' });
    expect(found.isError).toBe(false);
    expect(found.output).toContain('[1]');
    expect(found.output).toContain('alpha beta gamma');
    const miss = await call(host, 'web_recall', { responseId: id, findText: 'not-on-the-page' });
    expect(miss.isError).toBe(true);
    expect(miss.output).toContain('find_text_no_match');
  });

  test('a cache entry expires after one hour and is removed', async () => {
    const dir = makeTempDir();
    let clock = Date.now();
    const host = await start({ dataDir: dir, allowLoopback: true, now: () => clock });
    const fetched = await call(host, 'web_fetch', { url: `${base}/article` });
    const id = responseId(fetched.output);
    clock += 60 * 60 * 1000;
    const expired = await call(host, 'web_recall', { responseId: id });
    expect(expired.isError).toBe(true);
    expect(expired.output).toContain('cache_expired');
    expect(readdirSync(join(dir, 'web-cache'))).toEqual([]);
  });
});

describe('web_fetch trust boundary', () => {
  test('refuses loopback targets and embedded credentials', async () => {
    const dir = makeTempDir();
    const host = await start({ dataDir: dir });
    const loopback = await call(host, 'web_fetch', { url: `${base}/article` });
    expect(loopback.isError).toBe(true);
    expect(loopback.output).toContain('ssrf_blocked');

    const credentials = await call(host, 'web_fetch', { url: 'http://user:pass@example.com/' });
    expect(credentials.isError).toBe(true);
    expect(credentials.output).toContain('url_credentials_refused');

    const scheme = await call(host, 'web_fetch', { url: 'file:///etc/passwd' });
    expect(scheme.isError).toBe(true);
    expect(scheme.output).toContain('unsupported_scheme');
  });

  test('refuses a private address reached by DNS resolution', async () => {
    const dir = makeTempDir();
    const host = await start({ dataDir: dir, lookup: async () => [{ address: '10.0.0.7', family: 4 }] });
    const result = await call(host, 'web_fetch', { url: 'http://internal.example/secret' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('ssrf_blocked');
    expect(result.output).toContain('10.0.0.7');
  });

  test('pins the first validated address; a second DNS answer cannot redirect the connection (#289)', async () => {
    const dir = makeTempDir();
    let lookups = 0;
    const lookup = async (): Promise<LookupAddress[]> => {
      lookups += 1;
      return [{ address: lookups === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    };
    const pins: Array<LookupAddress | undefined> = [];
    const stub: WebPluginOptions['fetch'] = async (_input, _init, pin) => {
      pins.push(pin);
      return new Response(ARTICLE_HTML, { headers: { 'content-type': 'text/html' } });
    };
    const host = await start({ dataDir: dir, lookup, fetch: stub });
    const result = await call(host, 'web_fetch', { url: 'http://rebind.example/article' });
    expect(result.isError).toBe(false);
    // The second answer (loopback) is never consulted: validation and the connection use one result.
    expect(lookups).toBe(1);
    expect(pins).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  test('fetchPinned connects to the approved address and keeps the original Host header (#289)', async () => {
    const response = await fetchPinned(new URL(`http://rebind.test:${server.port}/host`), undefined, {
      address: '127.0.0.1',
      family: 4,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`rebind.test:${server.port}`);
  });

  test('a pinned connection failure is a named error, not a hostname retry (#289)', async () => {
    const dir = makeTempDir();
    const stub: WebPluginOptions['fetch'] = async () => {
      throw new Error('connect ECONNREFUSED (pinned)');
    };
    const host = await start({ dataDir: dir, lookup: async () => [{ address: '93.184.216.34', family: 4 }], fetch: stub });
    const result = await call(host, 'web_fetch', { url: 'http://rebind.example/article' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('fetch_failed');
    expect(result.output).toContain('ECONNREFUSED');
  });

  test('re-validates every redirect hop: loopback→loopback is allowed for the fixture, loopback→link-local is refused', async () => {
    const dir = makeTempDir();
    const host = await start({ dataDir: dir, allowLoopback: true });
    const followed = await call(host, 'web_fetch', { url: `${base}/redirect-article` });
    expect(followed.isError).toBe(false);
    expect(followed.output).toContain('The article body is here');

    const privateHop = await call(host, 'web_fetch', { url: `${base}/redirect-private` });
    expect(privateHop.isError).toBe(true);
    expect(privateHop.output).toContain('ssrf_blocked');
    expect(privateHop.output).toContain('169.254.169.254');
  });

  test('non-HTML and JavaScript-shell pages come back as named errors, not as raw bodies', async () => {
    const dir = makeTempDir();
    const host = await start({ dataDir: dir, allowLoopback: true });
    const pdf = await call(host, 'web_fetch', { url: `${base}/pdf` });
    expect(pdf.isError).toBe(true);
    expect(pdf.output).toContain('unsupported_content_type');
    expect(pdf.output).toContain('phase 2');

    const shell = await call(host, 'web_fetch', { url: `${base}/js-shell` });
    expect(shell.isError).toBe(true);
    expect(shell.output).toContain('extract_failed');
    expect(shell.output).toContain('does not execute JavaScript');
    expect(shell.output).not.toContain('render()');
  });
});

describe('web_search backends', () => {
  function enableSearch(dir: string): void {
    writeFileSync(join(dir, 'web.json'), JSON.stringify({ search: { exa: { enabled: true }, duckduckgo: { enabled: true } } }));
  }

  test('falls back from Exa to DuckDuckGo and parses both result shapes', async () => {
    const dir = makeTempDir();
    enableSearch(dir);
    const calls: string[] = [];
    const stub: WebPluginOptions['fetch'] = async (input) => {
      const url = typeof input === 'string' ? input : input.href;
      calls.push(url);
      if (url.startsWith('https://mcp.exa.ai')) {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { _meta: { 'ai.exa/rateLimited': true }, content: [] } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://html.duckduckgo.com')) {
        return new Response(
          `<html><body>
            <div class="result"><a class="result__a" href="https://example.com/a">Title A</a><div class="result__snippet">Snippet A</div></div>
            <div class="result result--ad"><a class="result__a" href="https://ad.example/">Ad</a></div>
            <div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Title B</a><span class="result__snippet">Snippet B</span></div>
          </body></html>`,
          { headers: { 'content-type': 'text/html' } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const host = await start({ dataDir: dir, fetch: stub });
    const result = await call(host, 'web_search', { query: 'cogmem' });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Backend: duckduckgo');
    expect(result.output).toContain('Title A');
    expect(result.output).toContain('https://example.org/b');
    expect(result.output).not.toContain('https://ad.example/');
    expect(calls[0]).toContain('mcp.exa.ai');
    expect(responseId(result.output)).toMatch(/^[0-9a-f]{32}$/);
  });

  test('uses Exa when it answers and parses its text-block format', async () => {
    const dir = makeTempDir();
    enableSearch(dir);
    const stub: WebPluginOptions['fetch'] = async () =>
      new Response(
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: 'Title: Exa One\nURL: https://exa.example/1\nText: First snippet\n---\nTitle: Exa Two\nURL: https://exa.example/2\nText: Second snippet',
              },
            ],
          },
        })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    const host = await start({ dataDir: dir, fetch: stub });
    const result = await call(host, 'web_search', { query: 'cogmem' });
    expect(result.isError).toBe(false);
    expect(result.output).toContain('Backend: exa');
    expect(result.output).toContain('Exa One');
    expect(result.output).toContain('https://exa.example/2');
  });

  test('names web.json and both fields when no backend is enabled', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'web.json'), JSON.stringify({ search: { exa: { enabled: false }, duckduckgo: { enabled: false } } }));
    const host = await start({ dataDir: dir });
    const result = await call(host, 'web_search', { query: 'cogmem' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('web_search_unavailable');
    expect(result.output).toContain(join(dir, 'web.json'));
    expect(result.output).toContain('search.exa.enabled=false');
    expect(result.output).toContain('search.duckduckgo.enabled=false');
  });

  test('a missing web.json leaves search off and sends no query anywhere', async () => {
    const dir = makeTempDir();
    const calls: string[] = [];
    const stub: WebPluginOptions['fetch'] = async (input) => {
      calls.push(typeof input === 'string' ? input : input.href);
      throw new Error('no outbound call is expected by default');
    };
    const host = await start({ dataDir: dir, fetch: stub });
    const result = await call(host, 'web_search', { query: 'cogmem' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('web_search_unavailable');
    expect(result.output).toContain(join(dir, 'web.json'));
    expect(calls).toEqual([]);
  });

  test('a malformed backend field fails startup and names the file and field', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'web.json'), JSON.stringify({ search: { exa: { enabled: 'yes' } } }));
    const host = new PluginHost();
    host.register(webPlugin({ dataDir: dir }));
    await expect(host.start()).rejects.toThrow(`invalid_web_config: ${join(dir, 'web.json')}: search.exa.enabled must be a boolean`);
  });

  test('response ids outside the cache naming rule are refused', async () => {
    const dir = makeTempDir();
    const host = await start({ dataDir: dir });
    const result = await call(host, 'web_recall', { responseId: '../../etc/passwd' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('invalid_response_id');
  });
});

test('the web tools are opt-in and exist only when the web plugin is registered', async () => {
  const names = ['web_search', 'web_fetch', 'web_recall'];
  const plain = makeShell(makeTempDir('web-default-'), new ScriptedProvider([{ text: 'ok', toolCalls: [] }]));
  await plain.start();
  try {
    for (const name of names) expect(plain.host.tools.has(name)).toBe(false);
  } finally {
    await plain.stop();
  }

  const spec = join(import.meta.dir, '../../src/plugins/web.ts');
  const enabled = makeShell(makeTempDir('web-opt-in-'), new ScriptedProvider([{ text: 'ok', toolCalls: [] }]), { plugins: [spec] });
  await enabled.start();
  try {
    for (const name of names) expect(enabled.host.tools.has(name)).toBe(true);
    const cage = enabled.host.getService<{ toolAllowed(name: string): boolean }>('cage');
    for (const name of names) expect(cage.toolAllowed(name)).toBe(true);
  } finally {
    await enabled.stop();
  }
});
