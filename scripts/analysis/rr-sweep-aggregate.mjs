// Aggregates a set of backtest IBacktestReport JSON files (one per target TP:SL ratio) into a
// markdown comparison. Pure read/format — no DB, no engine import. Invoked by rr-sweep.sh.
//
// Usage:
//   node rr-sweep-aggregate.mjs <runId> <fromUtcDate> <toUtcDate> <versionId> <outMarkdownPath> <report.json...>
//
// The target ratio for each run is read from the report's runLabel `-rr<value>` suffix.
//
// IMPORTANT: this sweep uses realistic risk-based sizing — a tighter stop yields a LARGER
// position for the same dollar risk. So PnL differences across ratios reflect BOTH the geometry
// change AND the position-size change. The aggregator surfaces avg notional so the sizing
// amplification is visible and not mistaken for a pure geometry effect.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , runId, fromUtcDate, toUtcDate, versionId, outPath, ...reportPaths] = process.argv;

function loadReport(path) {
    const report = JSON.parse(readFileSync(path, 'utf-8'));
    const ratioMatch = /-rr([\d.]+)/u.exec(report.runLabel ?? '');
    if (ratioMatch === null) {
        throw new Error(`report ${path} runLabel '${report.runLabel}' has no -rr<ratio> suffix`);
    }
    return { ratio: Number(ratioMatch[1]), report };
}

function exitMix(trades) {
    const mix = { take_profit: 0, stop_loss: 0, time_stop: 0 };
    for (const trade of trades) {
        if (trade.exitReason in mix) {
            mix[trade.exitReason] += 1;
        }
    }
    return mix;
}

function avg(values) {
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function fmt(value, digits = 2) {
    return value === null ? 'n/a' : value.toFixed(digits);
}

function pct(part, whole) {
    return whole === 0 ? '0.0' : ((100 * part) / whole).toFixed(1);
}

function summarize(report) {
    const trades = report.trades;
    const wins = trades.map((t) => Number(t.netPnlUsdt)).filter((p) => p > 0);
    const losses = trades.map((t) => Number(t.netPnlUsdt)).filter((p) => p <= 0);
    const notionals = trades.map((t) => Number(t.qty) * Number(t.entryPriceUsdt));
    const avgWin = avg(wins);
    const avgLoss = avg(losses);
    const realizedRr = avgWin !== null && avgLoss !== null && avgLoss !== 0 ? -avgWin / avgLoss : null;
    return {
        expectancy: trades.length === 0 ? null : Number(report.netPnlUsdt) / trades.length,
        avgNotional: avg(notionals),
        avgWin,
        avgLoss,
        realizedRr,
        mix: exitMix(trades),
    };
}

const runs = reportPaths.map(loadReport).sort((a, b) => a.ratio - b.ratio);

const lines = [];
lines.push(`# Reward:risk (TP:SL) geometry sweep — ${runId}`);
lines.push('');
lines.push('Backtest sweep of the take-profit:stop-loss distance ratio over the same soak window,');
lines.push('holding every other parameter fixed. The stop is re-derived to `TP_distance / ratio`;');
lines.push('the take-profit is unchanged. **Position size is re-derived from the new stop (realistic');
lines.push('risk-based sizing) — a tighter stop yields a larger position.**');
lines.push('');
lines.push('Context: the momentum stop is normally the *session VWAP* (a structural level, ~4×ATR),');
lines.push('so realized RR is currently ~0.5 (risk > reward). This sweep replaces that structural stop');
lines.push('with an RR-anchored stop to test whether forcing a higher TP:SL is worth it.');
lines.push('');
lines.push('**Baseline sizing/stop mismatch (relevant to reading this):** the live sizer (`PositionSizer`)');
lines.push('sizes risk off `1.5×ATR`, but the actual VWAP stop sits ~4×ATR away — so the baseline strategy');
lines.push('risks ~2.7× its intended per-trade budget on a full stop-out. In this sweep the override aligns');
lines.push('sizing to the *new* stop (size = risk budget ÷ new stop distance), so each swept run risks the');
lines.push('intended budget at its stop — which is itself a correction of the baseline mismatch.');
lines.push('');
lines.push('| Field | Value |');
lines.push('|-------|-------|');
lines.push(`| Run ID | ${runId} |`);
lines.push(`| Window (UTC, \`to\` exclusive) | ${fromUtcDate} → ${toUtcDate} |`);
lines.push(`| Strategy version id | ${versionId} (${runs[0]?.report.strategyName}:${runs[0]?.report.strategyVersion}) |`);
lines.push(`| TP:SL ratios swept | ${runs.map((r) => r.ratio).join(', ')} |`);
lines.push(`| Reproduce | \`scripts/analysis/rr-sweep.sh ${fromUtcDate} ${toUtcDate} ${versionId}\` |`);
lines.push('');

lines.push('## Headline metrics');
lines.push('');
lines.push('| TP:SL | trades | win% | net PnL | expectancy/trade | realized RR | avg win | avg loss | avg notional | PF | return% | max DD% | Sharpe |');
lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const { ratio, report: r } of runs) {
    const s = summarize(r);
    lines.push(
        `| ${ratio}:1 | ${r.tradeCount} | ${r.winRatePct} | ${Number(r.netPnlUsdt).toFixed(2)} | ` +
            `${fmt(s.expectancy, 3)} | ${fmt(s.realizedRr)} | ${fmt(s.avgWin)} | ${fmt(s.avgLoss)} | ` +
            `${fmt(s.avgNotional, 0)} | ${r.profitFactor} | ${r.returnPct} | ${r.maxDrawdownPct} | ${r.sharpeAnnualized} |`,
    );
}
lines.push('');

lines.push('## Exit-reason mix (count, % of trades)');
lines.push('');
lines.push('| TP:SL | take_profit | stop_loss | time_stop | other |');
lines.push('|---:|---:|---:|---:|---:|');
for (const { ratio, report: r } of runs) {
    const mix = exitMix(r.trades);
    const total = r.trades.length;
    const other = total - mix.take_profit - mix.stop_loss - mix.time_stop;
    lines.push(
        `| ${ratio}:1 | ${mix.take_profit} (${pct(mix.take_profit, total)}%) | ` +
            `${mix.stop_loss} (${pct(mix.stop_loss, total)}%) | ${mix.time_stop} (${pct(mix.time_stop, total)}%) | ` +
            `${other} (${pct(other, total)}%) |`,
    );
}
lines.push('');

lines.push('## Caveats (read before concluding)');
lines.push('');
lines.push('- **Sizing amplification is the dominant effect.** Net PnL / drawdown across ratios reflect');
lines.push('  BOTH the geometry change and the larger positions a tighter stop produces. Read `realized RR`');
lines.push('  and `win%` for the geometry signal; read `avg notional` / `max DD%` for the risk a tighter');
lines.push('  stop deploys. A "better" net PnL that comes purely from bigger bets is not free edge.');
lines.push("- **This replaces the strategy's VWAP structural stop with an RR-anchored stop** — it is a");
lines.push('  counterfactual on stop *philosophy*, not a parameter tweak, and deliberately breaks');
lines.push('  live↔backtest parity for the swept runs.');
lines.push('- **Not strictly ceteris-paribus on entries:** the 1-position slot cap means a different stop');
lines.push('  changes slot-occupancy and therefore which later triggers fill. Check whether `trades` moves.');
lines.push('- Backtest calibration gaps still apply (BTC index-shock understated, ETH leg dead, modelled');
lines.push('  fills). The *relative* ranking across ratios is the trustworthy signal, not absolute PnL.');
lines.push('- **Hypothesis-generating, not decision-grade** on a single window. Confirm any ranking across');
lines.push('  2–3 disjoint sub-windows before re-tuning stop geometry.');
lines.push('');

writeFileSync(outPath, lines.join('\n'), 'utf-8');
process.stderr.write(`wrote ${outPath}\n`);
