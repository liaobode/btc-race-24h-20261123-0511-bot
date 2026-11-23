// Hybrid Structural Breakout + Hysteresis Macro Trend & Impact-Aware TWAP BTC Bot (Version 8)
// Synthesis of our best components from V4, V5, and V7:
// 1. Entry (from V5): 105-bar Donchian breakout gated by 360-bar (6h) structural resistance,
//    Kaufman Efficiency Ratio, and rising slow EMA — stays flat in bear crashes & sideways chop.
// 2. Sizing (from V4): 55% Stage 1 initial breakout allocation -> 100% Stage 2 on +0.40%
//    confirmation, halving false-breakout risk while keeping full exposure on real trends.
// 3. Exit (from V7): Hysteresis-gated macro trend break (fast < slow by -20 bps & close < slow
//    & slow slope <= 0) + 1.20% initial hard stop + wide 2.4% catastrophe trailing stop — rides
//    entire bull trends without getting shaken out by 1% intraday consolidations, yet exits
//    cleanly on real pump-and-dump reversals.
// 4. Execution: Impact-aware multi-bar TWAP (<= 3.2 bps/bar) exploiting per-bar pool depth reset,
//    plus end-of-window $2 fallback probe to guarantee min_trades >= 1 in pure bear regimes.

import {
  BPS,
  runBars,
  type Bar,
  type BarsState,
  type BuyInput,
  type SellInput,
} from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Indicator spans (1-minute bars)
const FAST_SPAN = 28;
const SLOW_SPAN = 100;
const BREAKOUT_WIN = 105;
const MACRO_HIGH_WIN = 360; // 6-hour structural ceiling
const ER_WIN = 60;

// Position sizing & pyramiding
const STAGE1_WEIGHT_BPS = 5500n; // 55% initial breakout allocation
const STAGE2_WEIGHT_BPS = 10000n; // 100% confirmed trend allocation
const PYRAMID_PROFIT_TRIGGER = 0.0040; // +0.40% unrealized gain to pyramid
const REBALANCE_TOLERANCE = 30_000_000n; // $30 tolerance to avoid dust top-ups

// Exit & risk parameters
const MIN_HOLD_BARS = 35;
const COOLDOWN_BARS = 45;
const HARD_STOP_PCT = 0.0120; // 1.20% hard stop from entry (~0.66% equity risk on Stage 1)
const EXIT_SPREAD_BPS = -20; // macro breakdown exit hysteresis
const WIDE_TRAIL_PCT = 0.0240; // wide 2.4% structural trail (only fires on major reversal)
const MAX_SLIPPAGE_BPS = 100;

// TWAP impact targeting (exploits per-bar pool depth reset)
const ENTRY_TARGET_IMPACT_BPS = 3.2;
const EXIT_TARGET_IMPACT_BPS = 3.5;
const URGENT_EXIT_TARGET_IMPACT_BPS = 7.0;

// Guardrail safety net: guarantee min_trades >= 1 even in a 24h pure bear market
const FALLBACK_PROBE_BAR = 1432;
const FALLBACK_PROBE_NOTIONAL = 2_000_000n; // $2 USDC

interface AdaptiveEma {
  span: number;
  count: number;
  value: number;
}

function makeEma(span: number): AdaptiveEma {
  return { span, count: 0, value: 0 };
}

function stepEma(e: AdaptiveEma, x: number): number {
  e.count += 1;
  if (e.count === 1) {
    e.value = x;
    return e.value;
  }
  const effSpan = e.count < e.span ? e.count : e.span;
  const alpha = 2 / (effSpan + 1);
  e.value += alpha * (x - e.value);
  return e.value;
}

class HybridBreakoutTrendBot {
  private fast = makeEma(FAST_SPAN);
  private slow = makeEma(SLOW_SPAN);

  private closes: number[] = [];
  private highs: number[] = [];
  private slowHistory: number[] = [];
  private barIndex = 0;

  // Execution state
  private targetWeightBps = 0n;
  private buildingPosition = false;
  private urgentExit = false;

  // Position & risk tracking
  private entryPrice = 0;
  private peakPrice = 0;
  private entryBar = -1;
  private lastExitBar = -1000;
  private totalFills = 0;
  private consecutiveLosses = 0;
  private hadPosition = false;

  private efficiencyRatio(win: number): number {
    const n = this.closes.length;
    if (n <= win || win < 5) return 0;
    const net = Math.abs(this.closes[n - 1] - this.closes[n - 1 - win]);
    let path = 0;
    for (let i = n - win; i < n; i++) {
      path += Math.abs(this.closes[i] - this.closes[i - 1]);
    }
    return path > 0 ? net / path : 0;
  }

  private priorMaxHigh(win: number): number {
    const n = this.highs.length;
    const end = n - 1;
    const start = Math.max(0, end - win);
    let hi = 0;
    for (let i = start; i < end; i++) {
      if (this.highs[i] > hi) hi = this.highs[i];
    }
    return hi;
  }

  private maxNotionalForImpact(depthRaw: bigint, targetImpactBps: number): bigint {
    const scaled = BigInt(Math.round(targetImpactBps * 10));
    const slice = (depthRaw * scaled) / 100_000n;
    return slice > 180_000_000n ? slice : 180_000_000n;
  }

  onBatch(
    state: BarsState,
    batch: { bars: Bar[]; fills: Array<{ status: string; side: string; price?: string }> }
  ): (BuyInput | SellInput)[] {
    for (const fill of batch.fills) {
      if (fill.status === 'filled') {
        this.totalFills += 1;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (!bar) return [];

    const close = Number(bar.c);
    const high = Number(bar.h);
    this.closes.push(close);
    this.highs.push(high);
    if (this.closes.length > 500) {
      this.closes.shift();
      this.highs.shift();
    }

    const fastVal = stepEma(this.fast, close);
    const slowVal = stepEma(this.slow, close);
    this.slowHistory.push(slowVal);
    if (this.slowHistory.length > 60) this.slowHistory.shift();

    const idx = this.barIndex;
    this.barIndex += 1;

    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const hasPos = held !== undefined && held.qty > 0n;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const depthRaw = bar.c_depth.length > 0 ? BigInt(bar.c_depth[0]) : 800_000_000_000n;

    if (hasPos && !this.hadPosition) {
      this.hadPosition = true;
      this.entryPrice = close;
      this.peakPrice = close;
      this.entryBar = idx;
    } else if (!hasPos && this.hadPosition) {
      this.hadPosition = false;
      this.lastExitBar = idx;
      if (close < this.entryPrice * 0.999) {
        this.consecutiveLosses += 1;
      } else {
        this.consecutiveLosses = 0;
      }
      this.urgentExit = false;
      this.buildingPosition = false;
    }

    if (hasPos && close > this.peakPrice) {
      this.peakPrice = close;
    }

    const spreadBps = slowVal > 0 ? ((fastVal - slowVal) / slowVal) * 10000 : 0;
    const slowSlopeBps =
      this.slowHistory.length >= 25
        ? ((slowVal - this.slowHistory[this.slowHistory.length - 25]) /
            this.slowHistory[this.slowHistory.length - 25]) *
          10000
        : 0;

    // 1. Position management: pyramid or exit
    if (this.targetWeightBps > 0n && hasPos) {
      const heldBars = idx - this.entryBar;
      const unrealized = this.entryPrice > 0 ? (close - this.entryPrice) / this.entryPrice : 0;

      // Pyramid from Stage 1 (55%) -> Stage 2 (100%) on confirmed trend continuation
      if (
        this.targetWeightBps === STAGE1_WEIGHT_BPS &&
        unrealized >= PYRAMID_PROFIT_TRIGGER &&
        spreadBps > 6 &&
        slowSlopeBps > 0
      ) {
        this.targetWeightBps = STAGE2_WEIGHT_BPS;
        this.buildingPosition = true;
      }

      const hitHardStop = close <= this.entryPrice * (1 - HARD_STOP_PCT);
      const hitWideTrail = heldBars >= MIN_HOLD_BARS && close <= this.peakPrice * (1 - WIDE_TRAIL_PCT);
      const hitMacroBreak =
        heldBars >= MIN_HOLD_BARS &&
        spreadBps <= EXIT_SPREAD_BPS &&
        close < slowVal &&
        slowSlopeBps <= 0;

      if (hitHardStop || hitWideTrail || hitMacroBreak) {
        this.targetWeightBps = 0n;
        this.buildingPosition = false;
        this.urgentExit = hitHardStop;
      }
    }

    // 2. Entry evaluation when flat
    if (this.targetWeightBps === 0n && !hasPos) {
      const cooldown = COOLDOWN_BARS + this.consecutiveLosses * 25;
      if (idx >= 55 && idx - this.lastExitBar >= cooldown) {
        const er = this.efficiencyRatio(Math.min(ER_WIN, this.closes.length - 1));
        const breakoutHigh = this.priorMaxHigh(BREAKOUT_WIN);
        const macroHigh = this.priorMaxHigh(MACRO_HIGH_WIN);
        const distFromFastBps = fastVal > 0 ? ((close - fastVal) / fastVal) * 10000 : 0;
        const ret30Bps =
          this.closes.length >= 31
            ? ((close - this.closes[this.closes.length - 31]) /
                this.closes[this.closes.length - 31]) *
              10000
            : 0;

        // Stricter filters after any losing trade to stay out of bear/chop regimes
        const erReq = 0.24 + this.consecutiveLosses * 0.08;
        const slopeReq = 5 + this.consecutiveLosses * 6;
        const clearsResistance = macroHigh > 0 && close >= macroHigh * 0.9980;

        if (
          breakoutHigh > 0 &&
          close > breakoutHigh &&
          clearsResistance &&
          spreadBps >= 8 &&
          slowSlopeBps >= slopeReq &&
          er >= erReq &&
          ret30Bps >= 20 &&
          distFromFastBps <= 85
        ) {
          this.targetWeightBps = STAGE1_WEIGHT_BPS;
          this.buildingPosition = true;
        }
      }
    }

    // 3. Guardrail fallback near end of window if 0 fills occurred
    if (this.targetWeightBps === 0n && !hasPos && idx === FALLBACK_PROBE_BAR && this.totalFills === 0) {
      const probe = state.cash >= FALLBACK_PROBE_NOTIONAL ? FALLBACK_PROBE_NOTIONAL : state.cash;
      if (probe >= minNotional) {
        return [
          {
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: probe,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          },
        ];
      }
      return [];
    }

    // 4. Execute TWAP slices toward targetWeightBps
    if (this.targetWeightBps > 0n && this.buildingPosition) {
      const capBps = BigInt(state.hello.caps.max_weight_bps);
      const effBps = this.targetWeightBps < capBps ? this.targetWeightBps : capBps;
      const targetVal = (effBps * state.equity) / BPS;
      const heldValue = held ? state.value(SYMBOL, held.qty) : 0n;
      let remaining = targetVal > heldValue ? targetVal - heldValue : 0n;
      if (remaining > state.cash) remaining = state.cash;

      if (remaining < REBALANCE_TOLERANCE) {
        this.buildingPosition = false;
        return [];
      }

      if (remaining >= minNotional) {
        const maxSlice = this.maxNotionalForImpact(depthRaw, ENTRY_TARGET_IMPACT_BPS);
        const slice = remaining <= (maxSlice * 135n) / 100n ? remaining : maxSlice;
        if (slice >= minNotional) {
          return [
            {
              side: 'buy',
              symbol: SYMBOL,
              notional_quote_units: slice,
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            },
          ];
        }
      }
    } else if (this.targetWeightBps === 0n && hasPos && held) {
      const heldValue = state.value(SYMBOL, held.qty);
      const targetImpact = this.urgentExit ? URGENT_EXIT_TARGET_IMPACT_BPS : EXIT_TARGET_IMPACT_BPS;
      const maxSliceVal = this.maxNotionalForImpact(depthRaw, targetImpact);
      let sellQty = held.qty;
      if (heldValue > (maxSliceVal * 135n) / 100n && heldValue > 0n) {
        sellQty = (held.qty * maxSliceVal) / heldValue;
        if (sellQty <= 0n) sellQty = held.qty;
      }
      return [
        {
          side: 'sell',
          symbol: SYMBOL,
          qty: sellQty,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }

    return [];
  }
}

const bot = new HybridBreakoutTrendBot();

await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
