import { EventEmitter2 } from '@nestjs/event-emitter';
import { CoinTierEnum, DeviationSideEnum, ITriggerResult } from '@bot/shared';

import { VOLATILITY_DETECTED_EVENT } from '../../../src/common/const';
import { Money } from '../../../src/common/utils/money';
import { CANDLE_5M_INTERVAL_MS } from '../../../src/market-data/const';
import { IIndicatorSnapshot } from '../../../src/market-data/interface';
import { MarketDataService } from '../../../src/market-data/service/MarketDataService';
import { SymbolStateRegistry } from '../../../src/market-data/service/SymbolStateRegistry';

import * as indicatorModule from '../../../src/market-data/indicator';
import * as triggerModule from '../../../src/market-data/trigger';

jest.mock('../../../src/market-data/indicator', () => {
    const actual = jest.requireActual('../../../src/market-data/indicator');

    return { ...actual, computeIndicatorSnapshot: jest.fn() };
});

jest.mock('../../../src/market-data/trigger', () => {
    const actual = jest.requireActual('../../../src/market-data/trigger');

    return { ...actual, evaluateTrigger: jest.fn() };
});

const SYMBOL = 'ETH/USDT:USDT';
const SYMBOL_B = 'SOL/USDT:USDT';
const TIER = CoinTierEnum.TIER_1;

function buildFiringSnapshot(openTimeMs: number, symbol: string = SYMBOL): IIndicatorSnapshot {
    return {
        symbol,
        closedBarOpenTimeMs: openTimeMs,
        vwapSession: new Money(2000),
        vwap20bar: new Money(2000),
        vwap24h: new Money(2000),
        vwapEventAnchored: new Money(2000),
        activeVwapAnchorType: 'rolling_20bar' as IIndicatorSnapshot['activeVwapAnchorType'],
        vwapDeviationPct: 2.5,
        vwapDeviationSigma: 3.0,
        volumeRatio: 3.0,
        volume20barAvg: new Money(100),
        atr14: new Money(10),
        adx14: 30,
        adxDiPlus: 25,
        adxDiMinus: 10,
        rsi14: 70,
        bollingerUpper: new Money(2100),
        bollingerLower: new Money(1900),
        bollingerPctB: 0.95,
        close: new Money(2050),
        fiveMinMovePct: 1.2,
    };
}

const FIRED_RESULT: ITriggerResult = {
    fired: true,
    side: DeviationSideEnum.ABOVE,
    sigmaConditionMet: true,
    volumeConditionMet: true,
    minMoveConditionMet: true,
    maxMoveConditionMet: true,
};

function buildService(emitter: EventEmitter2, registry: SymbolStateRegistry, calibrationRecord: jest.Mock): MarketDataService {
    const universe = {
        getEntry: jest.fn((symbol: string) => ({ symbol, tier: TIER, volumeRank: 1, quoteVolume24h: new Money(0), enteredAtMs: 0 })),
        universeAgeHours: jest.fn().mockReturnValue(48),
    };
    const context = {
        btc5mMovePct: jest.fn().mockReturnValue(0),
        btc1mMovePct: jest.fn().mockReturnValue(0),
        eth5mMovePct: jest.fn().mockReturnValue(0),
        btc5mBarMovePct: jest.fn().mockReturnValue(0),
        breadth: jest.fn().mockReturnValue({ upPct1m: 0, upPct5m: 0, upPct15m: 0 }),
    };
    const depthAggressor = { start: jest.fn(), stop: jest.fn() };
    const flowPoll = { pollOpenInterestForSymbol: jest.fn() };
    const calibration = { record: calibrationRecord };

    return new MarketDataService(
        {} as never,
        emitter,
        universe as never,
        registry,
        context as never,
        depthAggressor as never,
        flowPoll as never,
        calibration as never,
    );
}

describe('MarketDataService close-path unification', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (triggerModule.evaluateTrigger as jest.Mock).mockReturnValue(FIRED_RESULT);
    });

    // Regression: an ACTIVE symbol graduates its bar on the TICK path (a tick crosses
    // the 5-min boundary) — that closed bar must be evaluated and emitted, not dropped.
    // Before the fix, only the wall-clock sweep evaluated bars, so active symbols were
    // silently never triggered/calibrated.
    it('evaluates and emits a tick-closed bar without waiting for the sweep', () => {
        const emitter = new EventEmitter2();
        const emitSpy = jest.spyOn(emitter, 'emit');
        const registry = new SymbolStateRegistry();
        const service = buildService(emitter, registry, jest.fn());

        (indicatorModule.computeIndicatorSnapshot as jest.Mock).mockReturnValue(buildFiringSnapshot(0));

        const tickerInBucket0 = { symbol: SYMBOL, last: '2000', quoteVolume: '1000', timestampMs: 60_000 };
        const tickerInBucket1 = { symbol: SYMBOL, last: '2050', quoteVolume: '2000', timestampMs: CANDLE_5M_INTERVAL_MS };

        service['handleTickerBatch']([tickerInBucket0] as never); // opens bucket 0
        service['handleTickerBatch']([tickerInBucket1] as never); // crosses boundary -> graduates bucket 0

        const volatilityEmits = emitSpy.mock.calls.filter(([event]) => event === VOLATILITY_DETECTED_EVENT);

        expect(volatilityEmits).toHaveLength(1);
    });

    // The fix: when MANY active symbols graduate the SAME 5-min bucket within ONE
    // watchTickers batch, sameBarTriggerCount must count them cross-sectionally — not
    // report 1 per symbol as it did when the tick path closed bars one at a time.
    it('counts all active symbols closing the same bucket in one ticker batch', () => {
        const emitter = new EventEmitter2();
        const emitSpy = jest.spyOn(emitter, 'emit');
        const registry = new SymbolStateRegistry();
        const service = buildService(emitter, registry, jest.fn());

        (indicatorModule.computeIndicatorSnapshot as jest.Mock).mockImplementation((input: { symbol: string }) => buildFiringSnapshot(0, input.symbol));

        // First batch opens bucket 0 for both symbols.
        service['handleTickerBatch']([
            { symbol: SYMBOL, last: '2000', quoteVolume: '1000', timestampMs: 60_000 },
            { symbol: SYMBOL_B, last: '2000', quoteVolume: '1000', timestampMs: 60_000 },
        ] as never);

        // Second batch crosses the boundary for both in the SAME pass -> both graduate bucket 0.
        service['handleTickerBatch']([
            { symbol: SYMBOL, last: '2050', quoteVolume: '2000', timestampMs: CANDLE_5M_INTERVAL_MS },
            { symbol: SYMBOL_B, last: '2050', quoteVolume: '2000', timestampMs: CANDLE_5M_INTERVAL_MS },
        ] as never);

        const volatilityEmits = emitSpy.mock.calls.filter(([event]) => event === VOLATILITY_DETECTED_EVENT);

        expect(volatilityEmits).toHaveLength(2);
        expect(volatilityEmits.every(([, payload]) => (payload as { sameBarTriggerCount: number }).sameBarTriggerCount === 2)).toBe(true);
    });

    it('records every tick-closed bar for calibration', () => {
        const emitter = new EventEmitter2();
        const registry = new SymbolStateRegistry();
        const calibrationRecord = jest.fn();
        const service = buildService(emitter, registry, calibrationRecord);

        (indicatorModule.computeIndicatorSnapshot as jest.Mock).mockReturnValue(buildFiringSnapshot(0));

        service['handleTickerBatch']([{ symbol: SYMBOL, last: '2000', quoteVolume: '1000', timestampMs: 60_000 }] as never);
        service['handleTickerBatch']([{ symbol: SYMBOL, last: '2050', quoteVolume: '2000', timestampMs: CANDLE_5M_INTERVAL_MS }] as never);

        expect(calibrationRecord).toHaveBeenCalledWith(SYMBOL, 2.5);
    });
});
