import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { backoffMs, createJsonGetter, createLimiter, parseRetryAfter, RetryableError, withRetry } from "../src/polite.mjs";

const noWait = async () => {};

test("backoff stays within [ceiling/2, ceiling] and never exceeds the cap (property)", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 40 }), fc.integer({ min: 1, max: 5000 }), fc.integer({ min: 1, max: 120_000 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (k, base, cap, r) => {
    const ms = backoffMs(k, { base, cap, rand: () => r });
    const ceiling = Math.min(cap, base * 2 ** k);
    return ms >= Math.floor(ceiling / 2) && ms <= ceiling && ms <= cap;
  }));
});

test("withRetry retries only retryable errors, and gives up after `attempts`", async () => {
  let calls = 0;
  await assert.rejects(withRetry(() => { calls++; throw new RetryableError("503"); }, { attempts: 4, wait: noWait }), /503/);
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(withRetry(() => { calls++; throw new Error("404"); }, { attempts: 4, wait: noWait }), /404/);
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(await withRetry(() => { if (++calls < 3) throw new RetryableError("x"); return "ok"; }, { attempts: 5, wait: noWait }), "ok");
});

test("withRetry waits at least Retry-After", async () => {
  const waits = [];
  let calls = 0;
  await withRetry(() => { if (++calls === 1) throw new RetryableError("429", { retryAfterMs: 7000 }); return 1; }, { wait: async (ms) => waits.push(ms), base: 1, rand: () => 0 });
  assert.equal(waits[0], 7000);
});

test("parseRetryAfter: seconds, dates, junk, and a cap", () => {
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter("99999"), 120_000);
  assert.equal(parseRetryAfter("soon"), undefined);
  assert.equal(parseRetryAfter(""), undefined);
  assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), { now: 4000 }), 6000);
  fc.assert(fc.property(fc.string(), (s) => { const v = parseRetryAfter(s); return v === undefined || (v >= 0 && v <= 120_000); }));
});

test("limiter: never more than `concurrency` in flight, and starts are spaced by 1/rps", async () => {
  let t = 0;
  const starts = [];
  const lim = createLimiter({ rps: 4, concurrency: 2, now: () => t, wait: async (ms) => { t += ms; } });
  let inFlight = 0, peak = 0;
  await Promise.all(Array.from({ length: 12 }, (_, i) => lim.schedule(async () => {
    starts.push(t); inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setImmediate(r));
    inFlight--; return i;
  })));
  assert.ok(peak <= 2, `peak ${peak}`);
  const sorted = [...starts].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= 250 - 1e-9, `gap ${sorted[i] - sorted[i - 1]}`);
});

function fakeFetch(script) {
  let i = 0;
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(i++, script.length - 1)];
    if (step instanceof Error) throw step;
    return { status: step.status, ok: step.status >= 200 && step.status < 300, headers: { get: (k) => (step.headers ?? {})[k.toLowerCase()] ?? null }, text: async () => step.body ?? "" };
  };
  f.calls = calls;
  return f;
}

test("getJson: 503 then 200 succeeds; identifies itself; 404 is final; HTML is retried then fails", async () => {
  const f1 = fakeFetch([{ status: 503, headers: { "retry-after": "1" } }, { status: 200, body: '{"a":1}' }]);
  const g1 = createJsonGetter({ fetchImpl: f1, wait: noWait });
  assert.deepEqual(await g1("https://x/api"), { a: 1 });
  assert.equal(f1.calls.length, 2);
  assert.match(f1.calls[0].init.headers["user-agent"], /flopscan.*read-only/);

  const f2 = fakeFetch([{ status: 404, body: "nope" }]);
  await assert.rejects(createJsonGetter({ fetchImpl: f2, wait: noWait })("https://x"), /HTTP 404/);
  assert.equal(f2.calls.length, 1);

  const f3 = fakeFetch([{ status: 200, body: "<html>maintenance</html>" }]);
  await assert.rejects(createJsonGetter({ fetchImpl: f3, wait: noWait, attempts: 3 })("https://x"), /not JSON/);
  assert.equal(f3.calls.length, 3);

  const f4 = fakeFetch([new TypeError("fetch failed"), { status: 200, body: "[]" }]);
  assert.deepEqual(await createJsonGetter({ fetchImpl: f4, wait: noWait })("https://x"), []);
});

test("a retry pauses the whole limiter: queued requests start no earlier than the backoff", async () => {
  let t = 0;
  const lim = createLimiter({ rps: 100, concurrency: 4, now: () => t, wait: async (ms) => { t += ms; } });
  lim.pause(5000);
  const starts = await Promise.all([1, 2, 3].map(() => lim.schedule(async () => t)));
  for (const s of starts) assert.ok(s >= 5000, `started at ${s}`);
  assert.equal(lim.stats.pauses, 1);
});

test("an RPC 503 through politeProvider is retried and pauses the shared limiter", async () => {
  const { politeProvider } = await import("../src/chain.mjs");
  let t = 0;
  const lim = createLimiter({ rps: 100, concurrency: 1, now: () => t, wait: async (ms) => { t += ms; } });
  let calls = 0;
  const provider = { send: async () => { if (++calls < 3) throw new Error("[503]: Service Unavailable"); return "ok"; } };
  politeProvider(provider, { limiter: lim, wait: async (ms) => { t += ms; } });
  assert.equal(await provider.send("chain_getHeader", []), "ok");
  assert.equal(calls, 3);
  assert.equal(lim.stats.pauses, 2);
  // A wrong-chain or bad-params error is final.
  const p2 = { send: async () => { throw new Error("-32602: Invalid params"); } };
  politeProvider(p2, { limiter: lim, wait: async () => {} });
  await assert.rejects(p2.send("x", []), /Invalid params/);
});
