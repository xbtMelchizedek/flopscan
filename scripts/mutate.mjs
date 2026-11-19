#!/usr/bin/env node
// Mutation check: break the code on purpose, one rule at a time, and require the test suite to fail.
// A mutant that survives means a rule nothing tests. Exit 1 if any survives or any mutation no
// longer applies (the code moved and the list needs updating).
//
//   node scripts/mutate.mjs            run all
//   node scripts/mutate.mjs --list     list mutations

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const MUTATIONS = [
  ["src/reconcile.mjs", "const agree = deciding.every((r) => r.value === first);", "const agree = deciding.some((r) => r.value === first);", "exact: one agreeing pair is enough"],
  ["src/reconcile.mjs", "const deciding = readings.filter((r) => !r.context && r.value !== null);", "const deciding = readings.filter((r) => r.value !== null);", "exact: context readings decide"],
  ["src/reconcile.mjs", "const inside = low <= x && x <= high;", "const inside = low <= x;", "bracketed: no upper bound"],
  ["src/reconcile.mjs", "if (ja !== null && ja === jb) agreed++;", "if (ja !== null) agreed++;", "rows: any present row counts as agreeing"],
  ["src/reconcile.mjs", "if (statuses.includes(STATUS.MISMATCH)) return STATUS.MISMATCH;", "", "worst: a mismatch can hide"],
  ["src/settlements.mjs", "next.rows[rowId(r)] = compact(r);", "next.rows[`${rowId(r)}#${Object.keys(next.rows).length}`] = compact(r);", "settlements: no dedupe"],
  ["src/settlements.mjs", "if (b > upTo) continue;", "if (b >= upTo) continue;", "settlements: off-by-one block bound"],
  ["src/settlements.mjs", "&& int(d.burned) === String(row.burned)", "", "settlements: burned not checked on chain"],
  ["src/settlements.mjs", "!/^\\d+$/.test(String(r.minerPaid ?? \"0\")) ||", "", "settlements: float amounts accepted"],
  ["src/runtime.mjs", "if (va === vb) return;", "if (va === vb || b - a < 64) return;", "runtime: short spans skipped"],
  ["src/runtime.mjs", "spans[spans.length - 1].to_block = b.block - 1;", "spans[spans.length - 1].to_block = b.block;", "runtime: spans overlap"],
  ["src/polite.mjs", "const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);", "const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 504]);", "http: 503 not retried"],
  ["src/polite.mjs", "if (/^\\d+$/.test(s)) return Math.min(capMs, Number(s) * 1000);", "if (/^\\d+$/.test(s)) return Number(s) * 1000;", "http: Retry-After not capped"],
  ["src/polite.mjs", "next = at + gap;", "next = at;", "limiter: no spacing between requests"],
  ["src/polite.mjs", "if (k === attempts - 1 || !isRetryable(e)) throw e;", "if (k === attempts - 1) throw e;", "retry: final errors retried"],
  ["src/metrics.mjs", "if (typeof v === \"string\" && /^-?\\d+$/.test(v)) return v;", "if (typeof v === \"string\" && /^-?[\\d.e]+$/.test(v)) return v;", "metrics: float strings accepted as integers"],
  ["src/metrics.mjs", "if (chain.some((r) => r.value === observed.value)) return { status: STATUS.MATCH", "if (true) return { status: STATUS.MATCH", "faucet: balance always agrees"],
  ["src/metrics.mjs", "return p?.last_match ? { ...m, last_match: p.last_match } : m;", "return p?.last_match ? { ...m, value: p.last_match.value, last_match: p.last_match } : m;", "carry: stale value shown as current"],
  ["src/metrics.mjs", "const status = !ok || checked === \"0\" ? STATUS.PENDING : disagreed === \"0\" ? STATUS.MATCH : STATUS.MISMATCH;", "const status = !ok || checked === \"0\" ? STATUS.PENDING : STATUS.MATCH;", "settlement rows: unconfirmed rows pass"],
  ["src/metrics.mjs", "if (!r0 || typeof r0.component !== \"string\" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(r0.component)) continue;", "if (!r0) continue;", "releases: unsanitised component names"],
  ["src/scan.mjs", "store.put(\"reward-periods\", periods); unit(`period ${b}`);", "unit(`period ${b}`);", "resume: periods not saved as they are read"],
  ["src/scan.mjs", "if (cache[t.hash]) confirmed++;", "confirmed++;", "verifiers: explorer trusted without the chain"],
  ["src/scan.mjs", "if (!r.explorer_digest || r.explorer_digest !== r.registry_digest) continue;", "if (!r.explorer_digest) continue;", "release history: unverified versions recorded"],
  ["src/sources/explorer.mjs", "!/^0x[0-9a-f]{64}$/.test(hash)", "false", "explorer: malformed head hash accepted"],
  ["src/rewards.mjs", "if (counter !== sums[leg]) {", "if (false) {", "rewards: counters not checked against events"],
  ["src/reconcile.mjs", "if (!Number.isSafeInteger(out.block) || out.block < 0) delete out.block;", "", "provenance: malformed block numbers published"],
  ["scripts/build-site.mjs", "<strong>Devnet data, not financial information. Unaudited.</strong>", "<strong>Live data.</strong>", "site: disclaimer removed"],
  ["src/format.mjs", "export const esc = (s) => String(s ?? \"\").replace(/[&<>\"']/g, (c) => ESC[c]);", "export const esc = (s) => String(s ?? \"\");", "site: no HTML escaping"],
  ["src/format.mjs", "const frac = digits.slice(-DECIMALS).slice(0, places).replace(/0+$/, \"\");", "const frac = digits.slice(-DECIMALS).slice(0, places + 1).replace(/0+$/, \"\");", "format: shows a digit it should have dropped"],
  ["src/reconcile.mjs", "if (agree && classes(deciding) < 2) return", "if (false) return", "independence: one source class can match"],
  ["src/reconcile.mjs", "if (inside && classes([lo, hi, observed]) < 2) return", "if (false) return", "independence: one indexer brackets itself"],
  ["src/polite.mjs", "pause(ms) { next = Math.max(next, now() + Math.max(0, ms)); stats.pauses++; },", "pause(ms) { stats.pauses++; },", "limiter: a 503 does not slow the queue"],
  ["src/faucet.mjs", "r.time_ms > prev.time_ms && r.time_ms <= cur.time_ms", "r.time_ms > prev.time_ms", "faucet: rows after the window end counted"],
  ["src/faucet.mjs", "if (t.sender === signer) rows.set", "rows.set", "faucet: transfers into the faucet counted as sent"],
  ["src/faucet.mjs", "const explorer = walk?.complete ?", "const explorer = walk ?", "faucet: an incomplete walk is published"],
  ["src/scan.mjs", "&& String(d.owner) === agent.owner", "", "agents: owner not checked"],
  ["src/scan.mjs", "acct?.liveBalance === false || acct?.balance == null ? null", "acct?.balance == null ? null", "faucet: untracked explorer balance read as 0"],
  ["src/sources/rpc.mjs", "    return call;\n  };", "    return Promise.resolve(call).catch(() => null);\n  };", "rpc: failed reads become missing items"],
  ["src/metrics.mjs", "reading(\"rpc.storage\", chainMiners ? String(sumBig(Object.values(chainMiners).map((m) => m?.total_rewards_earned))) : null, { label: \"minerStaking.totalRewardsEarned, summed\", context: true })", "reading(\"rpc.storage\", chainMiners ? String(sumBig(Object.values(chainMiners).map((m) => m?.total_rewards_earned))) : null, { label: \"minerStaking.totalRewardsEarned, summed\" })", "miners: a non-reward counter decides"],
  ["src/schedule.mjs", "if (last / len > MAX_PERIODS) throw", "if (false) throw", "schedule: unbounded period expansion"],
  ["src/format.mjs", "if (whole === \"0\" && !frac && /[1-9]/.test(digits)) return", "if (false) return", "format: tiny amounts shown as 0"],,
  ["src/scan.mjs", "const spend = () => { if (spent >= budget) throw new ProbeBudgetSpent(); spent++; };", "const spend = () => { spent++; };", "runtime: probe budget ignored"],
  ["src/scan.mjs", "const target = prev ? head : store.get(\"runtime-target\", null) ?? head;", "const target = head;", "runtime: bisection range moves every run"]
];

// A journal of the file under mutation, written before the mutant and removed after the restore.
// If the run is killed (SIGKILL, OOM, a closed terminal) the next run restores from it first, so a
// mutant can never be left behind in the source tree.
const JOURNAL = join(ROOT, ".cache", "mutate-journal.json");

export function recoverJournal(journal = JOURNAL) {
  if (!existsSync(journal)) return null;
  const { file, original } = JSON.parse(readFileSync(journal, "utf8"));
  writeFileSync(join(ROOT, file), original);
  rmSync(journal);
  return file;
}

function runTests() {
  try {
    execFileSync(process.execPath, ["--test", "--test-reporter=dot", ...readTests()], { cwd: ROOT, stdio: "pipe", env: { ...process.env, FUZZ_RUNS: "200" }, timeout: 300_000 });
    return true;
  } catch { return false; }
}
function readTests() {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "test/*.test.mjs"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
}

function main() {
  if (process.argv.includes("--list")) {
    for (const [f, , , why] of MUTATIONS) console.log(`${f}: ${why}`);
    return 0;
  }
  const recovered = recoverJournal();
  if (recovered) console.error(`restored ${recovered} from an interrupted mutation run`);
  // A mutant's replacement text already in the tree means an earlier run left it there.
  const leftovers = MUTATIONS.filter(([file, from, to]) => to && !readFileSync(join(ROOT, file), "utf8").includes(from) && readFileSync(join(ROOT, file), "utf8").includes(to));
  if (leftovers.length) { console.error(`mutant text found in the tree, restore it first: ${leftovers.map(([f, , , w]) => `${f}: ${w}`).join("; ")}`); return 2; }
  if (!runTests()) { console.error("baseline: tests fail before any mutation; fix that first"); return 2; }

  let current = null;
  const restore = () => { if (current) { writeFileSync(current.path, current.orig); rmSync(JOURNAL, { force: true }); current = null; } };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { restore(); process.exit(130); });
  mkdirSync(dirname(JOURNAL), { recursive: true });

  let killed = 0;
  const survivors = [];
  const stale = [];
  for (const [file, from, to, why] of MUTATIONS) {
    const path = join(ROOT, file);
    const orig = readFileSync(path, "utf8");
    if (!orig.includes(from)) { stale.push(`${file}: ${why}`); continue; }
    writeFileSync(JOURNAL, JSON.stringify({ file, original: orig }));
    current = { path, orig };
    writeFileSync(path, orig.replace(from, to));
    let passed;
    try { passed = runTests(); } finally { restore(); }
    if (passed) survivors.push(`${file}: ${why}`); else killed++;
    process.stdout.write(`${passed ? "SURVIVED" : "killed  "}  ${file}: ${why}\n`);
  }
  const total = killed + survivors.length;
  console.log(`\nmutation check: ${killed}/${total} killed, ${survivors.length} survived, ${stale.length} stale`);
  for (const s of stale) console.log(`stale (pattern not found): ${s}`);
  return survivors.length || stale.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
