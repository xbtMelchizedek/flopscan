#!/usr/bin/env node
// flopscan: read-only FLOP chain forensics. Prints JSON; exits 1 when sources disagree.
//
//   flopscan rewards   [--at N] [--last K]      reconcile block rewards: events vs counters vs schedule
//   flopscan issuance  --from A --to B          explain totalIssuance(B) - totalIssuance(A) from events
//   flopscan verifiers [--at N]                 vks / tickets per proof-verification pallet
//
// Common flags: --network devnet (default), --rpc URL (must still match the pinned genesis).

import { parseArgs } from "node:util";
import { connect, pin, readIssuanceWindow, readPeriod, readRewardsState, readVerifiers } from "./chain.mjs";
import { explainIssuance, isIssuanceEvent } from "./issuance.mjs";
import { reconcileRewards } from "./rewards.mjs";
import { periodBoundaries } from "./schedule.mjs";

const MAX_ISSUANCE_WINDOW = 600; // blocks; one RPC round trip per block, keep it honest and bounded

async function rewards(api, flags) {
  const pinned = await pin(api, flags.at);
  const state = await readRewardsState(api, pinned);
  const blocks = periodBoundaries(state.lastDistributionBlock, state.consts.distributionPeriodBlocks);
  const periods = [];
  for (const b of blocks) periods.push(await readPeriod(api, Number(b)));
  const result = reconcileRewards(state, periods);
  if (flags.last) result.rows = result.rows.slice(-Number(flags.last));
  return result;
}

async function issuance(api, flags) {
  const from = Number(flags.from);
  const to = Number(flags.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) throw new Error("need --from A --to B with B > A >= 0");
  if (to - from > MAX_ISSUANCE_WINDOW) throw new Error(`window over ${MAX_ISSUANCE_WINDOW} blocks; split it`);
  const w = await readIssuanceWindow(api, from, to, isIssuanceEvent);
  return { from, to, ...explainIssuance(w.issuance_from, w.issuance_to, w.events) };
}

async function verifiers(api, flags) {
  return readVerifiers(api, await pin(api, flags.at));
}

const VERBS = { rewards, issuance, verifiers };

export async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      network: { type: "string", default: "devnet" },
      rpc: { type: "string" },
      at: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      last: { type: "string" },
    },
  });
  const verb = VERBS[positionals[0]];
  if (!verb) {
    process.stdout.write(JSON.stringify({ ok: false, error: `verbs: ${Object.keys(VERBS).join(", ")}` }) + "\n");
    return 2;
  }
  const flags = { ...values, at: values.at === undefined ? undefined : Number(values.at) };
  let api;
  try {
    api = await connect(values.network, values.rpc);
    const out = await verb(api, flags);
    process.stdout.write(JSON.stringify({ verb: positionals[0], network: values.network, ...out }, null, 2) + "\n");
    return out.ok === false ? 1 : 0;
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, verb: positionals[0], error: String(err.message ?? err) }) + "\n");
    return 2;
  } finally {
    await api?.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/flopscan")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
