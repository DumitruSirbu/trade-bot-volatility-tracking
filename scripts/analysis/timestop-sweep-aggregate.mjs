// Aggregates a set of backtest IBacktestReport JSON files (one per time-stop horizon)
// into a single human-readable markdown comparison. Pure read/format — no DB, no engine
// import. Invoked by timestop-sweep.sh after the backtest runs complete.
//
// Usage:
//   node timestop-sweep-aggregate.mjs <runId> <fromUtcDate> <toUtcDate> <versionId> <outMarkdownPath> <report.json...>
//
// Each report filename is expected to encode its horizon via the `-ts<NN>` runLabel suffix;
// we read the horizon from the report's runLabel so the ordering is self-describing.

import { readFileSync, writeFileSync } from 'node:fs';

const [, , runId, fromUtcDate, toUtcDate, versionId, outPath, ...reportPaths] = process.argv;

const EXIT_REASONS = ['take_profit', 'stop_loss', 'time_stop', 'signal', 'force_close', 'manual', 'kill_switch'];

function loadReport(path) {
    const report = JSON.parse(readFileSync(path, 'utf-8'));
    const horizonMatch = /-ts(\d+)\b/u.exec(report.runLabel ?? '');
    if (horizonMatch === null) {
        // The whole table orders by horizon parsed from the runLabel suffix; a report without
        // it would sort as 0 and render a misleading row. Fail loudly instead.
        throw new Error(`report ${path} runLabel '${report.runLabel}' has no -ts<minutes> suffix`);
    }
    return { horizonMinutes: Number(horizonMatch[1]), report };
}

function exitMix(trades) {
    const counts = Object.fromEntries(EXIT_REASONS.map((reason) => [reason, 0]));
    for (const trade of trades) {
        counts[trade.exitReason] = (counts[trade.exitReason] ?? 0) + 1;
    }
    return counts;
}

function pct(part, whole) {
    return whole === 0 ? '0.0' : ((100 * part) / whole).toFixed(1);
}

function expectancy(netPnlUsdt, tradeCount) {
    return tradeCount === 0 ? '0.000' : (Number(netPnlUsdt) / tradeCount).toFixed(3);
}

function minutes(ms) {
    return (ms / 60000).toFixed(1);
}

const runs = reportPaths.map(loadReport).sort((a, b) => (a.horizonMinutes ?? 0) - (b.horizonMinutes ?? 0));

const lines = [];
lines.push(`# Time-stop horizon sweep — ${runId}`);
lines.push('');
lines.push(`Backtest sweep of \`time_stop_minutes\` over the same soak window, holding every other`);
lines.push(`parameter fixed. Goal: see how the time-based exit interacts with SL/TP — whether a longer`);
lines.push(`leash converts time-stops into take-profits, or just lets losers run to the stop.`);
lines.push('');
lines.push('| Field | Value |');
lines.push('|-------|-------|');
lines.push(`| Run ID | ${runId} |`);
lines.push(`| Window (UTC, \`to\` exclusive) | ${fromUtcDate} → ${toUtcDate} |`);
lines.push(`| Strategy version id | ${versionId} (${runs[0]?.report.strategyName}:${runs[0]?.report.strategyVersion}) |`);
lines.push(`| Horizons swept (min) | ${runs.map((r) => r.horizonMinutes).join(', ')} |`);
lines.push(`| Reproduce | \`scripts/analysis/timestop-sweep.sh ${fromUtcDate} ${toUtcDate} ${versionId}\` |`);
lines.push('');

lines.push('## Headline metrics');
lines.push('');
lines.push(
    '| time_stop (min) | trades | win% | net PnL | expectancy/trade | return% | profit factor | avg hold (min) | max DD% | Sharpe | Sortino | fees | funding |',
);
lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const { horizonMinutes, report: r } of runs) {
    lines.push(
        `| ${horizonMinutes} | ${r.tradeCount} | ${r.winRatePct} | ${Number(r.netPnlUsdt).toFixed(2)} | ` +
            `${expectancy(r.netPnlUsdt, r.tradeCount)} | ${r.returnPct} | ${r.profitFactor} | ${minutes(r.avgHoldMs)} | ` +
            `${r.maxDrawdownPct} | ${r.sharpeAnnualized} | ${r.sortinoAnnualized} | ` +
            `${Number(r.feesUsdt).toFixed(2)} | ${Number(r.fundingUsdt).toFixed(2)} |`,
    );
}
lines.push('');

lines.push('## Exit-reason mix (count, % of trades)');
lines.push('');
lines.push('| time_stop (min) | take_profit | stop_loss | time_stop | other |');
lines.push('|---:|---:|---:|---:|---:|');
for (const { horizonMinutes, report: r } of runs) {
    const mix = exitMix(r.trades);
    const total = r.trades.length;
    const other = total - mix.take_profit - mix.stop_loss - mix.time_stop;
    lines.push(
        `| ${horizonMinutes} | ${mix.take_profit} (${pct(mix.take_profit, total)}%) | ` +
            `${mix.stop_loss} (${pct(mix.stop_loss, total)}%) | ${mix.time_stop} (${pct(mix.time_stop, total)}%) | ` +
            `${other} (${pct(other, total)}%) |`,
    );
}
lines.push('');

lines.push('## Funnel');
lines.push('');
lines.push('> **Not strictly ceteris-paribus on entries.** Triggers are identical across horizons, but');
lines.push('> with the 1-position slot cap a longer time-stop holds the slot longer, so *which later');
lines.push('> triggers become fills* can differ. If `trades` moves across horizons in the headline table,');
lines.push('> the expectancy delta conflates "different exit" with "different trade population" — do not');
lines.push('> attribute it to the time-stop alone.');
lines.push('');
lines.push('| time_stop (min) | skipped triggers | rejected by gate | missed limit fill | low-fidelity trades |');
lines.push('|---:|---:|---:|---:|---:|');
for (const { horizonMinutes, report: r } of runs) {
    lines.push(`| ${horizonMinutes} | ${r.skippedTriggerCount} | ${r.rejectedByGateCount} | ` + `${r.missedLimitFillCount} | ${r.lowFidelityTradeCount} |`);
}
lines.push('');

lines.push('## Caveats (calibration gaps — read before concluding)');
lines.push('');
lines.push('- **BTC index-shock understated:** backtest uses candle-body returns; live uses a rolling');
lines.push('  tape window, so the backtest halts the BTC leg less often. Halt-frequency divergence here');
lines.push('  is structural, not signal.');
lines.push('- **ETH leg structurally dead in backtest:** single-symbol replay cannot reconstruct the ETH');
lines.push('  cross-tape. ETH behaviour is not represented.');
lines.push('- Intrabar SL/TP simulation reads `tick_aggregates` where present, else falls back to bar');
lines.push('  extremes — fills are modelled, not real.');
lines.push('- The time-stop and SL/TP are deterministic per bar, so the *relative* ranking across horizons');
lines.push('  is the trustworthy signal; absolute PnL inherits the gaps above.');
lines.push('- **Hypothesis-generating, not decision-grade.** A single ~2-week window at the tier-1 / 1-position');
lines.push('  live caps yields a small per-horizon trade count; an expectancy delta here is a hypothesis, not');
lines.push('  proof. Want ≥30–50 closed trades per horizon and the same ranking across 2–3 disjoint sub-windows');
lines.push('  before re-tuning `time_stop_minutes`.');
lines.push('');

writeFileSync(outPath, lines.join('\n'), 'utf-8');
process.stderr.write(`wrote ${outPath}\n`);
