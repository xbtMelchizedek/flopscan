import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Ajv from "ajv";
import fc from "fast-check";
import { buildMetrics } from "../src/metrics.mjs";
import { scan } from "../src/scan.mjs";
import { makeWorld } from "./helpers/world.mjs";

const schema = JSON.parse(readFileSync(new URL("../schema/v1.json", import.meta.url)));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const tmp = () => mkdtempSync(join(tmpdir(), "flopscan-"));

async function run(knobs = {}, dirs = { out: tmp(), cache: tmp() }) {
  const w = makeWorld(knobs);
  const doc = await scan({ outDir: dirs.out, cacheDir: dirs.cache, getJson: w.getJson, connectChain: async () => w.readers, fetchImpl: w.fetchImpl, now: w.now, bundlePath: join(dirs.out, "bundle.json") });
  return { doc, w, dirs, byId: new Map(doc.metrics.map((m) => [m.id, m])) };
}

/** The banteg rule, checked on every scalar metric. */
function assertRule(doc) {
  for (const m of doc.metrics) {
    if (m.kind === "table") continue;
    const deciding = (m.readings ?? []).filter((r) => !r.context && r.value !== null);
    if (m.value !== null) {
      assert.equal(m.status, "match", `${m.id} has a value but status ${m.status}`);
      assert.ok(deciding.length >= 2 || m.method === "rowwise", `${m.id} has a value from ${deciding.length} reading(s)`);
    }
    if (m.status !== "match") assert.equal(m.value, null, `${m.id} is ${m.status} but shows ${m.value}`);
  }
}

test("a consistent world: every metric agrees, output validates against the schema", async () => {
  const { doc, byId } = await run();
  assert.ok(validate(doc), JSON.stringify(validate.errors?.slice(0, 3)));
  assertRule(doc);
  const bad = doc.metrics.filter((m) => m.kind !== "table" && m.status !== "match").map((m) => `${m.id}:${m.status}`);
  // The faucet window needs two runs of history, so it is pending on the first run. Nothing else may be.
  assert.deepEqual(bad, ["faucet.transactions_window:pending"]);
  assert.deepEqual(doc.sources.errors, {});
  assert.deepEqual(bad, ["faucet.transactions_window:pending"]);
  assert.equal(doc.summary.mismatch, 0);
  assert.equal(byId.get("rewards.periods").value, "10");
  assert.equal(byId.get("rewards.periods_with_miner_payout").value, "5");
  assert.equal(byId.get("runtime.upgrades").value, "2");
  assert.equal(byId.get("verifiers.settlementSp1Pallet").value, "1");
  assert.equal(byId.get("forward.activity").value, "none");
  assert.equal(doc.as_of.block, 1000);
  assert.equal(doc.window.lo.block, 995);
});

test("explorer and chain disagree on settled compute: mismatch, both readings kept, no number", async () => {
  const { doc, byId } = await run({ minerPaidSkew: 1 });
  const m = byId.get("compute.miner_paid");
  assert.equal(m.status, "mismatch");
  assert.equal(m.value, null);
  assert.equal(m.delta, "1");
  assert.ok(m.readings.filter((r) => r.value !== null).length >= 4);
  assertRule(doc);
});

test("a registry digest that differs from the explorer's pin is a mismatch", async () => {
  const { byId } = await run({ registryDigest: `sha256:${"b".repeat(64)}` });
  assert.equal(byId.get("release.cli").status, "mismatch");
});

test("explorer down: explorer-backed metrics are pending, chain-only checks still run, nothing invented", async () => {
  const { doc, byId } = await run({ httpDown: () => true });
  assertRule(doc);
  assert.equal(byId.get("compute.miner_paid").status, "pending");
  assert.equal(byId.get("agents.identities").status, "match"); // three chain readings
  assert.equal(byId.get("runtime.current").status, "match");
  assert.ok(doc.sources.errors.explorer);
  assert.ok(validate(doc), JSON.stringify(validate.errors?.slice(0, 3)));
});

test("chain down: everything that needs the chain is pending", async () => {
  const w = makeWorld();
  const doc = await scan({ outDir: tmp(), cacheDir: tmp(), getJson: w.getJson, connectChain: async () => { throw new Error("connect: HTTP 503"); }, fetchImpl: w.fetchImpl, now: w.now });
  assertRule(doc);
  assert.equal(doc.as_of, null);
  assert.equal(doc.summary.match, doc.metrics.filter((m) => m.kind !== "table" && m.status === "match").length);
  for (const id of ["compute.miner_paid", "supply.total_issuance", "miners.registered", "rewards.miner_minted"]) assert.equal(doc.metrics.find((m) => m.id === id).status, "pending", id);
  assert.ok(validate(doc), JSON.stringify(validate.errors?.slice(0, 3)));
});

test("last agreed value is carried, labelled with its block, when a later run cannot agree", async () => {
  const dirs = { out: tmp(), cache: tmp() };
  await run({}, dirs);
  const { byId } = await run({ httpDown: (p) => p === "/api/stats" }, dirs);
  const m = byId.get("supply.total_issuance");
  assert.equal(m.status, "pending");
  assert.equal(m.value, null);
  assert.equal(m.last_match.block, 1000);
});

test("faucet window appears on the second run and reconciles", async () => {
  const dirs = { out: tmp(), cache: tmp() };
  await run({ head: 1000, lo: 995 }, dirs);
  const { byId } = await run({ head: 1600, lo: 1590 }, dirs);
  const m = byId.get("faucet.transactions_window");
  assert.equal(m.status, "match");
  assert.equal(m.value, "595"); // explorer txCount moved with the indexed block (lo), inside the chain's range
  assert.equal(byId.get("faucet.outflow_window").status, "match");
});

// Fuzz: take a real-shaped bundle, corrupt one leaf at random, rebuild. Must not throw; must keep the rule; must validate.
test("fuzz: corrupted bundles never crash the builders or break the rule (property)", async () => {
  const { dirs } = await run();
  const bundle = JSON.parse(readFileSync(join(dirs.out, "bundle.json"), "utf8"));
  const paths = [];
  const walk = (o, p) => { if (o && typeof o === "object") for (const k of Object.keys(o)) walk(o[k], [...p, k]); else paths.push(p); };
  walk(bundle, []);
  const junk = fc.constantFrom(null, undefined, "", "abc", "-1", "1.5", "1e30", -7, 3.14, Number.MAX_VALUE, {}, [], "0x" + "f".repeat(70), "99999999999999999999999999999999999999");
  fc.assert(fc.property(fc.array(fc.tuple(fc.nat(paths.length - 1), junk), { minLength: 1, maxLength: 4 }), (edits) => {
    const b = structuredClone(bundle);
    for (const [i, v] of edits) { const p = paths[i]; let o = b; for (const k of p.slice(0, -1)) o = o[k]; o[p.at(-1)] = v; }
    const metrics = buildMetrics(b);
    const doc = { ...JSON.parse(readFileSync(join(dirs.out, "latest.json"), "utf8")), metrics };
    assertRule(doc);
    if (validate(doc)) return true;
    const i = Number(validate.errors[0].instancePath.split("/")[2]);
    throw new Error(`${JSON.stringify(edits.map(([k, v]) => [paths[k].join("."), v]))} -> ${JSON.stringify(validate.errors.filter((e) => !["kind", "columns"].includes(e.params?.missingProperty)).slice(0, 4))} ${JSON.stringify(metrics[i]).slice(0, 300)}`);
  }), { numRuns: Number(process.env.FUZZ_RUNS ?? 300) });
});
