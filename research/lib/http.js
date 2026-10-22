// Small HTTP toolkit for the research collector: JSON fetch with timeout/retries/backoff,
// a concurrency limiter, a requests-per-second limiter and an on-disk response cache.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(url, status, body) {
    const snippet = body ? `: ${String(body).slice(0, 300)}` : '';
    super(`HTTP ${status} for ${url}${snippet}`);
    this.name = 'HttpError';
    this.url = url;
    this.status = status;
    this.body = body == null ? '' : String(body);
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
export const isRetryableStatus = (status) => RETRYABLE_STATUS.has(status);

// Retry-After is either delta-seconds or an HTTP date.
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// "Equal jitter": half the exponential delay is fixed, half random, so retries never collapse to ~0.
export function backoffDelay(attempt, baseMs = 1000, maxMs = 30000) {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return exp / 2 + Math.random() * (exp / 2);
}

export function createLimiter(concurrency) {
  const max = Math.max(1, Math.floor(concurrency) || 1);
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  const run = (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
  run.stats = () => ({ active, queued: queue.length });
  return run;
}

// Spaces request starts at least 1000/rps ms apart; pauseUntil() lets a 429 stall every caller.
export function createRateLimiter(rps) {
  const interval = rps > 0 && Number.isFinite(rps) ? 1000 / rps : 0;
  let nextAt = 0;
  let pausedUntil = 0;
  const wait = async () => {
    for (;;) {
      const now = Date.now();
      if (pausedUntil > now) {
        await sleep(pausedUntil - now);
        continue;
      }
      const at = Math.max(now, nextAt);
      nextAt = at + interval;
      if (at > now) await sleep(at - now);
      // A pause may have been set while we slept; honor it before firing.
      if (pausedUntil > Date.now()) continue;
      return;
    }
  };
  wait.pauseUntil = (ts) => {
    pausedUntil = Math.max(pausedUntil, ts);
  };
  return wait;
}

export async function writeFileAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export const cachePathFor = (cacheDir, url) =>
  path.join(cacheDir, `${createHash('sha1').update(url).digest('hex')}.json`);

/**
 * GET a URL and parse JSON. Retries network errors, timeouts, bad JSON, 429 and 5xx with
 * exponential backoff + jitter; a Retry-After header overrides the backoff (capped).
 * Returns the parsed body, or null on 404 when allow404 is set. Throws HttpError otherwise.
 */
export async function fetchJson(url, opts = {}) {
  const {
    timeoutMs = 30000,
    retries = 6,
    retryBaseMs = 1000,
    retryMaxMs = 30000,
    maxRetryAfterMs = 120000,
    allow404 = false,
    headers = {},
    beforeAttempt = null,
    onRetry = null,
    onResponse = null,
    onRetryAfter = null,
  } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (beforeAttempt) await beforeAttempt();
    let retryAfterMs = null;
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (onResponse) onResponse(res.status);
      if (res.status === 404 && allow404) return null;
      if (res.ok) {
        try {
          return text === '' ? null : JSON.parse(text);
        } catch {
          // Truncated bodies happen behind proxies; treat as transient.
          throw Object.assign(new Error(`Invalid JSON from ${url}: ${text.slice(0, 120)}`), { retryable: true });
        }
      }
      const err = new HttpError(url, res.status, text);
      if (!isRetryableStatus(res.status)) throw err;
      err.retryable = true;
      retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      if (retryAfterMs != null) retryAfterMs = Math.min(retryAfterMs, maxRetryAfterMs);
      lastErr = err;
    } catch (err) {
      if (err instanceof HttpError && !err.retryable) throw err;
      if (!(err instanceof HttpError) && err.retryable !== true && !isNetworkError(err)) throw err;
      lastErr = err;
    }
    if (attempt === retries) break;
    const delay = retryAfterMs != null ? retryAfterMs + Math.random() * 250 : backoffDelay(attempt, retryBaseMs, retryMaxMs);
    if (retryAfterMs != null && onRetryAfter) onRetryAfter(Date.now() + delay);
    if (onRetry) onRetry({ url, attempt: attempt + 1, delay, error: lastErr });
    await sleep(delay);
  }
  const note = `(gave up after ${retries + 1} attempts)`;
  if (lastErr instanceof HttpError) {
    lastErr.message = `${lastErr.message} ${note}`;
    throw lastErr;
  }
  // DOMException/TypeError messages can be read-only, so wrap rather than mutate.
  throw new Error(`${lastErr?.name || 'Error'}: ${lastErr?.message || 'request failed'} for ${url} ${note}`, { cause: lastErr });
}

function isNetworkError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  // undici surfaces connection failures as TypeError('fetch failed') with the real error as cause;
  // other TypeErrors (e.g. an unparsable URL) are bugs and must not be retried.
  const text = `${err.message} ${err.cause?.code || ''} ${err.cause?.message || ''}`;
  return (err.name === 'TypeError' && /fetch failed/i.test(err.message)) || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR|socket/i.test(text);
}

/**
 * Shared client: one concurrency limiter + one rps limiter for all requests, optional cache.
 * getJson(url, { cache, allow404 }) — cached entries are stored as { url, status, savedAt, body }
 * under cacheDir/<sha1(url)>.json; 404s are cached too (as body null) when allow404 is set.
 */
export function createHttpClient(options = {}) {
  const {
    concurrency = 4,
    rps = 4,
    cacheDir = null,
    log = () => {},
    ...fetchOpts
  } = options;
  const limit = createLimiter(concurrency);
  const throttle = createRateLimiter(rps);
  const stats = { requests: 0, cacheHits: 0, retries: 0, failures: 0, byStatus: {} };

  async function readCache(file) {
    try {
      const entry = JSON.parse(await readFile(file, 'utf8'));
      return entry && 'body' in entry ? entry : null;
    } catch {
      return null;
    }
  }

  async function getJson(url, { cache = false, allow404 = false } = {}) {
    const file = cache && cacheDir ? cachePathFor(cacheDir, url) : null;
    if (file) {
      const hit = await readCache(file);
      if (hit) {
        stats.cacheHits++;
        return hit.body;
      }
    }
    let body;
    let lastStatus = null;
    try {
      body = await limit(() =>
        fetchJson(url, {
          ...fetchOpts,
          allow404,
          beforeAttempt: async () => {
            await throttle();
            stats.requests++;
          },
          onResponse: (status) => {
            lastStatus = status;
            stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
          },
          onRetryAfter: (ts) => throttle.pauseUntil(ts),
          onRetry: ({ attempt, delay, error }) => {
            stats.retries++;
            log(`retry ${attempt} in ${Math.round(delay)}ms: ${String(error.message).slice(0, 160)}`);
          },
        })
      );
    } catch (err) {
      stats.failures++;
      throw err;
    }
    if (file) {
      await writeFileAtomic(file, JSON.stringify({ url, status: lastStatus, savedAt: Date.now(), body }));
    }
    return body;
  }

  return { getJson, stats };
}
