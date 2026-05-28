import * as fs from 'fs';
import * as path from 'path';

import { CoinTierEnum, IBacktestFill, type ITierSlippageParams } from '@bot/shared';

import { Money } from '../../common/utils';
import { TickAggregateEntity } from '../../market-data/entity';
import { HistoricalFillAdapter, IFillRequest } from '../fill/HistoricalFillAdapter';

// M7 Fill-Equivalence Regression (ADR 0032 §3 D15, M11a R2c.B load-bearing test).
//
// Asserts numerical equivalence between the pre-extraction engine-side `FillSimulator`
// and the post-extraction `HistoricalFillAdapter` (which delegates to the shared
// `@bot/shared/util/fillSimulatorCore`). The fixture in
// `fixtures/M7FillGoldenTape.json` was captured from the pre-extraction `FillSimulator`
// at the R2c.B wave; once the M7 fill files were deleted, this test became the
// permanent anchor: any future drift in shared core or adapter mapping fails here.
//
// Equivalence is numerical per-field (not byte-for-byte), per D15 R3.1 M5: decimal
// serialisation order, map-iteration, and floating-point summation order can produce
// non-byte-identical output for numerically equivalent results. Per-field assertion
// catches semantic regression without flapping on cosmetic re-ordering.

const GOLDEN_TAPE_PATH = path.join(__dirname, 'fixtures', 'M7FillGoldenTape.json');

interface IFixtureCase {
    readonly label: string;
    readonly request: {
        readonly eventId: string;
        readonly symbol: string;
        readonly side: 'long' | 'short';
        readonly intent: 'open' | 'reduce' | 'close';
        readonly policy: string;
        readonly limitPrice: string;
        readonly qty: string;
        readonly coinTier: CoinTierEnum;
        readonly signalBarOpenMs: number;
        readonly barHigh: string;
        readonly barLow: string;
        readonly ticks: { high: string; low: string; close: string; tsMs: number }[];
        readonly tierSlippageParams: ITierSlippageParams;
        readonly latencyMs: number;
    };
    readonly expected: IBacktestFill;
}

function loadGoldenTape(): IFixtureCase[] {
    const raw = fs.readFileSync(GOLDEN_TAPE_PATH, 'utf-8');
    return JSON.parse(raw) as IFixtureCase[];
}

function rehydrateRequest(fixture: IFixtureCase['request']): IFillRequest {
    const ticks: TickAggregateEntity[] = fixture.ticks.map((tick) => ({
        id: 0,
        ts: new Date(tick.tsMs),
        symbol: fixture.symbol,
        open: new Money(tick.close),
        high: new Money(tick.high),
        low: new Money(tick.low),
        close: new Money(tick.close),
        volume: new Money(0),
    }));

    return {
        eventId: fixture.eventId,
        symbol: fixture.symbol,
        side: fixture.side,
        intent: fixture.intent,
        policy: fixture.policy,
        limitPrice: new Money(fixture.limitPrice),
        qty: new Money(fixture.qty),
        coinTier: fixture.coinTier,
        signalBarOpenMs: fixture.signalBarOpenMs,
        barHigh: new Money(fixture.barHigh),
        barLow: new Money(fixture.barLow),
        ticks,
        bookSnapshot: null,
        tierSlippageParams: fixture.tierSlippageParams,
        config: {
            latencyMs: fixture.latencyMs,
            enableDepthAwareSlippage: false,
            enableIntrabarStopSimulation: true,
        },
    };
}

describe('M7 fill-equivalence regression — HistoricalFillAdapter vs golden tape', () => {
    const adapter = new HistoricalFillAdapter();
    const tape = loadGoldenTape();

    it('golden tape is non-empty and covers all canonical fill branches', () => {
        expect(tape.length).toBeGreaterThanOrEqual(8);
        const labels = tape.map((c) => c.label);
        // Spot-check key branches: at least one of each policy + a missed-fill + intra-bar covered.
        expect(labels.some((l) => l.includes('IOC'))).toBe(true);
        expect(labels.some((l) => l.includes('POST_ONLY'))).toBe(true);
        expect(labels.some((l) => l.includes('REDUCE_MARKET'))).toBe(true);
        expect(labels.some((l) => l.includes('missed'))).toBe(true);
    });

    for (const fixture of loadGoldenTape()) {
        it(`numerical equivalence — ${fixture.label}`, () => {
            const request = rehydrateRequest(fixture.request);
            const actual = adapter.simulateFill(request);

            // Per-field numerical equality. Passthrough identity fields must match exactly.
            expect(actual.eventId).toBe(fixture.expected.eventId);
            expect(actual.symbol).toBe(fixture.expected.symbol);
            expect(actual.side).toBe(fixture.expected.side);
            expect(actual.intent).toBe(fixture.expected.intent);
            expect(actual.missed).toBe(fixture.expected.missed);
            expect(actual.depthAware).toBe(fixture.expected.depthAware);
            expect(actual.tsMs).toBe(fixture.expected.tsMs);

            // Decimal-value fields: normalize via Money and compare numerically. This is
            // the documented tolerance for fields whose textual representation may differ
            // by trailing-zero count without numerical difference.
            expect(new Money(actual.priceUsdt).comparedTo(new Money(fixture.expected.priceUsdt))).toBe(0);
            expect(new Money(actual.qty).comparedTo(new Money(fixture.expected.qty))).toBe(0);
            expect(new Money(actual.feeUsdt).comparedTo(new Money(fixture.expected.feeUsdt))).toBe(0);
            expect(new Money(actual.slippagePct).comparedTo(new Money(fixture.expected.slippagePct))).toBe(0);
        });
    }
});
