# flopscan

Read-only forensics for the FLOP chain. It reports a number as settled only when two independent sources
agree, and otherwise exits non-zero with the disagreement in the output. Shaped after
[banteg/yearn-fees](https://github.com/banteg/yearn-fees), which refuses to save a fee report unless two methods reconcile.

flopscan never signs, never submits and never holds a key. It connects to a public RPC, refuses any chain whose
genesis isn't the one pinned for the network, and reads every value in a call at one block hash.

```
npm ci
node src/cli.mjs rewards   [--at N] [--last K]   # block rewards: events vs counters vs schedule
node src/cli.mjs issuance  --from A --to B       # explain totalIssuance(B) - totalIssuance(A)
node src/cli.mjs verifiers [--at N]              # vks / tickets per proof-verification pallet
```

Output is JSON. Exit codes: 0 when sources agree, 1 when they disagree, 2 for bad input or RPC errors.
Only `--network devnet` is pinned today (genesis `0x99c1…d631`). Testnet is added when its genesis is published.

## What `rewards` checks

| source | what it is |
|---|---|
| A. events | `blockRewards.RewardsDistributed` and `MinerRewarded` at every period boundary (each `distributionPeriodBlocks`) |
| B. counters | `blockRewards.total{Miner,Validator,Agent,Staker}Rewards`, read at one pinned block |
| C. schedule | `initialRewardPerBlock >> halvings` from runtime constants, and the documented 75/10/10/5 split ([tokenomics-basics](https://docs.flop.network/docs/tokenomics-basics)) |

These fail the run (`ok: false`):
- any period is unread or has no distribution event;
- an event's `total_reward` isn't the schedule;
- `MinerRewarded` amounts don't sum to `miner_share`, or `miner_share` exceeds the 75% leg;
- any counter differs from the event sum.

These are reported as `findings`, not failures, because the runtime documents them as expected:
- a `DistributionFailed` period (its pot is forfeited);
- a non-miner leg that's off the documented split.

The miner leg is minted only to miners with verified G_n, so each row reports `miner_leg_unminted`.

The split is checked, not assumed: it's documentation, not a runtime constant. Integer math throughout (planck,
18 decimals), with legs rounded down.

## What it found on devnet (18 Nov 2026, pinned at block 4,065,170)

From `test/fixtures/devnet-rewards-4065170.json`, which the test suite re-checks:

- All 47 periods up to block 4,060,800 reconcile exactly. Events equal counters for every leg, and every pot is
  86,400 × 96 FLOP.
- Validator, agent and staker legs follow the documented split in every period.
- The miner leg was minted in 6 of 47 periods, the last at block 777,600, with 1–2 miners each. Of 389,836,800
  scheduled FLOP, 134,783,999.99… was minted and 255,052,800 (the miner legs of the other 41 periods) was not.
  Runtime docs say a period's miner pot pays only for verified G_n. Why no miner earned G_n after block 777,600
  isn't something this tool can tell; it's devnet, where tokens have no value.
- Runtime event docs say the agent and staker legs are minted into pool accounts, with distribution "NOT implemented"
  pending policy (ECON-008).
- `issuance --from 4060790 --to 4060810` explains the delta exactly. That's 20 blocks of 8 + 8 FLOP subsidy plus
  one distribution's validator, agent and staker legs.
- `verifiers` at block 4,065,531 shows 0 registered vks in all 9 verifier pallets. A proof submitted with an inline vk
  leaves no storage entry, only an event (for example our SP1 proof at block 4,045,180), so a proof count needs an
  event scan. That's next.

## Layout

| file | job |
|---|---|
| `src/schedule.mjs` | reward per block, period pot, documented legs. Pure. |
| `src/rewards.mjs` | the A/B/C reconcile. Pure. |
| `src/issuance.mjs` | explain an issuance delta from events. Pure. |
| `src/chain.mjs` | pinned, read-only RPC reads via `@polkadot/api`. No auto-reconnect. |
| `src/cli.mjs` | verbs. Parse, call, print, exit. |
| `scripts/record-fixture.mjs` | record a pinned rewards fixture from devnet |

## Tests

`npm test` runs 15 tests with `node --test`. They need no network.

- **Golden:** the devnet period pot, the halving ladder down to the 3 FLOP floor, and the recorded 47-period fixture.
- **Second method:** brute-force sums for periods that cross a halving.
- **Adversarial:** a tampered pot, a counter off by 1 planck, a missing period, a miner over its leg, miner events that
  don't sum, and an unexplained issuance change.
- **Mutation check:** disabling the counter check, the halving cap, the halving-run split or `Rescinded` each fails a test.

## Limits

- The public devnet RPC is rate-limited and was briefly down (HTTP 503) during development. A full `rewards` run makes
  about 50 historical reads, and older runtimes need their own metadata, so expect minutes, not seconds.
- `issuance` is capped at 600 blocks per call.
- Assumption: block 1 is the first rewarded block. There's been no halving on devnet yet, so the boundary is untested
  on chain.

## Next

- `settled`: per-account `computeChannel.Settled` sums vs `settledTurns`.
- `jobs`: a keeper board of everything that becomes callable at a known block.
- `proofs`: an event scan for `ProofVerified` per pallet.
- The devnet explorer as a third source.

MIT. Unaffiliated with Flop Labs.
