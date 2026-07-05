// Offline TP-arm reconstruction for xmom (strategy_version_id = 20).
//
// RESEARCH SCRIPT (read-only). Changes no engine/production code. Lives in the
// analysis package's research/ folder (outside the tsc `src` build) so it can
// use `pg` + `decimal.js` from the package's node_modules. Run from repo root:
//
//   node packages/analysis/research/xmom_tp_arm_reconstruction.mjs
//
// QUESTION: would arming xmom's take-profit at 1.8R instead of 1.5R have changed
// the fill-accept / force_close mix and the traded-book outcomes on the ACTUAL
// historical signal set (EXP-018 offline feasibility check)?
//
// DATA MODEL (verified against the rows — see the doc's "Offline validation" section):
//   positions.entry_price       = the FILL price (post-slippage).
//   positions.stop_loss_price   = SIGNAL-frozen SL   = P0 - D.
//   positions.take_profit_price = SIGNAL-frozen TP   = P0 + 1.5*D   (arm ratio 1.5, tpRebaseEligible=false).
//   where P0 = signal price, D = stopDistance = atr24h * xmom_atr_stop_multiplier.
// The recorded (entry, SL, TP) triple is NOT a self-consistent 1.5R geometry: SL/TP
// are anchored at the signal, entry is the fill (MomentumOrchestratorService.ts:617-618).
//
// RECONSTRUCTION (pure algebra, no path assumptions):
//   D  = (TP_old - SL) / 2.5                  [TP-SL = (P0+1.5D)-(P0-D) = 2.5D at arm 1.5]
//   P0 = SL + D
//   s  = (entry - P0) / D                     (slippage as a fraction of D; s>0 = filled above signal)
//   TP_new(a) = P0 + a*D                       (SL is arm-independent, unchanged)
//   realizedRR_at_fill(a) = (TP_new(a) - entry) / (entry - SL)
// Fill-accept guard rejects (=> force_close) when realizedRR_at_fill < 1.5 (guard floor
// stays 1.5; only the arm moves). See exitGeometryHelper isRrInsufficient.
//
// LIMITATION (decisive): mfe_pct/mae_pct are the only post-fill price data. For SL exits
// MFE is a genuine peak that fell short of TP, so widening (TP moves further) leaves the SL
// outcome unchanged. For TP exits MFE is TRUNCATED at the 1.5 TP (the position closed there),
// so MFE cannot say whether price would have reached a wider 1.8 TP. The force_closes the 1.8
// arm would rescue have NO post-fill data at all (0-duration). So the outcome-changing cases
// are exactly the ones this reconstruction cannot resolve.

import pg from 'pg';
import Decimal from 'decimal.js';

Decimal.set({ precision: 40 });

const CONNECTION =
    process.env.PHASEB_DB_URL ?? 'postgresql://trade_bot:MakeMeRich2026!@localhost:5433/trade_bot';

const GUARD = new Decimal('1.5');
const ARM_BASELINE = new Decimal('1.5');
const ARM_PROPOSED = new Decimal('1.8');
const d = (x) => new Decimal(x);

function reconstruct(row) {
    const entry = d(row.entry_price);
    const sl = d(row.stop_loss_price);
    const tpOld = d(row.take_profit_price);
    const stopDist = tpOld.minus(sl).div(ARM_BASELINE.plus(1));
    const p0 = sl.plus(stopDist);
    const slDist = entry.minus(sl);
    const s = entry.minus(p0).div(stopDist);
    const rrAt = (a) => p0.plus(stopDist.times(a)).minus(entry).div(slDist);
    const rr15 = rrAt(ARM_BASELINE);
    const rr18 = rrAt(ARM_PROPOSED);
    const tp18 = p0.plus(stopDist.times(ARM_PROPOSED));
    const tpDist18 = tp18.minus(entry).div(entry).times(100);
    return {
        id: row.positions_id,
        sym: row.symbol.replace('/USDT:USDT', ''),
        exit: row.exit_reason,
        pnl: row.realized_pnl === null ? null : Number(row.realized_pnl),
        retry: row.is_retry_entry === true,
        dur: row.dur_s,
        mfe: row.mfe_pct === null ? null : Number(row.mfe_pct) * 100,
        mae: row.mae_pct === null ? null : Number(row.mae_pct) * 100,
        s: s.toNumber(),
        rr15: rr15.toNumber(),
        rr18: rr18.toNumber(),
        acc15: rr15.gte(GUARD),
        acc18: rr18.gte(GUARD),
        tpd18: tpDist18.toNumber(),
    };
}

const f = (n, dp = 2) => (n === null || Number.isNaN(n) ? '  n/a' : n.toFixed(dp).padStart(7));

async function main() {
    const client = new pg.Client({ connectionString: CONNECTION });
    await client.connect();
    const { rows } = await client.query(`
        SELECT positions_id, symbol, side, entry_price, stop_loss_price, take_profit_price,
               exit_reason, realized_pnl, mae_pct, mfe_pct, is_retry_entry, trigger_source,
               EXTRACT(EPOCH FROM (closed_at - opened_at))::int AS dur_s
        FROM positions WHERE strategy_version_id = 20 ORDER BY positions_id;`);
    await client.end();

    const recs = rows.map(reconstruct);
    console.log(`n = ${recs.length} xmom positions\n`);
    console.log('id  sym       exit         rtry dur       s   rr1.5   rr1.8 a15 a18  tpd%18   mfe%    pnl');
    for (const r of recs) {
        console.log(
            [
                String(r.id).padEnd(3),
                r.sym.padEnd(9),
                r.exit.padEnd(12),
                r.retry ? 'RTY' : '   ',
                String(r.dur).padStart(5),
                f(r.s, 3),
                f(r.rr15, 3),
                f(r.rr18, 3),
                (r.acc15 ? 'Y' : 'N').padStart(3),
                (r.acc18 ? 'Y' : 'N').padStart(3),
                f(r.tpd18),
                f(r.mfe),
                r.pnl === null ? '  n/a' : f(r.pnl),
            ].join(' '),
        );
    }

    const fc = recs.filter((r) => r.exit === 'force_close');
    const traded = recs.filter((r) => r.exit !== 'force_close');
    const rescued = fc.filter((r) => r.acc18);
    const still = fc.filter((r) => !r.acc18);
    console.log(
        `\nFORCE_CLOSE: ${fc.length} | ACCEPT@1.8: ${rescued.length} [${rescued.map((r) => r.id).join(',')}]` +
            ` | still FC: ${still.length} [${still.map((r) => r.id).join(',')}]`,
    );
    console.log(`TRADED(filled)@1.5: ${traded.length} | all still accept@1.8: ${traded.every((r) => r.acc18)}`);

    console.log('\nTRADED book — would 1.8R TP be reached (MFE proxy; TRUNCATED for TP exits)?');
    for (const r of traded) {
        const reach = r.mfe === null ? null : r.mfe >= r.tpd18;
        console.log(
            `id ${String(r.id).padEnd(3)} ${r.sym.padEnd(8)} ${r.exit.padEnd(12)} ` +
                `1.8TP@+${f(r.tpd18)}% mfe+${f(r.mfe)}% mae${f(r.mae)}% -> reach1.8: ${reach === null ? 'n/a' : reach ? 'YES' : 'NO'}`,
        );
    }
    const oldTp = traded.filter((r) => r.exit === 'take_profit');
    const lost = oldTp.filter((r) => r.mfe !== null && r.mfe < r.tpd18);
    console.log(
        `\nOld TP winners whose MFE < own 1.8TP (unresolvable, MFE truncated at 1.5 exit): ` +
            `${lost.length}/${oldTp.length} [${lost.map((r) => r.id).join(',') || 'none'}]`,
    );
    console.log(
        `Traded-book PnL sum: ${traded.reduce((a, r) => a + (r.pnl || 0), 0).toFixed(2)} | ` +
            `force_close PnL sum: ${fc.reduce((a, r) => a + (r.pnl || 0), 0).toFixed(2)}`,
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
