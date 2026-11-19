# flopscan

Read-only metrics for the FLOP devnet. A number is published only when two independent sources agree on it. When
they disagree, every reading is published and no number is. Shaped after
[banteg/yearn-fees](https://github.com/banteg/yearn-fees), which will not save a fee report unless two methods
reconcile.

**Devnet data, not financial information. Unaudited.** Devnet FLOP has no value. flopscan never signs, never
submits and never holds a key. Unaffiliated with Flop Labs.

## Usage

```
npm ci
npm run scan          # node src/cli.mjs scan --out data/v1 --cache .cache/flopscan
npm run build-site    # node scripts/build-site.mjs --data data/v1 --out _site
npm test              # 93 tests, no network
npm run mutate        # break the code on purpose, require a failing test (docs/MUTATION.md)
npm run secret-scan
```

`scan` writes `data/v1/latest.json` and `data/v1/history.json`, both validated by [`schema/v1.json`](schema/v1.json).
Exit codes: 0 when nothing disagrees, 1 when some metric disagrees (the files are still written), 2 on a fatal error.
Amounts are integer strings in planck (1 FLOP = 10^18 planck).

The older single-purpose verbs still work and print JSON:

```
node src/cli.mjs rewards   [--at N] [--last K]   # block rewards: events vs counters vs schedule
node src/cli.mjs issuance  --from A --to B       # explain totalIssuance(B) - totalIssuance(A)
node src/cli.mjs verifiers [--at N]              # vks / tickets per proof-verification pallet
```

Only `--network devnet` is pinned (genesis `0x99c1…d631`). Connecting to a chain with any other genesis is refused.

## Method

### Sources

| source | what it is |
|---|---|
| chain state (`rpc.storage`, `rpc.keys`) | storage values and storage-map sizes, read at one block hash |
| chain events (`rpc.events`) | `system.events` of specific blocks |
| chain runtime (`rpc.runtime`) | `state_getRuntimeVersion` at a block |
| explorer | the JSON API at `explorer.devnet.flop.network` |
| schedule | the reward schedule recomputed from runtime constants |
| registry | `ghcr.io` manifest digests |

Readings in the same row of that table count as **one** source. A storage counter and the size of the map it counts
are written by the same pallet; two endpoints of one explorer share one indexer. A metric whose readings all come
from one source is marked **One source only** (`"reason": "single_source"`) and has no value, even when the readings
agree with each other.

### The read window

The explorer is read first. Its indexed head at that moment is the window start (`lo`); the chain head after the
explorer reads is the window end (`hi`). Chain values are read at both ends. A monotone counter agrees with the
explorer when `lo ≤ explorer ≤ hi` ("bracketed"); anything else must be exactly equal. Every reading in the JSON
carries the block (and hash) it was read at.

### Statuses

- **Sources agree** (`match`): two or more independent sources were read and agree. Only these show a number.
- **Sources disagree** (`mismatch`): every reading and the smallest gap (`delta`) are shown. No number.
- **No value yet / One source only** (`pending`): fewer than two independent sources could be read. A
  previously agreed value is shown as "last agreed at block N", never as the current value.

### Metrics

| metric | compared |
|---|---|
| Block rewards scheduled, miner and validator legs minted, periods | schedule vs `RewardsDistributed` events vs `blockRewards.total*` counters vs `/api/rewards/summary`; every period row by row against `/api/rewards/distributions` |
| Block rewards paid to miners (per miner) | `MinerRewarded` events summed per miner vs `/api/miners` totalRewards |
| Registered miners | `minerStaking.totalMiners` and map size vs `/api/stats` |
| Liveness probes (ghost tasks), per miner | `syntheticTasks.minerGhostStatsStore` at both window ends vs `/api/miner-reliability` |
| Compute settled to miners | `computeChannel.totalMinerPaid` vs `/api/inference-spend` totalSpentRaw |
| Settlement rows | the 8 newest `/api/settlement-prices` rows, each matched to the `computeChannel.Settled` event in its block (channel, miner paid, burned, G_n) |
| Settlements (count) | explorer only: one source |
| Compute channels, session keys | storage map size / counter vs explorer totals |
| Proof verifiers | `ProofVerified` per verifier pallet in the explorer, each confirmed in its block's events |
| Forward compute market | forward offers, positions, bids, listings and bond totals on chain vs forward settlement rows and term-curve trades (presence only: the two count different things) |
| Agent identities (count) | chain only (counter, map size, global stats): one source. The explorer has no identity count |
| Agent registrations | 8 identities sampled from storage per run, each checked for an `AgentRegistered` event with the same id and owner in its `registeredAt` block |
| Agent wallets | `agentWallet.totalWallets` vs `/api/agent-wallets` |
| Faucet transactions since the last scan | the signer's nonce change between two window starts vs transactions the explorer lists as sent by the signer in the same blocks |
| Faucet balance, lifetime transactions | chain only: the explorer does not track the signer's balance, and its `txCount` also counts transfers in |
| Total issuance, active validators | `balances.totalIssuance`, `session.validators` vs `/api/stats` |
| Runtime version and history | `state_getRuntimeVersion` vs `system.lastRuntimeUpgrade`; history by bisection, each boundary confirmed by a `system.CodeUpdated` event |
| Operator releases | the explorer's pinned image digest vs the `ghcr.io` manifest digest for the same tag |

### Miner reward minting vs the schedule

The block-reward pot of each period is recomputed from runtime constants (`initialRewardPerBlock >> halvings`) and
compared with what each leg minted. The 75/10/10/5 split is the documented one
([tokenomics-basics](https://docs.flop.network/docs/tokenomics-basics)); it is not a runtime constant, so it is
checked, not assumed. The runtime mints a period's miner leg only to miners with verified G_n, so the reward table
shows, per period, what was scheduled for the miner leg, what was minted, and the difference. A difference is
reported as a fact about the period, not as an error: this tool can see that it happened, not why.

### Blind spots

- **Wrapped calls.** The explorer indexes an extrinsic under its outer call. A proof submitted inside
  `utility.batch`, `proxy.proxy`, `sudo` or `multisig` is filed under that wrapper, so verifier counts miss it on both
  sides. The same applies to anything else counted by explorer section.
- Runtime history by bisection cannot see an upgrade that was rolled back to the same version between two probes.
- Liveness probes are a proxy for uptime, not a measurement of it.
- The settlement-price list can omit settlements; its sum is shown as context only.

## Incremental, resumable, polite

- Every expensive unit (reward period, runtime probe, settlement page, verifier or agent check) is written to the
  cache (`.cache/flopscan`) with an atomic rename before the next starts. A killed run resumes where it stopped; the
  settlement walk resumes at its saved page and dedupes rows by (channel, block, event).
- Settlement rows are fetched only back to the cached block cursor (minus a 600-block margin for late indexing).
- All requests go through one limiter (RPC 5/s and 4 in flight, explorer 3/s and 2 in flight). 429, 5xx, timeouts
  and lagging RPC backends are retried with capped, jittered exponential backoff, honouring `Retry-After` (capped at
  2 minutes). A retry also pauses every queued request, so one 503 slows the whole client.
- Runtime history needs historical `state_getRuntimeVersion` calls, which cost the public node about 30 s each. A run
  spends at most 12 of them; the history is built over a few runs (cached) and shows as pending until complete.
- Malformed values are refused, not coerced: a non-integer amount, a bad hash, an implausible period count. The
  affected metrics go pending and the error is listed in `sources.errors`.

## Dashboard and deploy

`scripts/build-site.mjs` renders one static HTML page from `latest.json`. It has no scripts, cookies or analytics,
and a strict Content-Security-Policy. It uses Arc's free MIT core (foundation and badge CSS, vendored with Elia
Kuratli's notice in `web/arc/`) and follows the system dark-mode setting.

`.github/workflows/pages.yml` runs every 30 minutes. It restores the cache, runs the incremental scan, builds the
site and deploys it with `actions/deploy-pages`. No data is committed. `ci.yml` runs tests and the secret scan on
every push and PR, and the mutation check on PRs.

## Layout

| file | job |
|---|---|
| `src/scan.mjs` | one scan: read, cache, reconcile, write JSON |
| `src/metrics.mjs` | pure metric builders from one bundle of readings |
| `src/reconcile.mjs` | exact, bracketed and row-by-row agreement; source independence |
| `src/sources/rpc.mjs`, `src/chain.mjs` | read-only chain reads at a pinned block |
| `src/sources/explorer.mjs` | explorer API adapter |
| `src/settlements.mjs`, `src/runtime.mjs`, `src/faucet.mjs` | settlement cache, runtime bisection, faucet window |
| `src/schedule.mjs`, `src/rewards.mjs`, `src/issuance.mjs` | reward schedule and reward/issuance reconciles |
| `src/polite.mjs`, `src/store.mjs` | limiter, backoff, crash-safe cache |
| `scripts/build-site.mjs`, `web/` | static dashboard |
| `scripts/mutate.mjs` | mutation check |

## Tests

`npm test` needs no network. Golden vectors (the recorded 47-period devnet reward fixture, the halving ladder),
properties with fast-check (reconcile verdicts, backoff bounds, formatting round trips, the faucet window against a
model), a fuzz test that corrupts recorded bundles and requires the "no number without agreement" rule to hold,
malformed-RPC and malformed-explorer fixtures, crash-after-k resume tests, and adversarial compositions (a proof the
explorer calls verified with no event on chain, a registry digest that differs, an agent with the wrong owner).
`docs/MUTATION.md` lists the mutants and which test kills each.

MIT. Unaffiliated with Flop Labs.
