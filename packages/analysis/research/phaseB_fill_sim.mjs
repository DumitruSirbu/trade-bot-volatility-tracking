// EXP-012 — Cross-Sectional Momentum Phase B-lite: realistic-fill execution-drag study.
//
// RESEARCH SCRIPT (read-only). Changes no engine/production code. Lives in the
// analysis package's research/ folder (outside the tsc `src` build) so it can
// import the REAL shared fill core (@bot/shared) and `pg` via the package's
// node_modules. Run from repo root:
//
//   node packages/analysis/research/phaseB_fill_sim.mjs
//
// Purpose: EXP-011 (Phase A) measured the cross-sectional momentum edge on
// FRICTIONLESS close-to-close returns with a flat 10bps/leg cost stub, and
// flagged one open caveat — the winner (D10) leg trades the highest-slippage
// coins, so the price-only +4.1% overstates it. This script re-prices the
// 24h/24h operating point through the engine's ACTUAL fill model
// (`applyFill` from @bot/shared: tier-floor adverse slippage + taker fees, with
// the REAL per-symbol coin_tier from `instruments`) and recomputes the
// long-short spread net of true modeled execution cost.
//
// Fidelity scope (honest): the engine's M7 fill model is tier-floor — slippage
// is a fixed %-of-notional per tier (tier1 0.15% / tier2 0.50% / tier3 1.0%),
// NOT depth- or velocity-aware (see EXP-008). This script applies exactly that
// model, so it captures the dominant real cost (tier slippage + fees) but not
// fast-mover slippage beyond the tier floor, nor IOC missed-fills (the 2s IOC
// timeout vs ~10s tick granularity makes per-order miss modeling a granularity
// artifact). Those remain un-modeled costs — see the report's caveats.

import pg from 'pg';
import { applyFill, OrderPolicyEnum, CoinTierEnum } from '@bot/shared';

const LOOKBACK_H = 24;
const HOLDING_H = 24;
const LIQUIDITY_FLOOR = 20_000; // median 5m dollar-volume to be tradable (matches EXP-011)
const N_WINDOWS = 3;
const NOTIONAL_USDT = 1_000; // per-leg notional; cancels in % terms, needed for fee fraction
const REDUCE_MARKET_TIMEOUT_MS = 5_000; // ORDER_TIMEOUT_MS[REDUCE_MARKET]
const TIER_SLIPPAGE_PARAMS = {}; // {} → engine defaults: 0.15 / 0.50 / 1.0 %
const EMPTY_SEED = { seedBytes: Buffer.alloc(0), version: 'exp012-phaseB' };

const CONNECTION = process.env.PHASEB_DB_URL
    ?? 'postgresql://trade_bot:MakeMeRich2026!@localhost:5433/trade_bot';

// Decile-1 (short basket) and decile-10 (long basket) members at every
// non-overlapping 24h rebalance, with the real coin_tier and the entry/exit
// reference closes. Mirrors EXP-011's panel; emits only the two traded deciles.
const PANEL_SQL = `
WITH bounds AS (SELECT min(open_time) t0, max(open_time) t1 FROM candles WHERE interval='5m'),
liq AS (
  SELECT symbol, percentile_cont(0.5) WITHIN GROUP (ORDER BY close*volume) med
  FROM candles WHERE interval='5m' GROUP BY symbol),
tradable AS (SELECT symbol FROM liq WHERE med >= $1),
grid AS (
  SELECT gs AS t FROM bounds,
  generate_series((SELECT t0 FROM bounds)+($2||' hours')::interval,
                  (SELECT t1 FROM bounds)-($3||' hours')::interval,
                  ($3||' hours')::interval) gs),
panel AS (
  SELECT g.t AS rebal_time, c0.symbol, i.coin_tier,
         c0.close::float8 AS px_entry, cf.close::float8 AS px_exit,
         (c0.close/cb.close-1)::float8 AS trailing_return,
         (cf.close/c0.close-1)::float8 AS forward_return
  FROM grid g
  JOIN tradable tr ON true
  JOIN instruments i ON i.symbol = tr.symbol
  JOIN candles c0 ON c0.interval='5m' AND c0.symbol=tr.symbol AND c0.open_time=g.t
  JOIN candles cb ON cb.interval='5m' AND cb.symbol=tr.symbol AND cb.open_time=g.t-($2||' hours')::interval
  JOIN candles cf ON cf.interval='5m' AND cf.symbol=tr.symbol AND cf.open_time=g.t+($3||' hours')::interval
  WHERE c0.close>0 AND cb.close>0 AND cf.close>0),
ranked AS (
  SELECT *, ntile(10) OVER (PARTITION BY rebal_time ORDER BY trailing_return) AS decile,
            ntile($4) OVER (ORDER BY rebal_time) AS subwindow
  FROM panel)
SELECT rebal_time, symbol, coin_tier, decile, subwindow, px_entry, px_exit,
       trailing_return, forward_return
FROM ranked WHERE decile IN (1, 10)
ORDER BY rebal_time, decile, symbol;
`;

function tierEnumFromDb(coinTier) {
    if (coinTier === 'tier1') return CoinTierEnum.TIER_1;
    if (coinTier === 'tier2') return CoinTierEnum.TIER_2;
    return CoinTierEnum.TIER_3;
}

// Net realized return fraction for one position after real entry+exit fills.
function simulatePosition(row) {
    const side = row.decile === 10 ? 'long' : 'short';
    const qty = NOTIONAL_USDT / row.px_entry;
    const tsMs = new Date(row.rebal_time).getTime();

    const entry = applyFill(
        snapshotAt(row.px_entry, tsMs), openIntent(side, row.px_entry, qty),
        tierEnumFromDb(row.coin_tier), TIER_SLIPPAGE_PARAMS, EMPTY_SEED, [], tsMs, REDUCE_MARKET_TIMEOUT_MS, 0,
    );
    const exitTsMs = tsMs + HOLDING_H * 3_600_000;
    const exit = applyFill(
        snapshotAt(row.px_exit, exitTsMs), closeIntent(side, row.px_exit, qty),
        tierEnumFromDb(row.coin_tier), TIER_SLIPPAGE_PARAMS, EMPTY_SEED, [], exitTsMs, REDUCE_MARKET_TIMEOUT_MS, 0,
    );

    const entryPx = Number(entry.fillPrice);
    const exitPx = Number(exit.fillPrice);
    const fees = Number(entry.feeUsdt) + Number(exit.feeUsdt);
    const grossPnl = side === 'long' ? (exitPx - entryPx) * qty : (entryPx - exitPx) * qty;
    const netReturn = (grossPnl - fees) / NOTIONAL_USDT;

    return {
        side,
        tier: row.coin_tier,
        netReturn,
        frictionlessReturn: side === 'long' ? row.forward_return : -row.forward_return,
        entrySlipBps: Number(entry.slippagePct) * 100,
        exitSlipBps: Number(exit.slippagePct) * 100,
        feeBps: (fees / NOTIONAL_USDT) * 10_000,
    };
}

function snapshotAt(price, tsMs) {
    const ref = String(price);
    return { bid: ref, ask: ref, last: ref, mark: ref, high: ref, low: ref, ts: tsMs };
}
function openIntent(side, price, qty) {
    return { side, action: 'open', policy: OrderPolicyEnum.REDUCE_MARKET, limitPrice: String(price), qty: String(qty), postOnly: false, reduceOnly: false };
}
function closeIntent(side, price, qty) {
    return { side, action: 'close', policy: OrderPolicyEnum.REDUCE_MARKET, limitPrice: String(price), qty: String(qty), postOnly: false, reduceOnly: true };
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stddev(xs) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function summariseSeries(series) {
    const n = series.length;
    const m = mean(series);
    const sd = stddev(series);
    const tStat = sd === 0 ? 0 : m / (sd / Math.sqrt(n));
    const periodsPerYear = (365 * 24) / HOLDING_H;
    const annSharpe = sd === 0 ? 0 : (m / sd) * Math.sqrt(periodsPerYear);
    const pctPositive = (series.filter((x) => x > 0).length / n) * 100;
    return { n, meanPct: m * 100, stdPct: sd * 100, tStat, annSharpe, pctPositive };
}

async function main() {
    const client = new pg.Client({ connectionString: CONNECTION });
    await client.connect();
    let rows;
    try {
        const res = await client.query(PANEL_SQL, [LIQUIDITY_FLOOR, LOOKBACK_H, HOLDING_H, N_WINDOWS]);
        rows = res.rows.map((r) => ({ ...r, decile: Number(r.decile), subwindow: Number(r.subwindow) }));
    } finally {
        await client.end();
    }

    // Group by rebalance period; build per-period long, short, and long-short returns.
    const byPeriod = new Map();
    const tierCount = { long: { tier1: 0, tier2: 0, tier3: 0 }, short: { tier1: 0, tier2: 0, tier3: 0 } };
    const slipAccum = { long: [], short: [] };

    for (const row of rows) {
        const sim = simulatePosition(row);
        const key = new Date(row.rebal_time).toISOString();
        if (!byPeriod.has(key)) byPeriod.set(key, { subwindow: row.subwindow, longNet: [], shortNet: [], longFric: [], shortFric: [] });
        const bucket = byPeriod.get(key);
        if (sim.side === 'long') { bucket.longNet.push(sim.netReturn); bucket.longFric.push(sim.frictionlessReturn); }
        else { bucket.shortNet.push(sim.netReturn); bucket.shortFric.push(sim.frictionlessReturn); }
        tierCount[sim.side][sim.tier] += 1;
        slipAccum[sim.side].push(sim.entrySlipBps + sim.exitSlipBps + sim.feeBps);
    }

    const periods = [...byPeriod.entries()].map(([t, b]) => ({
        t,
        subwindow: b.subwindow,
        longNet: b.longNet.length ? mean(b.longNet) : 0,
        shortNet: b.shortNet.length ? mean(b.shortNet) : 0,
        longFric: b.longFric.length ? mean(b.longFric) : 0,
        shortFric: b.shortFric.length ? mean(b.shortFric) : 0,
    })).sort((a, b) => a.t.localeCompare(b.t));

    const lsNet = periods.map((p) => p.longNet + p.shortNet);
    const lsFric = periods.map((p) => p.longFric + p.shortFric);
    const longNetSeries = periods.map((p) => p.longNet);
    const longFricSeries = periods.map((p) => p.longFric);

    const perWindow = [];
    for (let w = 1; w <= N_WINDOWS; w++) {
        const wp = periods.filter((p) => p.subwindow === w);
        perWindow.push({ subwindow: w, n: wp.length, lsNetPct: mean(wp.map((p) => p.longNet + p.shortNet)) * 100, lsFricPct: mean(wp.map((p) => p.longFric + p.shortFric)) * 100 });
    }

    const report = {
        meta: { lookbackH: LOOKBACK_H, holdingH: HOLDING_H, liquidityFloor: LIQUIDITY_FLOOR, notionalUsdt: NOTIONAL_USDT, positions: rows.length, periods: periods.length, generatedAt: new Date().toISOString() },
        longShort: { net: summariseSeries(lsNet), frictionless: summariseSeries(lsFric) },
        longOnly: { net: summariseSeries(longNetSeries), frictionless: summariseSeries(longFricSeries) },
        perWindow,
        avgFrictionBpsRoundTrip: { longLeg: mean(slipAccum.long), shortLeg: mean(slipAccum.short) },
        tierComposition: tierCount,
    };

    print(report);
    process.stdout.write('\n__JSON__\n' + JSON.stringify(report, null, 2) + '\n');
}

function fmt(x, d = 2) { return Number(x).toFixed(d); }

function print(r) {
    const out = process.stdout;
    out.write(`\n=== EXP-012 Phase B-lite — realistic-fill execution drag (${r.meta.lookbackH}h/${r.meta.holdingH}h) ===\n`);
    out.write(`positions=${r.meta.positions}  periods=${r.meta.periods}  notional=$${r.meta.notionalUsdt}/leg\n`);
    out.write(`\n--- LONG-SHORT (D10 long + D1 short) per period ---\n`);
    out.write(`               mean%/period   std%    t-stat   annSharpe   %pos\n`);
    const ls = r.longShort;
    out.write(`frictionless:  ${fmt(ls.frictionless.meanPct,4).padStart(10)}   ${fmt(ls.frictionless.stdPct,3).padStart(6)}   ${fmt(ls.frictionless.tStat).padStart(5)}   ${fmt(ls.frictionless.annSharpe).padStart(7)}   ${fmt(ls.frictionless.pctPositive,1)}\n`);
    out.write(`real fills:    ${fmt(ls.net.meanPct,4).padStart(10)}   ${fmt(ls.net.stdPct,3).padStart(6)}   ${fmt(ls.net.tStat).padStart(5)}   ${fmt(ls.net.annSharpe).padStart(7)}   ${fmt(ls.net.pctPositive,1)}\n`);
    out.write(`\n--- LONG-ONLY (D10 winners, single-slot proxy) per period ---\n`);
    out.write(`frictionless:  ${fmt(r.longOnly.frictionless.meanPct,4).padStart(10)}   t=${fmt(r.longOnly.frictionless.tStat)}\n`);
    out.write(`real fills:    ${fmt(r.longOnly.net.meanPct,4).padStart(10)}   t=${fmt(r.longOnly.net.tStat)}\n`);
    out.write(`\n--- avg round-trip friction (slippage+fees), bps ---\n`);
    out.write(`long leg (D10): ${fmt(r.avgFrictionBpsRoundTrip.longLeg,1)}   short leg (D1): ${fmt(r.avgFrictionBpsRoundTrip.shortLeg,1)}\n`);
    out.write(`\n--- tier composition (position-count) ---\n`);
    out.write(`D10 long : tier1=${r.tierComposition.long.tier1}  tier2=${r.tierComposition.long.tier2}\n`);
    out.write(`D1  short: tier1=${r.tierComposition.short.tier1}  tier2=${r.tierComposition.short.tier2}\n`);
    out.write(`\n--- per sub-window long-short ---\n`);
    for (const w of r.perWindow) out.write(`  w${w.subwindow} (n=${w.n}): frictionless ${fmt(w.lsFricPct,3)}%  real ${fmt(w.lsNetPct,3)}%\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
