// M13 W4 — paired-backtest runner tests.

import {
    runComparisonBacktests,
    BacktestWindowMismatchError,
    type IComparisonMcpPort,
} from '../../src/backtest/runComparisonBacktests.js';
import type { BacktestReportParsed } from '../../src/mcp/schemas.js';

function makeReport(label: string, from: string, to: string): BacktestReportParsed {
    return {
        runLabel: label,
        strategyVersionId: 7,
        strategyName: 'volatility-vwap',
        strategyVersion: 3,
        fromUtcDate: from,
        toUtcDate: to,
        tradeCount: 10,
        winCount: 6,
        lossCount: 4,
        winRatePct: '60.00',
        grossPnlUsdt: '100.00',
        feesUsdt: '5.00',
        fundingUsdt: '1.00',
        slippageCostUsdt: '2.00',
        netPnlUsdt: '92.00',
        returnPct: '9.20',
        profitFactor: '1.50',
        avgHoldMs: 3_600_000,
        maxDrawdownPct: '4.00',
        maxDrawdownDurationDays: 2,
        sharpeAnnualized: '0.42',
        sortinoAnnualized: '0.55',
        skippedTriggerCount: 0,
        rejectedByGateCount: 0,
        missedLimitFillCount: 0,
        lowFidelityTradeCount: 0,
        equityCurve: [],
        perRegime: [],
        perFlowType: [],
        perSymbol: [],
        trades: [],
    };
}

function makeMcp(activeReport: BacktestReportParsed, draftReport: BacktestReportParsed): IComparisonMcpPort & { calls: Array<{ versionId: number; from: string; to: string }> } {
    const calls: Array<{ versionId: number; from: string; to: string }> = [];
    return {
        calls,
        async runBacktest(args) {
            calls.push({ versionId: args.versionId, from: args.from, to: args.to });
            return args.versionId === 7 ? activeReport : draftReport;
        },
    };
}

describe('runComparisonBacktests — happy path', () => {
    it('returns both reports when active and draft windows match', async () => {
        const mcp = makeMcp(
            makeReport('active', '2026-02-26', '2026-05-27'),
            makeReport('draft', '2026-02-26', '2026-05-27'),
        );

        const result = await runComparisonBacktests({
            mcp,
            parentVersionId: 7,
            draftVersionId: 8,
            from: '2026-02-26T00:00:00.000Z',
            to: '2026-05-27T00:00:00.000Z',
        });

        expect(result.active.runLabel).toBe('active');
        expect(result.draft.runLabel).toBe('draft');
        expect(mcp.calls).toHaveLength(2);
        expect(mcp.calls[0].versionId).toBe(7);
        expect(mcp.calls[1].versionId).toBe(8);
        expect(mcp.calls[0].from).toBe(mcp.calls[1].from);
        expect(mcp.calls[0].to).toBe(mcp.calls[1].to);
    });
});

describe('runComparisonBacktests — window mismatch', () => {
    it('throws BacktestWindowMismatchError when fromUtcDate diverges', async () => {
        const mcp = makeMcp(
            makeReport('active', '2026-02-26', '2026-05-27'),
            makeReport('draft', '2026-02-27', '2026-05-27'),
        );

        await expect(
            runComparisonBacktests({
                mcp,
                parentVersionId: 7,
                draftVersionId: 8,
                from: '2026-02-26T00:00:00.000Z',
                to: '2026-05-27T00:00:00.000Z',
            }),
        ).rejects.toBeInstanceOf(BacktestWindowMismatchError);
    });

    it('throws BacktestWindowMismatchError when toUtcDate diverges', async () => {
        const mcp = makeMcp(
            makeReport('active', '2026-02-26', '2026-05-27'),
            makeReport('draft', '2026-02-26', '2026-05-28'),
        );

        await expect(
            runComparisonBacktests({
                mcp,
                parentVersionId: 7,
                draftVersionId: 8,
                from: '2026-02-26T00:00:00.000Z',
                to: '2026-05-27T00:00:00.000Z',
            }),
        ).rejects.toBeInstanceOf(BacktestWindowMismatchError);
    });
});
