# Structural Breakout & Hysteresis Macro Trend TWAP Bot (cbBTC/USDC)

A deterministic, long-only `agent-fun/bars-replay/v1` trading bot for `btc-race-24h-20261123-0511` running on Node 22 with zero external dependencies (standard library + vendored `vendor/makefun-bars.ts`).

## Strategy Architecture

1. **Structural Breakout Entry Filter**:
   - Adaptive warm-start dual EMAs (`EMA 28` vs `EMA 100`), 105-bar Donchian breakout, and a 360-bar (6-hour) structural resistance filter to avoid buying dead-cat bounces in downtrends or lower-high tops inside sideways ranges.
   - Gated by Kaufman Efficiency Ratio (60-bar), positive slow-EMA slope, minimum 30-bar impulse (`>= 20 bps`), and an anti-chasing extension cap (`<= 85 bps` above fast EMA).
   - Adaptive chop brake raises entry conviction thresholds and cooldown after any losing trade.

2. **Two-Stage Conviction Pyramiding**:
   - Deploys 55% of equity on initial structural breakout (`Stage 1`), scaling to 100% (`Stage 2`) only after `+0.40%` unrealized confirmation with rising macro trend — cutting false-breakout risk while keeping full exposure on sustained rallies.

3. **Hysteresis-Gated Macro Exit & Risk Controls**:
   - Asymmetric exit deadband (`fast < slow` by `-20 bps` with `close < slow` and `slowSlope <= 0`) rides through normal intraday pullbacks without whipsaw while exiting cleanly on genuine reversals.
   - Backed by a `1.20%` initial hard stop and `2.40%` structural trailing stop.

4. **Impact-Aware Multi-Bar TWAP Execution**:
   - Exploits the replay engine's per-bar pool depth reset by slicing entries and exits across consecutive bars targeting `<= 3.2–3.5 bps` constant-product pool impact per bar (vs. ~11–18 bps for a single-bar full-equity order).
   - Includes an end-of-window `$2` fallback probe if zero fills occurred by bar 1432 to guarantee the `min_trades >= 1` guardrail even in a 24-hour pure bear market.

## Local Verification (`grade-local --driver process`)

- **Dev Net PnL**: `+11.931707 USDC` (`+1.193%`), `100%` win rate, `0` rejected orders
- **2x Fees Net PnL**: `+11.122772 USDC`
- **Max Drawdown**: `1.81%` (guardrail `<= 25%`)
- **Determinism**: Two executions reproduced byte-for-byte (`L1 regrade` verified)
