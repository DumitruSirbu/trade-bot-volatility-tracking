// Real-price TP:SL ratio replay for xmom (strategy_version_id = 20).
//
// RESEARCH SCRIPT (read-only). Touches no engine/production code. Lives in the
// analysis package's research/ folder (outside the tsc `src` build) so it can use
// `pg` + `decimal.js` from this package's node_modules, `@bot/shared`'s built touch
// primitive, and ccxt from apps/engine/node_modules (public OHLCV only, no keys).
//
// Run from repo root:
//   node packages/analysis/research/xmom_tp_ratio_replay.mjs --ratios=1.5,1.8,2,2.5,3
//   node packages/analysis/research/xmom_tp_ratio_replay.mjs --ratios=2,3 --position-ids=232,236
//
// QUESTION (closes the gap left by xmom_tp_arm_reconstruction.mjs): for a WIDENED
// take-profit arm, would the wider TP actually get HIT before the frozen stop-loss or
// the time-stop? The reconstruction script could only test the fill-accept guard; it
// could NOT test barrier-touch because mfe/mae are single peak values, truncated for
// winners and absent for 0-duration force_closes. This script fetches REAL 1m OHLCV
// from Binance USDT-M Futures and replays each position bar-by-bar to resolve the
// first-touched barrier, using the SAME touch convention as the live/backtest engine
// (`@bot/shared` simulateIntrabarStop: LONG SL when low<=SL, TP when high>=TP, SL wins
// ties — C6 conservatism).
//
// RECONSTRUCTION (identical algebra to xmom_tp_arm_reconstruction.mjs — cited, not owned):
//   D  = (TP_old - SL) / 2.5          [arm 1.5: TP-SL = (P0+1.5D)-(P0-D) = 2.5D]
//   P0 = SL + D                        (signal price)
//   s  = (entry - P0) / D              (fill slippage as fraction of D)
//   TP_new(a) = P0 + a*D  (long)  /  P0 - a*D  (short)   -- SL is arm-independent, frozen
//   realizedRR_at_fill(a) = (TP_new - entry)/(entry - SL)  (long); guard rejects when < 1.5.
//
// PnL: qty_coin = entry_notional / entry_price. Replay PnL is GROSS (qty*(exit-entry));
// it EXCLUDES fees/funding/slippage, so it is NOT directly comparable to positions.realized_pnl
// (which embeds them). It is an apples-to-apples cross-RATIO figure. force_close positions
// contribute ~0 (a small taker fee-bleed in reality; excluded here and reported separately).
//
// CAVEATS baked into the output: (1) entry-bar look-ahead is avoided by only replaying 1m
// bars whose open >= opened_at, so a same-minute touch in the fill minute is not counted
// (conservative). (2) 1m granularity cannot see sub-minute path; when SL and TP both fall
// inside one 1m bar the shared convention resolves SL-first (conservative), flagged lowFid.
// (3) n=31 is below decision-grade statistical power (see EXP-009/EXP-010) — this is better
// EVIDENCE than the mfe proxy, not proof.

import pg from 'pg';
import Decimal from 'decimal.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { simulateIntrabarStop } from '@bot/shared';

Decimal.set({ precision: 40 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const CCXT_ENTRY = path.join(REPO_ROOT, 'apps/engine/node_modules/ccxt/js/ccxt.js');

const CONNECTION =
    process.env.PHASEB_DB_URL ?? 'postgresql://trade_bot:MakeMeRich2026!@localhost:5433/trade_bot';

const STRATEGY_VERSION_ID = 20;
const GUARD = new Decimal('1.5');   // fill-accept RR floor — fixed; only the arm moves.
const ARM_BASELINE = new Decimal('1.5');
const TIMEFRAME = '1m';
const TIMEFRAME_MS = 60_000;
const PAGE_LIMIT = 1500;

const d = (x) => new Decimal(x);
const f = (n, dp = 2) => (n === null || Number.isNaN(n) ? '   n/a' : Number(n).toFixed(dp).padStart(8));

function parseArgs(argv) {
    const out = { ratios: ['1.5', '1.8', '2', '2.5', '3'], positionIds: null };
    for (const arg of argv) {
        if (arg.startsWith('--ratios=')) {
            out.ratios = arg.slice('--ratios='.length).split(',').map((r) => r.trim()).filter(Boolean);
        } else if (arg.startsWith('--position-ids=')) {
            out.positionIds = arg.slice('--position-ids='.length).split(',').map((r) => Number(r.trim())).filter((n) => !Number.isNaN(n));
        }
    }
    return out;
}

// Pure inversion — see header. Returns signal reference for one position.
function reconstruct(row) {
    const entry = d(row.entry_price);
    const sl = d(row.stop_loss_price);
    const tpOld = d(row.take_profit_price);
    const stopDist = tpOld.minus(sl).div(ARM_BASELINE.plus(1)); // /2.5
    const p0 = sl.plus(stopDist);
    const s = entry.minus(p0).div(stopDist);
    return { entry, sl, tpOld, stopDist, p0, s };
}

// Side-aware widened TP + realized-at-fill RR for arm `a`.
function armGeometry(rec, side, a) {
    const arm = d(a);
    const isLong = side === 'long';
    const tpNew = isLong ? rec.p0.plus(rec.stopDist.times(arm)) : rec.p0.minus(rec.stopDist.times(arm));
    const reward = isLong ? tpNew.minus(rec.entry) : rec.entry.minus(tpNew);
    const risk = isLong ? rec.entry.minus(rec.sl) : rec.sl.minus(rec.entry);
    const realizedRR = risk.lte(0) ? d(-999) : reward.div(risk);
    return { tpNew, realizedRR };
}

async function fetchBars(ex, symbol, startMs, endMs) {
    const bars = [];
    let cursor = startMs;
    // Paginate forward; Binance returns bars with open ts ascending.
    while (cursor <= endMs) {
        let page;
        try {
            page = await ex.fetchOHLCV(symbol, TIMEFRAME, cursor, PAGE_LIMIT);
        } catch (e) {
            return { bars, error: `${e.constructor.name}: ${String(e.message).slice(0, 80)}` };
        }
        if (!page || page.length === 0) break;
        for (const b of page) {
            if (b[0] > endMs) continue;
            bars.push(b); // [openMs, open, high, low, close, volume]
        }
        const lastOpen = page[page.length - 1][0];
        if (lastOpen <= cursor) break; // no progress
        cursor = lastOpen + TIMEFRAME_MS;
        if (page.length < PAGE_LIMIT) break;
    }
    return { bars, error: null };
}

// Replay one position at one ratio against real bars. Returns outcome + exit price.
function replay(rec, row, tpNew, bars) {
    const side = row.side;
    const openedMs = new Date(row.opened_at).getTime();
    const timeStopMs = new Date(row.time_stop_at).getTime();
    const slStr = rec.sl.toFixed();
    const tpStr = tpNew.toFixed();

    let lastClose = null;
    for (const bar of bars) {
        const [openMs, , high, low, close] = bar;
        if (openMs < openedMs) continue;   // avoid entry-minute look-ahead (conservative)
        if (openMs > timeStopMs) break;    // reached the time-stop deadline
        lastClose = close;
        // One 1m candle = one "bar" with no sub-ticks -> shared bar-extreme resolution.
        const res = simulateIntrabarStop(side, slStr, tpStr, [], String(high), String(low), openMs);
        if (res.hit === 'stop_loss') {
            return { outcome: 'sl_hit', exit: d(res.hitPrice), lowFid: res.lowFidelity, hitMs: openMs };
        }
        if (res.hit === 'take_profit') {
            return { outcome: 'tp_hit', exit: d(res.hitPrice), lowFid: res.lowFidelity, hitMs: openMs };
        }
    }
    // No barrier touched through the deadline -> time-stop at last observed close.
    return { outcome: 'time_stop', exit: lastClose === null ? rec.entry : d(lastClose), lowFid: true, hitMs: timeStopMs };
}

function grossPnl(row, rec, exitPrice) {
    const qtyCoin = d(row.entry_notional).div(rec.entry);
    const delta = row.side === 'long' ? exitPrice.minus(rec.entry) : rec.entry.minus(exitPrice);
    return qtyCoin.times(delta);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    console.log(`xmom TP:SL ratio replay — ratios [${args.ratios.join(', ')}]` +
        (args.positionIds ? ` — positions [${args.positionIds.join(',')}]` : ' — all strategy_version_id=20') + '\n');

    const client = new pg.Client({ connectionString: CONNECTION });
    await client.connect();
    const { rows } = await client.query(
        `SELECT positions_id, symbol, side, entry_price, stop_loss_price, take_profit_price,
                exit_reason, opened_at, closed_at, time_stop_at, entry_notional, leverage, realized_pnl
         FROM positions WHERE strategy_version_id = $1 ORDER BY positions_id;`,
        [STRATEGY_VERSION_ID],
    );
    await client.end();

    let positions = rows;
    if (args.positionIds) positions = positions.filter((r) => args.positionIds.includes(r.positions_id));
    const sides = new Set(positions.map((r) => r.side));
    console.log(`Loaded ${positions.length} positions. Sides present: [${[...sides].join(', ')}] ` +
        `(script is side-aware; sample is ${sides.size === 1 && sides.has('long') ? 'long-only as expected' : 'MIXED'}).\n`);

    const ccxtMod = await import(CCXT_ENTRY);
    const ccxt = ccxtMod.binanceusdm ? ccxtMod : ccxtMod.default;
    const ex = new ccxt.binanceusdm({ enableRateLimit: true, options: { defaultType: 'swap' } });

    // Pre-reconstruct + pre-fetch bars per position (fetch once, reuse across ratios).
    const recs = new Map();
    const barsCache = new Map();
    const fetchErrors = new Map();
    for (const row of positions) {
        recs.set(row.positions_id, reconstruct(row));
    }
    // Determine which positions need bars (pass guard at ANY requested ratio).
    const needsBars = new Set();
    for (const row of positions) {
        const rec = recs.get(row.positions_id);
        for (const a of args.ratios) {
            const { realizedRR } = armGeometry(rec, row.side, a);
            if (realizedRR.gte(GUARD)) { needsBars.add(row.positions_id); break; }
        }
    }
    for (const row of positions) {
        if (!needsBars.has(row.positions_id)) continue;
        const openedMs = new Date(row.opened_at).getTime();
        const timeStopMs = new Date(row.time_stop_at).getTime();
        const { bars, error } = await fetchBars(ex, row.symbol, openedMs, timeStopMs + TIMEFRAME_MS);
        if (error) { fetchErrors.set(row.positions_id, error); }
        barsCache.set(row.positions_id, bars);
    }

    // Per-ratio evaluation.
    const summary = [];
    for (const a of args.ratios) {
        let forceClose = 0, tpHit = 0, slHit = 0, timeStop = 0, excluded = 0, lowFidHits = 0;
        let filledGrossPnl = d(0);
        const perPos = [];
        for (const row of positions) {
            const rec = recs.get(row.positions_id);
            const { tpNew, realizedRR } = armGeometry(rec, row.side, a);
            if (realizedRR.lt(GUARD)) {
                forceClose++;
                perPos.push({ id: row.positions_id, sym: row.symbol.replace('/USDT:USDT', ''), rr: realizedRR.toNumber(), outcome: 'force_close', exit: null, lowFid: false });
                continue;
            }
            const bars = barsCache.get(row.positions_id) ?? [];
            if (fetchErrors.has(row.positions_id) && bars.length === 0) {
                excluded++;
                perPos.push({ id: row.positions_id, sym: row.symbol.replace('/USDT:USDT', ''), rr: realizedRR.toNumber(), outcome: 'no_data', exit: null, lowFid: false });
                continue;
            }
            const r = replay(rec, row, tpNew, bars);
            const pnl = grossPnl(row, rec, r.exit);
            filledGrossPnl = filledGrossPnl.plus(pnl);
            if (r.outcome === 'tp_hit') tpHit++;
            else if (r.outcome === 'sl_hit') slHit++;
            else timeStop++;
            if (r.lowFid) lowFidHits++;
            perPos.push({ id: row.positions_id, sym: row.symbol.replace('/USDT:USDT', ''), rr: realizedRR.toNumber(), outcome: r.outcome, exit: r.exit.toNumber(), pnl: pnl.toNumber(), lowFid: r.lowFid });
        }
        summary.push({ a, forceClose, tpHit, slHit, timeStop, excluded, filled: tpHit + slHit + timeStop, lowFidHits, filledGrossPnl: filledGrossPnl.toNumber() });

        console.log(`===== ratio ${a} =====`);
        console.log('  id  sym        rr@fill  outcome      exit        grossPnl  lowFid');
        for (const p of perPos) {
            console.log('  ' + [
                String(p.id).padEnd(3),
                p.sym.padEnd(9),
                f(p.rr, 3),
                (p.outcome).padEnd(11),
                p.exit === null ? '       -' : f(p.exit, 6),
                p.pnl === undefined ? '       -' : f(p.pnl, 2),
                p.lowFid ? 'lowFid' : '',
            ].join(' '));
        }
        console.log('');
    }

    console.log('================ CROSS-RATIO SUMMARY ================');
    console.log('ratio  forceClose  filled  tpHit  slHit  timeStop  noData  filledGrossPnl  lowFidHits');
    for (const s of summary) {
        console.log([
            String(s.a).padEnd(5),
            String(s.forceClose).padStart(10),
            String(s.filled).padStart(7),
            String(s.tpHit).padStart(6),
            String(s.slHit).padStart(6),
            String(s.timeStop).padStart(9),
            String(s.excluded).padStart(7),
            f(s.filledGrossPnl, 2).padStart(15),
            String(s.lowFidHits).padStart(11),
        ].join(' '));
    }
    if (fetchErrors.size > 0) {
        console.log('\nFETCH ERRORS (excluded from filled outcomes):');
        for (const [id, err] of fetchErrors) console.log(`  id ${id}: ${err}`);
    } else {
        console.log('\nNo fetch errors — real 1m OHLCV available for every guard-passing position.');
    }
    console.log('\nNOTE: filledGrossPnl is qty*(exit-entry), pre-fee/pre-funding — cross-ratio comparable, NOT vs realized_pnl.');
    console.log('NOTE: lowFidHits = touches resolved at 1m bar-extreme (SL-first on same-bar SL+TP). n=31 is below decision-grade power.');
}

main().catch((e) => { console.error(e); process.exit(1); });
