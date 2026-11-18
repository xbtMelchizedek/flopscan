// Polite I/O: a min-interval rate limiter, retry with capped exponential backoff and jitter, and
// a fetch wrapper that honours Retry-After. Public RPC and explorer are shared infrastructure;
// we would rather be slow than be the reason they 503.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** At most `rps` starts per second and at most `concurrency` in flight. FIFO. */
export function createLimiter({ rps = 4, concurrency = 4, now = () => Date.now(), wait = sleep } = {}) {
  if (!(rps > 0) || !(concurrency >= 1)) throw new RangeError("rps > 0 and concurrency >= 1");
  const gap = 1000 / rps;
  let next = 0;
  let active = 0;
  const queue = [];
  let stats = { started: 0, maxActive: 0 };
  const pump = async () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active++;
      stats.maxActive = Math.max(stats.maxActive, active);
      const t = now();
      const at = Math.max(t, next);
      next = at + gap;
      (async () => {
        if (at > t) await wait(at - t);
        stats.started++;
        try { job.resolve(await job.fn()); } catch (e) { job.reject(e); } finally { active--; pump(); }
      })();
    }
  };
  return {
    schedule(fn) { return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); }); },
    get stats() { return { ...stats, queued: queue.length, active }; },
  };
}

/** Backoff for attempt k (0-based): min(cap, base * 2^k), with full jitter drawn from `rand`. */
export function backoffMs(k, { base = 500, cap = 30_000, rand = Math.random } = {}) {
  const ceiling = Math.min(cap, base * 2 ** k);
  return Math.floor(ceiling / 2 + rand() * (ceiling / 2));
}

export class RetryableError extends Error {
  constructor(message, { retryAfterMs } = {}) { super(message); this.retryAfterMs = retryAfterMs; }
}

/** Retry `fn` while it throws something `isRetryable` says yes to, up to `attempts` tries. */
export async function withRetry(fn, { attempts = 5, isRetryable = (e) => e instanceof RetryableError, wait = sleep, base, cap, rand, onRetry } = {}) {
  let last;
  for (let k = 0; k < attempts; k++) {
    try { return await fn(k); } catch (e) {
      last = e;
      if (k === attempts - 1 || !isRetryable(e)) throw e;
      const ms = Math.max(e.retryAfterMs ?? 0, backoffMs(k, { base, cap, rand }));
      onRetry?.(e, k, ms);
      await wait(ms);
    }
  }
  throw last;
}

/** Retry-After as ms: delta-seconds or an HTTP date; capped so a hostile header cannot park us. */
export function parseRetryAfter(value, { now = Date.now(), capMs = 120_000 } = {}) {
  if (value == null || value === "") return undefined;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return Math.min(capMs, Number(s) * 1000);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  return Math.min(capMs, Math.max(0, t - now));
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export const USER_AGENT = "flopscan/1 (+https://github.com/xbtMelchizedek/flopscan; read-only)";

/** GET JSON with a timeout, retrying 429/5xx and network errors. 4xx other than those is final. */
export function createJsonGetter({ limiter, fetchImpl = globalThis.fetch, attempts = 7, timeoutMs = 30_000, wait = sleep, rand, base = 1000, cap = 30_000, onRetry } = {}) {
  return async function getJson(url) {
    return withRetry(async () => {
      const run = async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        let res;
        try {
          res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: ctl.signal });
        } catch (e) {
          throw new RetryableError(`GET ${url}: ${e.name === "AbortError" ? "timeout" : e.message}`);
        } finally { clearTimeout(timer); }
        if (RETRY_STATUS.has(res.status)) {
          throw new RetryableError(`GET ${url}: HTTP ${res.status}`, { retryAfterMs: parseRetryAfter(res.headers?.get?.("retry-after")) });
        }
        if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
        const text = await res.text();
        try { return JSON.parse(text); } catch { throw new RetryableError(`GET ${url}: body is not JSON`); }
      };
      return limiter ? limiter.schedule(run) : run();
    }, { attempts, wait, rand, base, cap, onRetry });
  };
}
