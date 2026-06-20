/**
 * M41 D2 — PaperFillSimulator requests REST tick refresh when WS cache is stale.
 */

import { CoinTierEnum, IOrderIntent, OrderIntentActionEnum, CorrelationModeEnum, FlowTypeEnum, PositionSideEnum } from '@bot/shared';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PAPER_TICK_REFRESH_REQUEST } from '../../common/const';
import { BootstrapSubkeyDeriver } from '../../boot-mode-history/service/BootstrapSubkeyDeriver';
import { AppConfigService } from '../../config/service';
import { STREAMING_FILL_STALE_TICK_MS } from '../const';
import { PaperSimulatorIdempotencyRepository } from '../repository/PaperSimulatorIdempotencyRepository';
import { PaperFillSimulator, IPaperSimulatorContext } from '../service/PaperFillSimulator';
import { StreamingFillAdapter } from '../service/StreamingFillAdapter';

function buildIntent(eventId: string, symbol: string): IOrderIntent {
    return {
        intentAction: OrderIntentActionEnum.OPEN,
        symbol,
        eventId,
        tradeSide: PositionSideEnum.LONG,
        signalScore: 70,
        correlationMode: CorrelationModeEnum.IDIOSYNCRATIC,
        coinTier: CoinTierEnum.TIER_1,
        idiosyncrasyScore: 0.8,
        quantity: '0.01',
        flowType: FlowTypeEnum.TREND_INITIATION,
    };
}

function buildContext(eventId: string): IPaperSimulatorContext {
    return {
        eventId,
        orderIntentId: `${eventId}-intent-1`,
        versionNamespace: 'paper.active.v1',
    };
}

const BOOTSTRAP_SECRET = 'b'.repeat(64);

function buildSubkeys(): BootstrapSubkeyDeriver {
    return new BootstrapSubkeyDeriver({ authBootstrapSecret: BOOTSTRAP_SECRET } as unknown as AppConfigService);
}

function buildIdempotencyRepo(): PaperSimulatorIdempotencyRepository {
    return {
        findByKey: jest.fn().mockResolvedValue(null),
        insertNew: jest.fn().mockResolvedValue({}),
    } as unknown as PaperSimulatorIdempotencyRepository;
}

describe('PaperFillSimulator — stale tick REST refresh (M42)', () => {
    it('emitAsync PAPER_TICK_REFRESH_REQUEST when cached tick is older than STREAMING_FILL_STALE_TICK_MS', async () => {
        const nowMs = 1_700_000_000_000;
        const staleTs = nowMs - STREAMING_FILL_STALE_TICK_MS - 1;
        const adapter = new StreamingFillAdapter();
        adapter.notifyTick('UNI/USDT:USDT', {
            bid: '3.10',
            ask: '3.12',
            last: '3.11',
            mark: '3.11',
            high: '3.11',
            low: '3.11',
            ts: staleTs,
        });

        const eventEmitter = {
            emitAsync: jest.fn().mockImplementation(async (_event: string, payload: { symbol: string; nowMs: number }) => {
                adapter.notifyTick(payload.symbol, {
                    bid: '3.11',
                    ask: '3.13',
                    last: '3.12',
                    mark: '3.12',
                    high: '3.12',
                    low: '3.12',
                    ts: payload.nowMs,
                });
            }),
        } as unknown as EventEmitter2;

        const simulator = new PaperFillSimulator(buildSubkeys(), buildIdempotencyRepo(), adapter, eventEmitter);
        const intent = buildIntent('UNI/USDT:USDT:1781877600000', 'UNI/USDT:USDT');
        const context = buildContext('UNI/USDT:USDT:1781877600000');

        const result = await simulator.simulateFill(intent, context, CoinTierEnum.TIER_1, nowMs);

        expect(eventEmitter.emitAsync).toHaveBeenCalledWith(PAPER_TICK_REFRESH_REQUEST, {
            symbol: 'UNI/USDT:USDT',
            nowMs,
        });
        expect(result.fill.filled).toBe(true);
        expect(Number(result.fill.fillPrice)).toBeGreaterThan(0);
    });

    it('does not emit refresh when cached tick is fresh', async () => {
        const nowMs = 1_700_000_000_000;
        const adapter = new StreamingFillAdapter();
        adapter.notifyTick('UNI/USDT:USDT', {
            bid: '3.10',
            ask: '3.12',
            last: '3.11',
            mark: '3.11',
            high: '3.11',
            low: '3.11',
            ts: nowMs - 1_000,
        });

        const eventEmitter = {
            emitAsync: jest.fn(),
        } as unknown as EventEmitter2;

        const simulator = new PaperFillSimulator(buildSubkeys(), buildIdempotencyRepo(), adapter, eventEmitter);
        const intent = buildIntent('evt-fresh', 'UNI/USDT:USDT');
        const context = buildContext('evt-fresh');

        const result = await simulator.simulateFill(intent, context, CoinTierEnum.TIER_1, nowMs);

        expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
        expect(result.fill.filled).toBe(true);
    });
});
