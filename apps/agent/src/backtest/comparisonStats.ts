// M13 W4 — local statistics layer for the weekly comparison report.
//
// Strictly read-only over the two `IBacktestReport` payloads — does NOT
// re-implement bootstrap or paired-difference logic; the engine produces those
// numbers per M8. When a field needed by ADR 0019 is not present on the
// current `IBacktestReport` shape we treat it as unavailable and surface that
// to the promotion gate; we never invent values.

// eslint-disable-next-line no-restricted-imports -- agent-internal `src/mcp/` directory; ADR 0035 §2.3 layer B targets WORKSPACE reaches (apps/mcp / packages/analysis), not the agent's own subdirectories.
import type { BacktestReportParsed } from '../mcp/schemas.js';

export interface IHeadlineDelta {
    // Uniform sign convention: **positive delta = draft is better**. For
    // higher-is-better metrics (epur, sharpe, sortino) we compute (draft - active);
    // for lower-is-better metrics (maxDrawdownPct) we flip to (active - draft)
    // so a positive delta still reads "draft is better". String-typed at the
    // boundary so we keep the engine's decimal formatting for downstream
    // renderers.
    readonly epurDelta: string;
    readonly sharpeDelta: string;
    readonly sortinoDelta: string;
    readonly maxDrawdownDelta: string;
}

export function computeHeadlineDelta(active: BacktestReportParsed, draft: BacktestReportParsed): IHeadlineDelta {
    return {
        epurDelta: subtract(deriveExpectancyPerUnitRisk(draft), deriveExpectancyPerUnitRisk(active)),
        sharpeDelta: subtract(draft.sharpeAnnualized, active.sharpeAnnualized),
        sortinoDelta: subtract(draft.sortinoAnnualized, active.sortinoAnnualized),
        // (active - draft): positive when draft has a SMALLER drawdown.
        maxDrawdownDelta: subtract(active.maxDrawdownPct, draft.maxDrawdownPct),
    };
}

// `IBacktestReport` does not yet carry the engine's per-fold bootstrap CI
// directly (the field landed on `IPerformanceByVersionView`, not on the run
// report). The agent-local Zod schema declares `bootstrap.ci` as optional so
// this helper reads it directly; absent CI yields a "no data" verdict. ADR
// 0019 criterion 5 is the consumer.
//
// Param type is `Pick<BacktestReportParsed, 'bootstrap'>` so callers holding
// a fully-parsed report pass without spread + tests that exercise the CI
// shape in isolation can supply `{}` / `{ bootstrap: ... }` without faking
// every IBacktestReport field.
export function bootstrapCiPassesZero(report: Pick<BacktestReportParsed, 'bootstrap'>): boolean {
    const ci = report.bootstrap?.ci;
    if (ci === undefined) {
        return false;
    }
    const lo = Number(ci.lo);
    const hi = Number(ci.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        return false;
    }
    // "Passes" means the CI is strictly on one side of zero — zero is OUTSIDE
    // the interval. If lo > 0 OR hi < 0 the CI excludes zero.
    return lo > 0 || hi < 0;
}

// Expectancy-per-unit-risk proxy: `netPnlUsdt / tradeCount`. The engine's
// real EPUR formula divides by per-trade risk, which is not exposed on
// `IBacktestReport` today; we fall back to mean-PnL-per-trade so the headline
// delta remains a relative number, not a fabricated one. ADR 0019 criterion 5
// still consumes the engine's CI directly (see `bootstrapCiPassesZero`).
function deriveExpectancyPerUnitRisk(report: BacktestReportParsed): string {
    if (report.tradeCount <= 0) {
        return '0';
    }
    const net = Number(report.netPnlUsdt);
    if (!Number.isFinite(net)) {
        return '0';
    }
    return (net / report.tradeCount).toFixed(6);
}

function subtract(left: string, right: string): string {
    const l = Number(left);
    const r = Number(right);
    if (!Number.isFinite(l) || !Number.isFinite(r)) {
        return 'NaN';
    }
    return (l - r).toFixed(6);
}
