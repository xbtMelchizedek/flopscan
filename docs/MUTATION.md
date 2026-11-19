# Mutation check

`node scripts/mutate.mjs` breaks the code on purpose, one rule at a time, and requires the test suite to fail.
A mutant that survives is a rule no test protects. CI runs it on every pull request.

Run on 19 Nov 2026 (UTC) on branch v1-live: **41 of 41 mutants killed, 0 survived, 0 stale.**

The runner journals each file before mutating it and restores it on SIGINT, SIGTERM and SIGHUP, and at the start of
the next run. A first run of the previous worker's runner had been killed mid-mutation and left one mutant
("float amounts accepted") in `src/settlements.mjs`. It is fixed, and the runner now refuses to start if a mutant's text
is already in the tree.

| # | file | rule broken | result |
|---|---|---|---|
| 1 | `src/reconcile.mjs` | exact: one agreeing pair is enough | killed |
| 2 | `src/reconcile.mjs` | exact: context readings decide | killed |
| 3 | `src/reconcile.mjs` | bracketed: no upper bound | killed |
| 4 | `src/reconcile.mjs` | rows: any present row counts as agreeing | killed |
| 5 | `src/reconcile.mjs` | worst: a mismatch can hide | killed |
| 6 | `src/settlements.mjs` | settlements: no dedupe | killed |
| 7 | `src/settlements.mjs` | settlements: off-by-one block bound | killed |
| 8 | `src/settlements.mjs` | settlements: burned not checked on chain | killed |
| 9 | `src/settlements.mjs` | settlements: float amounts accepted | killed |
| 10 | `src/runtime.mjs` | runtime: short spans skipped | killed |
| 11 | `src/runtime.mjs` | runtime: spans overlap | killed |
| 12 | `src/polite.mjs` | http: 503 not retried | killed |
| 13 | `src/polite.mjs` | http: Retry-After not capped | killed |
| 14 | `src/polite.mjs` | limiter: no spacing between requests | killed |
| 15 | `src/polite.mjs` | retry: final errors retried | killed |
| 16 | `src/metrics.mjs` | metrics: float strings accepted as integers | killed |
| 17 | `src/metrics.mjs` | faucet: balance always agrees | killed |
| 18 | `src/metrics.mjs` | carry: stale value shown as current | killed |
| 19 | `src/metrics.mjs` | settlement rows: unconfirmed rows pass | killed |
| 20 | `src/metrics.mjs` | releases: unsanitised component names | killed |
| 21 | `src/scan.mjs` | resume: periods not saved as they are read | killed |
| 22 | `src/scan.mjs` | verifiers: explorer trusted without the chain | killed |
| 23 | `src/scan.mjs` | release history: unverified versions recorded | killed |
| 24 | `src/sources/explorer.mjs` | explorer: malformed head hash accepted | killed |
| 25 | `src/rewards.mjs` | rewards: counters not checked against events | killed |
| 26 | `src/reconcile.mjs` | provenance: malformed block numbers published | killed |
| 27 | `scripts/build-site.mjs` | site: disclaimer removed | killed |
| 28 | `src/format.mjs` | site: no HTML escaping | killed |
| 29 | `src/format.mjs` | format: shows a digit it should have dropped | killed |
| 30 | `src/reconcile.mjs` | independence: one source class can match | killed |
| 31 | `src/reconcile.mjs` | independence: one indexer brackets itself | killed |
| 32 | `src/polite.mjs` | limiter: a 503 does not slow the queue | killed |
| 33 | `src/faucet.mjs` | faucet: rows after the window end counted | killed |
| 34 | `src/faucet.mjs` | faucet: transfers into the faucet counted as sent | killed |
| 35 | `src/faucet.mjs` | faucet: an incomplete walk is published | killed |
| 36 | `src/scan.mjs` | agents: owner not checked | killed |
| 37 | `src/scan.mjs` | faucet: untracked explorer balance read as 0 | killed |
| 38 | `src/sources/rpc.mjs` | rpc: failed reads become missing items | killed |
| 39 | `src/metrics.mjs` | miners: a non-reward counter decides | killed |
| 40 | `src/schedule.mjs` | schedule: unbounded period expansion | killed |
| 41 | `src/format.mjs` | format: tiny amounts shown as 0 | killed |

## History of this list

- First full run on the reviewed WIP: 28 of 30 killed. Survivors: "verifiers: explorer trusted without the chain" and
  "release history: unverified versions recorded". Both were killed by new tests in `test/adversarial-scan.test.mjs`.
- After the source-independence change and the new metrics, 12 mutants were added: 36 of 42 killed. Of the 6
  survivors:
  - "exact: a single source gets a value" (`deciding.length < 2` relaxed to `< 1`) became an **equivalent mutant**:
    a single reading is one source class, so the independence rule already refuses it. It was removed from the list
    rather than counted; the independence mutants (#30 and #31 in the table) cover that rule.
  - "settlements: off-by-one block bound", "faucet: balance always agrees", "releases: unsanitised component names"
    and "miners: a non-reward counter decides" were killed by new tests (`test/settlements.test.mjs`,
    `test/adversarial-scan.test.mjs`). The miner one needed the test world to match devnet, where
    `minerStaking.totalRewardsEarned` stays 0.
  - "rpc: failed reads become missing items" was mis-aimed (it changed a synchronous catch that a 503 never reaches).
    It now turns rejected reads into null, which is the real bug, and `test/rpc.test.mjs` kills it.

Reproduce: `npm run mutate` (about 15 minutes; each mutant runs the whole suite with 200 fuzz runs).
