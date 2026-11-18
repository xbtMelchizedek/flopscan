// Record a pinned rewards fixture from devnet: `node scripts/record-fixture.mjs [atBlock]`.
// Writes test/fixtures/devnet-rewards-<block>.json. Read-only.
import { writeFileSync } from "node:fs";
import { connect, pin, readPeriod, readRewardsState } from "../src/chain.mjs";
import { periodBoundaries } from "../src/schedule.mjs";

const api = await connect("devnet");
try {
  const pinned = await pin(api, process.argv[2] === undefined ? undefined : Number(process.argv[2]));
  const state = await readRewardsState(api, pinned);
  const periods = [];
  for (const b of periodBoundaries(state.lastDistributionBlock, state.consts.distributionPeriodBlocks)) {
    periods.push(await readPeriod(api, Number(b)));
    process.stderr.write(`period ${b}\n`);
  }
  const path = `test/fixtures/devnet-rewards-${pinned.number}.json`;
  writeFileSync(path, JSON.stringify({ recorded_at: new Date().toISOString(), state, periods }, null, 1) + "\n");
  process.stderr.write(`wrote ${path}\n`);
} finally {
  await api.disconnect();
}
