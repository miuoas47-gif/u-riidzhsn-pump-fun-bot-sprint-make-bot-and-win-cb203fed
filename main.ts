// Pump.fun paper bot: early-surge rider.
//
// Idea: on pump.fun bonding curves the big moves happen fast — in the dev
// window the median coin that ever peaked above 2x reached its peak only ~50
// slots after creation, and ~43% of coins peaked above 1.5x. So this bot
// watches every curve's tape for a sudden burst of dispersed buying (several
// distinct buyers, net SOL flowing in, price climbing and sitting near its
// recent high, inflow accelerating), buys a small first stake (0.2 SOL), then
// pyramids into strength only while the price keeps stepping up (up to
// 0.5 SOL per coin). Exits are loose and patient, by an offline sweep on the
// dev window: tight stops cut the runners before they run, so a position gets
// room (20% stop, 35% trailing drop) and time (1500 slots) while the trailing
// stop banks the tail. Sells
// go out in chunks the curve's real reserves can absorb: the harness rejects
// a sale whose SOL outruns those reserves, so a whole-position sale on a small
// curve would be refused and retried forever. Entries are edge-triggered
// (once when the signal turns on) with a retry delay after a refused buy, and
// a circuit breaker stops opening new positions once equity has fallen to
// 7 SOL, so the drawdown stays inside the 50% guardrail. A tiny 0.02 SOL
// probe round-trip keeps the run above the 20-coin guardrail when the
// momentum signal goes quiet.
//
// Deterministic by construction: no clock, no environment, no randomness;
// iteration only over insertion-ordered maps fed by the batch stream.
// All SOL figures below are plain numbers (floats); lamports are converted
// to bigint only at the moment an order is built.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95bps + creator 30bps fallback
const SOL_PER_LAMPORT = 1 / LAMPORTS;

// --- tuning ---------------------------------------------------------------

// Entry: tape window and signal thresholds.
const WINDOW_SLOTS = 24;
const MIN_NET_SOL = 0.5; // net buy SOL (buys minus sells) inside the window
const MIN_BUYS = 4; // buy trades inside the window
const MIN_BUYERS = 3; // distinct buying wallets inside the window
const MIN_PRICE_UP = 0.05; // price now vs window-start price, minus 1
const MAX_PRICE_UP = 1.0; // skip curves that already ran too far in one window
const NEAR_HIGH = 0.97; // price now at least this share of the window high
const MIN_REAL_SOL = 1; // curve real SOL reserves at entry
const MAX_REAL_SOL = 80;
const MAX_AGE_SLOTS = 400; // entries only while the curve is this young

// Sizing (SOL).
const FIRST_STAKE_SOL = 0.2;
const ADD_SOL = 0.1;
const MAX_STAKE_SOL = 0.5;
const MIN_BUY_SOL = 0.01;
const BUY_SLIP_BPS = 500; // tight: a buy that would fill far above the decision price is rejected instead
const SELL_SLIP_BPS = 10_000;

// Exits. Loose and patient, by offline sweep on the dev window: tight stops
// cut the runners before they run, and the frequent small losses add up with
// fees. The money is in the few coins that run 2-5x, so a position gets room
// (20% stop, 35% trailing drop) and time (1500 slots) while the trailing stop
// banks the tail.
const STOP_LOSS = 0.2; // sell when value < cost * (1 - STOP_LOSS)
const TRAIL_ARM = 0.1; // trailing stop arms once peak value >= cost * (1 + TRAIL_ARM)
const TRAIL_DROP = 0.35; // sell when value < peak value * (1 - TRAIL_DROP)
const FADE_WINDOW = 15; // exit when net flow over this many slots is very negative
const FADE_NET_SOL = -0.5;
const MAX_HOLD_SLOTS = 1500; // time limit, waived while the position is up a lot
const HOLD_IF_UP = 0.25;
const COOLDOWN_SLOTS = 150; // wait after an exit before re-entering the same curve
const MAX_ENTRIES_PER_COIN = 2;
const SELL_RETRY_DELAY = 20; // slots to wait before retrying a rejected sell
const BUY_RETRY_DELAY = 100; // slots to wait before retrying a rejected buy

// Guardrail pacing: keep the run on pace for this many coins / fills over
// PACE_SECS of block time, with tiny probe round trips when it lags.
const TARGET_COINS = 30;
const TARGET_FILLS = 240;
const PACE_SECS = 14_400;
const PROBE_SOL = 0.02;
const MAX_PROBES = 1;
const MAX_OPEN_MAIN = 5;
const MAX_EXPOSURE_SOL = 4;
// Circuit breaker: stop opening new positions once equity has fallen this
// far from the 10 SOL start, so max drawdown stays inside the 50% guardrail.
const EQUITY_FLOOR_SOL = 7.0;

// --- per-curve tape -------------------------------------------------------

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number; // SOL sent in buys for this position (fees included)
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight: false while the buy is pending, true once selling. */
const probes = new Map<Pubkey, boolean>();
/** Mints whose entry signal is currently true (edge-triggered entries: buy
 * once when the signal turns on, not every batch while it stays on). */
const signaled = new Set<Pubkey>();
/** Earliest slot a mint may be bought again after a rejected buy. */
const buyRetryAt = new Map<Pubkey, number>();
/** Earliest slot a mint's sell may be retried after a rejected sell. */
const sellRetryAt = new Map<Pubkey, number>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Price of a curve from its virtual reserves (quote per token). */
function curvePrice(state: BotState, mint: Pubkey): number {
  const c = state.curves.get(mint);
  if (c === undefined) return 0;
  const vt = Number(c.virtual_token_reserves);
  if (vt <= 0) return 0;
  return Number(c.virtual_quote_reserves) / vt;
}

/** What a position would fetch if sold whole right now (SOL, curve + tx fees off). */
function sellValue(state: BotState, mint: Pubkey, tokens: bigint): number {
  const c = state.curves.get(mint);
  if (c === undefined) return 0;
  const vt = Number(c.virtual_token_reserves);
  const vq = Number(c.virtual_quote_reserves);
  const t = Number(tokens);
  if (vt <= 0 || t <= 0) return 0;
  const gross = (t * vq) / (vt + t) / LAMPORTS;
  return gross * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / LAMPORTS;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function netFlow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/**
 * How many tokens can be sold in one order without the sale's gross SOL
 * outrunning the curve's real SOL reserves (the harness rejects a sell whose
 * quote-out exceeds them). Selling a whole position at once on a small curve
 * is rejected and retried forever; chunking avoids that. Returns 0n when
 * even a dust sale is not worthwhile.
 */
function sellChunkTokens(state: BotState, mint: Pubkey, tokens: bigint): bigint {
  const c = state.curves.get(mint);
  if (c === undefined) return 0n;
  const vt = Number(c.virtual_token_reserves);
  const vq = Number(c.virtual_quote_reserves);
  const rq = Number(c.real_quote_reserves);
  if (vt <= 0 || vq <= 0 || rq <= 0) return 0n;
  // Cap gross quote-out at 85% of real reserves: q(t) = t*vq/(vt+t) <= 0.85*rq
  // gives t <= 0.85*rq*vt / (vq - 0.85*rq).
  const qCap = 0.85 * rq;
  if (vq <= qCap) return tokens; // reserves are deep enough for the whole sale
  const tMax = Math.floor((qCap * vt) / (vq - qCap));
  if (tMax <= 0) return 0n;
  const chunk = BigInt(tMax);
  return chunk < tokens ? chunk : tokens;
}

/** Portfolio equity in SOL: cash plus what every position would fetch now. */
function equitySol(state: BotState): number {
  let e = Number(state.cash) * SOL_PER_LAMPORT;
  for (const [mint, pos] of state.positions) e += sellValue(state, mint, pos.token_amount);
  return e;
}

/** The entry signal: a fresh, dispersed, accelerating burst of buying. */
function entrySignal(t: Tape, now: number, priceNow: number, rqSol: number): boolean {
  if (rqSol < MIN_REAL_SOL || rqSol > MAX_REAL_SOL) return false;
  if (t.created === null || now - t.created > MAX_AGE_SLOTS) return false;
  const from = now - WINDOW_SLOTS;
  const mid = now - WINDOW_SLOTS / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  const buyers = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.set(tr.user, (buyers.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (startPrice <= 0 || priceNow <= 0) return false;
  const up = priceNow / startPrice - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  if (priceNow < high * NEAR_HIGH) return false;
  // Accelerating: the newer half of the window must carry at least as much
  // net inflow as the older half, and must be positive on its own.
  if (netNew <= 0 || netNew < netOld) return false;
  // No single wallet may dominate the window's buying.
  let top = 0;
  for (const v of buyers.values()) if (v > top) top = v;
  if (buySol > 0 && top > 0.8 * buySol) return false;
  return true;
}

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const traded = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      } else if (f.status === 'rejected' && !f.client_id.startsWith('_')) {
        // Never resend an identical order the market just refused: back off
        // and let the price or the reserves move first.
        if (f.side === 'buy') buyRetryAt.set(f.mint, now + BUY_RETRY_DELAY);
        else sellRetryAt.set(f.mint, now + SELL_RETRY_DELAY);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) * SOL_PER_LAMPORT,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
      }
    }
    // Trim tapes so memory stays bounded: keep a little more than the
    // longest window any rule looks back over.
    const keep = Math.max(WINDOW_SLOTS, FADE_WINDOW) + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) * SOL_PER_LAMPORT;
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    // --- exits first ------------------------------------------------------
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const value = sellValue(state, mint, pos.token_amount);
      const cost = Number(pos.cost_lamports) * SOL_PER_LAMPORT;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      let exit = h.exiting;
      const t = tapeOf(mint);
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL_DROP)) exit = true;
      if (!exit && netFlow(t, now, FADE_WINDOW) < FADE_NET_SOL) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS && value < cost * (1 + HOLD_IF_UP)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (now < (sellRetryAt.get(mint) ?? -1)) continue;
      if (orders.length >= cap) break;
      // Sell in chunks the curve's real reserves can absorb; a whole-position
      // sale on a small curve is rejected outright and retried forever.
      const chunk = sellChunkTokens(state, mint, pos.token_amount);
      if (chunk <= 0n) continue;
      if (sellValue(state, mint, chunk) <= 2 * txSol) continue; // fees would eat it
      orders.push({ side: 'sell', mint, token_amount: chunk, max_slippage_bps: SELL_SLIP_BPS });
    }

    // --- probe round trips: sell the probe as soon as its buy lands ------
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (now < (sellRetryAt.get(mint) ?? -1)) continue;
      if (orders.length >= cap) break;
      const chunk = sellChunkTokens(state, mint, pos.token_amount);
      if (chunk <= 0n || sellValue(state, mint, chunk) <= 2 * txSol) continue;
      orders.push({ side: 'sell', mint, token_amount: chunk, max_slippage_bps: SELL_SLIP_BPS });
      if (!selling) probes.set(mint, true);
    }

    // --- entries and pyramid adds ----------------------------------------
    // Circuit breaker: once equity has fallen to the floor, open nothing new
    // (exits above still run) so the drawdown stays inside the guardrail.
    const canEnter = equitySol(state) >= EQUITY_FLOOR_SOL;
    let free = Number(state.freeCashLamports()) * SOL_PER_LAMPORT;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = MAX_OPEN_MAIN - held.size;
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) * SOL_PER_LAMPORT);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = curvePrice(state, mint);
      if (price <= 0) continue;
      const rqSol = Number(curve.real_quote_reserves) * SOL_PER_LAMPORT;
      let want: number;
      if (h === undefined) {
        if (!canEnter || slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= MAX_ENTRIES_PER_COIN || now - t.lastExit < COOLDOWN_SLOTS) continue;
        if (now < (buyRetryAt.get(mint) ?? -1)) continue;
        // Edge-triggered: buy once when the signal turns on, not on every
        // batch while it stays on (re-sending a refused buy each batch
        // floods the log and fills at the worst prices).
        const signal = entrySignal(t, now, price, rqSol);
        if (signal) {
          if (signaled.has(mint)) continue;
          signaled.add(mint);
        } else {
          signaled.delete(mint);
          continue;
        }
        want = FIRST_STAKE_SOL;
      } else {
        // Pyramid into strength only: price stepped up from the last add,
        // the position is not underwater, and flow is still positive.
        if (h.exiting || !h.filled || h.invested >= MAX_STAKE_SOL - MIN_BUY_SOL) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice) continue;
        if (h.lastValue < Number(pos.cost_lamports) * SOL_PER_LAMPORT) continue;
        if (netFlow(t, now, WINDOW_SLOTS) <= 0) continue;
        if (rqSol > MAX_REAL_SOL) continue;
        want = Math.min(ADD_SOL, MAX_STAKE_SOL - h.invested);
      }
      const capSol = Number(state.maxBuyLamports(mint)) * SOL_PER_LAMPORT;
      let amount = Math.min(capSol, want, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + txSol;
      exposure += amount;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // --- guardrail pacing: open a probe when fills or coins lag ----------
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) * SOL_PER_LAMPORT < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * txSol) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + txSol;
        }
      }
    }
    return orders;
  },
});
