// M13 W1.D — redactForLlm tests (ADR 0037 §2.4).
//
// 1. Every blocklist field name throws.
// 2. Allowlist fixture (IBacktestReport-shaped) passes through unchanged.
// 3. Nested-object and array-element detection both fire.
// 4. Unknown string-valued fields throw (conservative-default).
// 5. Unknown numeric / decimal-string fields pass.

import { EGRESS_ALLOWLIST, EGRESS_BLOCKLIST, EgressViolationError, redactForLlm } from '../../src/llm/redactForLlm.js';

describe('redactForLlm — blocklist (ADR 0037 §2.3)', () => {
    // Each named entry in the blocklist gets its own assertion. The fixture
    // is generated from the live set so any future blocklist addition is
    // automatically covered (ADR 0037 §2.4 item 8).
    for (const fieldName of EGRESS_BLOCKLIST) {
        it(`throws EgressViolationError when leaf '${fieldName}' is present`, () => {
            const fixture: Record<string, unknown> = { [fieldName]: 'leaked-value' };
            try {
                redactForLlm(fixture);
                fail(`expected throw for field ${fieldName}`);
            } catch (err) {
                expect(err).toBeInstanceOf(EgressViolationError);
                const e = err as EgressViolationError;
                expect(e.paths.some((p) => p.endsWith(`.${fieldName}`))).toBe(true);
            }
        });
    }

    it('throws on prefix substring (e.g. `authToken`, `ipAddress`)', () => {
        expect(() => redactForLlm({ authToken: 'abc' })).toThrow(EgressViolationError);
        expect(() => redactForLlm({ ipAddress: '1.2.3.4' })).toThrow(EgressViolationError);
    });

    it('throws on substring containment in field names (e.g. `myBalance`, `clientApiKey`)', () => {
        expect(() => redactForLlm({ myBalance: 100 })).toThrow(EgressViolationError);
        expect(() => redactForLlm({ clientApiKey: 'k' })).toThrow(EgressViolationError);
    });

    it('detects blocklist fields nested 3 levels deep', () => {
        const nested = { outer: { middle: { inner: { apiKey: 'leak' } } } };
        try {
            redactForLlm(nested);
            fail('expected throw');
        } catch (err) {
            const e = err as EgressViolationError;
            expect(e.paths[0]).toBe('$.outer.middle.inner.apiKey');
        }
    });

    it('detects blocklist fields inside array elements', () => {
        const arr = {
            items: Array.from({ length: 100 }, (_, i) => (i === 42 ? { exchangeOrderId: 'X' } : { id: 'ok' })),
        };
        try {
            redactForLlm(arr);
            fail('expected throw');
        } catch (err) {
            const e = err as EgressViolationError;
            expect(e.paths).toContain('$.items[42].exchangeOrderId');
        }
    });

    it('reports ALL offending paths in one throw (no short-circuit)', () => {
        const multi = { apiKey: 'a', balance: 1, accountId: 'u', clientOrderId: 'c', ipAllowlist: ['x'] };
        try {
            redactForLlm(multi);
            fail('expected throw');
        } catch (err) {
            const e = err as EgressViolationError;
            expect(e.paths).toHaveLength(5);
        }
    });
});

describe('redactForLlm — allowlist (ADR 0037 §2.2)', () => {
    it('IBacktestReport-shaped fixture passes through unchanged', () => {
        const fixture = {
            runLabel: 'r1',
            strategyVersionId: 1,
            strategyName: 'volatility-vwap',
            strategyVersion: 1,
            fromUtcDate: '2026-04-01',
            toUtcDate: '2026-05-01',
            tradeCount: 10,
            winCount: 6,
            lossCount: 4,
            winRatePct: '60.0',
            netPnlUsdt: '112.0',
            sharpeAnnualized: '1.5',
            sortinoAnnualized: '1.9',
            maxDrawdownPct: '5.0',
            lowFidelity: false,
            perRegime: [{ key: 'trend', tradeCount: 3, winRatePct: '66.7', netPnlUsdt: '50', profitFactor: '2.0' }],
            equityCurve: [{ utcDate: '2026-04-01', equityUsdt: '1000', dailyReturnPct: '0.5' }],
        };
        expect(() => redactForLlm(fixture)).not.toThrow();
        expect(redactForLlm(fixture)).toBe(fixture);
    });

    it('IPerformanceByVersionView fixture passes', () => {
        const perf = {
            strategyVersionId: '1',
            label: 'v1',
            isLive: true,
            status: 'active',
            windowDays: 30,
            tradeCount: 42,
            winRate: '0.52',
            netPnlUsd: '123.45',
            maxDrawdownUsd: '-12.0',
            sharpe: '1.2',
            sortino: '1.7',
            expectancyPerUnitRisk: '0.12',
        };
        expect(() => redactForLlm(perf)).not.toThrow();
    });

    it('null leaves of allowlisted keys pass', () => {
        expect(() => redactForLlm({ winRate: null, sharpe: null })).not.toThrow();
    });

    it('every entry in EGRESS_ALLOWLIST passes when given a structural value', () => {
        for (const key of EGRESS_ALLOWLIST) {
            const fixture: Record<string, unknown> = { [key]: '1.23' };
            expect(() => redactForLlm(fixture)).not.toThrow();
        }
    });
});

describe('redactForLlm — unknown-field semantics', () => {
    it('unknown numeric leaf passes', () => {
        expect(() => redactForLlm({ customMetric: 42 })).not.toThrow();
    });

    it('unknown decimal-string leaf passes', () => {
        expect(() => redactForLlm({ customMetric: '1.23456' })).not.toThrow();
    });

    it('unknown boolean leaf passes', () => {
        expect(() => redactForLlm({ customFlag: true })).not.toThrow();
    });

    it('unknown free-text string leaf throws (catches leak via unanticipated field name)', () => {
        try {
            redactForLlm({ customString: 'hello operator' });
            fail('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(EgressViolationError);
            expect((err as EgressViolationError).paths).toContain('$.customString');
        }
    });
});

describe('redactForLlm — depth cap', () => {
    it('rejects trees deeper than the depth cap', () => {
        let nested: Record<string, unknown> = { tradeCount: 1 };
        for (let i = 0; i < 12; i++) {
            nested = { name: nested };
        }
        expect(() => redactForLlm(nested)).toThrow(EgressViolationError);
    });
});
