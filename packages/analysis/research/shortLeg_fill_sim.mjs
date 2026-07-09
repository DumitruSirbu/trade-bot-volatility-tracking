// EXP-020 — Cross-Sectional Momentum SHORT-vs-LONG leg comparison (realistic fills).
//
// RESEARCH SCRIPT (read-only). Changes no engine/production code. Lives in the
// analysis package's research/ folder so it can import the REAL shared fill core
// (@bot/shared applyFill) and `pg`. Run from repo root:
//
//   node packages/analysis/research/shortLeg_fill_sim.mjs
//
// Extends EXP-012 (phaseB_fill_sim.mjs) to answer: does a SHORT cross-sectional
// momentum leg (short the D1 losers) BEAT or COMPLEMENT the current LONG-only
// xmom (long the D10 winners)? Same panel, same fill core, same 24h/24h op point,
// same $20k median-5m-dvol floor, same non-overlapping rebalances and 3 disjoint
// sub-windows. Adds:
//   (1) the SHORT leg (D1) reported as its OWN series (mean/std/t/%pos), net &
//       frictionless, sign-flipped correctly for a short (return = -fwd_return),
//       priced through applyFill with the correct adverse direction per side.
//   (2) a REGIME-MATCHED breakdown: each period is tagged UP/DOWN by the realized
//       cross-sectional mean forward return of the FULL tradable universe (the
//       "market" that period). Long-net, short-net and LS-net are then compared
//       WITHIN each regime and WITHIN each chronological sub-window — never
//       long-in-an-up-month vs short-in-a-down-month.
//
// Fidelity scope identical to EXP-012: tier-floor slippage (tier1 0.15% / tier2
// 0.50% / tier3 1.0%) + 4bps taker, real per-symbol coin_tier from `instruments`,
// taker-market always-fill. Does NOT charge short-borrow, funding on 24h holds,
// fast-mover slippage beyond the tier floor, or missed IOC fills. Any short edge
// here is therefore an UPPER bound. The regime tag uses REALIZED forward market
// return, so it is descriptive attribution, not an ex-ante tradable conditioning
// rule (you do not know the regime at rebalance time).

import pg from 'pg';
import { applyFill, OrderPolicyEnum, CoinTierEnum } from '@bot/shared';

const LOOKBACK_H = 24;
const HOLDING_H = 24;
const LIQUIDITY_FLOOR = 20_000;
const N_WINDOWS = 3;
const NOTIONAL_USDT = 1_000;
const REDUCE_MARKET_TIMEOUT_MS = 5_000;
const TIER_SLIPPAGE_PARAMS = {};
const EMPTY_SEED = { seedBytes: Buffer.alloc(0), version: 'exp020-shortleg' };

const CONNECTION = process.env.PHASEB_DB_URL
    ?? 'postgresql://trade_bot:MakeMeRich2026!@localhost:5433/trade_bot';

// Full decile panel (all 10 deciles) so the per-period MARKET forward return can
// be computed from the whole tradable universe; fills are simulated only on the
// two traded deciles (D1 short, D10 long).
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
FROM ranked
ORDER BY rebal_time, decile, symbol;
`;

function tierEnumFromDb(coinTier) {
    if (coinTier === 'tier1') return CoinTierEnum.TIER_1;
    if (coinTier === 'tier2') return CoinTierEnum.TIER_2;
    return CoinTierEnum.TIER_3;
}

function simulatePosition(row, side) {
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
        tier: row.coin_tier,
        netReturn,
        frictionlessReturn: side === 'long' ? row.forward_return : -row.forward_return,
        frictionBps: Number(entry.slippagePct) * 100 + Number(exit.slippagePct) * 100 + (fees / NOTIONAL_USDT) * 10_000,
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

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stddev(xs) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function summarise(series) {
    const n = series.length;
    const m = mean(series);
    const sd = stddev(series);
    const tStat = sd === 0 ? 0 : m / (sd / Math.sqrt(n));
    const annSharpe = sd === 0 ? 0 : (m / sd) * Math.sqrt((365 * 24) / HOLDING_H);
    const pctPositive = n ? (series.filter((x) => x > 0).length / n) * 100 : 0;
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

    // Per-period aggregation. Market forward = cross-sectional mean of ALL deciles.
    const byPeriod = new Map();
    const tierCount = { long: { tier1: 0, tier2: 0, tier3: 0 }, short: { tier1: 0, tier2: 0, tier3: 0 } };
    const frictionAccum = { long: [], short: [] };

    for (const row of rows) {
        const key = new Date(row.rebal_time).toISOString();
        if (!byPeriod.has(key)) {
            byPeriod.set(key, { subwindow: row.subwindow, marketFwd: [], longNet: [], shortNet: [], longFric: [], shortFric: [] });
        }
        const bucket = byPeriod.get(key);
        bucket.marketFwd.push(row.forward_return);
        if (row.decile === 10) {
            const sim = simulatePosition(row, 'long');
            bucket.longNet.push(sim.netReturn); bucket.longFric.push(sim.frictionlessReturn);
            tierCount.long[sim.tier] += 1; frictionAccum.long.push(sim.frictionBps);
        } else if (row.decile === 1) {
            const sim = simulatePosition(row, 'short');
            bucket.shortNet.push(sim.netReturn); bucket.shortFric.push(sim.frictionlessReturn);
            tierCount.short[sim.tier] += 1; frictionAccum.short.push(sim.frictionBps);
        }
    }

    const periods = [...byPeriod.entries()].map(([t, b]) => ({
        t, subwindow: b.subwindow,
        marketFwd: mean(b.marketFwd),
        longNet: mean(b.longNet), shortNet: mean(b.shortNet),
        longFric: mean(b.longFric), shortFric: mean(b.shortFric),
    })).sort((a, b) => a.t.localeCompare(b.t));

    const series = (sel) => periods.map(sel);
    const longShortNet = series((p) => p.longNet + p.shortNet);
    const longShortFric = series((p) => p.longFric + p.shortFric);

    const legTable = {
        longOnly: { net: summarise(series((p) => p.longNet)), fric: summarise(series((p) => p.longFric)) },
        shortOnly: { net: summarise(series((p) => p.shortNet)), fric: summarise(series((p) => p.shortFric)) },
        longShort: { net: summarise(longShortNet), fric: summarise(longShortFric) },
    };

    // Regime split by realized market forward return (descriptive, ex-post).
    const up = periods.filter((p) => p.marketFwd > 0);
    const down = periods.filter((p) => p.marketFwd <= 0);
    const regimeRow = (ps) => ({
        n: ps.length,
        longNetPct: mean(ps.map((p) => p.longNet)) * 100,
        shortNetPct: mean(ps.map((p) => p.shortNet)) * 100,
        lsNetPct: mean(ps.map((p) => p.longNet + p.shortNet)) * 100,
        longFricPct: mean(ps.map((p) => p.longFric)) * 100,
        shortFricPct: mean(ps.map((p) => p.shortFric)) * 100,
    });

    // Per chronological sub-window, leg-by-leg (within-window comparison).
    const perWindow = [];
    for (let w = 1; w <= N_WINDOWS; w++) {
        const wp = periods.filter((p) => p.subwindow === w);
        perWindow.push({
            subwindow: w, n: wp.length,
            span: `${wp[0]?.t.slice(0, 10)} .. ${wp[wp.length - 1]?.t.slice(0, 10)}`,
            marketFwdPct: mean(wp.map((p) => p.marketFwd)) * 100,
            longNetPct: mean(wp.map((p) => p.longNet)) * 100,
            shortNetPct: mean(wp.map((p) => p.shortNet)) * 100,
            lsNetPct: mean(wp.map((p) => p.longNet + p.shortNet)) * 100,
        });
    }

    const report = {
        meta: { lookbackH: LOOKBACK_H, holdingH: HOLDING_H, liquidityFloor: LIQUIDITY_FLOOR, positions: rows.length, periods: periods.length, generatedAt: new Date().toISOString() },
        legTable,
        regime: { up: regimeRow(up), down: regimeRow(down) },
        perWindow,
        avgFrictionBpsRoundTrip: { longLeg: mean(frictionAccum.long), shortLeg: mean(frictionAccum.short) },
        tierComposition: tierCount,
    };

    print(report);
    process.stdout.write('\n__JSON__\n' + JSON.stringify(report, null, 2) + '\n');
}

function fmt(x, d = 2) { return Number(x).toFixed(d); }
function line(label, s) {
    return `${label.padEnd(16)} ${fmt(s.meanPct, 4).padStart(9)}  ${fmt(s.stdPct, 3).padStart(7)}  ${fmt(s.tStat).padStart(6)}  ${fmt(s.annSharpe).padStart(7)}  ${fmt(s.pctPositive, 1).padStart(5)}\n`;
}
function print(r) {
    const o = process.stdout;
    o.write(`\n=== EXP-020 SHORT-vs-LONG xmom leg comparison (${r.meta.lookbackH}h/${r.meta.holdingH}h, $${r.meta.liquidityFloor} floor) ===\n`);
    o.write(`positions=${r.meta.positions}  periods=${r.meta.periods}\n`);
    o.write(`\n--- per-leg per-period series ---\n`);
    o.write(`                 mean%/pd    std%   t-stat  annShrp  %pos\n`);
    o.write(`LONG net         ` + line('', r.legTable.longOnly.net).trimStart());
    o.write(`LONG frictionless` + line('', r.legTable.longOnly.fric).trimStart());
    o.write(`SHORT net        ` + line('', r.legTable.shortOnly.net).trimStart());
    o.write(`SHORT friction'ss` + line('', r.legTable.shortOnly.fric).trimStart());
    o.write(`L-S book net     ` + line('', r.legTable.longShort.net).trimStart());
    o.write(`L-S book fricti's` + line('', r.legTable.longShort.fric).trimStart());
    o.write(`\n--- REGIME-MATCHED (realized market fwd return sign; descriptive) ---\n`);
    const u = r.regime.up, d = r.regime.down;
    o.write(`UP   periods n=${u.n}: LONG net ${fmt(u.longNetPct, 3)}%  SHORT net ${fmt(u.shortNetPct, 3)}%  L-S ${fmt(u.lsNetPct, 3)}%  (fric L ${fmt(u.longFricPct, 3)} / S ${fmt(u.shortFricPct, 3)})\n`);
    o.write(`DOWN periods n=${d.n}: LONG net ${fmt(d.longNetPct, 3)}%  SHORT net ${fmt(d.shortNetPct, 3)}%  L-S ${fmt(d.lsNetPct, 3)}%  (fric L ${fmt(d.longFricPct, 3)} / S ${fmt(d.shortFricPct, 3)})\n`);
    o.write(`\n--- per chronological sub-window, leg-by-leg (net) ---\n`);
    for (const w of r.perWindow) {
        o.write(`  w${w.subwindow} (n=${w.n}, ${w.span}, mktFwd ${fmt(w.marketFwdPct, 2)}%): LONG ${fmt(w.longNetPct, 3)}%  SHORT ${fmt(w.shortNetPct, 3)}%  L-S ${fmt(w.lsNetPct, 3)}%\n`);
    }
    o.write(`\n--- avg round-trip friction (slippage+fees), bps ---\n`);
    o.write(`long leg (D10): ${fmt(r.avgFrictionBpsRoundTrip.longLeg, 1)}   short leg (D1): ${fmt(r.avgFrictionBpsRoundTrip.shortLeg, 1)}\n`);
    o.write(`--- tier composition (position-count) ---\n`);
    o.write(`D10 long : tier1=${r.tierComposition.long.tier1}  tier2=${r.tierComposition.long.tier2}\n`);
    o.write(`D1  short: tier1=${r.tierComposition.short.tier1}  tier2=${r.tierComposition.short.tier2}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
