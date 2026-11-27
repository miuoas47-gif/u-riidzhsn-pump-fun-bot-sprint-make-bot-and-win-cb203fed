# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/miuoas47-gif/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/miuoas47-gif/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A conservative momentum scalper for pump.fun bonding curves, built for the [make.fun](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) Pump.fun Bot Sprint. It trades paper money on a replay of pump.fun chain data: it buys only coins that are already pumping (price first reaches 1.10x its creation price within its first 40 trades), risks at most 0.05 SOL per coin with at most 5 positions open, and exits every position with a hard take-profit (+30%), a hard stop-loss (-12%), a trailing stop once +15%, and a time stop. No averaging down, no martingale, no leverage, no shorts — losers are cut, winners are ridden briefly, dead coins are freed so the slot can work on the next coin.

## Run it

```sh
python3 main.py
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (hello, batch, done) through the kit's vendored shim in `vendor/makefun_bot.py`. It is fully deterministic: no clock, no randomness, no network, no environment reads — two runs on the same replay produce byte-identical action logs.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6gvkzysc)</sub>
