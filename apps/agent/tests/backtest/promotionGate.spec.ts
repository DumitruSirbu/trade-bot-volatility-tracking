// M13 W4 — promotion gate golden tests (ADR 0019).

import { evaluatePromotionGate, MAX_DD_TOLERANCE_PCT, NOT_AVAILABLE } from '../../src/backtest/promotionGate.js';
import type { BacktestReportParsed } from '../../src/mcp/schemas.js';

function makeReport(overrides: Partial<BacktestReportParsed> = {}): BacktestReportParsed {
    return {
        runLabel: 'r',
        strategyVersionId: 7,
        strategyName: 'volatility-vwap',
        strategyVersion: 3,
        fromUtcDate: '2026-02-26',
        toUtcDate: '2026-05-27',
        tradeCount: 250,
        winCount: 150,
        lossCount: 100,
        winRatePct: '60.00',
        grossPnlUsdt: '500.00',
        feesUsdt: '5.00',
        fundingUsdt: '1.00',
        slippageCostUsdt: '2.00',
        netPnlUsdt: '492.00',
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
        lowFidelityTradeCount: 5,
        equityCurve: [
            { utcDate: '2026-05-25', equityUsdt: '1000', dailyReturnPct: '-1.5' },
            { utcDate: '2026-05-26', equityUsdt: '1010', dailyReturnPct: '1.0' },
            { utcDate: '2026-05-27', equityUsdt: '1020', dailyReturnPct: '1.0' },
        ],
        perRegime: [],
        perFlowType: [],
        perSymbol: [],
        trades: [],
        ...overrides,
    };
}

describe('evaluatePromotionGate — criteria ordering', () => {
    // M13 W6 fix wave 3 (#2): criterion 10 now splits into two rows — 10a
    // (per-symbol concentration, measurable) and 10b (per-week concentration,
    // NOT_AVAILABLE). The ADR-numbered indices we expect, in order, are:
    const EXPECTED_INDICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 12];

    it('emits 13 criteria rows in ADR 0019 order (criterion 10 splits per-symbol + per-week)', () => {
        const draft = makeReport();
        const active = makeReport();
        const result = evaluatePromotionGate(draft, active);
        expect(result.criteria).toHaveLength(EXPECTED_INDICES.length);
        for (let i = 0; i < EXPECTED_INDICES.length; i = i + 1) {
            expect(result.criteria[i].index).toBe(EXPECTED_INDICES[i]);
        }
    });
});

describe('evaluatePromotionGate — measurable criteria pass', () => {
    it('criterion 1 passes when netPnlUsdt > 0', () => {
        const result = evaluatePromotionGate(makeReport({ netPnlUsdt: '100' }), makeReport());
        expect(result.criteria[0].passed).toBe(true);
    });

    it('criterion 1 fails when netPnlUsdt <= 0', () => {
        const result = evaluatePromotionGate(makeReport({ netPnlUsdt: '0' }), makeReport());
        expect(result.criteria[0].passed).toBe(false);
        expect(result.passes).toBe(false);
    });

    it('criterion 2 fails when profitFactor < 1.25', () => {
        const result = evaluatePromotionGate(makeReport({ profitFactor: '1.10' }), makeReport());
        expect(result.criteria[1].passed).toBe(false);
    });

    it('criterion 2 passes at the 1.25 threshold', () => {
        const result = evaluatePromotionGate(makeReport({ profitFactor: '1.25' }), makeReport());
        expect(result.criteria[1].passed).toBe(true);
    });

    it('criterion 3 fails when |maxDrawdownPct| > MAX_DD_TOLERANCE_PCT', () => {
        const result = evaluatePromotionGate(makeReport({ maxDrawdownPct: '25.0' }), makeReport());
        expect(result.criteria[2].passed).toBe(false);
    });

    it('criterion 3 passes at the MAX_DD_TOLERANCE_PCT threshold (boundary)', () => {
        const result = evaluatePromotionGate(
            makeReport({ maxDrawdownPct: String(MAX_DD_TOLERANCE_PCT) }),
            makeReport(),
        );
        expect(result.criteria[2].passed).toBe(true);
    });

    it('criterion 3 fails just above MAX_DD_TOLERANCE_PCT', () => {
        const result = evaluatePromotionGate(
            makeReport({ maxDrawdownPct: String(MAX_DD_TOLERANCE_PCT + 0.01) }),
            makeReport(),
        );
        expect(result.criteria[2].passed).toBe(false);
    });
});

describe('evaluatePromotionGate — engine-side constant mirror (M13 W6 fix wave 2 #3)', () => {
    // The agent's MAX_DD_TOLERANCE_PCT MUST mirror the engine's
    // promotionGateConsts.ts source-of-truth value. ADR 0035 §2.2 forbids
    // direct package imports across the agent boundary, so the mirror is a
    // documented hand-copy. This test pins the value so a future engine
    // change without a paired agent update breaks the build.
    it('MAX_DD_TOLERANCE_PCT equals the engine-side bar (15)', () => {
        expect(MAX_DD_TOLERANCE_PCT).toBe(15);
    });

    it('criterion 4 fails when worst single-day return < -5', () => {
        const result = evaluatePromotionGate(
            makeReport({ equityCurve: [{ utcDate: '2026-05-25', equityUsdt: '1000', dailyReturnPct: '-6.5' }] }),
            makeReport(),
        );
        expect(result.criteria[3].passed).toBe(false);
        expect(result.criteria[3].measured).toBe('-6.5000');
    });

    it('criterion 4 returns NOT_AVAILABLE and fails when every equityCurve point has a non-finite dailyReturnPct', () => {
        const result = evaluatePromotionGate(
            makeReport({
                equityCurve: [
                    { utcDate: '2026-05-25', equityUsdt: '1000', dailyReturnPct: 'NaN' },
                    { utcDate: '2026-05-26', equityUsdt: '1010', dailyReturnPct: 'NaN' },
                ],
            }),
            makeReport(),
        );
        expect(result.criteria[3].measured).toBe(NOT_AVAILABLE);
        expect(result.criteria[3].passed).toBe(false);
    });

    it('criterion 4 passes exactly at the -5 WORST_DAY_LOSS_TOLERANCE_PCT boundary', () => {
        const result = evaluatePromotionGate(
            makeReport({ equityCurve: [{ utcDate: '2026-05-25', equityUsdt: '1000', dailyReturnPct: '-5' }] }),
            makeReport(),
        );
        expect(result.criteria[3].passed).toBe(true);
    });

    it('criterion 6 fails when tradeCount < 200', () => {
        const result = evaluatePromotionGate(makeReport({ tradeCount: 100 }), makeReport());
        expect(result.criteria[5].passed).toBe(false);
    });

    it('criterion 12 passes when low-fidelity ratio is small', () => {
        const result = evaluatePromotionGate(makeReport({ tradeCount: 250, lowFidelityTradeCount: 10 }), makeReport());
        // Criterion 12 is the LAST row (criteria[12]) once criterion 10 splits
        // into 10a + 10b.
        expect(result.criteria[12].passed).toBe(true);
    });

    it('criterion 12 fails when low-fidelity ratio dominates', () => {
        const result = evaluatePromotionGate(makeReport({ tradeCount: 100, lowFidelityTradeCount: 80 }), makeReport());
        expect(result.criteria[12].passed).toBe(false);
    });
});

describe('evaluatePromotionGate — NOT_AVAILABLE criteria', () => {
    // Array indices (0-based) for the rows that source NOT_AVAILABLE when the
    // baseline `makeReport()` fixture is used (empty perSymbol, no bootstrap,
    // no robustness/regime data):
    //   4 → criterion 5 (bootstrap CI)
    //   6, 7, 8 → criteria 7, 8, 9 (robustness)
    //   9 → criterion 10a (per-symbol; NOT_AVAILABLE on empty perSymbol)
    //   10 → criterion 10b (per-week; always NOT_AVAILABLE until engine adds data)
    //   11 → criterion 11 (regime targeting)
    const NA_ROW_INDICES = [4, 6, 7, 8, 9, 10, 11];

    it('marks criteria 5, 7, 8, 9, 10a, 10b, 11 as NOT_AVAILABLE when source fields are missing', () => {
        const draft = makeReport();
        const active = makeReport();
        const result = evaluatePromotionGate(draft, active);

        for (const idx of NA_ROW_INDICES) {
            const row = result.criteria[idx];
            expect(row.measured).toBe(NOT_AVAILABLE);
            expect(row.passed).toBe(false);
        }
    });

    it('overall passes is false whenever any NOT_AVAILABLE row is present', () => {
        const draft = makeReport();
        const active = makeReport();
        const result = evaluatePromotionGate(draft, active);
        expect(result.passes).toBe(false);
    });
});

describe('evaluatePromotionGate — criterion 10 per-symbol concentration (M13 W6 fix wave 3 #2)', () => {
    // Criterion 10a is now MEASURABLE via `IBacktestReport.perSymbol`. Goldens:
    //   - One symbol holds 50% of trades → fail (50 > 40).
    //   - Even distribution across 3 symbols → pass.
    //   - Empty perSymbol → NOT_AVAILABLE (no data to evaluate).
    //
    // The per-week sub-gate (criterion 10b) stays NOT_AVAILABLE for every case
    // because IBacktestReport has no per-week breakdown yet.

    function perSymbolRow(symbol: string, tradeCount: number) {
        return { key: `symbol:${symbol}`, tradeCount, winRatePct: '60.00', netPnlUsdt: '0', profitFactor: '1.00' };
    }

    it('fails 10a when a single symbol holds > 40% of trades', () => {
        const draft = makeReport({
            tradeCount: 100,
            perSymbol: [perSymbolRow('BTCUSDT', 50), perSymbolRow('ETHUSDT', 30), perSymbolRow('SOLUSDT', 20)],
        });
        const result = evaluatePromotionGate(draft, makeReport());
        const tenA = result.criteria[9];
        expect(tenA.index).toBe(10);
        expect(tenA.passed).toBe(false);
        expect(tenA.measured).toBe('50.00');
    });

    it('passes 10a when no single symbol exceeds 40% of trades', () => {
        const draft = makeReport({
            tradeCount: 90,
            perSymbol: [perSymbolRow('BTCUSDT', 30), perSymbolRow('ETHUSDT', 30), perSymbolRow('SOLUSDT', 30)],
        });
        const result = evaluatePromotionGate(draft, makeReport());
        const tenA = result.criteria[9];
        expect(tenA.passed).toBe(true);
        // 30/90 = 33.33% → 33.33 measured.
        expect(Number(tenA.measured)).toBeCloseTo(33.33, 2);
    });

    it('marks 10a NOT_AVAILABLE when perSymbol is empty (cannot measure)', () => {
        const draft = makeReport({ perSymbol: [] });
        const result = evaluatePromotionGate(draft, makeReport());
        const tenA = result.criteria[9];
        expect(tenA.measured).toBe(NOT_AVAILABLE);
        expect(tenA.passed).toBe(false);
    });

    it('always marks 10b (per-week distribution) NOT_AVAILABLE — engine has no per-week breakdown', () => {
        const draft = makeReport({
            tradeCount: 90,
            perSymbol: [perSymbolRow('BTCUSDT', 30), perSymbolRow('ETHUSDT', 30), perSymbolRow('SOLUSDT', 30)],
        });
        const result = evaluatePromotionGate(draft, makeReport());
        const tenB = result.criteria[10];
        expect(tenB.index).toBe(10);
        expect(tenB.measured).toBe(NOT_AVAILABLE);
        expect(tenB.passed).toBe(false);
    });

    it('boundary: exactly 40% share passes (<= threshold)', () => {
        const draft = makeReport({
            tradeCount: 100,
            perSymbol: [perSymbolRow('BTCUSDT', 40), perSymbolRow('ETHUSDT', 35), perSymbolRow('SOLUSDT', 25)],
        });
        const result = evaluatePromotionGate(draft, makeReport());
        expect(result.criteria[9].passed).toBe(true);
        expect(result.criteria[9].measured).toBe('40.00');
    });
});

describe('evaluatePromotionGate — single criterion failure surface', () => {
    it('failing only criterion 1 leaves criteria[0].passed=false and passes=false', () => {
        const result = evaluatePromotionGate(makeReport({ netPnlUsdt: '-1' }), makeReport());
        expect(result.criteria[0].passed).toBe(false);
        expect(result.passes).toBe(false);
    });
});
