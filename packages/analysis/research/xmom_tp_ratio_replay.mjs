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
//
// ─── M54 D3 / EXP-023 EXTENSION — expected-fill anchor + thin-book skip ─────────────
// The M54 anchor re-computes SL/TP against the EXPECTED fill F_exp = P0 × (1 + halfSpread/100)
// (halfSpread = spread_at_entry_pct / 2) instead of the signal price P0, and adds a pre-send
// order-size-aware thin-book SKIP (orderNotional / book_depth_10bps_at_entry > maxDepthFraction).
// This replay is FILL-ANCHOR-INVARIANT (M53b Route 2): barriers are still priced off the REAL
// recorded fill `entry`, so moving the SL/TP anchor changes only where the barriers sit, not the
// fill. Under the anchor, realizedRR_at_fill(a) = (a − r)/(1 + r) with residual r = s − s_exp
// (actual minus expected slippage), so the guard's realized R:R is centered at the arm ratio
// instead of biased below it (M54 §2).
//   Enable with:  --expected-fill --max-depth-fraction=0.10
//   node packages/analysis/research/xmom_tp_ratio_replay.mjs --ratios=1.5 --expected-fill --max-depth-fraction=0.10
// OUTPUT SPLIT (M54 §7 D3 / §10):
//   DECISION-GRADE: force_close count/rate, skip count, fee-churn (force_close + skip), vs the
//     P0 baseline. This is what M54 is measured on.
//   CHARACTERIZATION (NOT decision-grade, NOT comparable to the EXP-021/022 full-universe baseline
//     because the skip changes the admitted population, M54 §10): filled-book SL-hit-rate + PnL
//     delta. Reported separately and explicitly labelled. A PnL swing is a finding to EXPLAIN, not
//     a success or a dismissable artifact — the anchor moves absolute SL/TP by the half-spread on
//     every filled trade (M54 §2 caveat 2). This is CORRECTNESS/fee-bleed work, NOT an edge fix.

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
    const out = { ratios: ['1.5', '1.8', '2', '2.5', '3'], positionIds: null, expectedFill: false, maxDepthFraction: null };
    for (const arg of argv) {
        if (arg.startsWith('--ratios=')) {
            out.ratios = arg.slice('--ratios='.length).split(',').map((r) => r.trim()).filter(Boolean);
        } else if (arg.startsWith('--position-ids=')) {
            out.positionIds = arg.slice('--position-ids='.length).split(',').map((r) => Number(r.trim())).filter((n) => !Number.isNaN(n));
        } else if (arg === '--expected-fill') {
            // M54 anchor SL/TP to F_exp = P0 × (1 + halfSpread/100). Off = P0-anchored baseline.
            out.expectedFill = true;
        } else if (arg.startsWith('--max-depth-fraction=')) {
            // M54 thin-book skip budget. null = skip disabled (matches xmom_max_depth_fraction=null).
            const raw = arg.slice('--max-depth-fraction='.length).trim();
            out.maxDepthFraction = raw === '' ? null : new Decimal(raw);
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

// Side-aware widened TP + realized-at-fill RR for arm `a`, P0-anchored (the M53 baseline).
function armGeometry(rec, side, a) {
    const arm = d(a);
    const isLong = side === 'long';
    const tpNew = isLong ? rec.p0.plus(rec.stopDist.times(arm)) : rec.p0.minus(rec.stopDist.times(arm));
    const reward = isLong ? tpNew.minus(rec.entry) : rec.entry.minus(tpNew);
    const risk = isLong ? rec.entry.minus(rec.sl) : rec.sl.minus(rec.entry);
    const realizedRR = risk.lte(0) ? d(-999) : reward.div(risk);
    return { tpNew, slNew: rec.sl, realizedRR };
}

// M54 expected-fill anchor. F_exp = P0 × (1 + halfSpread/100); halfSpread = spread_at_entry_pct/2.
// Notional-independent (mirrors MomentumOrchestratorService.resolveExpectedFillPrice). Returns P0
// unchanged when the recorded spread is missing/≤0 (byte-identical no-op — matches the engine).
function expectedFillPrice(rec, row) {
    const spreadPct = row.spread_at_entry_pct === null || row.spread_at_entry_pct === undefined ? null : d(row.spread_at_entry_pct);
    if (spreadPct === null || spreadPct.lte(0)) {
        return rec.p0;
    }
    return rec.p0.times(d(1).plus(spreadPct.div(200))); // ×(1 + (spread/2)/100)
}

// Side-aware geometry anchored to F_exp (M54). SL_new = F_exp − D, TP_new = F_exp + a·D (long).
// realizedRR is measured against the REAL recorded fill `entry` (fill-anchor-invariant): the anchor
// moves the barriers, not the fill, so realizedRR(a) = (a − r)/(1 + r) with residual r = s − s_exp.
function armGeometryAnchored(rec, row, side, a) {
    const arm = d(a);
    const isLong = side === 'long';
    const fExp = expectedFillPrice(rec, row);
    const slNew = isLong ? fExp.minus(rec.stopDist) : fExp.plus(rec.stopDist);
    const tpNew = isLong ? fExp.plus(rec.stopDist.times(arm)) : fExp.minus(rec.stopDist.times(arm));
    const reward = isLong ? tpNew.minus(rec.entry) : rec.entry.minus(tpNew);
    const risk = isLong ? rec.entry.minus(slNew) : slNew.minus(rec.entry);
    const realizedRR = risk.lte(0) ? d(-999) : reward.div(risk);
    // s_exp = (F_exp − P0)/D (expected slippage as a fraction of D); r = s − s_exp (actual residual).
    const sExp = rec.stopDist.lte(0) ? d(0) : fExp.minus(rec.p0).div(rec.stopDist);
    return { tpNew, slNew, realizedRR, fExp, sExp, residual: rec.s.minus(sExp) };
}

// M54 pre-send thin-book skip. depthFraction = entry_notional / book_depth_10bps_at_entry.
// Fails CLOSED (skip) on a null or ≤0 depth reading (matches isBookTooThin / the engine helper).
// Never skips when the budget is disabled (maxDepthFraction === null). Returns { skipped, depthFraction }.
function depthSkip(row, maxDepthFraction) {
    if (maxDepthFraction === null) {
        return { skipped: false, depthFraction: null };
    }
    const depth = row.book_depth_10bps_at_entry === null || row.book_depth_10bps_at_entry === undefined
        ? null
        : d(row.book_depth_10bps_at_entry);
    if (depth === null || depth.lte(0)) {
        return { skipped: true, depthFraction: null };
    }
    const depthFraction = d(row.entry_notional).div(depth);
    return { skipped: depthFraction.gt(maxDepthFraction), depthFraction };
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

// Replay one position at one ratio against real bars. Returns outcome + exit price. The SL/TP
// anchor is passed in (P0-baseline or M54 F_exp-anchored); barriers still price off real bars.
function replay(rec, row, slNew, tpNew, bars) {
    const side = row.side;
    const openedMs = new Date(row.opened_at).getTime();
    const timeStopMs = new Date(row.time_stop_at).getTime();
    const slStr = slNew.toFixed();
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
    const anchorLabel = args.expectedFill ? 'F_exp (M54 expected-fill)' : 'P0 (baseline)';
    const skipLabel = args.maxDepthFraction === null ? 'disabled' : args.maxDepthFraction.toFixed();
    console.log(`xmom TP:SL ratio replay — ratios [${args.ratios.join(', ')}]` +
        (args.positionIds ? ` — positions [${args.positionIds.join(',')}]` : ' — all strategy_version_id=20') +
        `\n  anchor=${anchorLabel}  maxDepthFraction=${skipLabel}\n`);

    const client = new pg.Client({ connectionString: CONNECTION });
    await client.connect();
    const { rows } = await client.query(
        `SELECT positions_id, symbol, side, entry_price, stop_loss_price, take_profit_price,
                exit_reason, opened_at, closed_at, time_stop_at, entry_notional, leverage, realized_pnl,
                spread_at_entry_pct, book_depth_10bps_at_entry
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
    // Geometry dispatch: F_exp-anchored under --expected-fill, else the P0 baseline.
    const geomFor = (rec, row, a) => (args.expectedFill ? armGeometryAnchored(rec, row, row.side, a) : armGeometry(rec, row.side, a));

    // Determine which positions need bars (pass guard at ANY requested ratio AND survive the skip).
    const needsBars = new Set();
    for (const row of positions) {
        const rec = recs.get(row.positions_id);
        if (depthSkip(row, args.maxDepthFraction).skipped) continue; // skipped ⇒ never fills ⇒ no bars
        for (const a of args.ratios) {
            const { realizedRR } = geomFor(rec, row, a);
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
        let forceClose = 0, tpHit = 0, slHit = 0, timeStop = 0, excluded = 0, lowFidHits = 0, skipped = 0;
        let filledGrossPnl = d(0);
        const residuals = [];
        const perPos = [];
        for (const row of positions) {
            const rec = recs.get(row.positions_id);
            const geom = geomFor(rec, row, a);
            const { tpNew, slNew, realizedRR } = geom;

            // M54 skip runs pre-guard, pre-fill: a skipped candidate is never opened (fee-churn avoided).
            const skip = depthSkip(row, args.maxDepthFraction);
            if (skip.skipped) {
                skipped++;
                perPos.push({ id: row.positions_id, sym: row.symbol.replace('/USDT:USDT', ''), rr: realizedRR.toNumber(), outcome: 'skip', exit: null, lowFid: false });
                continue;
            }
            if (geom.residual !== undefined) residuals.push(geom.residual.toNumber());

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
            const r = replay(rec, row, slNew, tpNew, bars);
            const pnl = grossPnl(row, rec, r.exit);
            filledGrossPnl = filledGrossPnl.plus(pnl);
            if (r.outcome === 'tp_hit') tpHit++;
            else if (r.outcome === 'sl_hit') slHit++;
            else timeStop++;
            if (r.lowFid) lowFidHits++;
            perPos.push({ id: row.positions_id, sym: row.symbol.replace('/USDT:USDT', ''), rr: realizedRR.toNumber(), outcome: r.outcome, exit: r.exit.toNumber(), pnl: pnl.toNumber(), lowFid: r.lowFid });
        }
        const filled = tpHit + slHit + timeStop;
        const meanResidual = residuals.length === 0 ? null : residuals.reduce((x, y) => x + y, 0) / residuals.length;
        summary.push({ a, forceClose, tpHit, slHit, timeStop, excluded, skipped, filled, lowFidHits, filledGrossPnl: filledGrossPnl.toNumber(), meanResidual, slHitRate: filled === 0 ? null : slHit / filled });

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

    // ── DECISION-GRADE (M54 §10): force_close, skip, fee-churn. This is what M54 is measured on. ──
    console.log('================ DECISION-GRADE SUMMARY (force_close + skip + fee-churn) ================');
    console.log(`anchor=${anchorLabel}  maxDepthFraction=${skipLabel}`);
    console.log('ratio  forceClose  skip  feeChurn  filled  noData');
    for (const s of summary) {
        console.log([
            String(s.a).padEnd(5),
            String(s.forceClose).padStart(10),
            String(s.skipped).padStart(5),
            String(s.forceClose + s.skipped).padStart(8),   // fee-churn = 0-duration force_close + pre-send skip
            String(s.filled).padStart(7),
            String(s.excluded).padStart(6),
        ].join(' '));
    }

    // ── CHARACTERIZATION (M54 §10): NOT decision-grade, NOT comparable to EXP-021/022 full-universe. ──
    console.log('\n================ CHARACTERIZATION (NOT decision-grade — see notes) ================');
    console.log('ratio  filled  tpHit  slHit  slHitRate  timeStop  filledGrossPnl  meanResidual  lowFidHits');
    for (const s of summary) {
        console.log([
            String(s.a).padEnd(5),
            String(s.filled).padStart(7),
            String(s.tpHit).padStart(6),
            String(s.slHit).padStart(6),
            f(s.slHitRate === null ? NaN : s.slHitRate, 3).padStart(10),
            String(s.timeStop).padStart(9),
            f(s.filledGrossPnl, 2).padStart(15),
            f(s.meanResidual === null ? NaN : s.meanResidual, 4).padStart(13),
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
    console.log('NOTE (M54): meanResidual = mean(r) = mean(s − s_exp); r>0 ⇒ half-spread under-models the adverse bias (calibrate xmom_max_depth_fraction).');
    console.log('NOTE (M54): slHitRate + filledGrossPnl are CHARACTERIZATION only. The skip changes the admitted population, so a filtered-universe');
    console.log('           PnL delta is NOT comparable to the EXP-021/022 full-universe baseline and is NOT an edge claim (M54 §10). A PnL swing is a');
    console.log('           finding to EXPLAIN. Decision-grade metric = force_close-rate + fee-churn only.');
}

main().catch((e) => { console.error(e); process.exit(1); });
