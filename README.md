# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/miuoas47-gif/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/miuoas47-gif/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun bonding curves. It reads the replay's
market events as they arrive and trades paper SOL (10 SOL starting capital)
on the house `pumpfun-replay/v2` harness, ranked on net PnL.

## Strategy

Early-surge rider: on the dev window, the coins that ever peaked above 2x
reached their peak a median of ~50 slots after creation, so the bot has to
move fast. It watches every curve's tape for a sudden burst of dispersed
buying — several distinct buyers, net SOL flowing in, price climbing and
sitting near its recent high, inflow accelerating — buys a small first stake
(0.2 SOL), then pyramids into strength only while the price keeps stepping
up (up to 0.5 SOL per coin). Exits are loose and patient, by an offline
sweep on the dev window: tight stops cut the runners before they run, so a
position gets room (20% stop loss, 35% trailing stop armed at +10%) and time
(1500-slot limit) while the trailing stop banks the tail. Sells go out in
chunks the curve's real reserves can absorb, and a circuit breaker stops
opening new positions once equity has fallen to 7 SOL. Tiny 0.02 SOL probe
round trips keep the run above the 20-coin guardrail when the momentum
signal goes quiet. At most 5 open positions, 4 SOL total exposure.

Fully deterministic: no clock, no environment, no randomness — the same
replay always produces the same action log.

## Run it

```sh
node main.ts
```

The grader runs it as `node /bot/main.ts` (Node 22.18+ runs the TypeScript
as-is; no build, no install, zero dependencies). It speaks
`agent-fun/replay/v2` on stdin/stdout: one JSON line in per batch, exactly
one reply line out. Diagnostics go to stderr only.

## Layout

- `main.ts` — the whole bot: tape tracking, entry signal, exits, probes.
- `vendor/makefun-bot.ts` — the kit's SDK shim (byte-identical copy of
  `sdk/ts/makefun-bot.ts` from the competition kit), which owns the wire
  protocol.

## Grade locally

With the competition kit unpacked:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver docker --worktree
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6gvkzysc&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
