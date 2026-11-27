"""Conservative momentum scalper for the pump.fun replay (agent-fun/replay/v2).

Strategy, in one paragraph: buy only coins that are already pumping. A coin
becomes a candidate on its CreateEvent; it is bought once, and only once, when
its price first reaches 1.10x its creation price within its first 40 trades
and is still under 1.20x -- a coin that already ran 20% is dropped, never
chased, so a busy moment cannot turn into buying the top minutes later.
The stake is small (at most 0.05 SOL, never more than the harness size cap)
and at most 5 positions are open at once, so no single coin can hurt the
account. Every position carries a hard take-profit (+30% of realizable value
over cost), a hard stop-loss (-12%), a trailing stop (once +15%, exit if it
falls 10% from its peak) and a time stop (exit after 2400 slots if it has not
paid). Losers are cut, winners are ridden briefly, dead coins are freed so the
slot can work on the next coin. No averaging down, no martingale, no leverage,
no shorts, no second buy of the same coin.

All decisions use integer arithmetic on lamports and reserve ratios, so two
runs on the same replay are byte-identical: no clock, no randomness, no
network, no environment reads. The bot speaks the replay protocol through the
kit's vendored shim (vendor/makefun_bot.py), one reply per batch.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

import makefun_bot  # noqa: E402  (after the sys.path line: -P leaves the script directory off sys.path)

LAMPORTS_PER_SOL = makefun_bot.LAMPORTS_PER_SOL

# --- sizing ---------------------------------------------------------------
STAKE_LAMPORTS = 50_000_000          # 0.05 SOL per coin, at most
MIN_BUY_LAMPORTS = 10_000_000        # 0.01 SOL: smaller buys are fee-fodder
MAX_OPEN = 5                         # harness cap; enforced locally too

# --- entry ----------------------------------------------------------------
ENTRY_NUM = 11                       # enter at price >= 11/10 of creation
ENTRY_DEN = 10
ENTRY_MAX_NUM = 120                  # never chase: above 120/100 it already ran
ENTRY_MAX_DEN = 100
MAX_ENTRY_TRADES = 40                # only early pumps; never chase a stale coin

# --- exits, as realizable-proceeds / cost ratios ---------------------------
TP_NUM, TP_DEN = 130, 100            # take profit at +30%
SL_NUM, SL_DEN = 88, 100             # stop loss at -12%
TRAIL_ARM_NUM, TRAIL_ARM_DEN = 115, 100   # arm the trailing stop at +15%
TRAIL_NUM, TRAIL_DEN = 90, 100       # exit 10% below the peak once armed
TIME_STOP_SLOTS = 2400               # ~16 min: free the slot if it never pays
DEAD_SLOTS = 1500                    # no trade for this long: exit if under +10%

BUY_SLIPPAGE_BPS = 500               # 5%: never chase a fill that ran away
SELL_SLIPPAGE_BPS = 2000             # 20%: exits must execute, even in a dump

# Curve fees used to value a position (the landing trade's bps are 95/30 on
# essentially every fill; the fallback is the same pair).
FEE_PROTOCOL_BPS = 95
FEE_CREATOR_BPS = 30


def _ceil_div(a, b):
    return (a + b - 1) // b


def sell_proceeds(tokens, vq, vt):
    """Lamports a sell of `tokens` against reserves (vq, vt) would pay out,
    curve fees deducted (tx fee not included). Integer math, as the sim does."""
    q = (tokens * vq) // (vt + tokens)
    fee = _ceil_div(q * FEE_PROTOCOL_BPS, 10_000)
    creator = _ceil_div(q * FEE_CREATOR_BPS, 10_000)
    out = q - fee - creator
    return out if out > 0 else 0


class Coin:
    """Per-mint tape, kept from the CreateEvent onward."""

    __slots__ = ("vq0", "vt0", "trades", "last_slot", "complete", "decided")

    def __init__(self, vq0, vt0, slot):
        self.vq0 = vq0
        self.vt0 = vt0
        self.trades = 0
        self.last_slot = slot
        self.complete = False
        self.decided = False

    def mult_at_least(self, vq, vt, num, den):
        # vq/vt >= num/den * vq0/vt0  <=>  vq * vt0 * den >= vt * vq0 * num
        return vq * self.vt0 * den >= vt * self.vq0 * num


class Position:
    """A held coin: entry slot and the best realizable proceeds seen so far."""

    __slots__ = ("entry_slot", "peak_proceeds")

    def __init__(self, entry_slot):
        self.entry_slot = entry_slot
        self.peak_proceeds = 0


coins = {}       # mint -> Coin, in first-seen order (never iterated as a set)
held = {}        # mint -> Position, for coins we currently hold


def on_batch(state, batch):
    slot = batch["slot"]
    orders = []

    # -- 1. fold this batch's events into the per-coin tape -----------------
    for e in batch["events"]:
        mint = e["mint"]
        kind = e["event"]
        if kind == "CreateEvent":
            if mint not in coins:
                coins[mint] = Coin(int(e["virtual_quote_reserves"]),
                                   int(e["virtual_token_reserves"]), slot)
        elif kind == "TradeEvent":
            c = coins.get(mint)
            if c is None:
                continue
            c.trades += 1
            c.last_slot = slot
        else:  # CompleteEvent
            c = coins.get(mint)
            if c is not None:
                c.complete = True

    # -- 2. exits for every held position (marks carry current reserves) ----
    marks = {}
    for m in batch["marks"]:
        marks[m["mint"]] = m
    pending_sell = set()
    for p in state.pending.values():
        if p.order["side"] == "sell":
            pending_sell.add(p.order["mint"])

    for mint, holding in list(state.positions.items()):
        pos = held.get(mint)
        if pos is None:
            pos = Position(slot)
            held[mint] = pos
        mark = marks.get(mint)
        if mark is None or mint in pending_sell:
            continue
        vq = int(mark["virtual_quote_reserves"])
        vt = int(mark["virtual_token_reserves"])
        tokens = holding.token_amount
        cost = holding.cost_lamports
        if tokens <= 0 or cost <= 0:
            continue
        proceeds = sell_proceeds(tokens, vq, vt)
        if proceeds > pos.peak_proceeds:
            pos.peak_proceeds = proceeds
        sell = False
        if proceeds * TP_DEN >= cost * TP_NUM:
            sell = True  # take profit
        elif proceeds * SL_DEN <= cost * SL_NUM:
            sell = True  # stop loss
        elif (pos.peak_proceeds * TRAIL_ARM_DEN >= cost * TRAIL_ARM_NUM
                and proceeds * TRAIL_DEN <= pos.peak_proceeds * TRAIL_NUM):
            sell = True  # trailing stop: gave back 10% from the peak
        elif slot - pos.entry_slot >= TIME_STOP_SLOTS and proceeds * 100 < cost * 110:
            sell = True  # time stop: never paid, free the slot
        else:
            c = coins.get(mint)
            if (c is not None and slot - c.last_slot >= DEAD_SLOTS
                    and proceeds * 100 < cost * 110):
                sell = True  # dead coin: no trades, no profit
        if sell:
            orders.append({"side": "sell", "mint": mint,
                           "token_amount": tokens,
                           "max_slippage_bps": SELL_SLIPPAGE_BPS})
            held.pop(mint, None)

    # -- 3. entries: first early pump per coin, small stake, few positions ---
    free = state.free_cash_lamports()
    tx = state.tx_fee_lamports()
    slots_open = MAX_OPEN - state.committed_position_count()
    pending_buy = set()
    for p in state.pending.values():
        if p.order["side"] == "buy":
            pending_buy.add(p.order["mint"])

    for e in batch["events"]:
        if len(orders) >= state.hello["caps"]["max_orders_per_batch"]:
            break
        mint = e["mint"]
        if e["event"] not in ("CreateEvent", "TradeEvent"):
            continue
        c = coins.get(mint)
        if c is None or c.decided or c.complete:
            continue
        if mint in state.positions or mint in pending_buy:
            c.decided = True
            continue
        curve = state.curves.get(mint)
        if curve is None:
            continue
        # A candidate ages out fast: past 40 trades, or already up 20%, its
        # early-pump window is gone. Dropping it here (instead of leaving it
        # queued) is what stops the bot buying the top of a pump minutes
        # after the signal, when every slot was busy at trigger time.
        if c.trades > MAX_ENTRY_TRADES:
            c.decided = True
            continue
        if c.mult_at_least(curve.virtual_quote_reserves,
                            curve.virtual_token_reserves,
                            ENTRY_MAX_NUM, ENTRY_MAX_DEN):
            c.decided = True
            continue
        # current price multiple from the latest reserves the shim knows
        if not c.mult_at_least(curve.virtual_quote_reserves,
                                curve.virtual_token_reserves,
                                ENTRY_NUM, ENTRY_DEN):
            continue
        if slots_open <= 0:
            continue  # no slot now; the coin ages out above if it runs on
        cap = state.max_buy_lamports(mint)
        if cap < MIN_BUY_LAMPORTS:
            continue  # too small to buy yet; keep watching while it is early
        amount = cap if cap < STAKE_LAMPORTS else STAKE_LAMPORTS
        if free < amount + tx:
            continue
        orders.append({"side": "buy", "mint": mint,
                       "quote_lamports": amount,
                       "max_slippage_bps": BUY_SLIPPAGE_BPS})
        c.decided = True
        free -= amount + tx
        slots_open -= 1

    # -- 4. forget coins we no longer hold (their round trip is over) -------
    for mint in list(held):
        if mint not in state.positions:
            held.pop(mint, None)

    return orders


if __name__ == "__main__":
    makefun_bot.run(on_batch)
