import { CoinTierEnum, RetainReasonEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { VOLATILITY_DETECTED_EVENT } from '../../../src/common/const';
import { Money } from '../../../src/common/utils/money';
import { MarketDataService } from '../../../src/market-data/service/MarketDataService';
import { SubscriptionRetainer } from '../../../src/market-data/service/SubscriptionRetainer';
import { SymbolStateRegistry } from '../../../src/market-data/service/SymbolStateRegistry';

// M11a W1.3 — WebSocket resilience verification.
//
// Simulates a sustained ws drop on `watchTickers()` (modelled by a bounded
// sequence of rejections in place of the wall-clock 10-minute drop) and
// asserts:
//   (a) no volatility.detected events fire while the stream is rejecting;
//   (b) SubscriptionRetainer state survives the drop end-to-end (the
//       reason-set is in-memory and not cleared by the consume loop);
//   (c) the existing retry log line fires on each rejection (operator-
//       observable signal — see GAP below).
//
// GAP FLAGGED (not silently fixed): the engine does NOT today fire a dedicated
// Telegram "ticker stream stalled" alert when the consume loop is wedged in
// retry. ccxt.pro reconnects internally; engine-side observability today is
// the `logger.warn('watchTickers iteration failed, retrying: ...')` line.
// During the soak the runbook should treat the absence of `price.update`
// events for >N minutes as the stall signal until a dedicated alert lands.
// Surfaced for the final report.

const SYMBOL_A = 'BTC/USDT:USDT';
const SYMBOL_B = 'ETH/USDT:USDT';
const SIMULATED_DROP_ITERATIONS = 5;

function buildScaffold(exchangeClient: { watchTickers: jest.Mock }): {
    service: MarketDataService;
    emitter: EventEmitter2;
    retainer: SubscriptionRetainer;
    volatilityEvents: unknown[];
} {
    const emitter = new EventEmitter2();
    const volatilityEvents: unknown[] = [];
    emitter.on(VOLATILITY_DETECTED_EVENT, (evt) => volatilityEvents.push(evt));

    const registry = new SymbolStateRegistry();
    const retainer = new SubscriptionRetainer();
    const universe = {
        getEntry: jest.fn((symbol: string) => ({ symbol, tier: CoinTierEnum.TIER_1, volumeRank: 1, quoteVolume24h: new Money(0), enteredAtMs: 0 })),
        universeAgeHours: jest.fn().mockReturnValue(48),
        loadTradableSymbols: jest.fn(),
        refresh: jest.fn(),
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
    const calibration = { record: jest.fn() };

    const service = new MarketDataService(
        exchangeClient as never,
        emitter,
        { exchangeEnv: 'testnet' } as never,
        universe as never,
        registry,
        context as never,
        depthAggressor as never,
        flowPoll as never,
        calibration as never,
    );

    return { service, emitter, retainer, volatilityEvents };
}

describe('MarketDataService WS resilience (M11a W1.3)', () => {
    it('the consume loop keeps retrying on a simulated sustained drop and emits NO volatility events while the stream rejects', async () => {
        // Bounded rejection sequence: SIMULATED_DROP_ITERATIONS rejections in
        // a row, then one resolution that flips the streaming flag off via the
        // mock implementation. Avoids an unbounded loop that would OOM.
        let callCount = 0;
        const watchTickers = jest.fn(async (): Promise<unknown[]> => {
            callCount++;

            if (callCount <= SIMULATED_DROP_ITERATIONS) {
                throw new Error(`ECONNRESET: simulated ws drop iteration ${callCount}`);
            }

            // After the simulated drop, flip the streaming flag and resolve
            // with an empty batch — the loop exits its next iteration.
            (service as unknown as { streaming: boolean }).streaming = false;

            return [];
        });

        const { service, retainer, volatilityEvents } = buildScaffold({ watchTickers });
        // Manually flip the streaming flag (we are NOT going through
        // onApplicationBootstrap which would also fetchTickers).
        (service as unknown as { streaming: boolean }).streaming = true;

        retainer.retain(SYMBOL_A, RetainReasonEnum.OPEN_POSITION);
        retainer.retain(SYMBOL_B, RetainReasonEnum.OPEN_POSITION);

        const warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

        await (service as unknown as { streamTickers(): Promise<void> }).streamTickers();

        // (a) no volatility events during drop.
        expect(volatilityEvents).toHaveLength(0);

        // (c) retry log fired on each rejection (operator-observable signal).
        expect(warnSpy).toHaveBeenCalled();
        const warnLines = warnSpy.mock.calls.map((c) => String(c[0]));
        const retryLines = warnLines.filter((l) => l.includes('watchTickers iteration failed'));
        expect(retryLines.length).toBeGreaterThanOrEqual(SIMULATED_DROP_ITERATIONS);

        // Cause text sanitisation: the message survives, no raw stack.
        expect(retryLines.some((l) => l.includes('ECONNRESET'))).toBe(true);

        // (b) SubscriptionRetainer state survives.
        expect(retainer.isRetained(SYMBOL_A)).toBe(true);
        expect(retainer.isRetained(SYMBOL_B)).toBe(true);
        expect(retainer.getReasonsFor(SYMBOL_A).has(RetainReasonEnum.OPEN_POSITION)).toBe(true);

        // watchTickers was hit at least SIMULATED_DROP_ITERATIONS + 1 times.
        expect(watchTickers.mock.calls.length).toBeGreaterThan(SIMULATED_DROP_ITERATIONS);
    });

    it('resumes when watchTickers returns and never clears the retainer through a reconnect cycle', async () => {
        // 2 rejections, then resolved empty batch, then stop.
        let callCount = 0;
        const watchTickers = jest.fn(async (): Promise<unknown[]> => {
            callCount++;

            if (callCount <= 2) {
                throw new Error('transient drop');
            }

            (service as unknown as { streaming: boolean }).streaming = false;

            return [];
        });

        const { service, retainer, volatilityEvents } = buildScaffold({ watchTickers });
        (service as unknown as { streaming: boolean }).streaming = true;

        retainer.retain(SYMBOL_A, RetainReasonEnum.OPEN_POSITION);

        await (service as unknown as { streamTickers(): Promise<void> }).streamTickers();

        expect(volatilityEvents).toHaveLength(0);
        expect(retainer.isRetained(SYMBOL_A)).toBe(true);
        expect(watchTickers.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
});
