// Polite HTTP client for Polymarket public APIs.
// - global rate limit (default 7 req/s, hard cap 8) + bounded concurrency
// - retries with exponential backoff on 429 / 5xx / network errors
// - gzip disk cache keyed by method+url+body so re-runs resume for free
// Run node with: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CACHE_DIR = path.join(ROOT, 'data', 'raw', 'cache');

const RPS = Math.min(Number(process.env.BTC_RPS || 7), 8);
const MAX_CONC = Number(process.env.BTC_CONC || 6);
const minGapMs = 1000 / RPS;

let lastStart = 0;
let active = 0;
const waiters = [];
export const stats = { requests: 0, cacheHits: 0, retries: 0, failures: 0, bytes: 0, byHost: {} };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire() {
  while (active >= MAX_CONC) await new Promise((r) => waiters.push(r));
  active++;
  const now = Date.now();
  const wait = Math.max(0, lastStart + minGapMs - now);
  lastStart = Math.max(now, lastStart + minGapMs);
  if (wait) await sleep(wait);
}
function release() {
  active--;
  const w = waiters.shift();
  if (w) w();
}

function cacheKey(method, url, body) {
  return crypto.createHash('sha1').update(`${method} ${url} ${body || ''}`).digest('hex');
}
function cachePath(url, key) {
  const host = new URL(url).host.split('.')[0];
  return path.join(CACHE_DIR, host, key.slice(0, 2), key + '.json.gz');
}

/**
 * Fetch JSON. opts: {method, body (object -> JSON), cache (default true), retries (default 6), allowStatus: [codes returned as {__status}]}
 */
export async function getJSON(url, opts = {}) {
  const method = opts.method || 'GET';
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const useCache = opts.cache !== false;
  const key = cacheKey(method, url, body);
  const cp = cachePath(url, key);
  if (useCache && fs.existsSync(cp)) {
    try {
      stats.cacheHits++;
      return JSON.parse(zlib.gunzipSync(fs.readFileSync(cp)).toString('utf8'));
    } catch { /* corrupt cache entry: refetch */ }
  }
  const retries = opts.retries ?? 6;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await acquire();
    let res, text;
    try {
      stats.requests++;
      const host = new URL(url).host;
      stats.byHost[host] = (stats.byHost[host] || 0) + 1;
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), opts.timeoutMs || 60000);
      res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
        body,
        signal: ctl.signal,
      });
      text = await res.text();
      clearTimeout(to);
    } catch (e) {
      lastErr = e;
      release();
      stats.retries++;
      await sleep(Math.min(30000, 500 * 2 ** attempt) + Math.random() * 300);
      continue;
    }
    release();
    stats.bytes += text.length;
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status} ${url} ${text.slice(0, 200)}`);
      stats.retries++;
      const ra = Number(res.headers.get('retry-after'));
      await sleep(ra ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500);
      continue;
    }
    if (res.status !== 200) {
      if (opts.allowStatus && opts.allowStatus.includes(res.status)) return { __status: res.status, __text: text.slice(0, 500) };
      stats.failures++;
      throw new Error(`HTTP ${res.status} ${url} ${text.slice(0, 300)}`);
    }
    let json;
    try { json = JSON.parse(text); } catch (e) { lastErr = e; stats.retries++; await sleep(1000); continue; }
    if (useCache) {
      fs.mkdirSync(path.dirname(cp), { recursive: true });
      fs.writeFileSync(cp, zlib.gzipSync(text));
    }
    return json;
  }
  stats.failures++;
  throw lastErr || new Error('fetch failed ' + url);
}

/** Run async fn over items with bounded concurrency (rate limit still applies globally). */
export async function pool(items, conc, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __error: String(e && e.message || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}
