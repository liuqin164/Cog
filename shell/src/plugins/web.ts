/**
 * Web access phase 1 (#225): `web_search`, `web_fetch`, `web_recall`.
 *
 * The same three-tool split as pi-web-access: search returns sources, fetch returns the readable
 * body of one HTML page, and recall pages through whatever was too long to return inline. What is
 * deliberately absent is the browser: no JavaScript runs here, so a client-rendered page comes back
 * as a named extraction failure rather than as its loading shell. PDFs, GitHub special cases and
 * video stay out of this phase and say so.
 *
 * The fetch path is a trust boundary. Only HTTP(S), no embedded credentials, every resolved address
 * checked against loopback/private/link-local/reserved ranges, and every redirect hop re-validated.
 * The connection then uses the exact address that was checked, with the original hostname kept for
 * the `Host` header and TLS SNI, so a second DNS answer cannot move it (#289).
 * The cache is plugin-private under `<dataDir>/web-cache` (0700/0600), expires after one hour, and
 * is pruned on write and read.
 */
import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { NativePlugin, ToolDefinition, ToolOutcome } from './host.ts';

const CONFIG_FILE = 'web.json';
const CACHE_DIR = 'web-cache';
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 30_000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 10_000;
const MIN_EXTRACTED_CHARS = 80;
const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';
const DUCKDUCKGO_URL = 'https://html.duckduckgo.com/html/';
const USER_AGENT = 'Mozilla/5.0 (compatible; cogmem-web/1.0)';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CACHE_ID = /^[0-9a-f]{32}$/;

export interface LookupAddress {
  address: string;
  family: number;
}

type FetchLike = (input: string | URL, init?: RequestInit, pin?: LookupAddress) => Promise<Response>;

export interface WebPluginOptions {
  dataDir: string;
  now?: () => number;
  /** Test seam; production pins the validated address through `fetchPinned`. The third argument is that pin. */
  fetch?: FetchLike;
  /** Test seam for asserting the resolved-address check. */
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  /** Test fixtures run on loopback. Production never passes this. */
  allowLoopback?: boolean;
}

const WEB_TOOL_NAMES = ['web_search', 'web_fetch', 'web_recall'] as const;

export interface WebConfig {
  search: {
    exa: { enabled: boolean };
    duckduckgo: { enabled: boolean };
  };
}

export class WebToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

function backendEnabled(value: unknown, path: string, field: string, defaultEnabled: boolean): boolean {
  if (value === undefined) return defaultEnabled;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebToolError('invalid_web_config', `${path}: ${field} must be an object`);
  }
  const enabled = (value as Record<string, unknown>).enabled;
  if (enabled === undefined) return defaultEnabled;
  if (typeof enabled !== 'boolean') {
    throw new WebToolError('invalid_web_config', `${path}: ${field}.enabled must be a boolean`);
  }
  return enabled;
}

/**
 * `<dataDir>/web.json`. A missing file leaves both free backends off, so a fresh install sends no
 * search query anywhere until the owner enables one; a file that exists but cannot be understood
 * names itself and the offending field, like `budgets.json`.
 */
export function readWebConfig(dataDir: string): WebConfig {
  const path = join(dataDir, CONFIG_FILE);
  if (!existsSync(path)) {
    return { search: { exa: { enabled: false }, duckduckgo: { enabled: false } } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new WebToolError('invalid_web_config', `${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebToolError('invalid_web_config', `${path}: expected an object`);
  }
  const search = (parsed as Record<string, unknown>).search;
  if (search === undefined) {
    return { search: { exa: { enabled: false }, duckduckgo: { enabled: false } } };
  }
  if (search === null || typeof search !== 'object' || Array.isArray(search)) {
    throw new WebToolError('invalid_web_config', `${path}: search must be an object`);
  }
  const record = search as Record<string, unknown>;
  return {
    search: {
      exa: { enabled: backendEnabled(record.exa, path, 'search.exa', false) },
      duckduckgo: { enabled: backendEnabled(record.duckduckgo, path, 'search.duckduckgo', false) },
    },
  };
}

function asString(args: unknown, key: string, required = true): string {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  if (typeof value !== 'string' || (required && value.trim() === '')) {
    throw new WebToolError('invalid_arguments', `"${key}" must be a non-empty string`);
  }
  return value;
}

function requestSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIPv6(address: string): number[] | null {
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const ipv4 = address.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map(Number);
    address = `${address.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const pieces = address.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (pieces.length === 1 && missing !== 0) return null;
  if (pieces.length === 2 && missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map((part) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return -1;
    return parseInt(part, 16);
  });
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

function isBlockedIPv6(address: string): boolean {
  const groups = parseIPv6(address);
  if (!groups) return true;
  const first = groups[0];
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 0xffff) return true;
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) return true;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const ipv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    return isBlockedIPv4(ipv4);
  }
  return false;
}

function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIPv4(address);
  if (version === 6) return isBlockedIPv6(address);
  return true;
}

function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 4) return address.startsWith('127.');
  const groups = parseIPv6(address);
  return groups !== null && groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

export interface ValidateOptions {
  lookup: (hostname: string) => Promise<LookupAddress[]>;
  allowLoopback: boolean;
}

export interface ValidatedTarget {
  url: URL;
  /** The address the connection must use, so the runtime cannot resolve the hostname again. */
  pin?: LookupAddress;
}

/** Only `http(s)`, no credentials, and no address that could reach the machine's own network. */
export async function validateRemoteUrl(raw: string, options: ValidateOptions): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebToolError('invalid_url', `${raw} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebToolError('unsupported_scheme', `only http and https are fetchable, got ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new WebToolError('url_credentials_refused', `${url.origin} carries embedded credentials`);
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (hostname === '') throw new WebToolError('invalid_url', `${raw} has no hostname`);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    if (options.allowLoopback) return { url };
    throw new WebToolError('ssrf_blocked', `${hostname} resolves inside the machine`);
  }
  if (isIP(hostname)) {
    if (options.allowLoopback && isLoopbackAddress(hostname)) return { url, pin: { address: hostname, family: isIP(hostname) } };
    if (isBlockedAddress(hostname)) throw new WebToolError('ssrf_blocked', `${hostname} is a loopback, private, link-local or reserved address`);
    return { url, pin: { address: hostname, family: isIP(hostname) } };
  }
  let addresses: LookupAddress[];
  try {
    addresses = await options.lookup(hostname);
  } catch (error) {
    throw new WebToolError('dns_failed', `could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (addresses.length === 0) throw new WebToolError('dns_failed', `${hostname} resolved to no addresses`);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new WebToolError('ssrf_blocked', `${hostname} resolves to the loopback, private, link-local or reserved address ${address}`);
    }
  }
  // Every address was checked; the first one is pinned so a second DNS answer is never used.
  return { url, pin: addresses[0] };
}

interface Runtime {
  fetch: FetchLike;
  lookup: (hostname: string) => Promise<LookupAddress[]>;
  allowLoopback: boolean;
  now: () => number;
  dataDir: string;
}

/**
 * Connect to the address validation approved, while keeping the hostname for the `Host` header and
 * TLS SNI/verification. Passing the pinned address through `lookup` is what closes the DNS-rebinding
 * TOCTOU (#289): the socket cannot land on a second answer, and there is no hostname fallback.
 */
export function fetchPinned(input: string | URL, init: RequestInit | undefined, pin: LookupAddress): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const headers = init?.headers === undefined ? undefined : new Headers(init.headers).toJSON();
  return new Promise((resolve, reject) => {
    const options = {
      protocol: url.protocol,
      hostname,
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? 'GET',
      headers,
      signal: init?.signal ?? undefined,
      // Bun asks for all addresses; Node may ask for the classic (address, family) pair.
      lookup: ((_host: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (lookupOptions.all) callback(null, [{ address: pin.address, family: pin.family }]);
        else callback(null, pin.address, pin.family);
      }) as unknown as LookupFunction,
      ...(url.protocol === 'https:' && isIP(hostname) === 0 ? { servername: hostname } : {}),
    };
    const request = transport(options, (response) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      }
      resolve(
        new Response(Readable.toWeb(response) as unknown as BodyInit, {
          status: response.statusCode ?? 502,
          headers: responseHeaders,
        }),
      );
    });
    request.on('error', reject);
    if (init?.signal) {
      const abort = () => request.destroy(new DOMException('The operation was aborted.', 'AbortError'));
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
      request.on('close', () => init.signal?.removeEventListener('abort', abort));
    }
    request.end(init?.body as string | Uint8Array | undefined);
  });
}

async function fetchFollowingRedirects(target: string, runtime: Runtime, signal: AbortSignal): Promise<{ response: Response; finalUrl: string }> {
  let current = await validateRemoteUrl(target, runtime);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response: Response;
    try {
      response = await runtime.fetch(
        current.url,
        {
          method: 'GET',
          redirect: 'manual',
          headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT },
          signal,
        },
        current.pin,
      );
    } catch (error) {
      if (error instanceof WebToolError || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new WebToolError('fetch_failed', `${current.url.href}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current.url.href };
    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: current.url.href };
    await response.body?.cancel().catch(() => {});
    if (redirects === MAX_REDIRECTS) throw new WebToolError('too_many_redirects', `more than ${MAX_REDIRECTS} redirects fetching ${target}`);
    const next = new URL(location, current.url);
    current = await validateRemoteUrl(next.href, runtime);
  }
  throw new WebToolError('too_many_redirects', `more than ${MAX_REDIRECTS} redirects fetching ${target}`);
}

function isHtml(contentType: string): boolean {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'text/html' || type === 'application/xhtml+xml';
}

function isJsShell(html: string): boolean {
  return /<script\b/i.test(html) && !/<p\b|<article\b|<main\b/i.test(html);
}

function extractArticle(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  const documentTitle = document.title?.trim() ?? '';
  const reader = new Readability(document as unknown as Document);
  const article = reader.parse();
  if (!article?.content) {
    const reason = isJsShell(html)
      ? 'the page appears to be JavaScript-rendered and this tool does not execute JavaScript'
      : 'the HTML had no readable article body';
    throw new WebToolError('extract_failed', `could not extract readable content from ${url}: ${reason}`);
  }
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  turndown.remove(['script', 'style', 'noscript', 'iframe']);
  const markdown = turndown.turndown(article.content).trim();
  if (markdown.length < MIN_EXTRACTED_CHARS) {
    throw new WebToolError(
      'extract_failed',
      `could not extract readable content from ${url}: only ${markdown.length} characters were extracted; the page may be a failure page or load its body with JavaScript`,
    );
  }
  return { title: article.title?.trim() || documentTitle || url, markdown };
}

interface CacheEntry {
  version: number;
  id: string;
  kind: 'search' | 'fetch';
  createdAt: number;
  title?: string;
  url?: string;
  content: string;
}

function cacheDir(dataDir: string): string {
  return join(dataDir, CACHE_DIR);
}

function cachePath(dir: string, id: string): string {
  if (!CACHE_ID.test(id)) throw new WebToolError('invalid_response_id', `"${id}" is not a response id returned by web_search or web_fetch`);
  return join(dir, `${id}.json`);
}

function pruneCache(dir: string, now: number, keepId?: string): void {
  if (!existsSync(dir)) return;
  const live: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') && !name.includes('.tmp-')) continue;
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (name.includes('.tmp-')) {
        rmSync(path, { force: true });
        continue;
      }
      if (now - stat.mtimeMs >= CACHE_TTL_MS && name !== `${keepId}.json`) {
        rmSync(path, { force: true });
        continue;
      }
      live.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // A racing prune already removed it.
    }
  }
  live.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let bytes = live.reduce((sum, entry) => sum + entry.size, 0);
  while (live.length > CACHE_MAX_ENTRIES || bytes > CACHE_MAX_BYTES) {
    const oldest = live.shift();
    if (!oldest) break;
    if (oldest.path === join(dir, `${keepId}.json`)) {
      if (live.length === 0) break;
      continue;
    }
    try {
      rmSync(oldest.path, { force: true });
      bytes -= oldest.size;
    } catch {
      // Already gone.
    }
  }
}

function writeCache(runtime: Runtime, entry: CacheEntry): void {
  const dir = cacheDir(runtime.dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneCache(dir, runtime.now(), entry.id);
  const path = cachePath(dir, entry.id);
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  pruneCache(dir, runtime.now(), entry.id);
}

function readCache(runtime: Runtime, id: string): CacheEntry {
  const dir = cacheDir(runtime.dataDir);
  pruneCache(dir, runtime.now(), id);
  const path = cachePath(dir, id);
  if (!existsSync(path)) {
    throw new WebToolError('cache_missing', `responseId "${id}" is not cached or is older than one hour; run web_search or web_fetch again`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    rmSync(path, { force: true });
    throw new WebToolError('cache_invalid', `responseId "${id}" is not readable; run web_search or web_fetch again`);
  }
  const entry = parsed as Partial<CacheEntry>;
  if (
    entry === null ||
    typeof entry !== 'object' ||
    entry.version !== CACHE_VERSION ||
    entry.id !== id ||
    (entry.kind !== 'search' && entry.kind !== 'fetch') ||
    typeof entry.createdAt !== 'number' ||
    typeof entry.content !== 'string'
  ) {
    rmSync(path, { force: true });
    throw new WebToolError('cache_invalid', `responseId "${id}" is not readable; run web_search or web_fetch again`);
  }
  if (runtime.now() - entry.createdAt >= CACHE_TTL_MS) {
    rmSync(path, { force: true });
    throw new WebToolError('cache_expired', `responseId "${id}" is older than one hour; run web_search or web_fetch again`);
  }
  return entry as CacheEntry;
}

function newId(): string {
  return randomUUID().replace(/-/g, '');
}

/** A page never ends inside a UTF-16 surrogate pair, so an emoji is not split into two halves. */
function safeEnd(content: string, end: number): number {
  if (end < content.length) {
    const code = content.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) return Math.min(content.length, end + 1);
  }
  return end;
}

function pageText(id: string, content: string, offset: number, limit: number): string {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new WebToolError('invalid_arguments', '"offset" must be a non-negative integer');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTPUT_CHARS) {
    throw new WebToolError('invalid_arguments', `"limit" must be an integer from 1 to ${MAX_OUTPUT_CHARS}`);
  }
  if (offset > content.length) {
    throw new WebToolError('offset_out_of_range', `offset ${offset} is past the end of responseId "${id}" (${content.length} characters)`);
  }
  const end = safeEnd(content, Math.min(content.length, offset + limit));
  const slice = content.slice(offset, end);
  if (end >= content.length) return slice;
  return `${slice}\n\n---\nShowing characters ${offset}-${end} of ${content.length}. Use web_recall({ responseId: "${id}", offset: ${end}, limit: ${Math.min(limit, MAX_OUTPUT_CHARS)} }) for the next page.`;
}

function findInContent(id: string, content: string, query: string): string {
  const needle = query.toLowerCase();
  const haystack = content.toLowerCase();
  const matches: string[] = [];
  let index = haystack.indexOf(needle);
  while (index >= 0 && matches.length < 5) {
    let start = Math.max(0, index - 160);
    if (start > 0) {
      const code = content.charCodeAt(start);
      if (code >= 0xdc00 && code <= 0xdfff) start -= 1;
    }
    const end = safeEnd(content, Math.min(content.length, index + query.length + 160));
    matches.push(`…${content.slice(start, end)}…`);
    index = haystack.indexOf(needle, index + Math.max(1, needle.length));
  }
  if (matches.length === 0) throw new WebToolError('find_text_no_match', `"${query}" does not occur in responseId "${id}"`);
  return matches.map((match, index) => `[${index + 1}] ${match}`).join('\n\n');
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseExaText(text: string): SearchResult[] {
  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart)) as { results?: Array<{ title?: string; url?: string; text?: string; highlights?: unknown }> };
      if (Array.isArray(parsed.results)) {
        return parsed.results
          .filter((result) => typeof result.url === 'string' && result.url !== '')
          .map((result) => ({
            title: (result.title ?? '').trim(),
            url: result.url as string,
            snippet: typeof result.text === 'string' ? result.text : '',
          }));
      }
    } catch {
      // Fall through to the text-block format.
    }
  }
  return text
    .split(/(?=^Title: )/m)
    .map((block) => {
      const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? '';
      const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? '';
      const contentStart = Math.max(block.indexOf('\nText: '), block.indexOf('\nHighlights:\n'));
      const snippet = contentStart >= 0 ? block.slice(contentStart).replace(/^\n(?:Text: |Highlights:\n)/, '').trim() : '';
      return { title, url, snippet };
    })
    .filter((result) => result.url !== '');
}

async function searchExa(query: string, numResults: number, runtime: Runtime, signal: AbortSignal): Promise<SearchResult[]> {
  const response = await runtime.fetch(`${EXA_MCP_URL}?tools=web_search_exa`, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query, numResults } },
    }),
    signal,
  });
  if (!response.ok) throw new WebToolError('exa_http_error', `Exa MCP answered ${response.status}`);
  const body = await response.text();
  let rpc: { result?: { _meta?: Record<string, unknown>; content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: { message?: string } } | undefined;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const candidate = JSON.parse(line.slice(5).trim()) as typeof rpc;
      if (candidate?.result || candidate?.error) {
        rpc = candidate;
        break;
      }
    } catch {
      // Not the JSON-RPC frame.
    }
  }
  if (!rpc) {
    try {
      rpc = JSON.parse(body) as typeof rpc;
    } catch {
      throw new WebToolError('exa_invalid_response', 'Exa MCP returned neither JSON nor an SSE frame');
    }
  }
  if (rpc?.error) throw new WebToolError('exa_error', rpc.error.message ?? 'Exa MCP returned an error');
  if (rpc?.result?._meta?.['ai.exa/rateLimited'] === true) throw new WebToolError('exa_rate_limited', 'Exa free MCP hit its rate limit');
  if (rpc?.result?.isError) {
    const text = rpc.result.content?.find((item) => item.type === 'text')?.text?.trim();
    throw new WebToolError('exa_error', text ?? 'Exa MCP returned an error');
  }
  const text = rpc?.result?.content?.find((item) => item.type === 'text' && item.text?.trim())?.text;
  if (!text) throw new WebToolError('exa_invalid_response', 'Exa MCP returned no text content');
  const results = parseExaText(text);
  if (results.length === 0) throw new WebToolError('exa_invalid_response', 'Exa MCP returned no parseable results');
  return results.slice(0, numResults);
}

function decodeDuckDuckGoUrl(href: string): string | null {
  try {
    const link = new URL(href, DUCKDUCKGO_URL);
    const destination = link.searchParams.get('uddg') ?? link.href;
    const url = new URL(destination);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

async function searchDuckDuckGo(query: string, numResults: number, runtime: Runtime, signal: AbortSignal): Promise<SearchResult[]> {
  const url = new URL(DUCKDUCKGO_URL);
  url.searchParams.set('q', query);
  const response = await runtime.fetch(url, {
    redirect: 'error',
    headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
    signal,
  });
  if (!response.ok) throw new WebToolError('duckduckgo_http_error', `DuckDuckGo answered ${response.status}`);
  const { document } = parseHTML(await response.text());
  if (response.status === 202 || document.querySelector('.anomaly-modal__box, #challenge-form')) {
    throw new WebToolError('duckduckgo_bot_check', 'DuckDuckGo answered with a bot check');
  }
  const results: SearchResult[] = [];
  let parseable = 0;
  for (const container of Array.from(document.querySelectorAll('.result'))) {
    if (container.classList.contains('result--ad')) continue;
    const anchor = container.querySelector('.result__a');
    const title = anchor?.textContent?.trim() ?? '';
    const href = anchor?.getAttribute('href')?.trim() ?? '';
    const resultUrl = href ? decodeDuckDuckGoUrl(href) : null;
    if (!title || !resultUrl) continue;
    parseable += 1;
    results.push({ title, url: resultUrl, snippet: container.querySelector('.result__snippet')?.textContent?.trim() ?? '' });
    if (results.length >= numResults) break;
  }
  if (parseable === 0 && !document.querySelector('.no-results__message')) {
    throw new WebToolError('duckduckgo_invalid_response', 'DuckDuckGo returned no parseable results');
  }
  return results;
}

function formatSearch(results: SearchResult[]): string {
  return results.map((result, index) => `${index + 1}. ${result.title}\n${result.url}${result.snippet ? `\n${result.snippet}` : ''}`).join('\n\n');
}

function numberArg(args: unknown, key: string, fallback: number, min: number, max: number): number {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new WebToolError('invalid_arguments', `"${key}" must be an integer from ${min} to ${max}`);
  }
  return value;
}

function definitions(runtime: Runtime, config: WebConfig): ToolDefinition[] {
  return [
    {
      name: 'web_search',
      replay: 'safe',
      description:
        'Search the web and return result titles, URLs and snippets. Both backends are off by default: enable Exa and/or DuckDuckGo in web.json, and enabled queries are sent to that third party (Exa first, DuckDuckGo as fallback). Results over 30,000 characters are cached; page the rest with web_recall using the returned responseId. This is a search, not a browser.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          numResults: { type: 'integer', minimum: 1, maximum: 10, description: 'Default 5' },
        },
        required: ['query'],
      },
      async execute({ args, signal }): Promise<ToolOutcome> {
        try {
          const query = asString(args, 'query');
          const numResults = numberArg(args, 'numResults', 5, 1, 10);
          if (!config.search.exa.enabled && !config.search.duckduckgo.enabled) {
            throw new WebToolError(
              'web_search_unavailable',
              `no search backend is enabled in ${join(runtime.dataDir, CONFIG_FILE)} (search.exa.enabled=false, search.duckduckgo.enabled=false); set one to true there to send queries to Exa or DuckDuckGo`,
            );
          }
          const failures: string[] = [];
          let results: SearchResult[] | undefined;
          let backend = '';
          if (config.search.exa.enabled) {
            try {
              results = await searchExa(query, numResults, runtime, requestSignal(SEARCH_TIMEOUT_MS, signal));
              backend = 'exa';
            } catch (error) {
              failures.push(`exa: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (!results && config.search.duckduckgo.enabled) {
            try {
              results = await searchDuckDuckGo(query, numResults, runtime, requestSignal(SEARCH_TIMEOUT_MS, signal));
              backend = 'duckduckgo';
            } catch (error) {
              failures.push(`duckduckgo: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (!results) throw new WebToolError('search_failed', `every enabled backend failed — ${failures.join('; ')}`);
          const id = newId();
          const content = formatSearch(results);
          writeCache(runtime, { version: CACHE_VERSION, id, kind: 'search', createdAt: runtime.now(), content });
          return { output: `responseId: ${id}\nBackend: ${backend}\n\n${pageText(id, content, 0, MAX_OUTPUT_CHARS)}` };
        } catch (error) {
          if (error instanceof WebToolError) return { output: error.message, isError: true };
          if (error instanceof Error && error.name === 'AbortError') throw error;
          if (error instanceof Error && (error.name === 'TimeoutError' || /timeout/i.test(error.message))) {
            return { output: `fetch_timeout: the request did not finish within ${FETCH_TIMEOUT_MS / 1000} seconds`, isError: true };
          }
          throw error;
        }
      },
    },
    {
      name: 'web_fetch',
      replay: 'safe',
      description:
        'Fetch one HTML page over HTTP and return its readable article text as Markdown. It does not execute JavaScript, so client-rendered pages may return an extraction error rather than their body. PDFs, GitHub special handling and video are not supported in this phase. Content over 30,000 characters is cached; page the rest with web_recall using the returned responseId.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
        required: ['url'],
      },
      async execute({ args, signal }): Promise<ToolOutcome> {
        try {
          const target = asString(args, 'url');
          const { response, finalUrl } = await fetchFollowingRedirects(target, runtime, requestSignal(FETCH_TIMEOUT_MS, signal));
          if (!response.ok) throw new WebToolError('http_error', `${finalUrl} answered HTTP ${response.status}`);
          const contentType = response.headers.get('content-type') ?? '';
          if (!isHtml(contentType)) {
            throw new WebToolError(
              'unsupported_content_type',
              `${finalUrl} is ${contentType || 'an unknown content type'}; phase 1 only extracts HTML pages (PDF and GitHub special handling are phase 2)`,
            );
          }
          const declaredLength = Number(response.headers.get('content-length') ?? '');
          if (Number.isFinite(declaredLength) && declaredLength > MAX_HTML_BYTES) {
            throw new WebToolError('page_too_large', `${finalUrl} declares ${declaredLength} bytes (cap ${MAX_HTML_BYTES})`);
          }
          const html = await response.text();
          if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
            throw new WebToolError('page_too_large', `${finalUrl} is larger than the ${MAX_HTML_BYTES}-byte cap`);
          }
          const article = extractArticle(html, finalUrl);
          const id = newId();
          writeCache(runtime, {
            version: CACHE_VERSION,
            id,
            kind: 'fetch',
            createdAt: runtime.now(),
            title: article.title,
            url: finalUrl,
            content: article.markdown,
          });
          const header = `Title: ${article.title}\nURL: ${finalUrl}\nresponseId: ${id}\n\n`;
          return { output: header + pageText(id, article.markdown, 0, MAX_OUTPUT_CHARS) };
        } catch (error) {
          if (error instanceof WebToolError) return { output: error.message, isError: true };
          throw error;
        }
      },
    },
    {
      name: 'web_recall',
      replay: 'safe',
      description:
        'Read cached content from web_search or web_fetch by responseId. Use offset/limit to page (limit at most 30,000 characters), or findText to locate passages. Cache entries expire after one hour.',
      parameters: {
        type: 'object',
        properties: {
          responseId: { type: 'string', description: 'The id returned by web_search or web_fetch' },
          offset: { type: 'integer', minimum: 0, description: 'Character offset; default 0' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_CHARS, description: `Characters to return; default ${MAX_OUTPUT_CHARS}` },
          findText: { type: 'string', description: 'Return up to five passages containing this text instead of paging' },
        },
        required: ['responseId'],
      },
      async execute({ args }): Promise<ToolOutcome> {
        try {
          const id = asString(args, 'responseId');
          const entry = readCache(runtime, id);
          const findText = (args as Record<string, unknown> | undefined)?.findText;
          if (findText !== undefined) {
            if (typeof findText !== 'string' || findText.trim() === '') {
              throw new WebToolError('invalid_arguments', '"findText" must be a non-empty string');
            }
            return { output: findInContent(id, entry.content, findText) };
          }
          const offset = numberArg(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
          const limit = numberArg(args, 'limit', MAX_OUTPUT_CHARS, 1, MAX_OUTPUT_CHARS);
          return { output: pageText(id, entry.content, offset, limit) };
        } catch (error) {
          if (error instanceof WebToolError) return { output: error.message, isError: true };
          throw error;
        }
      },
    },
  ];
}

export function webPlugin(options: WebPluginOptions): NativePlugin {
  return {
    name: 'web',
    apply(ctx) {
      const runtime: Runtime = {
        fetch: options.fetch ?? ((input, init, pin) => (pin ? fetchPinned(input, init, pin) : fetch(input, init))),
        lookup: options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true })),
        allowLoopback: options.allowLoopback === true,
        now: options.now ?? Date.now,
        dataDir: options.dataDir,
      };
      const config = readWebConfig(options.dataDir);
      for (const definition of definitions(runtime, config)) ctx.registerTool(definition);
    },
  };
}

interface ShellService {
  readonly config: { readonly dataDir: string };
}

interface CageService {
  allowTools(names: readonly string[]): void;
}

/**
 * The opt-in plugin a user registers with `/plugins add cogmem/web`. It is not registered by the
 * resident itself: without this spec the three tools do not exist, and its allowance is not in the
 * cage whitelist. Registering it adds both at once.
 */
const defaultWebPlugin: NativePlugin = {
  name: 'web',
  inject: ['shell', 'cage'],
  apply(ctx) {
    const dataDir = ctx.getService<ShellService>('shell').config.dataDir;
    ctx.getService<CageService>('cage').allowTools(WEB_TOOL_NAMES);
    return webPlugin({ dataDir }).apply(ctx, {});
  },
};

export default defaultWebPlugin;
