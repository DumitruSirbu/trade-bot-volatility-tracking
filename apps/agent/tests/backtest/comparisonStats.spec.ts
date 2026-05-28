// M13 W4 — comparisonStats deterministic tests.

import { bootstrapCiPassesZero, computeHeadlineDelta } from '../../src/backtest/comparisonStats.js';
import type { BacktestReportParsed } from '../../src/mcp/schemas.js';

function makeReport(overrides: Partial<BacktestReportParsed> = {}): BacktestReportParsed {
    return {
        runLabel: 'r',
        strategyVersionId: 7,
        strategyName: 'volatility-vwap',
        strategyVersion: 3,
        fromUtcDate: '2026-02-26',
        toUtcDate: '2026-05-27',
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
        ...overrides,
    };
}

describe('computeHeadlineDelta', () => {
    it('returns (draft - active) on every headline metric', () => {
        const active = makeReport({ netPnlUsdt: '100', tradeCount: 10, sharpeAnnualized: '0.40', sortinoAnnualized: '0.50', maxDrawdownPct: '6.00' });
        const draft = makeReport({ netPnlUsdt: '200', tradeCount: 10, sharpeAnnualized: '0.55', sortinoAnnualized: '0.70', maxDrawdownPct: '4.00' });

        const delta = computeHeadlineDelta(active, draft);

        // epur proxy = netPnl / tradeCount = 20 vs 10 → diff 10.
        expect(Number(delta.epurDelta)).toBeCloseTo(10, 6);
        expect(Number(delta.sharpeDelta)).toBeCloseTo(0.15, 6);
        expect(Number(delta.sortinoDelta)).toBeCloseTo(0.2, 6);
        // Uniform sign convention: positive delta = draft is better.
        // draft DD = 4, active DD = 6 → delta = active - draft = +2 (draft has
        // a smaller drawdown, so the delta is positive).
        expect(Number(delta.maxDrawdownDelta)).toBeCloseTo(2, 6);
    });

    it('produces 0 epur when tradeCount is zero (no division by zero)', () => {
        const empty = makeReport({ netPnlUsdt: '0', tradeCount: 0 });
        const delta = computeHeadlineDelta(empty, empty);
        expect(delta.epurDelta).toBe('0.000000');
    });
});

describe('bootstrapCiPassesZero', () => {
    it('returns false when bootstrap field is absent', () => {
        expect(bootstrapCiPassesZero({})).toBe(false);
    });

    it('returns true when CI lower bound is strictly above zero', () => {
        expect(bootstrapCiPassesZero({ bootstrap: { ci: { lo: '0.01', hi: '0.5' } } })).toBe(true);
    });

    it('returns true when CI upper bound is strictly below zero', () => {
        expect(bootstrapCiPassesZero({ bootstrap: { ci: { lo: '-0.5', hi: '-0.01' } } })).toBe(true);
    });

    it('returns false when CI straddles zero (boundary case)', () => {
        expect(bootstrapCiPassesZero({ bootstrap: { ci: { lo: '-0.01', hi: '0.01' } } })).toBe(false);
    });

    it('returns false when CI touches zero exactly (zero NOT strictly excluded)', () => {
        expect(bootstrapCiPassesZero({ bootstrap: { ci: { lo: '0', hi: '0.5' } } })).toBe(false);
    });
});
